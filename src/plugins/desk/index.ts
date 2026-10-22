/**
 * The paper desk: Lain's demo account. $100 of virtual dollars, $20 on each of
 * five DEX markets (LAIN, CYBER.sol, ETH, SOL, BTC — markets.ts), each traded
 * by a strategy the backtest picked on that market's own hourly history.
 *
 * Once an hour (at CHECK_MINUTE, in the daemon) every market's new bars are
 * read and each sleeve is replayed through the backtest engine (book.ts); a
 * fill nobody has heard of yet becomes an event, which the daemon sends to the
 * operator on Telegram. A report follows every morning. Lain reads the desk
 * with paper_desk, changes a market's strategy with paper_desk_strategy (it is
 * backtested first), and sees one line of it in every conversation, so what
 * she says about her trading is what the books say.
 *
 * This replaces three desks that never met: trend-paper (two hard-coded
 * books the agent could not see), the backtest plugin's live runs (no run was
 * ever started), and the chain's paper wallet as a stand-in for a demo
 * account (it only moves when someone trades it by hand).
 *
 * Paper only: nothing here reaches a wallet, a signer or an order.
 */
import { join } from "node:path";
import { createLogger } from "../../logger.js";
import type { Action, IAgentRuntime, Plugin, Provider, Service } from "../../types.js";
import type { RoutineService } from "../skills/routines.js";
import type { Bar } from "../backtest/candles.js";
import { backtestSeries, compileStrategies, expandStrategies, PRESETS, type BacktestResult, type StrategyResult, type StrategySpec } from "../backtest/engine.js";
import { ruleHelp } from "../backtest/rules.js";
import { HOUR, isMarketId, loadBars, MARKET_IDS, MARKETS, toSeries, type DeskMarket, type Fetch, type MarketEnv, type MarketId } from "./markets.js";
import {
  accountMarks,
  handover,
  loadState,
  maxDrawdownPct,
  MODE,
  newState,
  replaySleeve,
  saveState,
  type DeskState,
  type Fill,
  type SleeveView,
} from "./book.js";

const log = createLogger("plugin:desk");

const CHECK_MINUTE = 10;
const REPORT_AT = "09:00";
const REPORT_TZ = "Europe/Moscow";
const HOLDOUT_PCT = 30;
/** A strategy that never trades can't be judged: the pick needs this many closed trades in-sample. */
const MIN_TRADES = 3;
const DAY = 86_400_000;

export interface DeskEvent {
  kind: "opened" | "fill" | "strategy" | "report" | "error";
  market?: MarketId;
  text: string;
}

