/**
 * Where trend paper reads its two markets. Reads only: every JSON-RPC call
 * goes through rpc(), which refuses any method outside READ_METHODS, and
 * nothing here builds, signs or sends a transaction.
 *
 * LAIN (Robinhood Chain), quoted in ETH — bars rebuilt from the chain itself:
 *   - launch on the PONS v2 bonding curve 0x2dbd…b6ae at block 77,625,110
 *     (2026-10-01 19:27:55 UTC); the curve is constant-product on a virtual
 *     ETH reserve that starts at its phantomQuote (1.68 ETH, read on chain)
 *     against 1e9 tokens (solved from the first fill, and every later fill
 *     replays to within rounding), so its spot price after each
 *     CurveBuy/CurveSell is exact;
 *   - graduation at block 79,742,975 (2026-10-04 07:01:44 UTC) into the
 *     Uniswap v4 pool 0x9103…cf9c (PoolManager 0x8366…0951: Initialize with
 *     currency0 = native ETH, currency1 = LAIN, the PONS hook 0xe5e7…e044);
 *     each v4 Swap carries the price and in-range liquidity right after it.
 *   The public RPC caps eth_getLogs at 10M blocks and 10k logs, stamps logs
 *   with blockTimestamp 0x0 (so block times are read in batches), and answers
 *   429 when pressed. Checked 2026-10-20.
 *
 * CYBER.sol (Solana), quoted in SOL — GeckoTerminal's hourly OHLCV with
 * currency=token, which prices and sizes bars in SOL (checked against the
 * USD series and SOL's price). History: the pump.fun bonding curve
 * 6AeQ…aRa6 from 2026-04-08 08:00 UTC, then the PumpSwap pool Dk19…YtEg
 * (owner program pAMMBay6…, created 2026-04-15 03:05 UTC). The free API
 * refuses a before_timestamp older than 180 days but still returns the 1000
 * bars before it, and skips hours nobody traded. Birdeye's OHLCV wants an
 * API key (401). Live reserves come from the pool's token accounts over
 * Solana RPC. A past bar's liquidity is estimated from its price on the
 * constant product: the pump.fun curve's virtual reserves (30 SOL × 1.073e9
 * tokens) before graduation, the pool's current k after it (its LP was
 * burned at migration, so k moves only by fees).
 *
 * Liquidity is always both sides of the pool in the quote coin: twice the
 * quote reserve that sets the price (in-range virtual for v4, virtual for the
 * curves, real for PumpSwap).
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AssetId } from "./config.js";
import type { Bar } from "./strategy.js";

const HOUR = 3_600_000;

/** fetch, injectable for tests. */
export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<Response>;

export interface MarketEnv {
  fetch: Fetch;
  /** Where the caches live (<data>/trend-paper/market). */
  dir: string;
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
  progress?: (text: string) => void;
}

/** What a feed hands the strategy: closed hourly bars, oldest first and without holes, and the pool now. */
export interface Snapshot {
  bars: Bar[];
  /** The pool's liquidity now, both sides, in the quote coin. */
  liquidity: number;
  notes: string[];
}

export interface Feed {
  asset: AssetId;
  quote: "ETH" | "SOL";
  pool: string;
  label: string;
  read(env: MarketEnv): Promise<Snapshot>;
}

/** The only JSON-RPC methods this module ever sends. All of them read. */
export const READ_METHODS: ReadonlySet<string> = new Set(["eth_blockNumber", "eth_getLogs", "eth_getBlockByNumber", "eth_call", "getTokenAccountsByOwner"]);

const UA = "Mozilla/5.0 (LainOS trend-paper)";
const sleepFor = (env: MarketEnv) => env.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

class RpcError extends Error {}

