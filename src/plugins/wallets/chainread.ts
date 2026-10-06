/**
 * Reading many wallets at once, over a plain public RPC.
 *
 * An explorer API would answer "what does this address hold" in one call, but
 * explorers rate-limit, change shape, and sometimes sit behind a bot wall the
 * agent cannot pass (Robinhood's Blockscout answers every API call from a
 * server with a Cloudflare challenge). The RPC is the one thing that is always
 * there, so everything here is built from three RPC primitives:
 *
 *   - `eth_getLogs` with the wallets OR-ed into a topic — one query covers a
 *     whole group, and a range the node refuses ("spans too many blocks",
 *     "exceeds limit of 10000 logs") is split in half until it is accepted;
 *   - Multicall3 for balances and token metadata — hundreds of reads per call;
 *   - `eth_getCode`, to tell a wallet from a contract (a pool, a locker).
 *
 * Everything reaches the chain through {@link WalletSource}, so the logic on
 * top (snapshot, the group watch) is testable with a fake.
 */
import { erc20Abi, type Address, type PublicClient } from "viem";
import { networkClient, type NetworkProfile } from "../chain/networks.js";

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface Transfer {
  token: Address;
  from: Address;
  to: Address;
  value: bigint;
  tx: string;
  block: bigint;
}

export interface TokenMeta {
  symbol: string;
  decimals: number;
  name?: string;
}

export interface WalletSource {
  head(): Promise<bigint>;
  /**
   * ERC20 transfers into (`in`) or out of (`out`) any of `wallets` within
   * [from, to]. `onProgress` reports blocks covered so far.
   */
  transfers(
    wallets: Address[],
    dir: "in" | "out",
    from: bigint,
    to: bigint,
    onProgress?: (doneBlocks: bigint, totalBlocks: bigint) => void,
  ): Promise<Transfer[]>;
  /**
   * Which tokens each of `wallets` received within [from, to] — discovery.
   * Aggregated as the logs stream in (a busy wallet receives hundreds of
   * thousands of transfers a week, which must never all sit in memory).
   * A window the node cannot serve even split small is reported to `onGap`
   * and skipped instead of failing the whole scan.
   */
  receivedTokens(
    wallets: Address[],
    from: bigint,
    to: bigint,
    onProgress?: (doneBlocks: bigint, totalBlocks: bigint) => void,
    onGap?: (from: bigint, to: bigint, reason: string) => void,
  ): Promise<Map<string, Set<string>>>;
  /**
   * Lowercase addresses that are contracts. A wallet delegated under EIP-7702
   * has code too (`0xef0100` + the delegate) but is still somebody's wallet,
   * so it is not one.
   */
  contracts(addresses: Address[]): Promise<Set<string>>;
  /** Native balance per lowercase wallet. */
  nativeBalances(wallets: Address[]): Promise<Map<string, bigint>>;
  /** balanceOf per `${token}:${wallet}` (lowercase); a failed read is absent. */
  tokenBalances(pairs: { token: Address; wallet: Address }[]): Promise<Map<string, bigint>>;
  /** Metadata per lowercase token; unreadable fields fall back to "?"/18. */
  tokenMeta(tokens: Address[]): Promise<Map<string, TokenMeta>>;
}

export const pairKey = (token: string, wallet: string) => `${token}:${wallet}`.toLowerCase();

/**
 * Wallets per OR-ed topic list. Public RPCs price a query by its topics:
 * Robinhood's answers 25 wallets × 30k blocks every time and 95 wallets ×
 * 5k blocks with a 429 every few calls.
 */
const TOPIC_GROUP = 25;
/** Parallel getLogs windows in flight. */
const LOG_CONCURRENCY = 2;
/** Least time between two getLogs starts on one endpoint. */
const LOG_GAP_MS = 120;
/** Calls per multicall. */
const MULTICALL_CHUNK = 400;

/** Errors a node gives for "ask for less" — the cue to split the range. */
export function isRateLimit(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.message} ${(err as { details?: string }).details ?? ""}` : String(err);
  return /\b429\b|rate.?limit|too many requests/i.test(msg);
}

export function isRangeError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.message} ${(err as { details?: string }).details ?? ""}` : String(err);
  // A rate limit is not a range problem: splitting would only send more requests.
  if (/\b429\b|rate.?limit|too many requests/i.test(msg)) return false;
  return /exceed|too many|too large|limit|spans|range|10000|response size|query timeout|timed out|-32005/i.test(msg);
}

/** An RPC error as one readable line — viem keeps the node's own words in `details`. */
export function rpcErrorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const e = err as Error & { shortMessage?: string; details?: string };
  const head = e.shortMessage ?? e.message.split("\n")[0];
  return e.details && !head.includes(e.details) ? `${head} — ${e.details}` : head;
}

export interface RangeScanOptions {
  concurrency?: number;
  onProgress?: (doneBlocks: bigint, totalBlocks: bigint) => void;
  /** Called for a window that failed even at the smallest split; without it, the scan throws. */
  onGap?: (from: bigint, to: bigint, reason: string) => void;
}

