/**
 * On-chain history for backtests: candles rebuilt from every Swap a Uniswap
 * v3 pool on Ethereum ever emitted. Robinhood Chain is too young for years of
 * history; Ethereum's pools reach back to Uniswap v3's launch (2021-05-05).
 *
 * Each Swap event carries the pool's price right after it (sqrtPriceX96), so
 * the price path is exact, not sampled: a bar opens where the last one
 * closed, its high and low are the furthest the pool's price went inside it,
 * and an hour nobody traded is a flat bar at the last price. Swaps are cached
 * per pool under <data>/market/dex as [time, price, base amount], and only
 * blocks past the cached ones are read again, so candles of any interval come
 * from one download.
 *
 * Facts, checked 2026-10-17: the public Tenderly gateway and MEV Blocker
 * answer eth_getLogs over old blocks with blockTimestamp on every log, up to
 * a few hundred thousand blocks per call (Tenderly refuses a million); drpc's
 * free plan stops at 10k blocks, publicnode wants a token for old logs, and
 * GeckoTerminal's free OHLCV ends 180 days back. WBTC/USDC 0.3% emits about
 * 180 swaps per 10k blocks, WETH/USDC 0.3% about 600 — the 0.05% ETH pool, at
 * 6–9k, would be gigabytes, which is why the 0.3% pools are used.
 */
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fetch as undiciFetch, ProxyAgent } from "undici";
import { intervalMs, type Interval, type Series } from "./candles.js";

const T_SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
/** Uniswap v3's factory went live here; no v3 pool is older. */
const V3_FIRST_BLOCK = 12_369_621;
const ETH_RPCS = ["https://gateway.tenderly.co/public/mainnet", "https://rpc.mevblocker.io"];
const WINDOW = 100_000;
const PARALLEL = 4;

interface Token {
  symbol: string;
  address: string;
  decimals: number;
}

/** A pool whose swaps make a pair's on-chain history; base is what is priced, quote what it is priced in. */
export interface DexMarket {
  pool: string;
  base: Token;
  quote: Token;
  /** The base token is the pool's token0. */
  baseIs0: boolean;
  /** "WBTC/USDC 0.3%" — what the report names. */
  label: string;
  /** No swap before this block. */
  fromBlock: number;
}

