/**
 * The paper desk's five markets and where their hours come from.
 *
 * Each market is one DEX pool — the pool a real order would go through, never
 * an exchange — read through GeckoTerminal's public OHLCV API as hourly bars
 * priced in dollars (currency=usd, the pool's base token).
 *
 * Facts, checked 2026-10-22: GeckoTerminal answers at most 1000 bars a
 * request, newest first, and never more than about 56 days of them (a pool
 * traded a few hours a day comes back with a few hundred); skips the hours
 * nobody traded; refuses a before_timestamp older than 180 days; and allows a
 * few requests a minute from one address.
 * It indexes Robinhood Chain ("robinhood"), so LAIN reads like the rest.
 *
 * Bars on disk are final. An hour is written once it has closed and its
 * indexer has had SETTLE_MS to catch up, with an hour nobody traded filled
 * flat at the last close, and it is never rewritten. Every bar opens where the
 * one before closed, so the price a signal fills at — the next bar's open —
 * is known the moment the signal's bar closes, and a replay over the same
 * bars always books the same fills (book.ts relies on that).
 *
 * Reads only: nothing here builds, signs or sends anything.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Bar, Series } from "../backtest/candles.js";
import type { Costs } from "../backtest/engine.js";

export const HOUR = 3_600_000;
/** How long after an hour closes its bar is taken as final. */
export const SETTLE_MS = 8 * 60_000;
const GT = "https://api.geckoterminal.com/api/v2";
/** GeckoTerminal refuses a before_timestamp further back than 180 days. */
const MAX_BACK_MS = 179 * 86_400_000;
const MAX_PAGES = 8;
const PAGE_GAP_MS = 7_000;
const UA = "Mozilla/5.0 (LainOS paper desk)";

export type MarketId = "LAIN" | "CYBER" | "ETH" | "SOL" | "BTC";
export const MARKET_IDS: readonly MarketId[] = ["LAIN", "CYBER", "ETH", "SOL", "BTC"];

export interface DeskMarket {
  id: MarketId;
  /** What the operator reads: the coin, the chain, the pool. */
  label: string;
  /** GeckoTerminal's network id. */
  network: string;
  pool: string;
  /**
   * Per fill: the pool's fee, and slippage for a fill the size of a sleeve
   * ($20 moves a ~$17k LAIN pool about 0.2%; the majors not at all).
   */
  costs: Costs;
  /**
   * Hours in a row the pool may go without a trade before a missing bar means
   * the indexer stalled rather than nobody trading: then no hour after the
   * last bar it has is written yet.
   */
  quietHours: number;
}

export const MARKETS: Record<MarketId, DeskMarket> = {
  LAIN: {
    id: "LAIN",
    label: "LAIN · Robinhood Chain (PONS, LAIN/WETH)",
    network: "robinhood",
    pool: "0x9103c042ae23fbcc5141b202dee6d9016d57b649bdc6e9c2a5764b0ad9f2cf9c",
    costs: { feePct: 1, slippagePct: 0.25 },
    quietHours: Infinity,
  },
  CYBER: {
    id: "CYBER",
    label: "CYBER.sol · Solana (PumpSwap, CYBER/SOL)",
    network: "solana",
    pool: "Dk19ZrUAJLW2e6Ra1qkaZk1pwb48y5cwQu6xfcFXYtEg",
    costs: { feePct: 0.3, slippagePct: 0.25 },
    quietHours: Infinity,
  },
  ETH: {
    id: "ETH",
    label: "ETH · Ethereum (Uniswap v3, WETH/USDC 0.05%)",
    network: "eth",
    pool: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
    costs: { feePct: 0.05, slippagePct: 0.02 },
    quietHours: 2,
  },
  SOL: {
    id: "SOL",
    label: "SOL · Solana (Orca, SOL/USDC)",
    network: "solana",
    pool: "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE",
    costs: { feePct: 0.04, slippagePct: 0.02 },
    quietHours: 2,
  },
  BTC: {
    id: "BTC",
    label: "BTC · Base (Uniswap v3, cbBTC/USDC 0.05%)",
    network: "base",
    pool: "0xfbb6eed8e7aa03b138556eedaf5d271a5e1e43ef",
    costs: { feePct: 0.05, slippagePct: 0.02 },
    quietHours: 2,
  },
};

export function isMarketId(s: unknown): s is MarketId {
  return typeof s === "string" && (MARKET_IDS as readonly string[]).includes(s);
}

/** fetch, injectable for tests. */
export type Fetch = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

