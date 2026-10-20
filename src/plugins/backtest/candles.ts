/**
 * Historical candles for backtests. Robinhood Chain is too young to test a
 * strategy over years, so history comes from the exchanges: Binance spot
 * klines, and Bitstamp before a pair was listed on Binance (Binance's BTC/USDT
 * starts 2017-08-17; Bitstamp's BTC/USD reaches back to 2011, enough for ten
 * years of bitcoin).
 *
 * Each source, pair and interval is cached under <data>/market and extended
 * at either end as runs ask for more, so a second run over the same years
 * reads no network. Only closed bars are kept — the bar still forming now is
 * left out.
 *
 * Facts, checked 2026-10-17: Binance answers 1000 klines per request, honours
 * startTime/endTime, and says "Invalid symbol" (400) for a pair it lacks.
 * Bitstamp answers 1000 bars from `start` — given `end` as well it ignores
 * `start` and returns the 1000 bars before `end` — and 404s an unknown pair.
 */
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fetch as undiciFetch, ProxyAgent } from "undici";

/** Bar length in minutes, per interval a run may use. */
export const INTERVALS = { "15m": 15, "30m": 30, "1h": 60, "2h": 120, "4h": 240, "6h": 360, "12h": 720, "1d": 1440 } as const;
export type Interval = keyof typeof INTERVALS;
export const intervalMs = (interval: Interval): number => INTERVALS[interval] * 60_000;
export const isInterval = (s: string): s is Interval => s in INTERVALS;

/** One bar: open time (ms), open, high, low, close, volume (base units). */
export type Bar = [number, number, number, number, number, number];

/** Where a stretch of the history came from — the report names every stitch. */
export interface Stretch {
  source: "binance" | "bitstamp" | "dex";
  pair: string;
  from: number;
  to: number;
}

/** A run's history as columns, oldest first. */
export interface Series {
  pair: string;
  interval: Interval;
  t: Float64Array;
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
  volume: Float64Array;
  stretches: Stretch[];
  /** What the history lacks and why, for the report (Bitstamp unreachable, a market it does not have). */
  notes: string[];
}

const QUOTES = ["FDUSD", "USDT", "USDC", "BTC", "ETH", "BNB", "EUR", "TRY"];

/** "btc", "BTC/USDT", "eth-btc" → base, quote and Binance's symbol (USDT when no quote is named). */
export function normalizePair(raw: string): { base: string; quote: string; binance: string } {
  const s = raw.trim().toUpperCase().replace(/[\s/_:-]/g, "");
  for (const q of QUOTES) {
    if (s.endsWith(q) && s.length > q.length) return { base: s.slice(0, -q.length), quote: q, binance: s };
  }
  return { base: s, quote: "USDT", binance: `${s}USDT` };
}

/** Bitstamp's name for the same market — dollar stablecoins become USD — or null if it has no such quote. */
export function bitstampPair(p: { base: string; quote: string }): string | null {
  const quote = ["USDT", "USDC", "FDUSD"].includes(p.quote) ? "usd" : ["BTC", "ETH", "EUR"].includes(p.quote) ? p.quote.toLowerCase() : null;
  return quote ? `${p.base.toLowerCase()}${quote}` : null;
}

class HttpError extends Error {}

