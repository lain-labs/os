/**
 * Live runs: a backtested strategy carried on at today's prices, on paper.
 *
 * The signal is the backtest's own — the same rules over the same history (a
 * pool's swaps on Ethereum, or the exchanges), read at each bar's close once
 * that bar has closed. The fills are the stock desk's: BTC (Coinbase's cbBTC)
 * or ETH bought and sold at Robinhood Chain's live Uniswap pools and booked in
 * the desk's dollar account, so a run's position sits on /stocks beside the
 * rest. Between closes the stop-loss, trailing stop and take-profit are
 * watched against the live pool price, as the backtest watches them inside a
 * bar; the trail follows the best close since entry, as it does there.
 *
 * A run starts where the strategy stands: replayed over the recent history,
 * when its rules have it in the market at the last close it buys at once
 * (the backtest would hold it now), otherwise it waits for the next entry.
 * The whole budget goes in and comes out, as in the backtest.
 */
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createLogger } from "../../logger.js";
import type { IAgentRuntime, Service } from "../../types.js";
import { intervalMs, normalizePair, type Interval, type Series } from "./candles.js";
import { compileRule, type Rule, type SeriesCache } from "./rules.js";
import { DEFAULT_COSTS, simulate, type StrategySpec } from "./engine.js";
import { knownDexMarket } from "./dex.js";

const log = createLogger("plugin:backtest");

/** Where a run reads its bars — the same place its backtest read them. */
export interface HistoryRequest {
  pair: string;
  interval: Interval;
  source?: "dex" | "cex";
  pool?: string;
  from: number;
  to: number;
}
export type HistoryLoader = (req: HistoryRequest, runtime: IAgentRuntime) => Promise<Series>;

/** What a run needs from the stock desk; StockDeskService provides it. */
export interface LiveDesk {
  blocker(): string | null;
  order(symbol: string, dollars: number, by: string, why: string): Promise<{ line: string; qty: bigint; px: number }>;
  sellUnits(symbol: string, qty: bigint, by: string, reason: string): Promise<{ line: string; proceeds: number | null }>;
  price(symbol: string): Promise<number | null>;
  saleValue(symbol: string, qty: bigint): Promise<number | null>;
  holding(symbol: string): bigint;
}

export interface LiveTrade {
  at: number;
  side: "buy" | "sell";
  usd: number;
  px: number;
  reason: string;
  /** On a sale: the round trip's return, percent. */
  pnlPct?: number;
}

export interface LiveRun {
  id: string;
  spec: StrategySpec;
  pair: string;
  /** The desk asset it trades. */
  asset: string;
  interval: Interval;
  source?: "dex" | "cex";
  pool?: string;
  budgetUsd: number;
  startedAt: number;
  /** The asset's live price at the start — what holding it since would have made. */
  startPx: number;
  stoppedAt?: number;
  /** Dollars while out of the market. */
  cash: number;
  /** Raw units held, "0" while out. */
  qty: string;
  /** Dollars paid while in (the sale's basis). */
  cost: number;
  entryAt: number | null;
  entryPx: number;
  /** Best close since entry — the trailing stop's reference. */
  peak: number;
  /** Closes read since entry, for maxBars. */
  bars: number;
  /** Open time of the last closed bar the rules were read on. */
  lastBar: number;
  lastClose: number;
  /** What the last reading decided. */
  last: string;
  error: string;
  trades: LiveTrade[];
}

export interface LiveStart {
  spec: StrategySpec;
  pair?: string;
  interval?: Interval;
  source?: "dex" | "cex";
  pool?: string;
  usd?: number;
}

const DEFAULT_BUDGET = 1_000;
/** Bars replayed to find where a strategy stands, past its warm-up. */
const REPLAY_BARS = 400;
/** A closed bar is read this long after its close: on-chain history stays a few blocks short of the head. */
const SETTLE_MS = 5 * 60_000;
const DOLLAR_QUOTES = new Set(["USDT", "USDC", "FDUSD"]);
/** Coins a run can trade, by the desk symbol a pair's base maps to. */
const TRADABLE: Record<string, string> = { BTC: "BTC", WBTC: "BTC", CBBTC: "BTC", ETH: "ETH", WETH: "ETH" };

