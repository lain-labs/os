/**
 * The skill kit: what a self-written tool gets besides the runtime.
 *
 * A skill is written in one go from one sentence ("find tokens that at least
 * 5 of these 30 wallets bought within 48 hours"), so it must not have to
 * rediscover the chain's quirks every time: that the RPC serves at most 30k
 * blocks per eth_getLogs, that the explorer API answers a server with a
 * Cloudflare page, that an airdrop is not a buy, that a skills directory
 * outside the repository cannot import viem. The first live run of phase 2
 * spent most of its turns on exactly that. The kit is the answer, passed as
 * the handler's fourth argument:
 *
 *   async handler(runtime, state, params, kit) { … }
 *
 *   kit.chain(network?)  — the chain, read the way the built-in tools read it
 *   kit.prices(tokens)   — USD prices and liquidity (DexScreener)
 *   kit.wallets(input)   — a wallet list from addresses, text or a workspace file
 *   kit.tool(name, args) — any live tool that reads, so a skill composes
 *   kit.store            — this skill's own state, kept across runs
 *   kit.http             — fetch with a timeout and honest errors
 *   kit.save(name, text) — a file in the workspace exports
 *   kit.viem             — the viem module itself
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as viem from "viem";
import { formatUnits, type Address, type PublicClient } from "viem";
import type { ActionResult, IAgentRuntime, State } from "../../types.js";
import { currentProfile, listNetworksSync, matchNetwork, networkClient, type NetworkProfile } from "../chain/networks.js";
import { walletsFromParams } from "../sentinel/index.js";
import { safePath, workspaceRoot } from "../system/index.js";
import { isRateLimit, pacer, pairKey, rpcErrorText, rpcWalletSource, type TokenMeta, type Transfer } from "../wallets/chainread.js";
import { parseWalletList, type WalletEntry } from "../wallets/lists.js";

export interface KitTransfer extends Transfer {
  /** Estimated time of the block, ms since epoch. */
  at: number;
}

/** One wallet's trade of one token in one transaction it signed. */
export interface KitTrade {
  wallet: Address;
  token: Address;
  symbol: string;
  decimals: number;
  side: "buy" | "sell";
  /** Tokens in (buy) or out (sell), as a decimal string. */
  amount: string;
  /** `amount` as a number, for arithmetic. */
  value: number;
  /** A buy that opened the position: the wallet held none before it. */
  opens: boolean;
  /** The wallet's balance of the token now, when it could be read. */
  balance?: number;
  tx: string;
  block: number;
  /** Estimated time, ms since epoch. */
  at: number;
}

export interface TokenPrice {
  usd: number;
  liquidityUsd?: number;
  symbol?: string;
  pair?: string;
  dex?: string;
}

export interface ChainKit {
  network: Pick<NetworkProfile, "name" | "title" | "chainId" | "nativeSymbol" | "explorerUrl">;
  client: PublicClient;
  head(): Promise<bigint>;
  /** The block about `hours` ago, from the chain's measured block rate. */
  blockHoursAgo(hours: number): Promise<bigint>;
  /** ERC20 transfers into or out of any of `wallets`; ranges are split and paced for the RPC. */
  transfers(
    wallets: string[],
    opts?: { dir?: "in" | "out" | "both"; hours?: number; fromBlock?: bigint; toBlock?: bigint },
  ): Promise<KitTransfer[]>;
  /**
   * What the wallets DID: one buy or sell per wallet, transaction and token,
   * for transactions the wallet itself signed — airdrops and spam are not
   * trades. Oldest first; at most the 60 newest transactions per wallet.
   */
  trades(wallets: string[], opts?: { hours?: number; fromBlock?: bigint }): Promise<KitTrade[]>;
  /** Symbol, decimals and name per lowercase token address. */
  tokens(addresses: string[]): Promise<Record<string, TokenMeta>>;
  /** balanceOf per `${token}:${wallet}` (lowercase). */
  balances(pairs: { token: string; wallet: string }[]): Promise<Record<string, bigint>>;
  /** Native balance per lowercase wallet. */
  nativeBalances(wallets: string[]): Promise<Record<string, bigint>>;
  /** The lowercase addresses among `addresses` that are contracts (an EIP-7702 wallet is not). */
  contracts(addresses: string[]): Promise<string[]>;
  /** Who signed a transaction. */
  txSender(hash: string): Promise<string | undefined>;
  /** Explorer links, when the network has an explorer. */
  link: { address(a: string): string | undefined; tx(h: string): string | undefined };
}