/** Windows this small are not split further on an unexplained error. */
const MIN_BLIND_SPLIT = 2_000n;

/**
 * Fetch [from, to] in windows of at most `maxSpan` blocks, `concurrency` at a
 * time. A 429 is waited out; a window the node refuses ("too many logs",
 * "spans too many blocks", a timeout, an unexplained failure on a big window)
 * is halved until it is served. Results come back in block order.
 */
export async function rangeScan<T>(
  fetchRange: (from: bigint, to: bigint) => Promise<T[]>,
  from: bigint,
  to: bigint,
  maxSpan: bigint,
  opts: RangeScanOptions = {},
): Promise<T[]> {
  if (to < from) return [];
  const total = to - from + 1n;
  const windows: [bigint, bigint][] = [];
  for (let a = from; a <= to; a += maxSpan) windows.push([a, a + maxSpan - 1n > to ? to : a + maxSpan - 1n]);
  const results: T[][] = new Array(windows.length);
  let done = 0n;

  const fetchSplit = async (a: bigint, b: bigint, attempt = 0): Promise<T[]> => {
    try {
      return await fetchRange(a, b);
    } catch (err) {
      // Throttled: wait it out (1s, 2s, 4s…) and ask again for the same range.
      if (isRateLimit(err) && attempt < 6) {
        await sleep(1_000 * 2 ** attempt + Math.random() * 500);
        return fetchSplit(a, b, attempt + 1);
      }
      const span = b - a + 1n;
      const splittable = a < b && !isRateLimit(err) && (isRangeError(err) || span > MIN_BLIND_SPLIT);
      if (!splittable) {
        if (opts.onGap) {
          opts.onGap(a, b, rpcErrorText(err));
          return [];
        }
        throw new Error(`blocks ${a}–${b}: ${rpcErrorText(err)}`);
      }
      const mid = a + (b - a) / 2n;
      const left = await fetchSplit(a, mid);
      const right = await fetchSplit(mid + 1n, b);
      return [...left, ...right];
    }
  };

  let next = 0;
  const worker = async () => {
    while (next < windows.length) {
      const i = next++;
      const [a, b] = windows[i];
      results[i] = await fetchSplit(a, b);
      done += b - a + 1n;
      opts.onProgress?.(done, total);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? LOG_CONCURRENCY, windows.length) }, worker));
  return results.flat();
}

