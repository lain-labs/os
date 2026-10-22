/**
 * The paper desk's account: $100 of virtual dollars split across five
 * markets, each sleeve trading one backtested strategy.
 *
 * Nothing about a fill is stored. A sleeve's trades are the backtest engine's
 * own simulate() run over the market's final bars (markets.ts) from the hour
 * the strategy took over — the same rules, the same fill model, the same
 * costs the backtest that chose it used — so the paper account is that
 * backtest carried on, hour by hour, and a restart can neither lose a fill nor
 * book one twice. What is stored is which strategy each sleeve ran from when
 * (segments), what was already announced, and when the last check and report
 * were.
 *
 * Paper only, by construction: this module reads bars and writes its own
 * files; it has no wallet, signer or order path to reach.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Series } from "../backtest/candles.js";
import { compileStrategies, simulate, type Costs, type StrategySpec } from "../backtest/engine.js";
import { MARKET_IDS, type MarketId } from "./markets.js";

export const MODE = "paper" as const;
export const CAPITAL_USD = 100;
/** Announced fill keys kept, newest last. */
const ANNOUNCED_CAP = 1_000;

/** One strategy's stretch in a sleeve. */
export interface Segment {
  spec: StrategySpec;
  /** Open time of the first bar it trades on. */
  from: number;
  /** Dollars it started with. */
  startUsd: number;
  /** Why it runs: what its backtest said, or who changed it and why. */
  why: string;
  /** Set once another strategy took over: the last bar it ran on, and what it handed over. */
  until?: number;
  endUsd?: number;
  /** The price a position still open at the handover was sold at; null when it was out. */
  handoverPx?: number | null;
}

export interface Sleeve {
  market: MarketId;
  budgetUsd: number;
  /** The market's price when the desk opened: what holding it since would have made. */
  startPx: number;
  segments: Segment[];
  /** Why the last read failed, "" when it did not. */
  error: string;
}

export interface DeskState {
  version: 1;
  mode: typeof MODE;
  openedAt: number;
  capitalUsd: number;
  sleeves: Partial<Record<MarketId, Sleeve>>;
  announced: string[];
  lastCheckAt: number | null;
  lastReportAt: number | null;
}

export interface Fill {
  key: string;
  market: MarketId;
  side: "buy" | "sell";
  /** Open time of the bar it filled on. */
  at: number;
  px: number;
  /** Dollars spent (buy) or received after costs (sell). */
  usd: number;
  strategy: string;
  reason: string;
  /** On a sale: the round trip's return and dollars. */
  retPct?: number;
  pnlUsd?: number;
}

/** A sleeve as of its last bar. */
export interface SleeveView {
  market: MarketId;
  strategy: Segment;
  valueUsd: number;
  inMarket: boolean;
  /** The open position's entry price and when it was bought. */
  entryPx: number | null;
  entryAt: number | null;
  lastPx: number;
  lastBar: number;
  fills: Fill[];
  /** [bar open time, dollars] for every bar since the desk opened. */
  marks: [number, number][];
}

export function newState(now: number): DeskState {
  return { version: 1, mode: MODE, openedAt: now, capitalUsd: CAPITAL_USD, sleeves: {}, announced: [], lastCheckAt: null, lastReportAt: null };
}