export interface DeskDeps {
  fetch?: Fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const money = (v: number) => `${v < 0 ? "−" : ""}$${Math.abs(v).toFixed(2)}`;
const pct = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)}%`;
const px = (v: number) => (v >= 1 ? `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : `$${v.toPrecision(4)}`);
const utc = (t: number) => `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;
const ICON: Record<Fill["side"], string> = { buy: "🟢", sell: "🔴" };

/** A strategy in one line: its rules and stops. */
export function describeSpec(spec: StrategySpec): string {
  return [
    `entry ${spec.entry}`,
    ...(spec.exit ? [`exit ${spec.exit}`] : []),
    ...(spec.stopLossPct ? [`stop ${spec.stopLossPct}%`] : []),
    ...(spec.takeProfitPct ? [`take-profit ${spec.takeProfitPct}%`] : []),
    ...(spec.trailPct ? [`trailing stop ${spec.trailPct}%`] : []),
    ...(spec.maxBars ? [`out after ${spec.maxBars} bars`] : []),
  ].join(", ");
}

/**
 * A backtest in one line. The held-out tail comes first: the whole window
 * includes the part the strategy was picked on, so it flatters.
 */
function resultLine(r: StrategyResult, hold: StrategyResult): string {
  const out = r.outSample ? `held-out last ${HOLDOUT_PCT}% ${pct(r.outSample.totalPct)} vs holding ${pct(hold.outSample?.totalPct ?? 0)}; ` : "";
  return `${out}whole window ${pct(r.full.totalPct)} vs holding ${pct(hold.full.totalPct)}, ${r.full.trades} trades${r.full.winPct === null ? "" : ` (${Math.round(r.full.winPct)}% won)`}, max drawdown ${r.full.maxDdPct.toFixed(1)}%`;
}

export class PaperDeskService implements Service {
  readonly name = "paper-desk";

  private dir = "";
  private queue: Promise<unknown> = Promise.resolve();
  private cancels: (() => void)[] = [];
  private subscribers = new Set<(event: DeskEvent) => void>();
  private views: Partial<Record<MarketId, SleeveView>> = {};
  private bars: Partial<Record<MarketId, Bar[]>> = {};
  private state: DeskState | null = null;

  constructor(private readonly deps: DeskDeps = {}) {}

  async start(runtime: IAgentRuntime): Promise<void> {
    this.dir = join(runtime.getSetting("LAINOS_DATA_DIR") ?? "./data", "desk");
    this.state = await loadState(this.dir).catch((err: Error) => {
      log.error(err.message);
      return null;
    });
    const routines = runtime.getService<RoutineService>("routines");
    if (!routines?.schedule) {
      log.warn("not scheduled: the routines service is not loaded");
      return;
    }
    this.cancels.push(
      routines.schedule({ name: "paper-desk:check", trigger: { kind: "hourly", minute: CHECK_MINUTE }, run: () => this.check().then(() => undefined) }),
      routines.schedule({ name: "paper-desk:report", trigger: { kind: "daily", at: REPORT_AT, timeZone: REPORT_TZ }, run: () => this.report().then(() => undefined) }),
    );
    log.info(`${MODE} only · $${this.state?.capitalUsd ?? 100} on ${MARKET_IDS.join(", ")} · checked at :${CHECK_MINUTE}, report ${REPORT_AT} ${REPORT_TZ}${routines.active ? "" : " (runs in the daemon)"}`);
  }

  async stop(): Promise<void> {
    for (const cancel of this.cancels.splice(0)) cancel();
  }

  onEvent(fn: (event: DeskEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /** Point the service at a directory without a runtime (tests, scripts). */
  async open(dir: string): Promise<void> {
    this.dir = dir;
    this.state = await loadState(dir);
  }

  /** One at a time: a check, a report and a strategy change never interleave. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const job = this.queue.then(fn);
    this.queue = job.catch(() => undefined);
    return job;
  }

  /**
   * Read every market's new bars, open the sleeves not open yet (each with
   * the strategy its backtest ranks first), replay every sleeve and announce
   * the fills nobody has heard of. Returns what happened, as text.
   */
  check(): Promise<string> {
    return this.serial(async () => {
      const now = this.now();
      const state = this.state ?? newState(now);
      const announced = new Set(state.announced);
      const opened: string[] = [];
      const fresh: Fill[] = [];
      const errors: DeskEvent[] = [];
      for (const id of MARKET_IDS) {
        const m = MARKETS[id];
        const had = state.sleeves[id]?.error ?? "";
        let bars: Bar[];
        try {
          bars = await loadBars(m, this.env());
          if (bars.length < 60) throw new Error(`only ${bars.length} hourly bars of history`);
        } catch (err) {
          const message = (err as Error).message.split("\n")[0]!.slice(0, 200);
          log.warn(`${id}: ${message}`);
          const sleeve = state.sleeves[id];
          if (sleeve) sleeve.error = message;
          if (!had && sleeve) errors.push({ kind: "error", market: id, text: `⚠️ Paper desk · ${id}: this hour's bars could not be read — ${message}. Its book waits for the next check.` });
          continue;
        }
        this.bars[id] = bars;
        let sleeve = state.sleeves[id];
        if (!sleeve) {
          const pick = choose(m, bars);
          const last = bars.at(-1)!;
          sleeve = state.sleeves[id] = {
            market: id,
            budgetUsd: state.capitalUsd / MARKET_IDS.length,
            startPx: last[4],
            segments: [{ spec: pick.spec, from: last[0] + HOUR, startUsd: state.capitalUsd / MARKET_IDS.length, why: pick.why }],
            error: "",
          };
          opened.push(`${id} — ${pick.spec.name}: ${describeSpec(pick.spec)}\n   backtest: ${pick.why}`);
        }
        sleeve.error = "";
        const view = replaySleeve(sleeve, toSeries(m, bars, true), m.costs);
        this.views[id] = view;
        for (const fill of view.fills) {
          if (announced.has(fill.key)) continue;
          announced.add(fill.key);
          state.announced.push(fill.key);
          fresh.push(fill);
        }
      }
      state.lastCheckAt = now;
      this.state = state;
      await saveState(this.dir, state);
      if (opened.length) {
        this.emit({
          kind: "opened",
          text: [
            `📒 Paper desk opened · ${money(state.capitalUsd)} of virtual dollars, ${money(state.capitalUsd / MARKET_IDS.length)} per market`,
            `Each market trades the strategy its backtest ranked first on its own hourly DEX history; I check every hour and report at ${REPORT_AT} Moscow time.`,
            ...opened.map((line) => `• ${line}`),
            `paper only — no order is ever sent`,
          ].join("\n"),
        });
      }
      for (const ev of errors) this.emit(ev);
      for (const fill of fresh.sort((a, b) => a.at - b.at)) this.emit({ kind: "fill", market: fill.market, text: this.fillText(fill) });
      return fresh.length ? fresh.map((f) => `${f.side} ${f.market} at ${px(f.px)}`).join("\n") : "no fills this hour";
    });
  }

  /** The morning report, delivered as an event and returned. */
  report(): Promise<string> {
    return this.serial(async () => {
      if (!this.state) return "the paper desk has not opened yet — it opens on the daemon's first hourly check";
      const text = this.reportText();
      this.state.lastReportAt = this.now();
      await saveState(this.dir, this.state);
      this.emit({ kind: "report", text });
      return text;
    });
  }

  /** Backtest a strategy on one market's history beside the strategy it trades now. */
  async testStrategy(id: MarketId, spec: StrategySpec): Promise<{ text: string; result: BacktestResult }> {
    const m = MARKETS[id];
    const bars = this.bars[id] ?? (await loadBars(m, this.env()));
    this.bars[id] = bars;
    const current = this.state?.sleeves[id]?.segments.at(-1)?.spec;
    const specs = current && current.name !== spec.name ? [spec, { ...current, name: `${current.name} (now)` }] : [spec];
    const result = runBacktest(m, bars, specs);
    const days = Math.round(bars.length / 24);
    const lines = [`Backtest on ${days} days of hourly ${m.label} history, ${m.costs.feePct}% fee + ${m.costs.slippagePct}% slippage a fill:`];
    for (const r of result.results) lines.push(`• ${r.spec.name}: ${resultLine(r, result.benchmark)}`);
    if (result.warmupShort) lines.push("(the history is short for this strategy's indicators — read it with care)");
    return { text: lines.join("\n"), result };
  }

  /**
   * Hand a market to another strategy from the next bar on: the current one
   * sells what it holds at the last close, and the new one starts with what
   * that leaves.
   */
  setStrategy(id: MarketId, spec: StrategySpec, why: string): Promise<string> {
    return this.serial(async () => {
      compileStrategies([spec]);
      const state = this.state;
      const sleeve = state?.sleeves[id];
      if (!state || !sleeve) return `the paper desk has no ${id} book yet — it opens on the daemon's hourly check`;
      const m = MARKETS[id];
      const bars = this.bars[id] ?? (await loadBars(m, this.env()));
      const closed = replaySleeve(sleeve, toSeries(m, bars, false), m.costs);
      const current = sleeve.segments.at(-1)!;
      const { endUsd, handoverPx } = handover(closed, m.costs);
      Object.assign(current, { until: closed.lastBar, endUsd, handoverPx });
      sleeve.segments.push({ spec, from: closed.lastBar + HOUR, startUsd: endUsd, why });
      await saveState(this.dir, state);
      this.views[id] = replaySleeve(sleeve, toSeries(m, bars, true), m.costs);
      const sold = handoverPx === null ? "it was out of the market" : `its position was sold at ${px(handoverPx)}`;
      const text = `🔁 Paper desk · ${id} now trades ${spec.name} (${describeSpec(spec)}) instead of ${current.spec.name}; ${sold}, ${money(endUsd)} carried over.\nwhy: ${why}`;
      this.emit({ kind: "strategy", market: id, text });
      return text;
    });
  }

  /**
   * Replay the sleeves this process has not read yet (a TUI, a fresh start),
   * from the bars on disk and whatever closed since; nothing is announced.
   */
  async refresh(): Promise<void> {
    const state = this.state;
    if (!state) return;
    for (const id of MARKET_IDS) {
      const sleeve = state.sleeves[id];
      if (!sleeve || this.views[id]) continue;
      try {
        const bars = this.bars[id] ?? (await loadBars(MARKETS[id], this.env()));
        this.bars[id] = bars;
        this.views[id] = replaySleeve(sleeve, toSeries(MARKETS[id], bars, true), MARKETS[id].costs);
      } catch (err) {
        sleeve.error = (err as Error).message.split("\n")[0]!.slice(0, 200);
      }
    }
  }

  /** The morning report's text, without sending it. */
  reportPreview(): string {
    return this.state ? this.reportText() : this.statusText();
  }

  /** The whole account as text: for paper_desk and the report. */
  statusText(): string {
    const state = this.state;
    if (!state) return "The paper desk has not opened yet: it opens on the daemon's first hourly check, with a strategy per market picked by backtest.";
    const views = this.currentViews();
    const t = this.totals(views);
    const lines = [
      `Paper desk — ${money(state.capitalUsd)} of virtual dollars on ${MARKET_IDS.length} DEX markets, paper only (opened ${utc(state.openedAt)}${state.lastCheckAt ? `, last check ${utc(state.lastCheckAt)}` : ""}).`,
      `Balance ${money(t.value)} (${pct(t.retPct)}) · holding all five instead: ${pct(t.holdPct)} · closed trades ${t.closed.length} (${t.closed.filter((f) => (f.pnlUsd ?? 0) > 0).length} won) · max drawdown ${t.maxDdPct.toFixed(1)}%`,
    ];
    for (const id of MARKET_IDS) {
      const sleeve = state.sleeves[id];
      const v = this.views[id];
      if (!sleeve || !v) {
        lines.push(`${id} — ${sleeve ? "its bars could not be read" : "not open yet"}${sleeve?.error ? ` (${sleeve.error})` : ""}`);
        continue;
      }
      const seg = v.strategy;
      lines.push(
        `${id} — ${money(v.valueUsd)} (${pct((v.valueUsd / sleeve.budgetUsd - 1) * 100)}) · ${v.inMarket ? `in since ${utc(v.entryAt!)} at ${px(v.entryPx!)}, now ${px(v.lastPx)}` : `out, price ${px(v.lastPx)}`} · ${seg.spec.name}: ${describeSpec(seg.spec)}` +
          `\n   why this strategy: ${seg.why}${sleeve.error ? `\n   ⚠ last read failed: ${sleeve.error}` : ""}`,
      );
    }
    const recent = t.fills.slice(-8);
    if (recent.length) lines.push("Recent fills:", ...recent.map((f) => `  ${this.fillLine(f)}`));
    else lines.push("No fills yet: every strategy waits for its entry rule.");
    return lines.join("\n");
  }

  /** Every fill, oldest first (the last `limit`). */
  tradesText(limit = 40): string {
    const fills = this.totals(this.currentViews()).fills;
    if (!fills.length) return "No paper desk fills yet.";
    return [`Paper desk fills (${fills.length}, last ${Math.min(limit, fills.length)}):`, ...fills.slice(-limit).map((f) => `  ${this.fillLine(f)}`)].join("\n");
  }

  /** One line for every conversation: what the books say right now. */
  summaryLine(): string {
    if (!this.state) return "";
    const views = this.currentViews();
    if (!views.length) return "";
    const t = this.totals(views);
    const holding = views.filter((v) => v.inMarket).map((v) => v.market);
    const last = t.fills.at(-1);
    return (
      `Your paper desk (your demo account: virtual $${this.state.capitalUsd} on ${MARKET_IDS.join(", ")} DEX pools, trading backtested strategies by itself every hour): ` +
      `${money(t.value)} (${pct(t.retPct)}), ${holding.length ? `in ${holding.join(", ")}` : "all out of the market"}` +
      `${last ? `, last fill ${last.side} ${last.market} ${utc(last.at)}` : ", no fills yet"}. ` +
      "For anything about your paper or demo trading, read paper_desk first and quote its numbers; paper_desk_strategy tests and changes a market's strategy."
    );
  }

  private currentViews(): SleeveView[] {
    return MARKET_IDS.map((id) => this.views[id]).filter((v): v is SleeveView => Boolean(v));
  }

  private totals(views: SleeveView[]) {
    const state = this.state!;
    const opened = MARKET_IDS.filter((id) => state.sleeves[id]);
    const unopenedUsd = (MARKET_IDS.length - opened.length) * (state.capitalUsd / MARKET_IDS.length);
    // A sleeve whose bars were not read in this process yet counts at what it started with.
    const unread = opened.filter((id) => !this.views[id]).reduce((a, id) => a + state.sleeves[id]!.segments.at(-1)!.startUsd, 0);
    const value = views.reduce((a, v) => a + v.valueUsd, 0) + unopenedUsd + unread;
    const hold =
      views.reduce((a, v) => {
        const s = state.sleeves[v.market]!;
        const cut = (MARKETS[v.market].costs.feePct + MARKETS[v.market].costs.slippagePct) / 100;
        return a + s.budgetUsd * (1 - cut) * (v.lastPx / s.startPx);
      }, 0) + unopenedUsd + opened.filter((id) => !this.views[id]).length * (state.capitalUsd / MARKET_IDS.length);
    const fills = views.flatMap((v) => v.fills).sort((a, b) => a.at - b.at);
    const closed = fills.filter((f) => f.side === "sell" && f.pnlUsd !== undefined);
    const marks = accountMarks(views).map(([, usd]) => usd + unopenedUsd + unread);
    return {
      value,
      retPct: (value / state.capitalUsd - 1) * 100,
      holdPct: (hold / state.capitalUsd - 1) * 100,
      fills,
      closed,
      maxDdPct: maxDrawdownPct([state.capitalUsd, ...marks]),
    };
  }

  private reportText(): string {
    const state = this.state!;
    const now = this.now();
    const views = this.currentViews();
    const t = this.totals(views);
    const dayAgo = now - DAY;
    const today = t.fills.filter((f) => f.at >= dayAgo);
    const closedToday = t.closed.filter((f) => f.at >= dayAgo);
    const worst = closedToday.filter((f) => (f.pnlUsd ?? 0) < 0).sort((a, b) => a.pnlUsd! - b.pnlUsd!)[0];
    const day = Math.floor((now - state.openedAt) / DAY) + 1;
    const lines = [
      `📒 Paper desk · day ${day} · ${utc(now)}`,
      `Balance: ${money(t.value)} (fake) · ${pct(t.retPct)} since ${utc(state.openedAt).slice(0, 10)} · holding all five instead: ${pct(t.holdPct)}`,
      `Last 24h: ${today.length} fills, ${closedToday.length} closed (${closedToday.filter((f) => f.pnlUsd! > 0).length} won) · all time: ${t.closed.length} closed, ${t.closed.filter((f) => f.pnlUsd! > 0).length} won · max drawdown ${t.maxDdPct.toFixed(1)}%`,
      `Biggest mistake: ${worst ? `${worst.market} ${worst.strategy} lost ${pct(worst.retPct ?? 0)} (${money(worst.pnlUsd!)}) — ${worst.reason} at ${px(worst.px)}` : "none — no trade closed at a loss in the last 24h"}`,
      "",
    ];
    for (const id of MARKET_IDS) {
      const v = this.views[id];
      const sleeve = state.sleeves[id];
      if (!v || !sleeve) {
        lines.push(`${id}: not open yet${sleeve?.error ? ` — ${sleeve.error}` : ""}`);
        continue;
      }
      lines.push(
        `${id}: ${money(v.valueUsd)} (${pct((v.valueUsd / sleeve.budgetUsd - 1) * 100)}) · ${v.inMarket ? `in from ${px(v.entryPx!)}, now ${px(v.lastPx)}` : "out"} · ${v.strategy.spec.name}${sleeve.error ? ` · ⚠ ${sleeve.error}` : ""}`,
      );
    }
    lines.push("", "paper only — virtual dollars, no orders sent");
    return lines.join("\n");
  }

  private fillLine(f: Fill): string {
    const verb = f.side === "buy" ? `BUY ${f.market} ${money(f.usd)}` : `SELL ${f.market} ${money(f.usd)}`;
    const result = f.side === "sell" && f.retPct !== undefined ? ` · ${pct(f.retPct)} (${money(f.pnlUsd!)})` : "";
    return `${utc(f.at)} ${verb} at ${px(f.px)}${result} · ${f.strategy}, ${f.reason}`;
  }

  private fillText(f: Fill): string {
    const t = this.totals(this.currentViews());
    return [
      `${ICON[f.side]} Paper desk · ${f.side === "buy" ? "BUY" : "SELL"} ${f.market} ${money(f.usd)} at ${px(f.px)}${f.side === "sell" && f.retPct !== undefined ? ` · ${pct(f.retPct)} (${money(f.pnlUsd!)})` : ""}`,
      `why: ${f.reason === "entry rule" ? `${f.strategy} entry — ${this.state?.sleeves[f.market]?.segments.find((s) => s.spec.name === f.strategy)?.spec.entry ?? ""}` : `${f.strategy}, ${f.reason}`}`,
      `account ${money(t.value)} (${pct(t.retPct)}) · paper, no order sent`,
    ].join("\n");
  }

  private env(): MarketEnv {
    return {
      fetch: this.deps.fetch ?? ((url, init) => fetch(url, init)),
      dir: join(this.dir, "market"),
      now: () => this.now(),
      sleep: this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
    };
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private emit(event: DeskEvent): void {
    for (const fn of this.subscribers) {
      try {
        fn(event);
      } catch {
        /* a broken subscriber must never break the books */
      }
    }
  }
}