/** Code that makes an address a contract — not empty, not an EIP-7702 delegation designator. */
export function isContractCode(code: string | undefined): boolean {
  if (!code || code === "0x") return false;
  return !code.toLowerCase().startsWith("0xef0100");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Space out request starts by `gapMs` (a shared clock per source). */
function pacer(gapMs: number): () => Promise<void> {
  let next = 0;
  return async () => {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + gapMs;
    if (at > now) await sleep(at - now);
  };
}

/** Progress over several topic groups scanned one after another, as one bar. */
function groupProgress(
  onProgress: ((done: bigint, total: bigint) => void) | undefined,
  index: number,
  count: number,
): ((done: bigint, total: bigint) => void) | undefined {
  if (!onProgress) return undefined;
  return (done, total) => onProgress(total * BigInt(index) + done, total * BigInt(count));
}

const topicOf = (a: string) => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}` as const;
const addressOfTopic = (t: string) => `0x${t.slice(26)}` as Address;

const MULTICALL3_ABI = [
  {
    type: "function",
    name: "getEthBalance",
    stateMutability: "view",
    inputs: [{ name: "addr", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
] as const;

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** The live chain behind {@link WalletSource}, for one network profile. */
export function rpcWalletSource(profile: NetworkProfile, client: PublicClient = networkClient(profile)): WalletSource {
  const maxSpan = BigInt(profile.maxLogSpan ?? 10_000);
  const multicall3 = profile.multicall3 as Address | undefined;
  const pace = pacer(LOG_GAP_MS);

  type RawLog = { address: string; topics: string[]; data: string; transactionHash: string; blockNumber: string };

  const getLogs = async (a: bigint, b: bigint, topics: unknown[]): Promise<RawLog[]> => {
    await pace();
    return (await client.request({
      method: "eth_getLogs",
      params: [{ fromBlock: `0x${a.toString(16)}`, toBlock: `0x${b.toString(16)}`, topics } as never],
    })) as RawLog[];
  };

  const decodeTransfer = (log: RawLog): Transfer | null => {
    // ERC721 shares the signature with a third indexed topic and no data.
    if (log.topics.length !== 3 || !log.data || log.data === "0x") return null;
    try {
      return {
        token: log.address as Address,
        from: addressOfTopic(log.topics[1]),
        to: addressOfTopic(log.topics[2]),
        value: BigInt(log.data.slice(0, 66)),
        tx: log.transactionHash,
        block: BigInt(log.blockNumber),
      };
    } catch {
      return null;
    }
  };

  return {
    head: () => client.getBlockNumber(),

    async transfers(wallets, dir, from, to, onProgress) {
      const groups = chunks(wallets.map(topicOf), TOPIC_GROUP);
      const out: Transfer[] = [];
      for (const [gi, group] of groups.entries()) {
        const topics = dir === "in" ? [TRANSFER_TOPIC, null, group] : [TRANSFER_TOPIC, group];
        const logs = await rangeScan<RawLog>((a, b) => getLogs(a, b, topics), from, to, maxSpan, {
          onProgress: groupProgress(onProgress, gi, groups.length),
        });
        for (const log of logs) {
          const t = decodeTransfer(log);
          if (t) out.push(t);
        }
      }
      return out;
    },

    async receivedTokens(wallets, from, to, onProgress, onGap) {
      const groups = chunks(wallets.map(topicOf), TOPIC_GROUP);
      const out = new Map<string, Set<string>>();
      for (const [gi, group] of groups.entries()) {
        const topics = [TRANSFER_TOPIC, null, group];
        await rangeScan<never>(
          async (a, b) => {
            // Reduce each window as it lands; keep nothing but the token sets.
            for (const log of await getLogs(a, b, topics)) {
              if (log.topics.length !== 3 || !log.data || log.data === "0x") continue;
              const wallet = addressOfTopic(log.topics[2]).toLowerCase();
              if (!out.has(wallet)) out.set(wallet, new Set());
              out.get(wallet)!.add(log.address.toLowerCase());
            }
            return [];
          },
          from,
          to,
          maxSpan,
          { onProgress: groupProgress(onProgress, gi, groups.length), onGap },
        );
      }
      return out;
    },

    async contracts(addresses) {
      const out = new Set<string>();
      for (const group of chunks(addresses, 50)) {
        const codes = await Promise.all(group.map((address) => client.getCode({ address }).catch(() => undefined)));
        codes.forEach((code, i) => {
          if (isContractCode(code)) out.add(group[i].toLowerCase());
        });
      }
      return out;
    },

    async nativeBalances(wallets) {
      const out = new Map<string, bigint>();
      if (multicall3) {
        for (const group of chunks(wallets, MULTICALL_CHUNK)) {
          const res = await client.multicall({
            allowFailure: true,
            contracts: group.map((w) => ({ address: multicall3, abi: MULTICALL3_ABI, functionName: "getEthBalance", args: [w] }) as const),
          });
          res.forEach((r, i) => {
            if (r.status === "success") out.set(group[i].toLowerCase(), r.result as bigint);
          });
        }
        return out;
      }
      for (const group of chunks(wallets, 50)) {
        const bals = await Promise.all(group.map((address) => client.getBalance({ address }).catch(() => undefined)));
        bals.forEach((b, i) => {
          if (b !== undefined) out.set(group[i].toLowerCase(), b);
        });
      }
      return out;
    },

    async tokenBalances(pairs) {
      const out = new Map<string, bigint>();
      for (const group of chunks(pairs, MULTICALL_CHUNK)) {
        const res = multicall3
          ? await client.multicall({
              allowFailure: true,
              contracts: group.map((p) => ({ address: p.token, abi: erc20Abi, functionName: "balanceOf", args: [p.wallet] }) as const),
            })
          : await Promise.all(
              group.map((p) =>
                client
                  .readContract({ address: p.token, abi: erc20Abi, functionName: "balanceOf", args: [p.wallet] })
                  .then((result) => ({ status: "success" as const, result }))
                  .catch(() => ({ status: "failure" as const, result: undefined })),
              ),
            );
        res.forEach((r, i) => {
          if (r.status === "success") out.set(pairKey(group[i].token, group[i].wallet), r.result as bigint);
        });
      }
      return out;
    },

    async tokenMeta(tokens) {
      const out = new Map<string, TokenMeta>();
      for (const group of chunks(tokens, Math.floor(MULTICALL_CHUNK / 3))) {
        const calls = group.flatMap((t) => [
          { address: t, abi: erc20Abi, functionName: "symbol" } as const,
          { address: t, abi: erc20Abi, functionName: "decimals" } as const,
          { address: t, abi: erc20Abi, functionName: "name" } as const,
        ]);
        const res = multicall3
          ? await client.multicall({ allowFailure: true, contracts: calls })
          : await Promise.all(
              calls.map((c) =>
                client
                  .readContract(c as never)
                  .then((result) => ({ status: "success" as const, result }))
                  .catch(() => ({ status: "failure" as const, result: undefined })),
              ),
            );
        group.forEach((t, i) => {
          const [sym, dec, name] = [res[i * 3], res[i * 3 + 1], res[i * 3 + 2]];
          const decimals = dec?.status === "success" ? Number(dec.result) : 18;
          out.set(t.toLowerCase(), {
            symbol: sym?.status === "success" && typeof sym.result === "string" && sym.result.trim() ? clean(sym.result) : "?",
            decimals: Number.isInteger(decimals) && decimals >= 0 && decimals <= 36 ? decimals : 18,
            ...(name?.status === "success" && typeof name.result === "string" ? { name: clean(name.result) } : {}),
          });
        });
      }
      return out;
    },
  };
}

/** Token names are attacker-chosen text: no control characters, no markup, bounded length. */
function clean(s: string): string {
  return s.replace(/[\u0000-\u001f<>&"]/g, "").trim().slice(0, 32) || "?";
}