export interface SkillKit {
  /** Returns the reader at once; awaiting it is harmless. */
  chain(network?: string): ChainKit;
  prices(tokens: string[], network?: string): Promise<Record<string, TokenPrice>>;
  wallets(input: string | string[] | { file?: string; addresses?: string[] }): Promise<WalletEntry[]>;
  tool(name: string, params?: Record<string, unknown>): Promise<ActionResult>;
  store: {
    get<T = unknown>(key: string, fallback?: T): Promise<T>;
    set(key: string, value: unknown): Promise<void>;
  };
  http: {
    json<T = unknown>(url: string, init?: RequestInit): Promise<T>;
    text(url: string, init?: RequestInit): Promise<string>;
  };
  save(name: string, content: string): Promise<string>;
  viem: typeof viem;
}

/**
 * Tools a skill may not call: anything that moves funds, and anything that
 * changes Lain herself. A skill reads and reports; acting stays a step the
 * operator sees in conversation.
 */
const FORBIDDEN_TOOL_RE =
  /^(send_|buy_|sell_|swap|transfer|add_liquidity|remove_liquidity|speculate_|launch_|create_wallet|trader$|create_skill|edit_skill|remove_skill|revert_skill|schedule_skill|stop_routine|learn_skill|build_wish|set_setting|switch_network|set_chat_provider|set_task_route|set_forge_provider|install_agent_skill|remove_agent_skill)/;
/** Arguments that turn a two-step spending tool into a signature. */
export const UNSAFE_PARAM_RE = /^(execute|confirm|confirmation|confirm_phrase)$/i;

/** Most transactions per wallet whose signer is looked up in one trades() call. */
const MAX_SENDER_LOOKUPS = 60;
const SENDER_CONCURRENCY = 6;
/** Least time between two signer lookups: a public RPC answers a burst with 429 for a minute. */
const SENDER_GAP_MS = 40;
/** A lookup the RPC throttles is retried this many times, backing off. */
const SENDER_RETRIES = 6;
/** Above this share of signer lookups failing, trades() fails instead of under-counting. */
const MAX_LOOKUP_LOSS = 0.05;
const HTTP_TIMEOUT_MS = 20_000;
const USER_AGENT = "Mozilla/5.0 (compatible; LainOS skill; +https://lain-os.com)";

/** DexScreener's chain ids, by EVM chain id. Anything else falls back to the profile name. */
const DEXSCREENER_CHAINS: Record<number, string> = {
  1: "ethereum",
  10: "optimism",
  56: "bsc",
  137: "polygon",
  324: "zksync",
  8453: "base",
  42161: "arbitrum",
  43114: "avalanche",
  59144: "linea",
  81457: "blast",
  534352: "scroll",
  4663: "robinhood",
};

export function dexscreenerChain(profile: Pick<NetworkProfile, "chainId" | "name">): string {
  return DEXSCREENER_CHAINS[profile.chainId] ?? profile.name;
}

/** Blocks this far behind the head are settled: their logs are cached between runs. */
const SETTLED_BLOCKS = 2_000n;
/** Log windows fetched at once (each is itself paced and split by the wallet source). */
const WINDOW_CONCURRENCY = 2;
const MAX_CACHED_TRANSFERS = 150_000;
const MAX_CACHED_SENDERS = 200_000;
/** The cache is written at most this often, and only when it changed. */
const CACHE_FLUSH_MS = 5_000;

/**
 * What the chain already said and will never say differently: Transfer logs
 * of settled block windows, and who signed a transaction. Shared by every
 * skill run in the process, so a re-run after an edit, or a routine every few
 * minutes, reads only what is new — a public RPC answers a full two-day scan
 * of thirty wallets twice in a row with a Cloudflare wall.
 */
const windowCache = new Map<string, Transfer[]>();
let cachedTransfers = 0;
const senderCache = new Map<string, string>();

