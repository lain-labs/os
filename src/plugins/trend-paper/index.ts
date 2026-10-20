/**
 * Trend paper: LAIN (in ETH) and CYBER.sol (in SOL) traded on paper by one
 * trend rule (strategy.ts), each with its own virtual balance.
 *
 * Every hour, `checkMinute` minutes after the bar closes, the routines
 * scheduler runs check(): each feed's closed bars and live pool are read,
 * every bar since the last one read goes through the rule, fills are booked
 * in the ledger, and each fill becomes an event. Once a day it runs report().
 * The scheduler runs only in the daemon, so a TUI session never trades the
 * same books a second time.
 *
 * Paper is the only mode (config.MODE). This module reads markets and writes
 * its own files; it never asks the runtime for a wallet, a signer or an
 * action, and its events are text the daemon delivers to the operator alone
 * (scripts/serve.ts). scripts/trend-paper-smoke.ts fails the build if any
 * path to a real order becomes reachable from here.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../../logger.js";
import type { IAgentRuntime, Plugin, Service } from "../../types.js";
import type { RoutineService } from "../skills/routines.js";
import { ASSETS, MODE, resolveConfig, type AssetId, type TrendPaperConfig } from "./config.js";
import { Ledger, type AssetState, type JournalEntry, type TrendPaperState } from "./ledger.js";
import { FEEDS, type Feed, type Fetch, type MarketEnv, type Snapshot } from "./market.js";
import { ema, equity, fmt, maxDrawdown, newBook, step, type Decision } from "./strategy.js";

const log = createLogger("plugin:trend-paper");
const HOUR = 3_600_000;

export interface TrendPaperEvent {
  kind: "trade" | "report" | "error";
  asset?: AssetId;
  text: string;
}

export interface TrendPaperDeps {
  fetch?: Fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  feeds?: Record<AssetId, Feed>;
}

const TOKEN: Record<AssetId, string> = { LAIN: "LAIN", CYBER: "CYBER" };
const QUOTE: Record<AssetId, "ETH" | "SOL"> = { LAIN: "ETH", CYBER: "SOL" };
const ICON: Record<Decision["action"], string> = { buy: "🟢", sell_partial: "🟡", sell: "🔴", skip: "⚪" };
const VERB: Record<Decision["action"], string> = { buy: "BUY", sell_partial: "SELL 50%", sell: "SELL ALL", skip: "SKIP" };

const utc = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
const pct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;

export class TrendPaperService implements Service {
  readonly name = "trend-paper";

  private dir = "";
  private cfg: TrendPaperConfig = resolveConfig();
  private ledger?: Ledger;
  private busy = false;
  private cancels: (() => void)[] = [];
  private subscribers = new Set<(event: TrendPaperEvent) => void>();

  constructor(private readonly deps: TrendPaperDeps = {}) {}

  async start(runtime: IAgentRuntime): Promise<void> {
    this.dir = join(runtime.getSetting("LAINOS_DATA_DIR") ?? "./data", "trend-paper");
    this.ledger = new Ledger(this.dir);
    try {
      this.cfg = await this.readConfig();
    } catch (err) {
      log.error(`not scheduled: ${(err as Error).message}`);
      return;
    }
    const routines = runtime.getService<RoutineService>("routines");
    if (!routines?.schedule) {
      log.warn("not scheduled: the routines service is not loaded");
      return;
    }
    this.cancels.push(
      routines.schedule({ name: "trend-paper:check", trigger: { kind: "hourly", minute: this.cfg.checkMinute }, run: () => this.check().then(() => undefined) }),
      routines.schedule({ name: "trend-paper:report", trigger: { kind: "daily", at: this.cfg.reportAt, timeZone: this.cfg.reportTimeZone }, run: () => this.report().then(() => undefined) }),
    );
    log.info(`${MODE} only · LAIN/ETH and CYBER/SOL · bars read at :${String(this.cfg.checkMinute).padStart(2, "0")}, report ${this.cfg.reportAt} ${this.cfg.reportTimeZone}${routines.active ? "" : " (scheduler runs in the daemon)"}`);
  }

  async stop(): Promise<void> {
    for (const cancel of this.cancels.splice(0)) cancel();
  }

  onEvent(fn: (event: TrendPaperEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /** Point the service at a directory without a runtime (the backtest script, tests). */
  async open(dir: string): Promise<void> {
    this.dir = dir;
    this.ledger = new Ledger(dir);
    this.cfg = await this.readConfig();
  }

  get config(): TrendPaperConfig {
    return this.cfg;
  }

  /** Read every bar that closed since the last check, for both books; returns what happened, as text. */
  async check(): Promise<string> {
    if (this.busy || !this.ledger) return "a check is already running";
    this.busy = true;
    try {
      const state = await this.ledger.load(this.cfg.capital);
      const entries: JournalEntry[] = [];
      const events: TrendPaperEvent[] = [];
      for (const asset of ASSETS) {
        const before = state.assets[asset]?.error ?? "";
        try {
          const snap = await this.feeds()[asset].read(this.env());
          for (const d of this.advance(state, asset, snap)) {
            entries.push(this.entry(asset, d, state.assets[asset]!));
            if (d.action !== "skip") events.push({ kind: "trade", asset, text: this.tradeText(asset, d, state.assets[asset]!, state.capital[asset]) });
          }
          state.assets[asset]!.error = "";
        } catch (err) {
          const message = (err as Error).message.split("\n")[0]!.slice(0, 300);
          log.warn(`${asset}: ${message}`);
          const a = state.assets[asset];
          if (a) a.error = message;
          if (!before) events.push({ kind: "error", asset, text: `⚠️ Trend paper · ${asset}: this hour's bar could not be read — ${message}. It is read on the next check.` });
        }
      }
      await this.ledger.commit(state, entries);
      for (const ev of events) this.emit(ev);
      if (state.lastReportAt === null && ASSETS.every((a) => state.assets[a])) await this.report();
      return entries.length ? entries.map((e) => `${e.asset} ${e.action}: ${e.reason}`).join("\n") : "no fills this hour";
    } finally {
      this.busy = false;
    }
  }

  /** The daily report: both books against holding, delivered as an event and returned. */
  async report(): Promise<string> {
    if (!this.ledger) return "trend paper is not started";
    const state = await this.ledger.load(this.cfg.capital);
    const journal = await this.ledger.journal();
    const text = this.reportText(state, journal);
    state.lastReportAt = this.now();
    await this.ledger.commit(state, []);
    this.emit({ kind: "report", text });
    return text;
  }

  /** Bars past the book's last one, through the rule, oldest first. */
  private advance(state: TrendPaperState, asset: AssetId, snap: Snapshot): Decision[] {
    const bars = snap.bars;
    const n = bars.length;
    if (n < 2) throw new Error(`only ${n} closed hourly bars`);
    let a = state.assets[asset];
    if (!a) {
      // A new book starts on the latest closed bar: it is read now, as every later one will be.
      a = state.assets[asset] = {
        book: newBook(state.capital[asset]),
        startedAt: bars[n - 1]!.t + HOUR,
        startPx: bars[n - 1]!.c,
        lastBar: bars[n - 2]!.t,
        marks: [],
        liquidity: null,
        error: "",
      };
    }
    a.liquidity = snap.liquidity;
    const emas = ema(bars.map((b) => b.c), this.cfg.emaPeriod);
    const out: Decision[] = [];
    for (let i = 0; i < n; i++) {
      if (bars[i]!.t <= a.lastBar) continue;
      // Missed bars replay with their own liquidity; the newest is judged against the pool as it is now.
      const d = step(a.book, bars, emas, i, this.cfg, i === n - 1 ? snap.liquidity : undefined);
      if (d) out.push(d);
      a.lastBar = bars[i]!.t;
      a.marks.push([bars[i]!.t + HOUR, equity(a.book, bars[i]!.c), bars[i]!.c]);
    }
    return out;
  }

  private entry(asset: AssetId, d: Decision, a: AssetState): JournalEntry {
    return {
      time: new Date(d.at).toISOString(),
      asset,
      mode: MODE,
      action: d.action,
      price: d.price,
      ema: d.ema,
      volume: d.volume,
      median_volume: d.medianVolume,
      liquidity: d.liquidity,
      reason: d.reason,
      quote: d.quote,
      tokens: d.tokens,
      fee: d.fee,
      balance_after: { [QUOTE[asset]]: a.book.cash, [TOKEN[asset]]: a.book.qty },
    };
  }

  private tradeText(asset: AssetId, d: Decision, a: AssetState, capital: number): string {
    const q = QUOTE[asset];
    const moved =
      d.action === "buy"
        ? `${fmt(d.quote)} ${q} → ${fmt(d.tokens)} ${asset} (cost ${fmt(d.fee)} ${q})`
        : `${fmt(d.tokens)} ${asset} → ${fmt(d.quote)} ${q} (cost ${fmt(d.fee)} ${q})`;
    const value = equity(a.book, d.price);
    return [
      `${ICON[d.action]} Trend paper · ${asset} ${VERB[d.action]} at ${fmt(d.price)} ${q} — bar closed ${utc(d.at)}`,
      `why: ${d.reason}`,
      `EMA${this.cfg.emaPeriod} ${fmt(d.ema)} · volume ${fmt(d.volume)} ${q} · pool ${d.liquidity === null ? "?" : `${fmt(d.liquidity)} ${q}`}`,
      moved,
      `balance: ${fmt(a.book.cash)} ${q} + ${fmt(a.book.qty)} ${asset} ≈ ${fmt(value)} ${q} (${pct(value / capital - 1)} since start)`,
      `paper only — no order was sent`,
    ].join("\n");
  }

  private reportText(state: TrendPaperState, journal: JournalEntry[]): string {
    const lines = [`📒 Trend paper · daily report · ${utc(this.now())}`, `paper only — virtual balances, no orders sent`];
    for (const asset of ASSETS) {
      const a = state.assets[asset];
      const q = QUOTE[asset];
      if (!a) {
        lines.push("", `${asset}: not started — its first bar has not been read yet`);
        continue;
      }
      const capital = state.capital[asset];
      const lastPx = a.marks.at(-1)?.[2] ?? a.startPx;
      const value = equity(a.book, lastPx);
      const hold = ((capital * (1 - this.cfg.costRate)) / a.startPx) * lastPx;
      const fills = journal.filter((e) => e.asset === asset && e.action !== "skip").length;
      const skips = journal.filter((e) => e.asset === asset && e.action === "skip").length;
      const { roundTrips, wins } = a.book;
      lines.push(
        "",
        `${asset} (${q}) · since ${utc(a.startedAt)}`,
        `  balance ${fmt(value)} ${q} (${pct(value / capital - 1)}) vs just holding ${fmt(hold)} ${q} (${pct(hold / capital - 1)})`,
        `  now: ${a.book.qty > 0 ? `in — ${fmt(a.book.qty)} ${asset} from ${fmt(a.book.entryPx)}${a.book.cash > 0 ? ` + ${fmt(a.book.cash)} ${q}` : ""}` : `out — ${fmt(a.book.cash)} ${q}`}`,
        `  trades: ${fills} fills, ${roundTrips} closed · profitable ${roundTrips ? `${wins}/${roundTrips} (${Math.round((100 * wins) / roundTrips)}%)` : "n/a"}${skips ? ` · ${skips} entries skipped (liquidity)` : ""}`,
        `  max drawdown ${(100 * maxDrawdown([capital, ...a.marks.map((m) => m[1])])).toFixed(1)}% · pool ${a.liquidity === null ? "?" : `${fmt(a.liquidity)} ${q}`} · last close ${fmt(lastPx)} ${q}`,
      );
      if (a.error) lines.push(`  ⚠ last read failed: ${a.error}`);
    }
    return lines.join("\n");
  }

  private async readConfig(): Promise<TrendPaperConfig> {
    let text: string;
    try {
      text = await readFile(join(this.dir, "config.json"), "utf8");
    } catch {
      return resolveConfig();
    }
    return resolveConfig(JSON.parse(text));
  }

  private feeds(): Record<AssetId, Feed> {
    return this.deps.feeds ?? FEEDS;
  }

  private env(): MarketEnv {
    return {
      fetch: this.deps.fetch ?? ((url, init) => fetch(url, init)),
      dir: join(this.dir, "market"),
      now: () => this.now(),
      sleep: this.deps.sleep,
    };
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private emit(event: TrendPaperEvent): void {
    for (const fn of this.subscribers) {
      try {
        fn(event);
      } catch {
        /* a broken subscriber must never break the books */
      }
    }
  }
}

export const trendPaperPlugin: Plugin = {
  name: "trend-paper",
  description: "Paper-only trend strategy on LAIN (ETH, Robinhood Chain) and CYBER.sol (SOL, Solana): hourly checks, a JSONL journal, reports to the operator.",
  services: [new TrendPaperService()],
};
