/**
 * The backtest itself: long-only spot strategies run bar by bar over a pair's
 * history, the numbers that say whether they were any good, and the presets
 * worth trying first.
 *
 * How fills are modelled, so a result can be trusted for what it is:
 *   - a rule is read at a bar's close and acts at the next bar's open — a
 *     strategy never trades on a price it could not have seen yet;
 *   - every fill pays the fee; market fills (entries, rule exits, stops) also
 *     pay slippage, while a take-profit is a resting limit and fills at its price;
 *   - stops, trailing stops and take-profits are watched inside each bar
 *     against its high and low, a bar that gaps through one fills at the open,
 *     and when one bar touches both the stop and the take-profit the stop is
 *     taken to have come first;
 *   - the whole account goes in and out: no leverage, no shorting, no funding.
 *
 * The window is split in two: strategies are ranked on the first part only,
 * and the last holdoutPct is reported beside it, never used to choose. A rule
 * tuned until it shines on all ten years tells little; one that still holds
 * up on years it was not picked on tells more.
 */
import { compileRule, type Rule, type SeriesCache } from "./rules.js";
import { intervalMs, loadSeries, type Interval, type Series, type Stretch } from "./candles.js";
import { loadDexSeries, type DexMarket } from "./dex.js";

export interface StrategySpec {
  name: string;
  /** Condition to buy at the next open while out of the market. */
  entry: string;
  /** Condition to sell at the next open while in. */
  exit?: string;
  stopLossPct?: number;
  takeProfitPct?: number;
  /** Sell when price falls this far below its best close since entry. */
  trailPct?: number;
  /** Sell at the next open once a position has been held this many bars. */
  maxBars?: number;
}

/** A strategy as it is asked for: rules may hold {param} slots, filled from `params` — one variant per combination. */
export interface StrategyInput {
  name?: string;
  entry: string;
  exit?: string;
  stopLossPct?: number | string;
  takeProfitPct?: number | string;
  trailPct?: number | string;
  maxBars?: number | string;
  params?: Record<string, number[]>;
}

export interface Costs {
  /** Per fill, percent (Binance spot taker: 0.1). */
  feePct: number;
  /** Per market fill, percent. */
  slippagePct: number;
}

export interface Trade {
  entryAt: number;
  entryPx: number;
  /** null while still open at the end of the window. */
  exitAt: number | null;
  exitPx: number | null;
  /** After fees and slippage. */
  retPct: number;
  bars: number;
  reason: string;
}

export interface Run {
  /** Account value at each bar's close from the window's first bar, starting from 1. */
  equity: Float64Array;
  inMarket: Uint8Array;
  trades: Trade[];
}

export interface Metrics {
  totalPct: number;
  /** null for a window under three months — an annual rate from weeks says nothing. */
  cagrPct: number | null;
  maxDdPct: number;
  sharpe: number;
  /** Closed trades entered in the window. */
  trades: number;
  winPct: number | null;
  avgTradePct: number | null;
  /** Gross gains over gross losses; null with no losing trade. */
  profitFactor: number | null;
  exposurePct: number;
}

export const DEFAULT_COSTS: Costs = { feePct: 0.1, slippagePct: 0.05 };
export const MAX_VARIANTS = 200;