/** One JSON-RPC call, or a batch of them; retried on 429, 5xx and dropped connections. */
export async function rpc<T>(env: MarketEnv, url: string, calls: { method: string; params: unknown[] }[]): Promise<T[]> {
  for (const c of calls) {
    if (!READ_METHODS.has(c.method)) throw new Error(`${c.method} is not a read; trend-paper only reads`);
  }
  const body = calls.map((c, i) => ({ jsonrpc: "2.0", id: i, method: c.method, params: c.params }));
  const sleep = sleepFor(env);
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await env.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": UA },
        body: JSON.stringify(calls.length === 1 ? body[0] : body),
        signal: AbortSignal.timeout(45_000),
      });
    } catch (err) {
      if (attempt >= 5) throw new Error(`${new URL(url).host}: ${(err as Error).message}`);
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    const json = (await res.json().catch(() => null)) as unknown;
    const replies = (Array.isArray(json) ? json : [json]) as { id?: number; result?: T; error?: { code?: number; message?: string } }[];
    const limited = res.status === 429 || res.status >= 500 || replies.some((r) => r?.error?.code === 429);
    if (limited && attempt < 10) {
      await sleep(Math.min(30_000, 1500 * 2 ** attempt));
      continue;
    }
    if (!res.ok && !Array.isArray(json)) throw new RpcError(`${new URL(url).host}: HTTP ${res.status}`);
    const byId = new Map(replies.map((r) => [r?.id ?? 0, r]));
    return calls.map((c, i) => {
      const r = byId.get(i);
      if (!r || r.error || r.result === undefined) throw new RpcError(`${c.method}: ${r?.error?.message ?? "no result"}`);
      return r.result;
    });
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(value), "utf8");
  await rename(`${file}.tmp`, file);
}

/** A trade as the caches keep it: unix seconds, price after it, quote traded, pool liquidity after it. */
export type Tick = [number, number, number, number];

/**
 * Hourly bars from trades: a bar opens where the last one closed, an hour
 * without trades is flat at the last price with zero volume, and only bars
 * that have closed by `now` are returned.
 */
export function barsFromTicks(ticks: readonly Tick[], now: number): Bar[] {
  const bars: Bar[] = [];
  if (!ticks.length) return bars;
  let i = 0;
  let last = ticks[0]![1];
  let liq = ticks[0]![3];
  for (let t = Math.floor((ticks[0]![0] * 1000) / HOUR) * HOUR; t + HOUR <= now; t += HOUR) {
    let [o, h, l, v] = [last, last, last, 0];
    while (i < ticks.length && ticks[i]![0] * 1000 < t + HOUR) {
      const [, px, qty, after] = ticks[i++]!;
      h = Math.max(h, px);
      l = Math.min(l, px);
      last = px;
      liq = after;
      v += qty;
    }
    bars.push({ t, o, h, l, c: last, v, liq });
  }
  return bars;
}

// ---------------------------------------------------------------- LAIN

export const LAIN = {
  rpc: "https://rpc.mainnet.chain.robinhood.com",
  token: "0x2b79a071a75dd40f1aca68146d7978204efd156a",
  curve: "0x2dbd6dead1bac5e3e3910a7d4d844bb4b6c1b6ae",
  poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
  stateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
  poolId: "0x9103c042ae23fbcc5141b202dee6d9016d57b649bdc6e9c2a5764b0ad9f2cf9c",
  launchBlock: 77_625_110,
  graduationBlock: 79_742_975,
  /** The curve's virtual ETH at launch (phantomQuote) and the tokens it held. */
  phantomEth: 1.68,
  curveTokens: 1e9,
} as const;

const T_CURVE_BUY = "0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455";
const T_CURVE_SELL = "0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df";
const T_V4_SWAP = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
const SEL_GET_SLOT0 = "0xc815641c";
const SEL_GET_LIQUIDITY = "0xfa6793d5";
/** Blocks short of the head a scan stops at, so a reorg cannot leave a swap that never happened. */
const HEAD_MARGIN = 20;
const POOL_WINDOW = 2_000_000;
const BATCH = 25;
const Q96 = 2 ** 96;
const WAD = 1e18;

