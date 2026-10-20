/**
 * The trend rule, as plain arithmetic over closed hourly bars. The backtest
 * and the hourly paper check both call step() bar by bar, so what the
 * backtest shows is exactly what the paper desk does.
 *
 *   - in:  the last `entryBars` closes above the EMA, the last bar's volume
 *          above zero and ≥ volumeMultiple × the median of the `volumeLookback`
 *          bars before it, no stop-loss cooldown running, and the whole cash
 *          no more than maxLiquidityShare of the pool's liquidity;
 *   - out: a close ≤ entry × (1 − stopLoss) (then a cooldown), or the last
 *          `exitBars` closes below the EMA;
 *   - part: once, `partialShare` of the position at a close ≥ entry × (1 + partialProfit).
 *
 * Fills are at the signal bar's close and pay costRate on what they trade.
 * One decision per bar: a bar that exits does not also enter.
 */
import type { TrendPaperConfig } from "./config.js";

const HOUR = 3_600_000;

/** One closed hourly bar. Volume is in the quote coin; liquidity is the pool's, both sides, in the quote coin. */
export interface Bar {
  /** Open time, ms. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  /** Null when unknown — no entry is taken against an unknown pool. */
  liq: number | null;
}

/** One asset's paper book, in its quote coin and its token. */
export interface Book {
  cash: number;
  qty: number;
  entryPx: number;
  partialDone: boolean;
  /** Close time (ms) before which no entry is taken. */
  cooldownUntil: number;
  /** Cash the open position cost, and what it has returned so far (partial exits). */
  cost: number;
  proceeds: number;
  /** Closed round trips, and how many of them returned more than they cost. */
  roundTrips: number;
  wins: number;
}

export type Action = "buy" | "sell_partial" | "sell" | "skip";

/** What one bar did, as the journal keeps it. */
export interface Decision {
  /** The bar's close time, ms. */
  at: number;
  action: Action;
  reason: string;
  price: number;
  ema: number;
  volume: number;
  medianVolume: number;
  liquidity: number | null;
  /** Quote coin in (buy) or out (sells), after costs; tokens out (buy) or in (sells). */
  quote: number;
  tokens: number;
  fee: number;
}

export function newBook(capital: number): Book {
  return { cash: capital, qty: 0, entryPx: 0, partialDone: false, cooldownUntil: 0, cost: 0, proceeds: 0, roundTrips: 0, wins: 0 };
}