/** Strategies worth trying first: trend, breakout, mean reversion, momentum. Periods are bars. */
export const PRESETS: Record<string, Omit<StrategySpec, "name"> & { about: string }> = {
  trend_200: {
    about: "in above the 200-bar average, out below it",
    entry: "close > sma(close, 200)",
    exit: "close < sma(close, 200)",
  },
  golden_cross: {
    about: "in while the 50-bar average is above the 200-bar one",
    entry: "sma(close, 50) > sma(close, 200)",
    exit: "sma(close, 50) < sma(close, 200)",
  },
  ema_cross: {
    about: "in while ema 12 is above ema 26",
    entry: "ema(close, 12) > ema(close, 26)",
    exit: "ema(close, 12) < ema(close, 26)",
  },
  macd: {
    about: "in while the MACD line is above its signal",
    entry: "macd(close, 12, 26) > macd_signal(close, 12, 26, 9)",
    exit: "macd(close, 12, 26) < macd_signal(close, 12, 26, 9)",
  },
  donchian: {
    about: "turtle breakout: a close above the 20-bar high, out under the 10-bar low",
    entry: "close > highest(high, 20)[1]",
    exit: "close < lowest(low, 10)[1]",
  },
  rsi_dip: {
    about: "buy RSI under 30, sell over 50, 15% stop",
    entry: "rsi(close, 14) < 30",
    exit: "rsi(close, 14) > 50",
    stopLossPct: 15,
  },
  bollinger_dip: {
    about: "buy a close under the lower band, sell back at the average, 15% stop",
    entry: "close < bb_lower(close, 20, 2)",
    exit: "close > sma(close, 20)",
    stopLossPct: 15,
  },
  momentum_trail: {
    about: "up 10% in 30 bars and above the 100-bar average; ride it on a 15% trailing stop",
    entry: "roc(close, 30) > 10 and close > sma(close, 100)",
    trailPct: 15,
  },
};

/** Inputs to runnable strategies: presets by name, rules with {param} slots expanded, every variant named. */
export function expandStrategies(presets: string[], inputs: StrategyInput[]): StrategySpec[] {
  const out: StrategySpec[] = [];
  for (const raw of presets) {
    const name = raw.trim().toLowerCase();
    if (name === "all") {
      for (const [n, p] of Object.entries(PRESETS)) out.push({ name: n, ...strip(p) });
      continue;
    }
    const p = PRESETS[name];
    if (!p) throw new Error(`no preset "${raw}" — ${Object.keys(PRESETS).join(", ")}`);
    out.push({ name, ...strip(p) });
  }
  inputs.forEach((input, idx) => {
    if (!input?.entry) throw new Error(`strategy ${idx + 1} has no entry rule`);
    const base = input.name?.trim() || `rule_${idx + 1}`;
    const keys = Object.keys(input.params ?? {});
    let combos: Record<string, number>[] = [{}];
    for (const k of keys) {
      const values = input.params![k]!;
      if (!Array.isArray(values) || !values.length || !values.every(Number.isFinite)) throw new Error(`${base}: params.${k} must be a list of numbers`);
      combos = combos.flatMap((c) => values.map((v) => ({ ...c, [k]: v })));
      if (out.length + combos.length > MAX_VARIANTS) throw new Error(`more than ${MAX_VARIANTS} variants in one run — narrow the params`);
    }
    for (const combo of combos) {
      const fill = (s: string) =>
        s.replace(/\{(\w+)\}/g, (_, k: string) => {
          if (!(k in combo)) throw new Error(`${base}: {${k}} has no values in params`);
          return String(combo[k]);
        });
      const num = (v: number | string | undefined, field: string): number | undefined => {
        if (v === undefined || v === "") return undefined;
        const n = typeof v === "number" ? v : Number(fill(v));
        if (!Number.isFinite(n) || n < 0) throw new Error(`${base}: ${field} must be a non-negative number`);
        return n || undefined;
      };
      out.push({
        name: keys.length ? `${base} ${keys.map((k) => `${k}=${combo[k]}`).join(",")}` : base,
        entry: fill(input.entry),
        ...(input.exit ? { exit: fill(input.exit) } : {}),
        ...opt("stopLossPct", num(input.stopLossPct, "stopLossPct")),
        ...opt("takeProfitPct", num(input.takeProfitPct, "takeProfitPct")),
        ...opt("trailPct", num(input.trailPct, "trailPct")),
        ...opt("maxBars", num(input.maxBars, "maxBars")),
      });
    }
  });
  if (out.length > MAX_VARIANTS) throw new Error(`more than ${MAX_VARIANTS} variants in one run — narrow the params`);
  return out;
}

const opt = <K extends string>(k: K, v: number | undefined) => (v === undefined ? {} : ({ [k]: v } as Record<K, number>));
const strip = ({ about: _about, ...spec }: Omit<StrategySpec, "name"> & { about: string }) => spec;