interface RawLog {
  blockNumber: string;
  logIndex?: string;
  topics: string[];
  data: string;
}

const word = (data: string, i: number) => BigInt(`0x${data.slice(2 + 64 * i, 66 + 64 * i) || "0"}`);
const int256 = (v: bigint) => (v >= 2n ** 255n ? v - 2n ** 256n : v);
const abs = (v: bigint) => (v < 0n ? -v : v);
const hex = (n: number) => `0x${n.toString(16)}`;

/** Price (ETH per LAIN) and liquidity (ETH, both sides) of the v4 pool at a sqrtPriceX96 and in-range L. */
export function v4State(sqrtPriceX96: bigint, liquidity: bigint): { px: number; liq: number } {
  const s = Number(sqrtPriceX96) / Q96;
  return { px: 1 / (s * s), liq: (2 * Number(liquidity)) / s / WAD };
}

interface LainCache {
  version: 1;
  scannedTo: number;
  ticks: Tick[];
}

/** Logs over [from, to]; a window the endpoint refuses is halved until it serves. */
async function logs(env: MarketEnv, filter: { address: string; topics: (string | string[])[] }, from: number, to: number): Promise<RawLog[]> {
  try {
    const [got] = await rpc<RawLog[]>(env, LAIN.rpc, [{ method: "eth_getLogs", params: [{ ...filter, fromBlock: hex(from), toBlock: hex(to) }] }]);
    return got!;
  } catch (err) {
    if (!(err instanceof RpcError) || to - from < 1_000) throw err;
    const mid = Math.floor((from + to) / 2);
    return [...(await logs(env, filter, from, mid)), ...(await logs(env, filter, mid + 1, to))];
  }
}

/** Unix seconds of each block, in small paced batches (the endpoint counts every header in a batch). */
async function blockTimes(env: MarketEnv, blocks: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const todo = [...new Set(blocks)];
  for (let i = 0; i < todo.length; i += BATCH) {
    const part = todo.slice(i, i + BATCH);
    const heads = await rpc<{ timestamp: string }>(env, LAIN.rpc, part.map((b) => ({ method: "eth_getBlockByNumber", params: [hex(b), false] })));
    part.forEach((b, k) => out.set(b, Number(BigInt(heads[k]!.timestamp))));
    if (todo.length > 4 * BATCH) {
      if ((i / BATCH) % 20 === 19) env.progress?.(`LAIN: block times ${Math.min(i + BATCH, todo.length)}/${todo.length}`);
      await sleepFor(env)(250);
    }
  }
  return out;
}

/** The curve's fills replayed into ticks: spot price, ETH traded and 2 × the virtual ETH reserve after each. */
export function curveTicks(fills: RawLog[], times: Map<number, number>): Tick[] {
  let v = LAIN.phantomEth;
  let tokens = LAIN.curveTokens;
  const ticks: Tick[] = [];
  for (const log of fills) {
    const buy = log.topics[0] === T_CURVE_BUY;
    const [a, b, fee, tax] = [0, 1, 2, 3].map((k) => Number(word(log.data, k)) / WAD) as [number, number, number, number];
    if (buy) {
      v += a - fee - tax;
      tokens -= b;
    } else {
      v -= b + fee + tax;
      tokens += a;
    }
    ticks.push([times.get(Number(BigInt(log.blockNumber)))!, v / tokens, buy ? a : b + fee + tax, 2 * v]);
  }
  return ticks;
}

/** v4 Swap logs into ticks: price and liquidity right after each, ETH traded. */
export function poolTicks(swaps: RawLog[], times: Map<number, number>): Tick[] {
  return swaps.map((log) => {
    const { px, liq } = v4State(word(log.data, 2), word(log.data, 3));
    const eth = Number(abs(int256(word(log.data, 0)))) / WAD;
    return [times.get(Number(BigInt(log.blockNumber)))!, px, eth, liq];
  });
}