function rememberWindow(key: string, transfers: Transfer[]): void {
  windowCache.set(key, transfers);
  cachedTransfers += transfers.length;
  for (const [k, v] of windowCache) {
    if (cachedTransfers <= MAX_CACHED_TRANSFERS) break;
    windowCache.delete(k);
    cachedTransfers -= v.length;
  }
  scheduleFlush();
}

function rememberSender(key: string, from: string): void {
  senderCache.set(key, from);
  if (senderCache.size > MAX_CACHED_SENDERS) senderCache.delete(senderCache.keys().next().value!);
  scheduleFlush();
}

/**
 * The same cache on disk (`data/kit-cache.json`), so a restarted daemon or a
 * new TUI session starts warm: a cold two-day scan is two thousand requests,
 * which is exactly what a public RPC answers with a Cloudflare wall.
 */
let cacheFile: string | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

type StoredTransfer = { token: string; from: string; to: string; value: string; tx: string; block: string };

function useDiskCache(file: string): void {
  if (cacheFile) return;
  cacheFile = file;
  try {
    const stored = JSON.parse(readFileSync(file, "utf8")) as {
      windows?: [string, StoredTransfer[]][];
      senders?: [string, string][];
    };
    for (const [key, list] of stored.windows ?? []) {
      const transfers = list.map((t) => ({ ...t, value: BigInt(t.value), block: BigInt(t.block) }) as Transfer);
      windowCache.set(key, transfers);
      cachedTransfers += transfers.length;
    }
    for (const [key, from] of stored.senders ?? []) senderCache.set(key, from);
  } catch {
    // No cache yet, or an unreadable one: start cold.
  }
}

function scheduleFlush(): void {
  if (!cacheFile || flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushCache();
  }, CACHE_FLUSH_MS);
  flushTimer.unref?.();
}