/** One strategy over the window [start, end of history), from an account of 1. */
export function simulate(s: Series, start: number, entry: Float64Array, exit: Float64Array | null, spec: StrategySpec, costs: Costs): Run {
  const n = s.close.length;
  const fee = costs.feePct / 100;
  const slip = costs.slippagePct / 100;
  const sl = (spec.stopLossPct ?? 0) / 100;
  const tp = (spec.takeProfitPct ?? 0) / 100;
  const trail = (spec.trailPct ?? 0) / 100;
  const equity = new Float64Array(n - start);
  const inMarket = new Uint8Array(n - start);
  const trades: Trade[] = [];
  let cash = 1;
  let units = 0;
  let held = false;
  let basis = 0;
  let entryPx = 0;
  let entryBar = 0;
  let peak = 0;
  /** What the last close decided for this open: "entry", an exit's reason, or nothing. */
  let pending = "";

  const sell = (i: number, px: number, reason: string) => {
    cash = units * px * (1 - fee);
    units = 0;
    held = false;
    const t = trades[trades.length - 1]!;
    Object.assign(t, { exitAt: s.t[i]!, exitPx: px, retPct: (cash / basis - 1) * 100, bars: i - entryBar + 1, reason });
  };

  for (let i = start; i < n; i++) {
    const o = s.open[i]!;
    if (pending === "entry") {
      entryPx = o * (1 + slip);
      units = (cash * (1 - fee)) / entryPx;
      basis = cash;
      cash = 0;
      held = true;
      entryBar = i;
      peak = entryPx;
      trades.push({ entryAt: s.t[i]!, entryPx, exitAt: null, exitPx: null, retPct: 0, bars: 0, reason: "open" });
    } else if (pending && held) sell(i, o * (1 - slip), pending);
    pending = "";

    if (held) {
      const stopPx = sl ? entryPx * (1 - sl) : 0;
      const trailPx = trail ? peak * (1 - trail) : 0;
      const floor = Math.max(stopPx, trailPx);
      const tpPx = entryPx * (1 + tp);
      if (floor > 0 && s.low[i]! <= floor) sell(i, Math.min(o, floor) * (1 - slip), trailPx > stopPx ? "trailing stop" : "stop-loss");
      else if (tp && s.high[i]! >= tpPx) sell(i, Math.max(o, tpPx), "take-profit");
    }

    if (held) {
      peak = Math.max(peak, s.close[i]!);
      if (exit && exit[i] === 1) pending = "exit rule";
      else if (spec.maxBars && i - entryBar + 1 >= spec.maxBars) pending = `held ${spec.maxBars} bars`;
    } else if (entry[i] === 1 && i < n - 1) pending = "entry";

    equity[i - start] = held ? units * s.close[i]! : cash;
    inMarket[i - start] = held ? 1 : 0;
  }
  const last = trades.at(-1);
  if (held && last) Object.assign(last, { retPct: ((units * s.close[n - 1]!) / basis - 1) * 100, bars: n - entryBar });
  return { equity, inMarket, trades };
}

/** The benchmark: buy at the window's first open, hold to the end. */
export function buyAndHold(s: Series, start: number, costs: Costs): Run {
  const n = s.close.length;
  const px = s.open[start]! * (1 + costs.slippagePct / 100);
  const units = (1 - costs.feePct / 100) / px;
  const equity = new Float64Array(n - start);
  for (let i = start; i < n; i++) equity[i - start] = units * s.close[i]!;
  return {
    equity,
    inMarket: new Uint8Array(n - start).fill(1),
    trades: [{ entryAt: s.t[start]!, entryPx: px, exitAt: null, exitPx: null, retPct: (equity[n - start - 1]! - 1) * 100, bars: n - start, reason: "open" }],
  };
}

const YEAR_MS = 365.25 * 86_400_000;