const at = (t: number) => new Date(t).toISOString().slice(0, 16).replace("T", " ");
const day = (t: number) => new Date(t).toISOString().slice(0, 10);
/** A bar by its close: the day for daily bars, the hour it closed for shorter ones. */
const closeOf = (interval: Interval, t: number) => (interval === "1d" ? day(t) : `${at(t + intervalMs(interval))} UTC`);
const money = (v: number) => `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signed = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

function span(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m >= 1440 ? `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h` : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

export class LiveStrategyService implements Service {
  readonly name = "live-strategies";

  private runtime?: IAgentRuntime;
  private file = "";
  private runs: LiveRun[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  /** `desk` stands in for the stock desk in tests; by default it is the runtime's. */
  constructor(
    private readonly load: HistoryLoader,
    private readonly deskOverride?: LiveDesk,
  ) {}

  async start(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
    this.file = join(runtime.getSetting("LAINOS_DATA_DIR") ?? "./data", "backtests", "live.json");
    try {
      this.runs = (JSON.parse(await readFile(this.file, "utf8")) as { runs?: LiveRun[] }).runs ?? [];
    } catch {
      // No live runs yet.
    }
    const every = Math.max(10_000, Number(runtime.getSetting("LAINOS_LIVE_STRATEGY_TICK_MS")) || 60_000);
    this.timer = setInterval(() => void this.tick(), every);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  list(): readonly LiveRun[] {
    return this.runs;
  }

  private desk(): LiveDesk | undefined {
    return this.deskOverride ?? (this.runtime?.getService("stocks") as LiveDesk | undefined);
  }

  /** Start a run; returns the report of it. */
  async begin(input: LiveStart): Promise<string> {
    const desk = this.desk();
    if (!desk) throw new Error("live runs fill on the stock desk, and the stocks plugin is not loaded");
    const blocker = desk.blocker();
    if (blocker) throw new Error(blocker);
    const pair = input.pair || "BTCUSDT";
    const p = normalizePair(pair);
    const asset = TRADABLE[p.base];
    if (!asset || !DOLLAR_QUOTES.has(p.quote)) {
      throw new Error(`a live run trades on Robinhood Chain's pools, which have BTC and ETH against dollars — not ${p.base}/${p.quote}`);
    }
    const usd = input.usd ?? DEFAULT_BUDGET;
    if (!(usd > 0)) throw new Error("the budget must be a positive number of dollars");
    const { entry, exit } = compile(input.spec);
    const startPx = await desk.price(asset);
    if (startPx === null) throw new Error(`${asset}: its pools on Robinhood Chain could not be read just now`);
    const run: LiveRun = {
      id: `s${this.runs.reduce((n, r) => Math.max(n, Number(r.id.slice(1)) || 0), 0) + 1}`,
      spec: input.spec,
      pair,
      asset,
      interval: input.interval ?? "1d",
      ...(input.pool ? { pool: input.pool } : input.source ? { source: input.source } : {}),
      budgetUsd: usd,
      startedAt: Date.now(),
      startPx,
      cash: usd,
      qty: "0",
      cost: 0,
      entryAt: null,
      entryPx: 0,
      peak: 0,
      bars: 0,
      lastBar: 0,
      lastClose: 0,
      last: "",
      error: "",
      trades: [],
    };

    // Where the strategy stands: the backtest's own simulation over the recent bars.
    const s = await this.bars(run, entry, exit);
    const n = s.t.length;
    const cache: SeriesCache = new Map();
    const e = entry.run(s, cache);
    const x = exit?.run(s, cache) ?? null;
    const warm = Math.min(n - 2, Math.max(entry.warmup, exit?.warmup ?? 0) + 1);
    const sim = simulate(s, warm, e, x, run.spec, DEFAULT_COSTS);
    const open = sim.trades.at(-1)?.exitAt === null ? sim.trades.at(-1)! : null;
    const i = n - 1;
    run.lastBar = s.t[i]!;
    run.lastClose = s.close[i]!;
    this.runs.push(run);
    if (open) {
      const held = i - s.t.indexOf(open.entryAt) + 1;
      if (x?.[i] === 1) run.last = `out — the exit rule fired at the ${closeOf(run.interval, run.lastBar)} close, so the strategy would sell now; waiting for the next entry`;
      else if (run.spec.maxBars && held >= run.spec.maxBars) run.last = `out — the position the rules opened ${day(open.entryAt)} has run its ${run.spec.maxBars} bars; waiting for the next entry`;
      else {
        await this.buy(run, desk, `its rules have been in the market since ${day(open.entryAt)} — joining at the live pool`);
        run.bars = held;
      }
    } else if (e[i] === 1) await this.buy(run, desk, `entry rule true at the ${closeOf(run.interval, run.lastBar)} close`);
    else run.last = `out — waiting for ${run.spec.entry}`;
    await this.persist();
    log.info(`live run ${run.id} started: ${run.spec.name} on ${run.asset} ${run.interval}`);
    return this.describe(run, await this.mark(run, desk));
  }

  /** Stop a run ("all" for every one); a run in the market sells first. */
  async end(id: string): Promise<string> {
    const desk = this.desk();
    const targets = this.runs.filter((r) => !r.stoppedAt && (id === "all" || r.id === id.toLowerCase()));
    if (!targets.length) return `no running live strategy "${id}" — ${this.runs.filter((r) => !r.stoppedAt).map((r) => r.id).join(", ") || "none running"}`;
    const lines: string[] = [];
    for (const run of targets) {
      if (BigInt(run.qty) > 0n && desk) await this.sell(run, desk, "the run was stopped");
      if (BigInt(run.qty) > 0n) {
        lines.push(`${run.id} ${run.spec.name} is still running — ${run.last}`);
        continue;
      }
      run.stoppedAt = Date.now();
      lines.push(`⏹ ${run.id} ${run.spec.name} stopped · ${money(run.budgetUsd)} → ${money(run.cash)} (${signed((run.cash / run.budgetUsd - 1) * 100)})`);
    }
    await this.persist();
    return lines.join("\n");
  }

  /** Every run as text, running ones first. */
  async report(): Promise<string> {
    if (!this.runs.length) return "no live strategies — backtest one, then start it (live_strategy start, or /backtest live <preset>)";
    const desk = this.desk();
    const out: string[] = [];
    for (const run of [...this.runs].sort((a, b) => Number(Boolean(a.stoppedAt)) - Number(Boolean(b.stoppedAt)) || b.startedAt - a.startedAt).slice(0, 8)) {
      out.push(this.describe(run, run.stoppedAt || !desk ? null : await this.mark(run, desk)));
    }
    return out.join("\n\n");
  }

  /** One minute of the clock: stops against the live price, and the rules on every bar that has closed. */
  async tick(): Promise<void> {
    if (this.busy) return;
    const desk = this.desk();
    const running = this.runs.filter((r) => !r.stoppedAt);
    if (!desk || !running.length) return;
    this.busy = true;
    try {
      for (const run of running) {
        try {
          await this.step(run, desk);
          run.error = "";
        } catch (err) {
          run.error = (err as Error).message.split("\n")[0]!.slice(0, 200);
          log.warn(`live run ${run.id}`, err);
        }
      }
      await this.persist();
    } finally {
      this.busy = false;
    }
  }

  private async step(run: LiveRun, desk: LiveDesk): Promise<void> {
    const blocker = desk.blocker();
    if (blocker) throw new Error(blocker);
    const spec = run.spec;
    if (BigInt(run.qty) > 0n) {
      // A position closed outside the run — by hand, or a desk reset — leaves it out, booked back at its cost.
      if (desk.holding(run.asset) < BigInt(run.qty)) {
        run.cash = run.cost;
        run.qty = "0";
        run.cost = 0;
        run.entryAt = null;
        run.last = "out — its position was closed on the desk outside the run (booked back at cost)";
        return;
      }
      const px = await desk.price(run.asset);
      if (px !== null) {
        const stopPx = spec.stopLossPct ? run.entryPx * (1 - spec.stopLossPct / 100) : 0;
        const trailPx = spec.trailPct ? run.peak * (1 - spec.trailPct / 100) : 0;
        if (Math.max(stopPx, trailPx) > 0 && px <= Math.max(stopPx, trailPx)) {
          await this.sell(run, desk, trailPx > stopPx ? `trailing stop (${spec.trailPct}% under the best close)` : `stop-loss (−${spec.stopLossPct}%)`);
        } else if (spec.takeProfitPct && px >= run.entryPx * (1 + spec.takeProfitPct / 100)) {
          await this.sell(run, desk, `take-profit (+${spec.takeProfitPct}%)`);
        }
      }
    }
    if (Date.now() < run.lastBar + 2 * intervalMs(run.interval) + SETTLE_MS) return;

    const { entry, exit } = compile(spec);
    const s = await this.bars(run, entry, exit);
    const n = s.t.length;
    const fresh = [];
    for (let i = 0; i < n; i++) if (s.t[i]! > run.lastBar) fresh.push(i);
    if (!fresh.length) return;
    const cache: SeriesCache = new Map();
    const e = entry.run(s, cache);
    const x = exit?.run(s, cache) ?? null;
    const i = fresh.at(-1)!;
    run.lastBar = s.t[i]!;
    run.lastClose = s.close[i]!;
    if (BigInt(run.qty) > 0n) {
      for (const k of fresh) run.peak = Math.max(run.peak, s.close[k]!);
      run.bars += fresh.length;
      if (x?.[i] === 1) await this.sell(run, desk, `exit rule at the ${closeOf(run.interval, run.lastBar)} close`);
      else if (spec.maxBars && run.bars >= spec.maxBars) await this.sell(run, desk, `held ${spec.maxBars} bars`);
      else run.last = `in — the ${closeOf(run.interval, run.lastBar)} close kept it in`;
    } else if (e[i] === 1) await this.buy(run, desk, `entry rule true at the ${closeOf(run.interval, run.lastBar)} close`);
    else run.last = `out — the ${closeOf(run.interval, run.lastBar)} close gave no entry`;
  }

  /** The bars a run reads: closed ones, with room for the warm-up and the replay. */
  private bars(run: LiveRun, entry: Rule, exit: Rule | null): Promise<Series> {
    const step = intervalMs(run.interval);
    const warmup = Math.max(entry.warmup, exit?.warmup ?? 0) + 1;
    const now = Date.now();
    const req = { pair: run.pair, interval: run.interval, source: run.source, pool: run.pool, from: now - (warmup + REPLAY_BARS) * step, to: now };
    return this.load(req, this.runtime!).then((s) => {
      if (s.t.length < warmup + 2) throw new Error(`fewer than ${warmup + 2} closed ${run.interval} bars to read the rules on`);
      return s;
    });
  }

  private async buy(run: LiveRun, desk: LiveDesk, why: string): Promise<void> {
    const got = await desk.order(run.asset, run.cash, `strategy ${run.id}`, `${run.id} ${run.spec.name}: ${why}`);
    if (got.qty <= 0n) {
      run.last = `out — the entry did not fill: ${got.line}`;
      return;
    }
    run.trades.push({ at: Date.now(), side: "buy", usd: run.cash, px: got.px, reason: why });
    run.cost = run.cash;
    run.cash = 0;
    run.qty = got.qty.toString();
    run.entryAt = Date.now();
    run.entryPx = got.px;
    run.peak = got.px;
    run.bars = 0;
    run.last = `in — ${why}`;
  }

  private async sell(run: LiveRun, desk: LiveDesk, reason: string): Promise<void> {
    const qty = BigInt(run.qty);
    const got = await desk.sellUnits(run.asset, qty, `strategy ${run.id}`, `${run.id} ${run.spec.name}: ${reason}`);
    if (got.proceeds === null) {
      run.last = `in — the exit (${reason}) did not fill: ${got.line}`;
      return;
    }
    const pnlPct = run.cost > 0 ? (got.proceeds / run.cost - 1) * 100 : 0;
    run.trades.push({ at: Date.now(), side: "sell", usd: got.proceeds, px: run.cost > 0 ? (got.proceeds / run.cost) * run.entryPx : 0, reason, pnlPct });
    run.cash = got.proceeds;
    run.qty = "0";
    run.cost = 0;
    run.entryAt = null;
    run.last = `out — sold: ${reason} (${signed(pnlPct)})`;
  }

  /** Live value and price of a run, null when the pools could not be read. */
  private async mark(run: LiveRun, desk: LiveDesk): Promise<{ equity: number; px: number } | null> {
    const px = await desk.price(run.asset);
    if (px === null) return null;
    const qty = BigInt(run.qty);
    const value = qty > 0n ? await desk.saleValue(run.asset, qty) : 0;
    return value === null ? null : { equity: run.cash + value, px };
  }

  private describe(run: LiveRun, live: { equity: number; px: number } | null): string {
    const s = run.spec;
    const dex = run.pool ? `the pool ${run.pool}` : run.source === "cex" ? null : knownDexMarket(normalizePair(run.pair).base)?.label;
    const src = dex ? `every swap of ${dex} on Ethereum` : `Binance ${normalizePair(run.pair).binance}`;
    const extras = [s.stopLossPct && `stop ${s.stopLossPct}%`, s.takeProfitPct && `take ${s.takeProfitPct}%`, s.trailPct && `trail ${s.trailPct}%`, s.maxBars && `${s.maxBars} bars max`].filter(Boolean);
    const inMarket = BigInt(run.qty) > 0n;
    const lines = [
      `${run.stoppedAt ? "⏹" : "🛰"} ${run.id} · ${s.name} · ${run.asset} ${run.interval} · ${run.stoppedAt ? `stopped ${at(run.stoppedAt)} UTC` : `live since ${at(run.startedAt)} UTC`}`,
      `  rules: in ${s.entry}${s.exit ? ` · out ${s.exit}` : ""}${extras.length ? ` · ${extras.join(", ")}` : ""}`,
      `  signals: closed ${run.interval} bars from ${src} · fills: ${run.asset} at Robinhood Chain's live pools on the stock desk (paper)`,
    ];
    if (live) {
      const ret = (live.equity / run.budgetUsd - 1) * 100;
      lines.push(
        `  ${inMarket ? `IN ${run.asset} since ${at(run.entryAt!)} at ${money(run.entryPx)}` : "OUT, in dollars"} · ${money(run.budgetUsd)} → ${money(live.equity)} (${signed(ret)})` +
          ` · ${run.asset} now ${money(live.px)}, ${signed((live.px / run.startPx - 1) * 100)} since the start`,
      );
    } else if (run.stoppedAt) lines.push(`  ${money(run.budgetUsd)} → ${money(run.cash)} (${signed((run.cash / run.budgetUsd - 1) * 100)})`);
    if (!run.stoppedAt) {
      const next = run.lastBar + 2 * intervalMs(run.interval);
      lines.push(`  last close read: ${closeOf(run.interval, run.lastBar)} at ${money(run.lastClose)} · next close ${at(next)} UTC (in ${span(next - Date.now())})`);
    }
    if (run.last) lines.push(`  ${run.last}`);
    if (run.error) lines.push(`  ⚠ ${run.error}`);
    for (const t of run.trades.slice(-4)) {
      lines.push(`  ${t.side === "buy" ? "🟢 bought" : "🔴 sold"} ${money(t.usd)} at ${money(t.px)} · ${at(t.at)}${t.pnlPct !== undefined ? ` · ${signed(t.pnlPct)}` : ""} — ${t.reason}`);
    }
    return lines.join("\n");
  }

  private async persist(): Promise<void> {
    if (!this.file) return;
    try {
      await mkdir(join(this.file, ".."), { recursive: true });
      await writeFile(this.file, JSON.stringify({ runs: this.runs }, null, 1), "utf8");
    } catch (err) {
      log.warn("could not save the live strategies", err);
    }
  }
}

function compile(spec: StrategySpec): { entry: Rule; exit: Rule | null } {
  const rule = (src: string, part: string): Rule => {
    try {
      return compileRule(src);
    } catch (err) {
      throw new Error(`${spec.name}: ${part} rule "${src}" — ${(err as Error).message}`);
    }
  };
  return { entry: rule(spec.entry, "entry"), exit: spec.exit ? rule(spec.exit, "exit") : null };
}