/** Write the cache now (tests; a caller about to exit). */
export async function flushCache(): Promise<void> {
  if (!cacheFile) return;
  const windows = [...windowCache].map(([key, list]) => [
    key,
    list.map((t) => ({ token: t.token, from: t.from, to: t.to, value: t.value.toString(), tx: t.tx, block: t.block.toString() })),
  ]);
  try {
    await mkdir(dirname(cacheFile), { recursive: true });
    const tmp = `${cacheFile}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ windows, senders: [...senderCache] }), "utf8");
    await rename(tmp, cacheFile);
  } catch {
    // A cache that cannot be written only costs the next run some requests.
  }
}

/** Blocks per hour, measured once per endpoint — chains differ by 100×. */
const blockRates = new Map<string, { perHour: number; at: number }>();

async function blocksPerHour(profile: NetworkProfile, client: PublicClient): Promise<number> {
  const key = `${profile.chainId}:${profile.rpcUrl}`;
  const cached = blockRates.get(key);
  if (cached && Date.now() - cached.at < 3_600_000) return cached.perHour;
  const head = await client.getBlock();
  const probe = head.number > 100_000n ? head.number - 100_000n : 0n;
  const back = await client.getBlock({ blockNumber: probe });
  const secs = Number(head.timestamp - back.timestamp);
  const perHour = secs > 0 ? Math.max(1e-3, (Number(head.number - back.number) * 3_600) / secs) : 3_600;
  blockRates.set(key, { perHour, at: Date.now() });
  return perHour;
}

/** Read a failed HTTP answer for what it is: a bot wall is not "invalid JSON". */
export function httpProblem(url: string, status: number, contentType: string, body: string): string | null {
  const html = /text\/html/i.test(contentType) || /^\s*<(!doctype|html)/i.test(body);
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();
  if (html && /just a moment|cf-chl|cloudflare|attention required/i.test(body)) {
    return `${host} answered with a Cloudflare challenge page (HTTP ${status}), not data — it blocks servers; read the chain over RPC (kit.chain) instead`;
  }
  if (status >= 400) return `${host} answered HTTP ${status}: ${body.replace(/\s+/g, " ").slice(0, 200)}`;
  if (html) return `${host} answered with an HTML page (HTTP ${status}) instead of data`;
  return null;
}

async function fetchText(url: string, init: RequestInit = {}): Promise<{ status: number; type: string; body: string }> {
  const res = await fetch(url, {
    ...init,
    headers: { "user-agent": USER_AGENT, accept: "application/json, text/plain, */*", ...(init.headers ?? {}) },
    signal: init.signal ?? AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  return { status: res.status, type: res.headers.get("content-type") ?? "", body: await res.text() };
}

export const kitHttp: SkillKit["http"] = {
  async text(url, init) {
    const r = await fetchText(url, init);
    const problem = httpProblem(url, r.status, r.type, r.body);
    if (problem && r.status >= 400) throw new Error(problem);
    return r.body;
  },
  async json(url, init) {
    const r = await fetchText(url, init);
    const problem = httpProblem(url, r.status, r.type, r.body);
    if (problem) throw new Error(problem);
    try {
      return JSON.parse(r.body);
    } catch {
      throw new Error(`${url} did not answer JSON: ${r.body.replace(/\s+/g, " ").slice(0, 160)}`);
    }
  },
};

/** USD price per lowercase token address: the deepest DexScreener pair where the token is the base. */
export async function dexscreenerPrices(
  chain: string,
  tokens: string[],
  http: Pick<SkillKit["http"], "json"> = kitHttp,
): Promise<Record<string, TokenPrice>> {
  const wanted = [...new Set(tokens.map((t) => t.toLowerCase()).filter((t) => /^0x[0-9a-f]{40}$/.test(t)))];
  const out: Record<string, TokenPrice> = {};
  for (let i = 0; i < wanted.length; i += 30) {
    const batch = wanted.slice(i, i + 30);
    const pairs = await http.json<DexPair[] | { pairs?: DexPair[] }>(
      `https://api.dexscreener.com/tokens/v1/${encodeURIComponent(chain)}/${batch.join(",")}`,
    );
    const list = Array.isArray(pairs) ? pairs : (pairs.pairs ?? []);
    for (const p of list) {
      const base = p.baseToken?.address?.toLowerCase();
      const usd = Number(p.priceUsd);
      if (!base || !batch.includes(base) || !Number.isFinite(usd) || usd <= 0) continue;
      const liquidityUsd = Number(p.liquidity?.usd ?? 0) || undefined;
      const prev = out[base];
      if (prev && (prev.liquidityUsd ?? 0) >= (liquidityUsd ?? 0)) continue;
      out[base] = { usd, liquidityUsd, symbol: p.baseToken?.symbol, pair: p.pairAddress, dex: p.dexId };
    }
  }
  return out;
}

interface DexPair {
  baseToken?: { address?: string; symbol?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  pairAddress?: string;
  dexId?: string;
}

/** Synchronous on purpose: `kit.chain()` must work with and without `await`. */
function resolveProfile(runtime: IAgentRuntime, network?: string): NetworkProfile {
  if (network && network.trim()) {
    const found = matchNetwork(listNetworksSync(runtime), network);
    if (!found) throw new Error(`unknown network "${network}" (list_networks shows the known ones)`);
    return found;
  }
  const active = currentProfile(runtime);
  if (!active) throw new Error("no chain is configured; name a network, e.g. kit.chain('robinhood')");
  return active;
}

const lower = (a: string) => a.toLowerCase();

function asAddresses(list: string[]): Address[] {
  const out: Address[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const a = String(raw).trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(a) || seen.has(lower(a))) continue;
    seen.add(lower(a));
    out.push(a as Address);
  }
  return out;
}