export interface MarketEnv {
  fetch: Fetch;
  /** Where the bar caches live (<data>/desk/market). */
  dir: string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

interface Cache {
  version: 1;
  pool: string;
  /** Final hourly bars, oldest first, one per hour without a hole. */
  bars: Bar[];
}

/** [unix seconds, o, h, l, c, volume usd], newest first. */
type GtBar = [number, number, number, number, number, number];

async function page(env: MarketEnv, m: DeskMarket, before?: number): Promise<GtBar[]> {
  const url =
    `${GT}/networks/${m.network}/pools/${m.pool}/ohlcv/hour?aggregate=1&limit=1000&currency=usd&token=base` +
    (before ? `&before_timestamp=${Math.floor(before / 1000)}` : "");
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await env.fetch(url, { headers: { accept: "application/json", "user-agent": UA }, signal: AbortSignal.timeout(60_000) });
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        await env.sleep(15_000 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new Error(`GeckoTerminal HTTP ${res.status} for ${m.id}`);
      const body = (await res.json()) as { data?: { attributes?: { ohlcv_list?: GtBar[] } } };
      return body.data?.attributes?.ohlcv_list ?? [];
    } catch (err) {
      if ((err as Error).message.startsWith("GeckoTerminal HTTP")) throw err;
      if (attempt >= 3) throw new Error(`GeckoTerminal unreachable: ${(err as Error).message}`);
      await env.sleep(2_000 * 2 ** attempt);
    }
  }
}

async function readCache(file: string): Promise<Cache | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Cache;
  } catch {
    return null;
  }
}

async function writeCache(file: string, cache: Cache): Promise<void> {
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(cache), "utf8");
  await rename(`${file}.tmp`, file);
}

/**
 * The market's final hourly bars: the cache, extended by every hour that has
 * closed and settled since. The first read pages back as far as GeckoTerminal
 * goes (about seven months); later reads fetch one page.
 */
export async function loadBars(m: DeskMarket, env: MarketEnv): Promise<Bar[]> {
  const file = join(env.dir, `${m.id.toLowerCase()}.json`);
  const cached = await readCache(file);
  const cache: Cache = cached && cached.version === 1 && cached.pool === m.pool ? cached : { version: 1, pool: m.pool, bars: [] };
  const last = cache.bars.at(-1)?.[0] ?? null;
  const now = env.now();
  // The newest hour that has closed and settled.
  const lastClosed = Math.floor((now - SETTLE_MS) / HOUR) * HOUR - HOUR;
  if (last !== null && last >= lastClosed) return cache.bars;

  // Page back until the pages reach the last bar on disk (one page, normally), run dry, or go past 180 days.
  const raw = new Map<number, GtBar>();
  let before: number | undefined;
  for (let p = 0; p < MAX_PAGES; p++) {
    // A first download pages hard; GeckoTerminal answers a burst by holding the connection open.
    if (p > 0 || last === null) await env.sleep(PAGE_GAP_MS);
    const got = await page(env, m, before);
    if (!got.length) break;
    for (const b of got) raw.set(b[0] * 1000, b);
    const oldest = Math.min(...got.map((b) => b[0] * 1000));
    if (last !== null && oldest <= last + HOUR) break;
    if (now - oldest > MAX_BACK_MS) break;
    before = oldest;
  }

  const times = [...raw.keys()].filter((t) => t <= lastClosed && (last === null || t > last)).sort((a, b) => a - b);
  // A liquid pool silent for longer than it ever is: the indexer is behind, so wait for it.
  const lastRaw = [...raw.keys()].reduce((a, b) => Math.max(a, b), -Infinity);
  const upTo = lastClosed - lastRaw > m.quietHours * HOUR ? lastRaw : lastClosed;
  let prevClose = cache.bars.at(-1)?.[4] ?? null;
  let t = last !== null ? last + HOUR : (times[0] ?? null);
  if (t === null) return cache.bars;
  const added: Bar[] = [];
  for (; t <= upTo; t += HOUR) {
    const b = raw.get(t);
    if (!b && prevClose === null) continue;
    if (!b) {
      added.push([t, prevClose!, prevClose!, prevClose!, prevClose!, 0]);
      continue;
    }
    const [, o, h, l, c, v] = b;
    const open = prevClose ?? o;
    added.push([t, open, Math.max(h, open, c), Math.min(l, open, c), c, v]);
    prevClose = c;
  }
  if (!added.length) return cache.bars;
  cache.bars.push(...added);
  await writeCache(file, cache);
  return cache.bars;
}

/**
 * Bars as the backtest engine's columns. With `live`, one more bar is added
 * for the hour now running: it opens (and, until it closes, stands) at the
 * last close, which is exactly where its final bar will open — so a signal on
 * the last closed bar fills now, at the price the replay will always give it.
 */
export function toSeries(m: DeskMarket, bars: readonly Bar[], live = false): Series {
  const rows = [...bars];
  const last = rows.at(-1);
  if (live && last) rows.push([last[0] + HOUR, last[4], last[4], last[4], last[4], 0]);
  const col = (k: number) => Float64Array.from(rows, (r) => r[k]!);
  return {
    pair: `${m.id}/USD`,
    interval: "1h",
    t: col(0),
    open: col(1),
    high: col(2),
    low: col(3),
    close: col(4),
    volume: col(5),
    stretches: rows.length ? [{ source: "dex", pair: `${m.id}/USD`, from: rows[0]![0], to: rows.at(-1)![0] }] : [],
    notes: [],
  };
}