function runBacktest(m: DeskMarket, bars: Bar[], specs: StrategySpec[]): BacktestResult {
  const s = toSeries(m, bars);
  const { warmup } = compileStrategies(specs);
  // Leave the indicators their warm-up, but never less than 60 bars to judge on.
  const from = s.t[Math.max(0, Math.min(warmup, s.t.length - 60))]!;
  return backtestSeries(s, { from, strategies: specs, costs: m.costs, holdoutPct: HOLDOUT_PCT });
}

/** The preset the backtest ranks first on this market (by in-sample Sharpe) among those that traded enough to judge. */
export function choose(m: DeskMarket, bars: Bar[]): { spec: StrategySpec; why: string } {
  const result = runBacktest(m, bars, expandStrategies(["all"], []));
  const pick = result.results.find((r) => r.inSample.trades >= MIN_TRADES) ?? result.results[0]!;
  const days = Math.round(bars.length / 24);
  return {
    spec: pick.spec,
    why: `ranked first of ${result.results.length} presets on ${days} days of hourly history — ${resultLine(pick, result.benchmark)}`,
  };
}

function getDesk(runtime: IAgentRuntime): PaperDeskService | undefined {
  return runtime.getService<PaperDeskService>("paper-desk");
}

const paperDeskAction: Action = {
  name: "paper_desk",
  similes: ["demo_account", "demo_trading", "paper_account", "paper_journal", "paper_results", "trading_results", "desk_status"],
  description:
    "Your demo account — the paper desk: $100 of virtual dollars, $20 on each of LAIN, CYBER.sol, ETH, SOL and BTC, each traded by itself every hour by the strategy its backtest picked on that market's DEX history; fills and a morning report go to the operator. " +
    "Read it before saying anything about your paper/demo trading, its results, wins, losses or mistakes, and quote its numbers. " +
    "view 'status' (default): balance, return, vs just holding, each market's position and strategy and why it was chosen, recent fills. 'trades': every fill. 'report': the daily report as the operator gets it.",
  parameters: {
    type: "object",
    properties: {
      view: { type: "string", enum: ["status", "trades", "report"], description: "What to show; status by default." },
    },
  },
  examples: [
    { user: "how is your demo account doing?", agent: "(paper_desk) $101.84, +1.84% since Oct 22 — ETH and SOL are in, the rest wait for their entries." },
    { user: "what was your worst trade?", agent: "(paper_desk view trades) SOL bollinger_dip, stopped out at −3.1%." },
  ],
  async validate(runtime) {
    return Boolean(getDesk(runtime));
  },
  async handler(runtime, _state, params) {
    const desk = getDesk(runtime)!;
    await desk.refresh();
    const view = String(params.view ?? "status");
    if (view === "trades") return { ok: true, text: desk.tradesText() };
    if (view === "report") return { ok: true, text: desk.reportPreview() };
    return { ok: true, text: desk.statusText() };
  },
};