/** Exponential moving average seeded with the simple average of the first `period` values; NaN before that. */
export function ema(values: readonly number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let e = 0;
  for (let i = 0; i < period; i++) e += values[i]!;
  e /= period;
  out[period - 1] = e;
  for (let i = period; i < values.length; i++) {
    e = values[i]! * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

export function median(values: readonly number[]): number {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** The first bar index a decision can be taken on: the EMA and the volume yardstick both exist. */
export function firstDecisionBar(cfg: TrendPaperConfig): number {
  return Math.max(cfg.emaPeriod - 1 + Math.max(cfg.entryBars, cfg.exitBars) - 1, cfg.volumeLookback);
}

/**
 * Read bar i (bars oldest first, emas = ema(closes)) against the book, change
 * the book, and say what happened — null when nothing did. `liquidity`
 * overrides the bar's own (the live pool, read at check time).
 */
export function step(book: Book, bars: readonly Bar[], emas: readonly number[], i: number, cfg: TrendPaperConfig, liquidity?: number | null): Decision | null {
  if (i < firstDecisionBar(cfg)) return null;
  const bar = bars[i]!;
  const at = bar.t + HOUR;
  const px = bar.c;
  const e = emas[i]!;
  const window = bars.slice(i - cfg.volumeLookback, i).map((b) => b.v);
  const med = median(window);
  const liq = liquidity === undefined ? bar.liq : liquidity;
  const base = { at, price: px, ema: e, volume: bar.v, medianVolume: med, liquidity: liq };
  const run = (n: number, above: boolean) => {
    for (let k = i - n + 1; k <= i; k++) if (above ? !(bars[k]!.c > emas[k]!) : !(bars[k]!.c < emas[k]!)) return false;
    return true;
  };

  if (book.qty > 0) {
    const stopPx = book.entryPx * (1 - cfg.stopLoss);
    if (px <= stopPx) {
      const d = sell(book, px, book.qty, cfg, { ...base, action: "sell", reason: `stop-loss: close ${fmt(px)} ≤ entry ${fmt(book.entryPx)} × ${round(1 - cfg.stopLoss)}` });
      book.cooldownUntil = at + cfg.cooldownHours * HOUR;
      return d;
    }
    if (run(cfg.exitBars, false)) {
      return sell(book, px, book.qty, cfg, { ...base, action: "sell", reason: `trend exit: ${cfg.exitBars} closes in a row below EMA${cfg.emaPeriod}` });
    }
    if (!book.partialDone && px >= book.entryPx * (1 + cfg.partialProfit)) {
      book.partialDone = true;
      return sell(book, px, book.qty * cfg.partialShare, cfg, {
        ...base,
        action: "sell_partial",
        reason: `take profit: close ${fmt(px)} ≥ entry ${fmt(book.entryPx)} × ${round(1 + cfg.partialProfit)}, selling ${round(cfg.partialShare * 100)}%`,
      });
    }
    return null;
  }

  if (!(book.cash > 0) || at < book.cooldownUntil) return null;
  if (!run(cfg.entryBars, true)) return null;
  if (!(bar.v > 0) || !(bar.v >= cfg.volumeMultiple * med)) return null;
  const signal = `${cfg.entryBars} closes above EMA${cfg.emaPeriod}, volume ${fmt(bar.v)} ≥ ${cfg.volumeMultiple} × median ${fmt(med)}`;
  if (liq === null || !(liq > 0)) {
    return { ...base, action: "skip", reason: `${signal}, but the pool's liquidity is unknown`, quote: 0, tokens: 0, fee: 0 };
  }
  if (book.cash > cfg.maxLiquidityShare * liq) {
    return { ...base, action: "skip", reason: `${signal}, but ${fmt(book.cash)} is more than ${round(cfg.maxLiquidityShare * 100)}% of the pool's ${fmt(liq)} liquidity`, quote: 0, tokens: 0, fee: 0 };
  }
  const spend = book.cash;
  const fee = spend * cfg.costRate;
  const tokens = (spend - fee) / px;
  Object.assign(book, { cash: 0, qty: tokens, entryPx: px, partialDone: false, cost: spend, proceeds: 0 });
  return { ...base, action: "buy", reason: signal, quote: spend, tokens, fee };
}

function sell(book: Book, px: number, qty: number, cfg: TrendPaperConfig, d: Omit<Decision, "quote" | "tokens" | "fee">): Decision {
  const gross = qty * px;
  const fee = gross * cfg.costRate;
  const out = gross - fee;
  book.cash += out;
  book.qty -= qty;
  book.proceeds += out;
  if (d.action === "sell") {
    book.qty = 0;
    book.roundTrips += 1;
    if (book.proceeds > book.cost) book.wins += 1;
    Object.assign(book, { entryPx: 0, partialDone: false, cost: 0, proceeds: 0 });
  }
  return { ...d, quote: out, tokens: qty, fee };
}

/** The book's value at a price, in the quote coin (tokens marked at the price, before exit costs). */
export function equity(book: Book, px: number): number {
  return book.cash + book.qty * px;
}

/** Worst fall from a running peak, as a positive share (0.25 = −25 %). */
export function maxDrawdown(values: readonly number[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const v of values) {
    peak = Math.max(peak, v);
    if (peak > 0) worst = Math.max(worst, 1 - v / peak);
  }
  return worst;
}

export interface Summary {
  start: number;
  end: number;
  capital: number;
  /** Strategy value at the end, in the quote coin. */
  equity: number;
  /** Buying at the start (paying the cost once) and holding. */
  hold: number;
  roundTrips: number;
  wins: number;
  fills: number;
  /** Signals the liquidity filter (or an unknown pool) turned away. */
  skips: number;
  maxDrawdown: number;
  holdMaxDrawdown: number;
  /** Still in the market at the end. */
  open: boolean;
}

/** Run the rule over a whole history from the first bar it can decide on. */
export function backtest(bars: readonly Bar[], cfg: TrendPaperConfig, capital: number): { summary: Summary; decisions: Decision[] } {
  const emas = ema(bars.map((b) => b.c), cfg.emaPeriod);
  const first = firstDecisionBar(cfg);
  if (bars.length <= first) throw new Error(`need more than ${first} hourly bars, have ${bars.length}`);
  const book = newBook(capital);
  const startPx = bars[first]!.c;
  const held = (capital * (1 - cfg.costRate)) / startPx;
  const decisions: Decision[] = [];
  const curve: number[] = [];
  const holdCurve: number[] = [];
  for (let i = first; i < bars.length; i++) {
    const d = step(book, bars, emas, i, cfg);
    if (d) decisions.push(d);
    curve.push(equity(book, bars[i]!.c));
    holdCurve.push(held * bars[i]!.c);
  }
  return {
    decisions,
    summary: {
      start: bars[first]!.t + HOUR,
      end: bars.at(-1)!.t + HOUR,
      capital,
      equity: curve.at(-1)!,
      hold: holdCurve.at(-1)!,
      roundTrips: book.roundTrips,
      wins: book.wins,
      fills: decisions.filter((d) => d.action !== "skip").length,
      skips: decisions.filter((d) => d.action === "skip").length,
      maxDrawdown: maxDrawdown(curve),
      holdMaxDrawdown: maxDrawdown(holdCurve),
      open: book.qty > 0,
    },
  };
}

/** A number for a message: enough significant digits for 1e-8 prices and 0.1 ETH alike. */
export function fmt(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  if (v === 0) return "0";
  return Math.abs(v) >= 1000 ? v.toFixed(0) : Number(v.toPrecision(5)).toString();
}

function round(v: number): string {
  return Number(v.toFixed(4)).toString();
}