const USDC: Token = { symbol: "USDC", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", decimals: 6 };
const WBTC: Token = { symbol: "WBTC", address: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", decimals: 8 };
const WETH: Token = { symbol: "WETH", address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", decimals: 18 };

/** The pairs whose on-chain history is known without asking: bitcoin and ether against dollars. */
export const DEX_MARKETS: Record<string, DexMarket> = {
  BTC: { pool: "0x99ac8ca7087fa4a2a1fb6357269965a2014abc35", base: WBTC, quote: USDC, baseIs0: true, label: "Uniswap v3 WBTC/USDC 0.3%", fromBlock: V3_FIRST_BLOCK },
  ETH: { pool: "0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8", base: WETH, quote: USDC, baseIs0: false, label: "Uniswap v3 WETH/USDC 0.3%", fromBlock: V3_FIRST_BLOCK },
};
const ALIASES: Record<string, string> = { WBTC: "BTC", XBT: "BTC", WETH: "ETH" };

/** The known market for a coin (BTC, ETH and their wrapped names), if there is one. */
export function knownDexMarket(base: string): DexMarket | undefined {
  const b = base.toUpperCase();
  return DEX_MARKETS[ALIASES[b] ?? b];
}

class Rpc {
  private next = 0;
  private readonly dispatcher?: ProxyAgent;
  constructor(
    private readonly urls: string[],
    proxy?: string,
  ) {
    this.dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
  }

  /** One call, trying each endpoint in turn; a JSON-RPC error comes back as thrown text. */
  async call<T>(method: string, params: unknown[]): Promise<T> {
    let last: Error = new Error("no Ethereum RPC configured");
    for (let attempt = 0; attempt < this.urls.length * 2; attempt++) {
      const url = this.urls[(this.next + attempt) % this.urls.length]!;
      try {
        const res = await undiciFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(45_000),
          ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
        });
        const body = (await res.json().catch(() => null)) as { result?: T; error?: { message?: string } } | null;
        if (body && "result" in body && body.result !== undefined) {
          this.next = (this.next + attempt) % this.urls.length;
          return body.result;
        }
        last = new Error(`${new URL(url).host}: ${body?.error?.message ?? `HTTP ${res.status}`}`);
      } catch (err) {
        last = new Error(`${new URL(url).host}: ${(err as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
    throw last;
  }
}

interface RawLog {
  blockNumber: string;
  blockTimestamp?: string;
  data: string;
}

/** A swap as the cache keeps it: unix seconds, the base token's price in the quote after it, base amount traded. */
type Tick = [number, number, number];

interface TickFile {
  pool: string;
  /** Every block up to this one has been read. */
  scannedTo: number;
  ticks: Tick[];
}

const Q96 = 2 ** 96;
const TWO255 = 2n ** 255n;
const TWO256 = 2n ** 256n;
const word = (data: string, i: number) => BigInt(`0x${data.slice(2 + 64 * i, 66 + 64 * i)}`);
const signed = (v: bigint) => (v >= TWO255 ? v - TWO256 : v);

function decode(log: RawLog, m: DexMarket, ts: number): Tick {
  const sqrt = Number(word(log.data, 2)) / Q96;
  const dec0 = m.baseIs0 ? m.base.decimals : m.quote.decimals;
  const dec1 = m.baseIs0 ? m.quote.decimals : m.base.decimals;
  const oneIn0 = sqrt * sqrt * 10 ** (dec0 - dec1);
  const amount = signed(word(log.data, m.baseIs0 ? 0 : 1));
  const qty = Number(amount < 0n ? -amount : amount) / 10 ** m.base.decimals;
  return [ts, +(m.baseIs0 ? oneIn0 : 1 / oneIn0).toPrecision(8), +qty.toPrecision(6)];
}

/** Every swap of the pool in [from, to]; a window the endpoint will not serve is halved until it does. */
async function windowTicks(rpc: Rpc, m: DexMarket, from: number, to: number): Promise<Tick[]> {
  let logs: RawLog[];
  try {
    logs = await rpc.call<RawLog[]>("eth_getLogs", [{ address: m.pool, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, topics: [T_SWAP] }]);
  } catch (err) {
    if (to - from < 2_000) throw err;
    const mid = Math.floor((from + to) / 2);
    return [...(await windowTicks(rpc, m, from, mid)), ...(await windowTicks(rpc, m, mid + 1, to))];
  }
  if (!logs.length) return [];
  // Most endpoints stamp each log with its block's time; for one that does not, time is drawn
  // between the window's two ends (12-second slots keep that within minutes).
  let clock: (block: number) => number = () => 0;
  if (logs.some((l) => !l.blockTimestamp)) {
    const [a, b] = await Promise.all(
      [from, to].map((n) => rpc.call<{ timestamp: string }>("eth_getBlockByNumber", [`0x${n.toString(16)}`, false]).then((h) => Number(BigInt(h.timestamp)))),
    );
    clock = (n) => Math.round(a! + ((b! - a!) * (n - from)) / Math.max(1, to - from));
  }
  return logs.map((l) => decode(l, m, l.blockTimestamp ? Number(BigInt(l.blockTimestamp)) : clock(Number(BigInt(l.blockNumber)))));
}

/** The pool's swaps from the cache, extended to the chain's head first. */
async function poolTicks(m: DexMarket, dataDir: string, rpc: Rpc, onProgress?: (text: string) => void): Promise<Tick[]> {
  const file = join(dataDir, "market", "dex", `ethereum-${m.pool}.json`);
  let cache: TickFile = { pool: m.pool, scannedTo: m.fromBlock - 1, ticks: [] };
  try {
    const got = JSON.parse(await readFile(file, "utf8")) as TickFile;
    if (got.pool === m.pool) cache = got;
  } catch {
    // Nothing cached yet.
  }
  // A few blocks short of the head: a reorg must not leave a swap in the cache that never happened.
  const head = Number(BigInt(await rpc.call<string>("eth_blockNumber", []))) - 12;
  const save = async () => {
    await mkdir(join(dataDir, "market", "dex"), { recursive: true });
    await writeFile(file, JSON.stringify(cache), "utf8");
  };
  const total = head - cache.scannedTo;
  let since = 0;
  while (cache.scannedTo < head) {
    const starts: number[] = [];
    for (let s = cache.scannedTo + 1; s <= head && starts.length < PARALLEL; s += WINDOW) starts.push(s);
    const parts = await Promise.all(starts.map((s) => windowTicks(rpc, m, s, Math.min(s + WINDOW - 1, head))));
    for (const p of parts) cache.ticks.push(...p);
    cache.scannedTo = Math.min(starts.at(-1)! + WINDOW - 1, head);
    since += starts.length;
    if (since >= 20) {
      since = 0;
      await save();
      onProgress?.(`${m.label}: ${Math.round((100 * (total - (head - cache.scannedTo))) / Math.max(1, total))}% of the chain read, ${cache.ticks.length.toLocaleString("en-US")} swaps`);
    }
  }
  if (total > 0) await save();
  return cache.ticks;
}

/** Candles of `interval` over [from, to] from a pool's swaps; only closed bars. */
export function candlesFromTicks(ticks: Tick[], interval: Interval, from: number, to: number): { t: number[]; o: number[]; h: number[]; l: number[]; c: number[]; v: number[] } {
  const step = intervalMs(interval);
  const out = { t: [] as number[], o: [] as number[], h: [] as number[], l: [] as number[], c: [] as number[], v: [] as number[] };
  if (!ticks.length) return out;
  const end = Math.min(to, Date.now() - step);
  let i = 0;
  let last = NaN;
  // The price as it stood when the window opened: the last swap before it.
  const first = Math.floor(Math.max(from, ticks[0]![0] * 1000) / step) * step;
  while (i < ticks.length && ticks[i]![0] * 1000 < first) last = ticks[i++]![1];
  for (let t = first; t <= end; t += step) {
    let o = last;
    let h = last;
    let l = last;
    let v = 0;
    while (i < ticks.length && ticks[i]![0] * 1000 < t + step) {
      const [, px, qty] = ticks[i++]!;
      if (Number.isNaN(o)) o = h = l = px;
      h = Math.max(h, px);
      l = Math.min(l, px);
      last = px;
      v += qty;
    }
    if (Number.isNaN(last)) continue;
    out.t.push(t);
    out.o.push(o);
    out.h.push(h);
    out.l.push(l);
    out.c.push(last);
    out.v.push(v);
  }
  return out;
}

/** A pair's on-chain history over [from, to], as the engine reads any other history. */
export async function loadDexSeries(opts: {
  market: DexMarket;
  interval: Interval;
  from: number;
  to: number;
  dataDir: string;
  proxy?: string;
  rpcUrls?: string[];
  onProgress?: (text: string) => void;
}): Promise<Series> {
  const m = opts.market;
  const rpc = new Rpc(opts.rpcUrls?.length ? opts.rpcUrls : ETH_RPCS, opts.proxy);
  const ticks = await poolTicks(m, opts.dataDir, rpc, opts.onProgress);
  const c = candlesFromTicks(ticks, opts.interval, opts.from, opts.to);
  if (!c.t.length) throw new Error(`no swaps in ${m.label} in that window`);
  return {
    pair: `${m.base.symbol}/${m.quote.symbol}`,
    interval: opts.interval,
    t: Float64Array.from(c.t),
    open: Float64Array.from(c.o),
    high: Float64Array.from(c.h),
    low: Float64Array.from(c.l),
    close: Float64Array.from(c.c),
    volume: Float64Array.from(c.v),
    stretches: [{ source: "dex", pair: `${m.label} on Ethereum`, from: c.t[0]!, to: c.t.at(-1)! }],
    notes: [],
  };
}

const ERC20 = { symbol: "0x95d89b41", decimals: "0x313ce567" };
const POOL = { token0: "0x0dfe1681", token1: "0xd21220a7", fee: "0xddca3f43" };
const STABLES = new Set(["USDC", "USDT", "DAI", "USDS", "PYUSD", "FRAX", "USDE"]);

/**
 * Any Uniswap v3 pool on Ethereum, by address: its tokens read from the chain,
 * the dollar side (or WETH) as the quote, the other priced.
 */
export async function dexMarketFromPool(address: string, opts: { proxy?: string; rpcUrls?: string[] } = {}): Promise<DexMarket> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`"${address}" is not a pool address`);
  const pool = address.toLowerCase();
  const rpc = new Rpc(opts.rpcUrls?.length ? opts.rpcUrls : ETH_RPCS, opts.proxy);
  const read = (to: string, data: string) => rpc.call<string>("eth_call", [{ to, data }, "latest"]);
  const addr = (hex: string) => `0x${hex.slice(-40)}`.toLowerCase();
  let t0: string;
  let t1: string;
  let fee: number;
  try {
    [t0, t1, fee] = await Promise.all([read(pool, POOL.token0).then(addr), read(pool, POOL.token1).then(addr), read(pool, POOL.fee).then((h) => Number(BigInt(h)))]);
  } catch {
    throw new Error(`${address} is not a Uniswap v3 pool on Ethereum`);
  }
  const token = async (a: string): Promise<Token> => {
    const [sym, dec] = await Promise.all([read(a, ERC20.symbol), read(a, ERC20.decimals)]);
    return { address: a, symbol: abiString(sym) || a.slice(0, 8), decimals: Number(BigInt(dec)) };
  };
  const [a, b] = await Promise.all([token(t0), token(t1)]);
  // Price the coin in dollars when one side is a dollar, else in WETH, else token0 in token1.
  const quoteIs1 = STABLES.has(b.symbol.toUpperCase()) || (!STABLES.has(a.symbol.toUpperCase()) && b.symbol.toUpperCase() === "WETH");
  const [base, quote] = quoteIs1 ? [a, b] : [b, a];
  return { pool, base, quote, baseIs0: quoteIs1, label: `Uniswap v3 ${base.symbol}/${quote.symbol} ${fee / 10_000}%`, fromBlock: V3_FIRST_BLOCK };
}

/** A string an eth_call returned: ABI-encoded, or (old tokens) a bytes32. */
function abiString(hex: string): string {
  const body = hex.slice(2);
  try {
    if (body.length >= 128) {
      const len = Number(BigInt(`0x${body.slice(64, 128)}`));
      if (len > 0 && len < 64) return Buffer.from(body.slice(128, 128 + len * 2), "hex").toString("utf8");
    }
    return Buffer.from(body.slice(0, 64), "hex").toString("utf8").replace(/\0+$/, "");
  } catch {
    return "";
  }
}