/** The chain half of the kit, for one network profile. */
export function chainKit(profile: NetworkProfile, client: PublicClient = networkClient(profile)): ChainKit {
  const source = rpcWalletSource(profile, client);
  const base = profile.explorerUrl?.replace(/\/+$/, "");
  const senders = new Map<string, Promise<string | undefined>>();
  const pace = pacer(SENDER_GAP_MS);
  const lookups = { done: 0, failed: 0, lastError: "" };

  /**
   * Who signed `hash`. A throttled lookup waits and asks again; one that still
   * fails is counted, not cached, and not mistaken for "somebody else signed".
   */
  const lookup = async (hash: string): Promise<string | undefined> => {
    for (let attempt = 0; ; attempt++) {
      await pace();
      try {
        return (await client.getTransaction({ hash: hash as `0x${string}` })).from;
      } catch (err) {
        if (isRateLimit(err) && attempt < SENDER_RETRIES) {
          await new Promise((r) => setTimeout(r, 1_000 * 2 ** Math.min(attempt, 4) + Math.random() * 400));
          continue;
        }
        throw err;
      }
    }
  };
  const txSender = (hash: string) => {
    const key = lower(hash);
    const known = senderCache.get(`${profile.chainId}|${key}`);
    if (known) return Promise.resolve(known);
    let p = senders.get(key);
    if (!p) {
      p = lookup(hash).then(
        (from) => {
          lookups.done += 1;
          if (from) rememberSender(`${profile.chainId}|${key}`, from);
          return from;
        },
        (err) => {
          lookups.done += 1;
          lookups.failed += 1;
          lookups.lastError = rpcErrorText(err);
          senders.delete(key);
          return undefined;
        },
      );
      senders.set(key, p);
    }
    return p;
  };

  /** [from, to] and a block → time estimate, for an hours look-back or explicit blocks. */
  const window = async (opts: { hours?: number; fromBlock?: bigint; toBlock?: bigint }) => {
    const head = await client.getBlockNumber();
    const perHour = await blocksPerHour(profile, client);
    const to = opts.toBlock !== undefined ? BigInt(opts.toBlock) : head;
    let from: bigint;
    if (opts.fromBlock !== undefined) from = BigInt(opts.fromBlock);
    else {
      const span = BigInt(Math.ceil(Math.max(0.01, opts.hours ?? 24) * perHour));
      from = to > span ? to - span : 0n;
    }
    const now = Date.now();
    const timeOf = (block: bigint) => Math.round(now - (Number(head - block) / perHour) * 3_600_000);
    return { from, to, timeOf, head };
  };

  const kit: ChainKit = {
    network: {
      name: profile.name,
      title: profile.title,
      chainId: profile.chainId,
      nativeSymbol: profile.nativeSymbol,
      explorerUrl: profile.explorerUrl,
    },
    client,
    head: () => client.getBlockNumber(),
    async blockHoursAgo(hours) {
      return (await window({ hours })).from;
    },
    async transfers(wallets, opts = {}) {
      const list = asAddresses(wallets);
      if (!list.length) return [];
      const { from, to, timeOf, head } = await window(opts);
      const dirs: ("in" | "out")[] = opts.dir === "in" ? ["in"] : opts.dir === "out" ? ["out"] : ["in", "out"];
      // Windows on fixed boundaries, so the next run over the same wallets
      // finds the settled ones cached and reads only the newest blocks.
      const span = BigInt(profile.maxLogSpan ?? 10_000);
      const settled = head - SETTLED_BLOCKS;
      const group = createHash("sha1").update(list.map(lower).sort().join(",")).digest("hex").slice(0, 16);
      const jobs: { dir: "in" | "out"; a: bigint; b: bigint; key?: string }[] = [];
      for (const dir of dirs) {
        for (let a = (from / span) * span; a <= to; a += span) {
          const end = a + span - 1n;
          const b = end > to ? to : end;
          const closed = b === end && end <= settled;
          jobs.push({ dir, a, b, key: closed ? `${profile.chainId}|${profile.rpcUrl}|${group}|${dir}|${a}` : undefined });
        }
      }
      const pieces: Transfer[][] = new Array(jobs.length);
      let next = 0;
      const worker = async () => {
        while (next < jobs.length) {
          const i = next++;
          const job = jobs[i];
          const hit = job.key ? windowCache.get(job.key) : undefined;
          if (hit) {
            pieces[i] = hit;
            continue;
          }
          const got = await source.transfers(list, job.dir, job.a, job.b);
          if (job.key) rememberWindow(job.key, got);
          pieces[i] = got;
        }
      };
      await Promise.all(Array.from({ length: Math.min(WINDOW_CONCURRENCY, jobs.length) }, worker));
      const seen = new Set<string>();
      const all: KitTransfer[] = [];
      for (const t of pieces.flat()) {
        if (t.block < from || t.block > to) continue;
        // A transfer between two listed wallets is in both scans; keep it once.
        const key = `${t.tx}:${t.token}:${t.from}:${t.to}:${t.value}`.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        all.push({ ...t, at: timeOf(t.block) });
      }
      return all.sort((a, b) => (a.block < b.block ? -1 : a.block > b.block ? 1 : 0));
    },
    async trades(wallets, opts = {}) {
      const list = asAddresses(wallets);
      if (!list.length) return [];
      const { from, to, timeOf } = await window(opts);
      const transfers = await kit.transfers(list, { fromBlock: from, toBlock: to });
      const byWallet = new Map<string, Transfer[]>();
      for (const w of list) byWallet.set(lower(w), []);
      for (const t of transfers) {
        if (lower(t.from) === lower(t.to)) continue;
        byWallet.get(lower(t.to))?.push(t);
        byWallet.get(lower(t.from))?.push(t);
      }
      const wrapped = profile.dexWrappedNative?.trim().toLowerCase();
      // Net flow per position over the whole window, to find each balance before it.
      const allNet = new Map<string, bigint>();
      for (const [wallet, ts] of byWallet) {
        for (const t of ts) {
          const pk = pairKey(t.token, wallet);
          allNet.set(pk, (allNet.get(pk) ?? 0n) + (lower(t.to) === wallet ? t.value : -t.value));
        }
      }

      // Who signed each transaction: only the wallet's own count. Newest first,
      // so a busy bot's cap keeps the most recent ones.
      const before = { ...lookups };
      const own = new Map<string, Set<string>>();
      const queue = [...byWallet].map(([w, ts]) => ({ wallet: w, ts: capByTx(ts, MAX_SENDER_LOOKUPS) }));
      let next = 0;
      const worker = async () => {
        while (next < queue.length) {
          const { wallet, ts } = queue[next++];
          const mine = new Set<string>();
          for (const hash of new Set(ts.map((t) => lower(t.tx)))) {
            const signer = await txSender(hash);
            if (signer && lower(signer) === wallet) mine.add(hash);
          }
          own.set(wallet, mine);
          byWallet.set(wallet, ts);
        }
      };
      await Promise.all(Array.from({ length: Math.min(SENDER_CONCURRENCY, queue.length) }, worker));
      const done = lookups.done - before.done;
      const failed = lookups.failed - before.failed;
      if (failed > 0 && failed / Math.max(1, done) > MAX_LOOKUP_LOSS) {
        throw new Error(
          `could not tell who signed ${failed} of ${done} transactions (${lookups.lastError}) — ` +
            `counting them would under-report trades; try again in a minute or with fewer wallets/hours`,
        );
      }

      // One trade per wallet, transaction and token: what came in minus what went out.
      type Net = { wallet: string; token: string; tx: string; block: bigint; net: bigint };
      const nets = new Map<string, Net>();
      for (const [wallet, ts] of byWallet) {
        for (const t of ts) {
          if (wrapped && lower(t.token) === wrapped) continue;
          const sign = lower(t.to) === wallet ? 1n : -1n;
          if (!own.get(wallet)?.has(lower(t.tx))) continue; // airdrops, spam, somebody else's transaction
          const key = `${wallet}:${lower(t.tx)}:${lower(t.token)}`;
          const n = nets.get(key) ?? { wallet, token: lower(t.token), tx: t.tx, block: t.block, net: 0n };
          n.net += sign * t.value;
          nets.set(key, n);
        }
      }
      const moved = [...nets.values()].filter((n) => n.net !== 0n);
      const pairs = [...new Set(moved.map((n) => pairKey(n.token, n.wallet)))].map((k) => {
        const [token, wallet] = k.split(":");
        return { token: token as Address, wallet: wallet as Address };
      });
      const [balances, meta] = await Promise.all([
        source.tokenBalances(pairs),
        source.tokenMeta([...new Set(pairs.map((p) => p.token))]),
      ]);

      // Walk each position forward from its balance before the window to see which buy opened it.
      const running = new Map<string, bigint>();
      const out: KitTrade[] = [];
      for (const n of moved.sort((a, b) => (a.block < b.block ? -1 : a.block > b.block ? 1 : 0))) {
        const pk = pairKey(n.token, n.wallet);
        const now = balances.get(pk);
        const start = running.has(pk) ? running.get(pk)! : now !== undefined ? now - (allNet.get(pk) ?? 0n) : undefined;
        const m = meta.get(n.token);
        const decimals = m?.decimals ?? 18;
        const amount = n.net < 0n ? -n.net : n.net;
        out.push({
          wallet: list.find((a) => lower(a) === n.wallet)!,
          token: n.token as Address,
          symbol: m?.symbol ?? "?",
          decimals,
          side: n.net > 0n ? "buy" : "sell",
          amount: formatUnits(amount, decimals),
          value: Number(formatUnits(amount, decimals)),
          opens: n.net > 0n && start !== undefined && start <= 0n,
          balance: now !== undefined ? Number(formatUnits(now, decimals)) : undefined,
          tx: n.tx,
          block: Number(n.block),
          at: timeOf(n.block),
        });
        if (start !== undefined) running.set(pk, start + n.net);
      }
      return out;
    },
    async tokens(addresses) {
      return Object.fromEntries(await source.tokenMeta(asAddresses(addresses)));
    },
    async balances(pairs) {
      const clean = pairs
        .filter((p) => /^0x[0-9a-fA-F]{40}$/.test(p.token) && /^0x[0-9a-fA-F]{40}$/.test(p.wallet))
        .map((p) => ({ token: p.token as Address, wallet: p.wallet as Address }));
      return Object.fromEntries(await source.tokenBalances(clean));
    },
    async nativeBalances(wallets) {
      return Object.fromEntries(await source.nativeBalances(asAddresses(wallets)));
    },
    async contracts(addresses) {
      return [...(await source.contracts(asAddresses(addresses)))];
    },
    txSender,
    link: {
      address: (a) => (base ? `${base}/address/${a}` : undefined),
      tx: (h) => (base ? `${base}/tx/${h}` : undefined),
    },
  };
  return kit;
}