async function lainTicks(env: MarketEnv): Promise<Tick[]> {
  const file = join(env.dir, "lain-ticks.json");
  const cache = (await readJson<LainCache>(file)) ?? { version: 1, scannedTo: 0, ticks: [] };
  const [headHex] = await rpc<string>(env, LAIN.rpc, [{ method: "eth_blockNumber", params: [] }]);
  const head = Number(BigInt(headHex!)) - HEAD_MARGIN;
  if (cache.scannedTo >= head) return cache.ticks;

  const fresh: RawLog[] = [];
  let curve: RawLog[] = [];
  if (cache.scannedTo < LAIN.graduationBlock) {
    env.progress?.("LAIN: reading the PONS curve from launch to graduation");
    curve = await logs(env, { address: LAIN.curve, topics: [[T_CURVE_BUY, T_CURVE_SELL]] }, LAIN.launchBlock, LAIN.graduationBlock);
  }
  for (let from = Math.max(cache.scannedTo + 1, LAIN.graduationBlock); from <= head; from += POOL_WINDOW) {
    const to = Math.min(from + POOL_WINDOW - 1, head);
    fresh.push(...(await logs(env, { address: LAIN.poolManager, topics: [T_V4_SWAP, LAIN.poolId] }, from, to)));
    if (head - LAIN.graduationBlock > 4 * POOL_WINDOW) env.progress?.(`LAIN: v4 swaps read to block ${to.toLocaleString("en-US")} (${fresh.length})`);
  }
  const times = await blockTimes(env, [...curve, ...fresh].map((l) => Number(BigInt(l.blockNumber))));
  const order = (a: RawLog, b: RawLog) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(BigInt(a.logIndex ?? "0x0") - BigInt(b.logIndex ?? "0x0"));
  cache.ticks.push(...curveTicks(curve.sort(order), times), ...poolTicks(fresh.sort(order), times));
  cache.scannedTo = head;
  await writeJson(file, cache);
  return cache.ticks;
}

/** The v4 pool's liquidity now, read from StateView. */
async function lainLiquidity(env: MarketEnv): Promise<number> {
  const id = LAIN.poolId.slice(2);
  const [slot0, liquidity] = await rpc<string>(env, LAIN.rpc, [
    { method: "eth_call", params: [{ to: LAIN.stateView, data: `${SEL_GET_SLOT0}${id}` }, "latest"] },
    { method: "eth_call", params: [{ to: LAIN.stateView, data: `${SEL_GET_LIQUIDITY}${id}` }, "latest"] },
  ]);
  const sqrt = word(slot0!, 0);
  if (sqrt === 0n) throw new Error("LAIN: the v4 pool reads as uninitialised");
  return v4State(sqrt, word(liquidity!, 0)).liq;
}

export const lainFeed: Feed = {
  asset: "LAIN",
  quote: "ETH",
  pool: LAIN.poolId,
  label: "LAIN/ETH · Uniswap v4 on Robinhood Chain (PONS curve before 2026-10-04)",
  async read(env) {
    const [ticks, liquidity] = [await lainTicks(env), await lainLiquidity(env)];
    return { bars: barsFromTicks(ticks, env.now()), liquidity, notes: [] };
  },
};

// ---------------------------------------------------------------- CYBER

export const CYBER = {
  mint: "E67WWiQY4s9SZbCyFVTh2CEjorEYbhuVJQUZb3Mbpump",
  ammPool: "Dk19ZrUAJLW2e6Ra1qkaZk1pwb48y5cwQu6xfcFXYtEg",
  curvePool: "6AeQXNHZ8oGsyCujkeYNmcgxiuCBJtpVr3MbWRWoaRa6",
  /** The hour the PumpSwap pool was created in (2026-04-15 03:05:27 UTC). */
  ammStart: Date.UTC(2026, 3, 15, 3),
  wsol: "So11111111111111111111111111111111111111112",
  solanaRpc: "https://api.mainnet-beta.solana.com",
  geckoterminal: "https://api.geckoterminal.com/api/v2/networks/solana/pools",
  /** pump.fun's curve: 30 SOL of virtual reserve against 1.073e9 tokens. */
  pumpK: 30 * 1_073_000_000,
} as const;