/** A run's numbers over bars [a, b) of its window. */
export function measure(run: Run, s: Series, start: number, a: number, b: number): Metrics {
  const e = run.equity;
  const barMs = intervalMs(s.interval);
  const e0 = a === 0 ? 1 : e[a - 1]!;
  const end = e[b - 1]!;
  const years = (s.t[start + b - 1]! - s.t[start + a]! + barMs) / YEAR_MS;
  let peak = e0;
  let dd = 0;
  let sum = 0;
  let sumSq = 0;
  let held = 0;
  for (let i = a; i < b; i++) {
    const r = e[i]! / (i === a ? e0 : e[i - 1]!) - 1;
    sum += r;
    sumSq += r * r;
    peak = Math.max(peak, e[i]!);
    dd = Math.max(dd, 1 - e[i]! / peak);
    held += run.inMarket[i]!;
  }
  const count = b - a;
  const mean = sum / count;
  const sd = Math.sqrt(Math.max(0, sumSq / count - mean * mean));
  const lo = s.t[start + a]!;
  const hi = s.t[start + b - 1]!;
  const closed = run.trades.filter((t) => t.exitAt !== null && t.entryAt >= lo && t.entryAt <= hi);
  const wins = closed.filter((t) => t.retPct > 0);
  const gains = wins.reduce((x, t) => x + t.retPct, 0);
  const losses = closed.filter((t) => t.retPct < 0).reduce((x, t) => x - t.retPct, 0);
  return {
    totalPct: (end / e0 - 1) * 100,
    cagrPct: years >= 0.25 ? ((end / e0) ** (1 / years) - 1) * 100 : null,
    maxDdPct: dd * 100,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(YEAR_MS / barMs) : 0,
    trades: closed.length,
    winPct: closed.length ? (wins.length / closed.length) * 100 : null,
    avgTradePct: closed.length ? closed.reduce((x, t) => x + t.retPct, 0) / closed.length : null,
    profitFactor: losses > 0 ? gains / losses : null,
    exposurePct: (held / count) * 100,
  };
}

/** Return per calendar year (UTC); the first and last years may be partial. */
export function yearly(run: Run, s: Series, start: number): { year: number; pct: number }[] {
  const out: { year: number; pct: number }[] = [];
  const e = run.equity;
  let base = 1;
  let year = new Date(s.t[start]!).getUTCFullYear();
  for (let i = 1; i < e.length; i++) {
    const y = new Date(s.t[start + i]!).getUTCFullYear();
    if (y !== year) {
      out.push({ year, pct: (e[i - 1]! / base - 1) * 100 });
      base = e[i - 1]!;
      year = y;
    }
  }
  out.push({ year, pct: (e[e.length - 1]! / base - 1) * 100 });
  return out;
}

export interface StrategyResult {
  spec: StrategySpec;
  run: Run;
  full: Metrics;
  /** The part strategies are ranked on. */
  inSample: Metrics;
  /** The held-out end of the window; null when there is no holdout. */
  outSample: Metrics | null;
  yearly: { year: number; pct: number }[];
}

export interface BacktestResult {
  pair: string;
  interval: Interval;
  /** First and last bar of the window. */
  from: number;
  to: number;
  bars: number;
  stretches: Stretch[];
  /** What the history lacks and why. */
  notes: string[];
  /** The history did not reach back far enough to warm every indicator up before the window. */
  warmupShort: boolean;
  /** When the held-out part starts. */
  holdoutFrom: number | null;
  holdoutPct: number;
  costs: Costs;
  benchmark: StrategyResult;
  /** Best first, by in-sample Sharpe (or full-window Sharpe with no holdout). */
  results: StrategyResult[];
}