export async function loadState(dir: string): Promise<DeskState | null> {
  let text: string;
  try {
    text = await readFile(join(dir, "state.json"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const state = JSON.parse(text) as DeskState;
  if (state.version !== 1 || state.mode !== MODE) throw new Error("desk: state.json is not a paper book this version knows");
  return state;
}

export async function saveState(dir: string, state: DeskState): Promise<void> {
  if (state.announced.length > ANNOUNCED_CAP) state.announced = state.announced.slice(-ANNOUNCED_CAP);
  await mkdir(dir, { recursive: true });
  const file = join(dir, "state.json");
  await writeFile(`${file}.tmp`, JSON.stringify(state, null, 1), "utf8");
  await rename(`${file}.tmp`, file);
}

/** The series up to and including the bar that opened at `t`. */
function until(s: Series, t: number): Series {
  const end = s.t.findIndex((x) => x > t);
  if (end < 0) return s;
  const cut = (a: Float64Array) => a.subarray(0, end);
  return { ...s, t: cut(s.t), open: cut(s.open), high: cut(s.high), low: cut(s.low), close: cut(s.close), volume: cut(s.volume) };
}

/** One segment run over its bars: its fills, its value at each bar, and where it ended. */
function runSegment(market: MarketId, seg: Segment, s: Series, costs: Costs) {
  const series = seg.until !== undefined ? until(s, seg.until) : s;
  const start = series.t.findIndex((t) => t >= seg.from);
  if (start < 0) return null;
  const { compiled } = compileStrategies([seg.spec]);
  const c = compiled[0]!;
  const run = simulate(series, start, c.entry.run(series, new Map()), c.exit?.run(series, new Map()) ?? null, seg.spec, costs);
  const index = new Map<number, number>();
  series.t.forEach((t, i) => index.set(t, i));
  /** Account value (from 1) right before bar i. */
  const before = (i: number) => (i <= start ? 1 : run.equity[i - 1 - start]!);
  const fills: Fill[] = [];
  const id = `${market}:${seg.from}`;
  for (const tr of run.trades) {
    const i = index.get(tr.entryAt)!;
    const spent = seg.startUsd * before(i);
    fills.push({ key: `${id}:${tr.entryAt}:buy`, market, side: "buy", at: tr.entryAt, px: tr.entryPx, usd: spent, strategy: seg.spec.name, reason: "entry rule" });
    if (tr.exitAt !== null && tr.exitPx !== null) {
      const got = seg.startUsd * run.equity[index.get(tr.exitAt)! - start]!;
      fills.push({
        key: `${id}:${tr.exitAt}:sell`,
        market,
        side: "sell",
        at: tr.exitAt,
        px: tr.exitPx,
        usd: got,
        strategy: seg.spec.name,
        reason: tr.reason,
        retPct: tr.retPct,
        pnlUsd: got - spent,
      });
    }
  }
  const open = run.trades.at(-1);
  const inMarket = run.inMarket[run.inMarket.length - 1] === 1;
  const marks: [number, number][] = Array.from(run.equity, (e, k) => [series.t[start + k]!, seg.startUsd * e]);
  return { fills, marks, inMarket, open: inMarket && open ? open : null, last: series.t.length - 1, series };
}

/**
 * The sleeve over its market's bars (the live bar included): every segment
 * replayed, the fills in order, the value now.
 */
export function replaySleeve(sleeve: Sleeve, s: Series, costs: Costs): SleeveView {
  const fills: Fill[] = [];
  const marks: [number, number][] = [];
  let view: SleeveView | null = null;
  for (const seg of sleeve.segments) {
    const r = runSegment(sleeve.market, seg, s, costs);
    if (!r) continue;
    fills.push(...r.fills);
    marks.push(...r.marks.filter(([t]) => !marks.length || t > marks.at(-1)![0]));
    if (seg.until !== undefined) {
      if (seg.handoverPx !== null && seg.handoverPx !== undefined && seg.endUsd !== undefined) {
        fills.push({
          key: `${sleeve.market}:${seg.from}:${seg.until}:handover`,
          market: sleeve.market,
          side: "sell",
          at: seg.until,
          px: seg.handoverPx,
          usd: seg.endUsd,
          strategy: seg.spec.name,
          reason: "strategy changed",
        });
      }
      continue;
    }
    const lastPx = r.series.close[r.last]!;
    view = {
      market: sleeve.market,
      strategy: seg,
      valueUsd: marks.at(-1)?.[1] ?? seg.startUsd,
      inMarket: r.inMarket,
      entryPx: r.open?.entryPx ?? null,
      entryAt: r.open?.entryAt ?? null,
      lastPx,
      lastBar: r.series.t[r.last]!,
      fills,
      marks,
    };
  }
  if (view) return view;
  // The current strategy has not reached its first bar yet.
  const seg = sleeve.segments.at(-1)!;
  const n = s.t.length - 1;
  return {
    market: sleeve.market,
    strategy: seg,
    valueUsd: seg.startUsd,
    inMarket: false,
    entryPx: null,
    entryAt: null,
    lastPx: s.close[n] ?? 0,
    lastBar: s.t[n] ?? seg.from,
    fills,
    marks,
  };
}

/**
 * What the current strategy hands over when another takes its place at the
 * last bar: its value, less the cost of selling a position it still holds.
 */
export function handover(view: SleeveView, costs: Costs): { endUsd: number; handoverPx: number | null } {
  if (!view.inMarket) return { endUsd: view.valueUsd, handoverPx: null };
  const cut = (costs.feePct + costs.slippagePct) / 100;
  return { endUsd: view.valueUsd * (1 - cut), handoverPx: view.lastPx * (1 - costs.slippagePct / 100) };
}

/** The account's value at each hour every sleeve has a mark for, from the opening. */
export function accountMarks(views: SleeveView[]): [number, number][] {
  if (!views.length) return [];
  const byTime = new Map<number, number[]>();
  views.forEach((v, k) => {
    for (const [t, usd] of v.marks) {
      const row = byTime.get(t) ?? new Array<number>(views.length).fill(NaN);
      row[k] = usd;
      byTime.set(t, row);
    }
  });
  const last = views.map((v) => v.strategy.startUsd);
  return [...byTime.keys()]
    .sort((a, b) => a - b)
    .map((t) => {
      byTime.get(t)!.forEach((usd, k) => {
        if (!Number.isNaN(usd)) last[k] = usd;
      });
      return [t, last.reduce((a, b) => a + b, 0)] as [number, number];
    });
}

export function maxDrawdownPct(values: readonly number[]): number {
  let peak = -Infinity;
  let dd = 0;
  for (const v of values) {
    peak = Math.max(peak, v);
    if (peak > 0) dd = Math.max(dd, 1 - v / peak);
  }
  return dd * 100;
}

export { MARKET_IDS };