/** GeckoTerminal refuses a before_timestamp further back than this. */
const GT_MAX_BACK = 179 * 86_400_000;

/** [open ms, o, h, l, c, volume in SOL] */
type Ohlcv = [number, number, number, number, number, number];

interface CyberCache {
  version: 1;
  /** Full history downloaded once; later reads only refresh the tail. */
  complete: boolean;
  amm: Ohlcv[];
  curve: Ohlcv[];
  notes: string[];
}

async function gtPage(env: MarketEnv, pool: string, before: number, limit: number): Promise<Ohlcv[]> {
  const url = `${CYBER.geckoterminal}/${pool}/ohlcv/hour?aggregate=1&limit=${limit}&currency=token&before_timestamp=${Math.floor(before / 1000)}`;
  const sleep = sleepFor(env);
  for (let attempt = 0; ; attempt++) {
    const res = await env.fetch(url, { headers: { accept: "application/json", "user-agent": UA }, signal: AbortSignal.timeout(30_000) });
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await sleep(15_000 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`GeckoTerminal ${pool.slice(0, 6)}…: HTTP ${res.status}`);
    const json = (await res.json()) as { data?: { attributes?: { ohlcv_list?: number[][] } } };
    return (json.data?.attributes?.ohlcv_list ?? []).map((r) => [r[0]! * 1000, r[1]!, r[2]!, r[3]!, r[4]!, r[5]!] as Ohlcv);
  }
}

/** One row per hour (the API repeats the forming bar), only closed hours, oldest first. */
function tidy(rows: Ohlcv[], now: number): Ohlcv[] {
  const byHour = new Map<number, Ohlcv>();
  for (const r of rows) {
    if (r[0] + HOUR > now || !r.every(Number.isFinite)) continue;
    const seen = byHour.get(r[0]);
    if (!seen || r[5] > seen[5]) byHour.set(r[0], r);
  }
  return [...byHour.values()].sort((a, b) => a[0] - b[0]);
}

/** A pool's bars back to `stop` (or as far as the free API reaches), newest pages first. */
async function gtHistory(env: MarketEnv, pool: string, stop: number, notes: string[]): Promise<Ohlcv[]> {
  const now = env.now();
  const floor = now - GT_MAX_BACK;
  const rows: Ohlcv[] = [];
  let before = now;
  for (;;) {
    const page = await gtPage(env, pool, before, 1000);
    const older = page.filter((r) => r[0] < before);
    rows.push(...page);
    if (!older.length) break;
    const oldest = Math.min(...older.map((r) => r[0]));
    if (oldest <= stop) break;
    if (before === floor) {
      notes.push(`CYBER history before ${new Date(oldest).toISOString().slice(0, 16)} UTC is out of reach of GeckoTerminal's free API`);
      break;
    }
    before = Math.max(oldest, floor);
    env.progress?.(`CYBER: ${pool.slice(0, 6)}… read back to ${new Date(oldest).toISOString().slice(0, 10)}`);
  }
  return tidy(rows, now);
}