/** Keep the transfers of the newest `max` transactions. */
function capByTx(ts: Transfer[], max: number): Transfer[] {
  const hashes = [...new Set([...ts].sort((a, b) => (a.block > b.block ? -1 : 1)).map((t) => lower(t.tx)))];
  if (hashes.length <= max) return ts;
  const keep = new Set(hashes.slice(0, max));
  return ts.filter((t) => keep.has(lower(t.tx)));
}

/** One JSON file per skill under data/skill-state/. */
function skillStore(dataDir: string, skill: string): SkillKit["store"] {
  const file = join(dataDir, "skill-state", `${skill}.json`);
  let cache: Record<string, unknown> | null = null;
  const load = async () => {
    if (cache) return cache;
    try {
      cache = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    } catch {
      cache = {};
    }
    return cache;
  };
  return {
    async get<T>(key: string, fallback?: T): Promise<T> {
      const all = await load();
      return (key in all ? all[key] : fallback) as T;
    },
    async set(key, value) {
      const all = await load();
      all[key] = value;
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(all, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2), "utf8");
      await rename(tmp, file);
    },
  };
}

/** The kit handed to one skill's handler for one call. */
export function makeKit(runtime: IAgentRuntime, state: State, skill: string): SkillKit {
  const dataDir = runtime.getSetting("LAINOS_DATA_DIR") || "./data";
  useDiskCache(join(dataDir, "kit-cache.json"));
  return {
    // Not async: `const chain = kit.chain()` without await is the natural way to
    // write it, and in a live run a model did exactly that and lost the turn
    // to "chain.trades is not a function".
    chain(network) {
      return chainKit(resolveProfile(runtime, network));
    },
    async prices(tokens, network) {
      const profile = resolveProfile(runtime, network);
      return dexscreenerPrices(dexscreenerChain(profile), tokens);
    },
    async wallets(input) {
      if (typeof input === "string") {
        const path = safePath(input.trim());
        if (path && !/0x[0-9a-fA-F]{40}/.test(input) && input.trim().length < 300) {
          const { wallets, error } = await walletsFromParams({ file: input.trim() });
          if (error) throw new Error(error);
          return wallets;
        }
        return parseWalletList(input);
      }
      const params = Array.isArray(input) ? { addresses: input } : input;
      const { wallets, error } = await walletsFromParams(params as Record<string, unknown>);
      if (error) throw new Error(error);
      return wallets;
    },
    async tool(name, params = {}) {
      const action = runtime.actions.find((a) => a.name === name || a.similes.includes(name));
      if (!action) throw new Error(`no tool named "${name}"`);
      if (action.name === skill) throw new Error(`a skill cannot call itself`);
      if (FORBIDDEN_TOOL_RE.test(action.name)) {
        throw new Error(`"${action.name}" moves funds or changes Lain herself; a skill may only call tools that read`);
      }
      const unsafe = Object.keys(params).find((k) => UNSAFE_PARAM_RE.test(k));
      if (unsafe) throw new Error(`a skill never passes "${unsafe}": signing stays an in-conversation step`);
      return action.handler(runtime, state, params);
    },
    store: skillStore(dataDir, skill),
    http: kitHttp,
    async save(name, content) {
      const clean = name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 80) || "output.txt";
      const path = join(workspaceRoot(), "exports", clean);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf8");
      return path;
    },
    viem,
  };
}