/** Fetch the history, warm every indicator up before `from`, run each strategy and the benchmark, rank them. */
export async function runBacktest(opts: {
  pair: string;
  interval: Interval;
  from: number;
  to: number;
  strategies: StrategySpec[];
  costs: Costs;
  holdoutPct: number;
  dataDir: string;
  proxy?: string;
  /** Read the history from this pool's swaps on Ethereum instead of the exchanges. */
  dex?: DexMarket;
  rpcUrls?: string[];
  onProgress?: (text: string) => void;
}): Promise<BacktestResult> {
  const { warmup } = compileStrategies(opts.strategies);
  const barMs = intervalMs(opts.interval);
  const span = { interval: opts.interval, from: opts.from - warmup * barMs, to: opts.to, dataDir: opts.dataDir, proxy: opts.proxy };
  const s = opts.dex
    ? await loadDexSeries({ ...span, market: opts.dex, rpcUrls: opts.rpcUrls, onProgress: opts.onProgress })
    : await loadSeries({ ...span, pair: opts.pair });
  // History that begins inside the window, not just inside its warm-up, is worth a line of its own.
  const notes = [...s.notes];
  if (s.t[0]! > opts.from + barMs) {
    notes.push(
      `the history starts ${new Date(s.t[0]!).toISOString().slice(0, 10)}, later than asked` +
        (opts.dex ? ` (the pool's first swap) — for earlier years use source "cex" (Binance, Bitstamp before it)` : ""),
    );
  }
  return backtestSeries(s, { from: opts.from, strategies: opts.strategies, costs: opts.costs, holdoutPct: opts.holdoutPct, notes });
}

export interface CompiledStrategy {
  spec: StrategySpec;
  entry: Rule;
  exit: Rule | null;
}

/** Parse every strategy's rules, and the bars the slowest of them needs before it can be trusted. */
export function compileStrategies(strategies: StrategySpec[]): { compiled: CompiledStrategy[]; warmup: number } {
  if (!strategies.length) throw new Error("no strategies to test");
  const compiled = strategies.map((spec) => {
    const rule = (src: string, part: string): Rule => {
      try {
        return compileRule(src);
      } catch (err) {
        throw new Error(`${spec.name}: ${part} rule "${src}" — ${(err as Error).message}`);
      }
    };
    return { spec, entry: rule(spec.entry, "entry"), exit: spec.exit ? rule(spec.exit, "exit") : null };
  });
  return { compiled, warmup: Math.max(0, ...compiled.flatMap((c) => [c.entry.warmup, c.exit?.warmup ?? 0])) + 1 };
}

/** Each strategy and the benchmark over a series already in hand, from its first bar at or after `from`; best first. */
export function backtestSeries(
  s: Series,
  opts: { from: number; strategies: StrategySpec[]; costs: Costs; holdoutPct: number; notes?: string[] },
): BacktestResult {
  const { compiled, warmup } = compileStrategies(opts.strategies);
  const interval = s.interval;
  const start = s.t.findIndex((t) => t >= opts.from);
  if (start < 0 || s.t.length - start < 30) throw new Error(`fewer than 30 ${interval} bars of ${s.pair} in that window`);
  const n = s.t.length;
  const len = n - start;
  const holdoutPct = Math.max(0, Math.min(60, opts.holdoutPct));
  const split = holdoutPct > 0 ? Math.floor(len * (1 - holdoutPct / 100)) : len;
  const holdout = split >= 30 && len - split >= 30;

  const cache: SeriesCache = new Map();
  const finish = (spec: StrategySpec, run: Run): StrategyResult => ({
    spec,
    run,
    full: measure(run, s, start, 0, len),
    inSample: holdout ? measure(run, s, start, 0, split) : measure(run, s, start, 0, len),
    outSample: holdout ? measure(run, s, start, split, len) : null,
    yearly: yearly(run, s, start),
  });
  const results = compiled.map((c) =>
    finish(c.spec, simulate(s, start, c.entry.run(s, cache), c.exit?.run(s, cache) ?? null, c.spec, opts.costs)),
  );
  results.sort((x, y) => y.inSample.sharpe - x.inSample.sharpe);
  return {
    pair: s.pair,
    interval,
    from: s.t[start]!,
    to: s.t[n - 1]!,
    bars: len,
    stretches: s.stretches,
    notes: opts.notes ?? [...s.notes],
    warmupShort: start < warmup,
    holdoutFrom: holdout ? s.t[start + split]! : null,
    holdoutPct: holdout ? holdoutPct : 0,
    costs: opts.costs,
    benchmark: finish({ name: "buy & hold", entry: "" }, buyAndHold(s, start, opts.costs)),
    results,
  };
}