const paperDeskStrategyAction: Action = {
  name: "paper_desk_strategy",
  similes: ["change_paper_strategy", "set_desk_strategy", "test_desk_strategy", "paper_strategy"],
  description:
    "Test, then optionally switch, the strategy one market of your paper desk trades. It is always backtested first on that market's hourly DEX history, beside the strategy trading it now; with apply=true the market switches from the next hour (the current position is sold at the last close on paper) and the operator is told. " +
    "Give a preset (" +
    Object.keys(PRESETS).join(", ") +
    ") or your own rules: entry (and exit, stopLossPct, takeProfitPct, trailPct, maxBars). Periods count hourly bars. Rules: " +
    ruleHelp().split("\n")[0],
  parameters: {
    type: "object",
    properties: {
      market: { type: "string", enum: [...MARKET_IDS], description: "The market whose strategy to test or change." },
      preset: { type: "string", enum: Object.keys(PRESETS), description: "A ready strategy instead of your own rules." },
      name: { type: "string", description: "A short name for your own strategy." },
      entry: { type: "string", description: "Buy condition, e.g. ema(close, 12) > ema(close, 26)." },
      exit: { type: "string", description: "Sell condition." },
      stopLossPct: { type: "number" },
      takeProfitPct: { type: "number" },
      trailPct: { type: "number" },
      maxBars: { type: "number" },
      apply: { type: "boolean", description: "Switch the market to it after the test. Default false: test only." },
      why: { type: "string", description: "Why the switch, in one line (kept with the strategy and sent to the operator)." },
    },
    required: ["market"],
  },
  examples: [
    { user: "try an RSI dip on SOL", agent: "(paper_desk_strategy market SOL preset rsi_dip) On 220 days it made +4% vs holding −9%…" },
  ],
  async validate(runtime) {
    return Boolean(getDesk(runtime));
  },
  async handler(runtime, _state, params) {
    const desk = getDesk(runtime)!;
    const market = String(params.market ?? "").toUpperCase();
    if (!isMarketId(market)) return { ok: false, text: `market must be one of ${MARKET_IDS.join(", ")}` };
    let spec: StrategySpec;
    try {
      if (typeof params.preset === "string" && params.preset) {
        spec = expandStrategies([params.preset], [])[0]!;
      } else if (typeof params.entry === "string" && params.entry.trim()) {
        const num = (k: string) => (typeof params[k] === "number" && Number.isFinite(params[k]) && (params[k] as number) > 0 ? { [k]: params[k] as number } : {});
        spec = {
          name: (typeof params.name === "string" && params.name.trim()) || "custom",
          entry: params.entry.trim(),
          ...(typeof params.exit === "string" && params.exit.trim() ? { exit: params.exit.trim() } : {}),
          ...num("stopLossPct"),
          ...num("takeProfitPct"),
          ...num("trailPct"),
          ...num("maxBars"),
        };
        compileStrategies([spec]);
      } else {
        return { ok: false, text: "give a preset, or an entry rule" };
      }
      const tested = await desk.testStrategy(market, spec);
      if (params.apply !== true) return { ok: true, text: `${tested.text}\nNot switched (apply=true switches ${market} to it).` };
      const best = tested.result.results.find((r) => r.spec.name === spec.name)!;
      const why = (typeof params.why === "string" && params.why.trim()) || `chosen in conversation; backtest: ${resultLine(best, tested.result.benchmark)}`;
      return { ok: true, text: `${tested.text}\n${await desk.setStrategy(market, spec, why)}` };
    } catch (err) {
      return { ok: false, text: `paper_desk_strategy: ${(err as Error).message}` };
    }
  },
};

const paperDeskProvider: Provider = {
  name: "paper_desk",
  async get(runtime) {
    return getDesk(runtime)?.summaryLine() ?? "";
  },
};

export const deskPlugin: Plugin = {
  name: "desk",
  description: "The paper desk: Lain's $100 demo account on five DEX markets, each traded hourly by a backtested strategy; fills and a daily report to the operator.",
  actions: [paperDeskAction, paperDeskStrategyAction],
  providers: [paperDeskProvider],
  services: [new PaperDeskService()],
};