/** Human amount for a raw token value — handy in skill output. */
export function human(raw: bigint, decimals: number, digits = 4): string {
  const n = Number(formatUnits(raw, decimals));
  return n.toLocaleString("en-US", { maximumFractionDigits: n >= 1 ? 2 : digits });
}

/** The reference a model reads before writing a skill (skill_kit). */
export const KIT_REFERENCE = `Skill kit — the 4th handler argument: async handler(runtime, state, params, kit)

kit.chain(network?) → chain reader (returned at once, await optional) for a network name ("robinhood") or the active chain:
  .network {name,title,chainId,nativeSymbol,explorerUrl}   .client (viem PublicClient)   .head()
  .blockHoursAgo(hours) → bigint block about that long ago (measured block rate)
  .transfers(wallets, {dir:'in'|'out'|'both', hours | fromBlock,toBlock}) → [{token,from,to,value:bigint,tx,block:bigint,at:ms}]
      ERC20 Transfer logs for many wallets at once; ranges split/paced for the RPC's limits (never hand-roll eth_getLogs).
  .trades(wallets, {hours | fromBlock}) → [{wallet,token,symbol,decimals,side:'buy'|'sell',amount:string,value:number,opens,balance,tx,block,at:ms}]
      what each wallet DID: one trade per wallet+tx+token, only transactions the wallet signed (airdrops/spam excluded);
      opens = the buy started a position from zero. Oldest first; the 60 newest txs per wallet. USD: value × kit.prices()[token].usd.
  .tokens(addrs) → {addr: {symbol,decimals,name}}   .balances([{token,wallet}]) → {"token:wallet": bigint}
  .nativeBalances(wallets) → {wallet: bigint}   .contracts(addrs) → [lowercase contract addrs; EIP-7702 wallets excluded]
  .txSender(hash)   .link.address(a) / .link.tx(h) → explorer URLs
kit.prices(tokenAddrs, network?) → {lowercase addr: {usd, liquidityUsd, symbol, pair, dex}} (DexScreener; missing = no market)
kit.wallets(input) → [{address,rank,label?}] from an array, pasted text, or a workspace file path (CSV/JSON/one per line)
kit.tool(name, args) → {ok,text,data} of any live tool that only reads (wallets_snapshot, token_info, …). Tools that move funds
  or change Lain are refused, as are execute/confirm args.
kit.store.get(key, fallback) / kit.store.set(key, value) → this skill's own JSON state, kept across runs (seen txs, last result).
kit.http.json(url) / kit.http.text(url) → fetch with timeout; a Cloudflare/HTML wall throws a clear error instead of bad JSON.
kit.save(name, text) → writes workspace/exports/<name>, returns the path (put big tables there, keep the reply short).
kit.viem → the viem module (formatUnits, parseAbi, …) — no import needed.

Return { ok, text, data }: text is the answer for the operator (short; the top of a long list), data holds the key numbers,
and data.fingerprint a stable summary when a routine should report only on change. Numbers in data must not be BigInt.`;