async function getJson(url: string, proxy?: string): Promise<unknown> {
  const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
  const host = new URL(url).host;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await undiciFetch(url, {
        headers: { "user-agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(20_000),
        ...(dispatcher ? { dispatcher } : {}),
      });
      const retryable = res.status === 429 || res.status === 418 || res.status >= 500;
      if (retryable && attempt < 4) {
        const after = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      const body = (await res.json().catch(() => null)) as { msg?: string } | null;
      if (!res.ok) throw new HttpError(`${host} ${res.status}${body?.msg ? `: ${body.msg}` : ""}`);
      return body;
    } catch (err) {
      // A host that cannot be reached at all will not be reached on the fifth try either.
      if (err instanceof HttpError || attempt >= 2) throw err;
      await sleep(1000 * 2 ** attempt);
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Source = "binance" | "bitstamp";

/** Up to 1000 bars of one source starting at `from` (ms), none after `to`. */
async function page(source: Source, pair: string, interval: Interval, from: number, to: number, proxy?: string): Promise<Bar[]> {
  if (source === "binance") {
    const rows = (await getJson(
      `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${interval}&startTime=${from}&endTime=${to}&limit=1000`,
      proxy,
    )) as (string | number)[][];
    return rows.map((r) => [Number(r[0]), Number(r[1]), Number(r[2]), Number(r[3]), Number(r[4]), Number(r[5])]);
  }
  const body = (await getJson(
    `https://www.bitstamp.net/api/v2/ohlc/${pair}/?step=${INTERVALS[interval] * 60}&limit=1000&start=${Math.floor(from / 1000)}`,
    proxy,
  )) as { data?: { ohlc?: Record<string, string>[] } };
  return (body.data?.ohlc ?? [])
    .map((r): Bar => [Number(r.timestamp) * 1000, Number(r.open), Number(r.high), Number(r.low), Number(r.close), Number(r.volume)])
    .filter((b) => b[0] >= from && b[0] <= to);
}

/** Every bar in [from, to], a few pages at a time; pages never overlap, gaps just come back short. */
async function fetchRange(source: Source, pair: string, interval: Interval, from: number, to: number, proxy?: string): Promise<Bar[]> {
  const span = intervalMs(interval) * 1000;
  const starts: number[] = [];
  for (let s = from; s <= to; s += span) starts.push(s);
  const out: Bar[] = [];
  for (let i = 0; i < starts.length; i += 4) {
    const pages = await Promise.all(starts.slice(i, i + 4).map((s) => page(source, pair, interval, s, Math.min(s + span - 1, to), proxy)));
    for (const p of pages) out.push(...p);
  }
  return out;
}

interface CacheFile {
  /** The first bar the source has for this pair, once a request has reached back past it. */
  listedAt?: number;
  bars: Bar[];
}

/**
 * Bars of one source in [from, to], from the cache and whatever it lacks at
 * either end. A pair the source does not list throws.
 */
async function cachedBars(source: Source, pair: string, interval: Interval, from: number, to: number, dataDir: string, proxy?: string): Promise<Bar[]> {
  const file = join(dataDir, "market", source, `${pair}-${interval}.json`);
  let cache: CacheFile = { bars: [] };
  try {
    cache = JSON.parse(await readFile(file, "utf8")) as CacheFile;
  } catch {
    // Nothing cached yet.
  }
  const step = intervalMs(interval);
  const now = Date.now();
  const first = cache.bars[0]?.[0];
  const last = cache.bars.at(-1)?.[0];
  let changed = false;

  if (first === undefined || from < first - step) {
    // Binance says where a pair's history starts in one request — cheaper than paging through years of nothing.
    if (cache.listedAt === undefined && source === "binance") {
      const head = await page(source, pair, interval, 0, now);
      if (!head.length) throw new Error(`Binance has no ${interval} history for ${pair}`);
      cache.listedAt = head[0]![0];
      changed = true;
    }
    const lo = Math.max(from, cache.listedAt ?? from);
    const hi = first === undefined ? to : first - step;
    if (lo <= hi) {
      const got = await fetchRange(source, pair, interval, lo, hi, proxy);
      // Nothing back from the very start: the source's history begins later — remember where.
      if (source === "bitstamp" && (!got.length || got[0]![0] > lo + step)) cache.listedAt = got[0]?.[0] ?? first ?? hi;
      cache.bars = [...got, ...cache.bars];
      changed = true;
    }
  }
  const tail = cache.bars.at(-1)?.[0] ?? last;
  if (tail !== undefined && tail + 2 * step <= Math.min(to, now)) {
    cache.bars.push(...(await fetchRange(source, pair, interval, tail + step, to, proxy)));
    changed = true;
  }

  if (changed) {
    const seen = new Set<number>();
    cache.bars = cache.bars
      .filter((b) => b[0] + step <= now && b.every(Number.isFinite) && !seen.has(b[0]) && seen.add(b[0]))
      .sort((a, b) => a[0] - b[0]);
    await mkdir(join(dataDir, "market", source), { recursive: true });
    await writeFile(file, JSON.stringify(cache), "utf8");
  }
  return cache.bars.filter((b) => b[0] >= from && b[0] <= to);
}

/**
 * A pair's history over [from, to]: Binance, with Bitstamp filling in the
 * years before Binance listed the pair when Bitstamp has the same market.
 */
export async function loadSeries(opts: {
  pair: string;
  interval: Interval;
  from: number;
  to: number;
  dataDir: string;
  proxy?: string;
}): Promise<Series> {
  const p = normalizePair(opts.pair);
  const step = intervalMs(opts.interval);
  const main = await cachedBars("binance", p.binance, opts.interval, opts.from, opts.to, opts.dataDir, opts.proxy).catch((err: Error) => {
    if (/Invalid symbol/i.test(err.message)) throw new Error(`Binance has no ${p.binance} pair`);
    throw err;
  });
  const stretches: Stretch[] = [];
  const notes: string[] = [];
  let bars = main;
  const listed = main[0]?.[0] ?? opts.to;
  const early = bitstampPair(p);
  if (early && opts.from < listed - step) {
    try {
      const before = await cachedBars("bitstamp", early, opts.interval, opts.from, listed - step, opts.dataDir, opts.proxy);
      if (before.length) {
        stretches.push({ source: "bitstamp", pair: `${p.base}/${early.slice(p.base.length).toUpperCase()}`, from: before[0]![0], to: before.at(-1)![0] });
        bars = [...before, ...main];
      }
    } catch (err) {
      const why = err instanceof HttpError && / 404/.test(err.message) ? `Bitstamp has no ${early} market` : `Bitstamp unreachable (${(err as Error).message})`;
      notes.push(`${why} — the history starts at Binance's listing, ${new Date(listed).toISOString().slice(0, 10)}`);
    }
  }
  if (main.length) stretches.push({ source: "binance", pair: `${p.base}/${p.quote}`, from: main[0]![0], to: main.at(-1)![0] });
  if (!bars.length) throw new Error(`no ${p.binance} ${opts.interval} candles in that window`);
  const col = (k: number) => Float64Array.from(bars, (b) => b[k]!);
  return {
    pair: `${p.base}/${p.quote}`,
    interval: opts.interval,
    t: col(0),
    open: col(1),
    high: col(2),
    low: col(3),
    close: col(4),
    volume: col(5),
    stretches,
    notes,
  };
}