async function cyberHistory(env: MarketEnv): Promise<CyberCache> {
  const file = join(env.dir, "cyber-ohlcv.json");
  const now = env.now();
  let cache = await readJson<CyberCache>(file);
  if (!cache?.complete) {
    const notes: string[] = [];
    env.progress?.("CYBER: reading the PumpSwap pool's history");
    const amm = await gtHistory(env, CYBER.ammPool, CYBER.ammStart, notes);
    env.progress?.("CYBER: reading the pump.fun curve's history");
    const curve = tidy(await gtPage(env, CYBER.curvePool, Math.max(CYBER.ammStart + 2 * HOUR, now - GT_MAX_BACK), 1000), now);
    cache = { version: 1, complete: true, amm, curve, notes };
  } else {
    // The tail is re-read every time: the newest bars may have been revised since.
    const last = cache.amm.at(-1)?.[0] ?? CYBER.ammStart;
    const rows: Ohlcv[] = [];
    let before = now;
    for (let pages = 0; pages < 10; pages++) {
      const page = await gtPage(env, CYBER.ammPool, before, 200);
      rows.push(...page);
      const oldest = Math.min(...page.map((r) => r[0]));
      if (!page.length || oldest <= last || before - oldest < HOUR) break;
      before = oldest;
    }
    const fresh = tidy(rows, now);
    const from = fresh[0]?.[0] ?? Infinity;
    cache.amm = [...cache.amm.filter((r) => r[0] < from), ...fresh];
  }
  await writeJson(file, cache);
  return cache;
}

/**
 * Both pools' bars as one hourly series without holes; the hour the curve
 * handed over to the pool combines both. `k` is the pool's reserve product
 * now, to estimate past liquidity from price.
 */
export function cyberBars(cache: Pick<CyberCache, "amm" | "curve">, k: number | null, now: number): Bar[] {
  const byHour = new Map<number, Ohlcv>();
  for (const r of cache.curve) byHour.set(r[0], [...r]);
  for (const r of cache.amm) {
    const c = byHour.get(r[0]);
    byHour.set(r[0], c ? [r[0], c[1], Math.max(c[2], r[2]), Math.min(c[3], r[3]), r[4], c[5] + r[5]] : [...r]);
  }
  const rows = [...byHour.values()].sort((a, b) => a[0] - b[0]);
  const bars: Bar[] = [];
  let i = 0;
  for (let t = rows[0]?.[0] ?? Infinity; t + HOUR <= now; t += HOUR) {
    const r = rows[i]?.[0] === t ? rows[i++] : null;
    const prev = bars.at(-1);
    if (!r && !prev) continue;
    const [o, h, l, c, v] = r ? [r[1], r[2], r[3], r[4], r[5]] : [prev!.c, prev!.c, prev!.c, prev!.c, 0];
    const product = t < CYBER.ammStart ? CYBER.pumpK : k;
    bars.push({ t, o, h, l, c, v, liq: product ? 2 * Math.sqrt(product * c) : null });
  }
  return bars;
}

/** The PumpSwap pool's reserves now: SOL and CYBER held by its token accounts. */
async function cyberReserves(env: MarketEnv): Promise<{ sol: number; tokens: number }> {
  const amount = async (mint: string) => {
    const [got] = await rpc<{ value: { account: { data: { parsed: { info: { tokenAmount: { uiAmount: number } } } } } }[] }>(env, CYBER.solanaRpc, [
      { method: "getTokenAccountsByOwner", params: [CYBER.ammPool, { mint }, { encoding: "jsonParsed" }] },
    ]);
    return got!.value.reduce((s, a) => s + (a.account.data.parsed.info.tokenAmount.uiAmount ?? 0), 0);
  };
  const sol = await amount(CYBER.wsol);
  const tokens = await amount(CYBER.mint);
  if (!(sol > 0) || !(tokens > 0)) throw new Error("CYBER: the PumpSwap pool's reserves read as empty");
  return { sol, tokens };
}

export const cyberFeed: Feed = {
  asset: "CYBER",
  quote: "SOL",
  pool: CYBER.ammPool,
  label: "CYBER.sol/SOL · PumpSwap on Solana (pump.fun curve before 2026-04-15)",
  async read(env) {
    const reserves = await cyberReserves(env);
    const cache = await cyberHistory(env);
    return {
      bars: cyberBars(cache, reserves.sol * reserves.tokens, env.now()),
      liquidity: 2 * reserves.sol,
      notes: [...cache.notes, "past CYBER liquidity is estimated from price on the constant product"],
    };
  },
};

export const FEEDS: Record<AssetId, Feed> = { LAIN: lainFeed, CYBER: cyberFeed };
