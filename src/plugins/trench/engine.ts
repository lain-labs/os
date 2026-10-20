/**
 * The trench engine: paper-trading memecoins fresh off the PONS launchpad.
 *
 * A fast, rule-driven loop — trenching is a game of seconds, and a model call
 * per decision would lose it. Every tick (15 s by default) it reads the new
 * curve trades and launches, keeps a rolling picture of each young curve
 * (buys, distinct wallets, net inflow, the creator tax it charges), and:
 *
 *   - enters a curve whose momentum clears the rules, at the curve's live
 *     state, sized at a fixed paper amount;
 *   - walks every open position: half off at the take-profit, the rest on a
 *     trailing stop from its high; a stop-loss; a time limit; and a close at
 *     the last curve price when the curve graduates to its v4 pool.
 *
 * It only ever trades on paper — there is no execution path in here at all.
 * Fills book into the paper account of Robinhood Chain (the same cash and
 * journal /paper shows), so a trench result and a hand-placed paper trade add
 * up in one place. Lain watches it: she reads the state through the trench
 * tool, comments, and changes the rules when the operator asks.
 */
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { formatEther, parseEther, type PublicClient } from "viem";
import { createLogger } from "../../logger.js";
import type { ChainService } from "../chain/index.js";
import type { IAgentRuntime, Service } from "../../types.js";
import {
  buyOut,
  clockFrom,
  curveActivity,
  curveStates,
  curveTokens,
  DEFAULT_TAX_BPS,
  launches,
  measureBlocks,
  NATIVE_PAIR,
  netIn,
  PONS_CHAIN_ID,
  progress,
  sellOut,
  symbols,
  withOwn,
  type BlockAnchor,
  type CurveState,
  type CurveTrade,
  type Launch,
} from "./pons.js";

const log = createLogger("plugin:trench");

/** The rules, in the units an operator types them in. */
export interface TrenchRules {
  /** Paper ETH per entry. */
  sizeNative: number;
  maxOpen: number;
  /** Only tokens launched within this many minutes. */
  maxAgeMin: number;
  /** The momentum window, minutes. */
  windowMin: number;
  minBuys: number;
  /** Distinct receiving wallets buying in the window. */
  minBuyers: number;
  /** Net ETH into the curve in the window (buys − sells). */
  minInflowNative: number;
  /** Curve progress to graduation, percent. */
  minProgressPct: number;
  maxProgressPct: number;
  /** Highest creator tax accepted, percent. */
  maxTaxPct: number;
  /** Sell half once the position is up this much, percent. */
  takeProfitPct: number;
  /** After the take-profit, sell the rest when it falls this far from its high, percent. */
  trailPct: number;
  stopLossPct: number;
  maxHoldMin: number;
  /** No re-entry into a token closed this recently, minutes. */
  cooldownMin: number;
}

export const DEFAULT_RULES: TrenchRules = {
  sizeNative: 0.02,
  maxOpen: 5,
  maxAgeMin: 30,
  windowMin: 5,
  minBuys: 8,
  minBuyers: 5,
  minInflowNative: 0.1,
  minProgressPct: 3,
  maxProgressPct: 60,
  maxTaxPct: 5,
  takeProfitPct: 100,
  trailPct: 25,
  stopLossPct: 30,
  maxHoldMin: 45,
  cooldownMin: 60,
};

/** What each rule means, for the tool description and /trench rules. */
export const RULE_HELP: Record<keyof TrenchRules, string> = {
  sizeNative: "paper ETH per entry",
  maxOpen: "most positions open at once",
  maxAgeMin: "only tokens launched within N minutes",
  windowMin: "momentum window, minutes",
  minBuys: "buys in the window",
  minBuyers: "distinct buying wallets in the window",
  minInflowNative: "net ETH in during the window",
  minProgressPct: "lowest curve progress to graduation, %",
  maxProgressPct: "highest curve progress to graduation, %",
  maxTaxPct: "highest creator tax, %",
  takeProfitPct: "sell half at this gain, %",
  trailPct: "then trail the rest this far below its high, %",
  stopLossPct: "stop-loss, %",
  maxHoldMin: "time exit, minutes",
  cooldownMin: "no re-entry into a closed token for N minutes",
};

export interface TrenchPosition {
  token: string;
  curve: string;
  symbol: string;
  /** Tokens still held, raw. */
  qty: string;
  /** Basis of the tokens still held, wei. */
  cost: string;
  /** Spent on entry, wei. */
  spent: string;
  /** Realised so far (a half sold at the take-profit), wei of proceeds. */
  proceeds: string;
  openedAt: number;
  taxBps: number;
  /** The signal it was entered on, in words. */
  why: string;
  tpDone: boolean;
  /** Best sell-side value per whole token seen, wei. */
  peakPx: string;
  /** Last marked value of the tokens still held, wei, and curve progress. */
  markValue: string;
  markProgress: number;
  markedAt: number;
  /** Return at each mark, percent — the position's sparkline (last 40). */
  marks?: number[];
}

export interface TrenchClosed {
  token: string;
  symbol: string;
  spent: string;
  proceeds: string;
  pnl: string;
  pnlPct: number;
  openedAt: number;
  closedAt: number;
  reason: string;
  why: string;
}

export interface TrenchEvent {
  /** `tick` carries no text: it only says a scan finished and the board can redraw. */
  kind: "open" | "close" | "note" | "tick";
  text: string;
}

/** One of the hottest curves right now, and what the rules make of it. */
export interface RadarRow {
  curve: string;
  token?: string;
  symbol: string;
  buys: number;
  buyers: number;
  /** Net ETH in during the window, wei. */
  inflow: bigint;
  /** Minutes since launch; null when it launched before the scan horizon. */
  ageMin: number | null;
  progress: number | null;
  taxBps: number;
  /** "in" when held, "next" when it clears every rule, else the first rule it fails. */
  verdict: string;
}

/** Everything the live board draws, in one read. */
export interface TrenchSnapshot {
  enabled: boolean;
  blocker: string | null;
  error: string;
  lastTick: number;
  intervalMs: number;
  head: bigint | null;
  cash: bigint;
  start: bigint;
  /** Equity (cash + open marks) per scan, wei, oldest first. */
  equity: { ts: number; wei: bigint }[];
  positions: TrenchPosition[];
  radar: RadarRow[];
  /** Latest curve trades across the launchpad, newest last, with symbols where known. */
  tape: (CurveTrade & { symbol: string; seenAt: number })[];
  /** Entries, exits and notes as they happened, newest last. */
  journal: { at: number; kind: TrenchEvent["kind"]; text: string }[];
  closed: TrenchClosed[];
  rules: TrenchRules;
  /** Curve trades seen in the last scan — the pulse of the launchpad. */
  lastScanTrades: number;
  /** Trades per scan, oldest first (last 60 scans). */
  pulse: number[];
  launchesSeen: number;
}

interface TrenchFile {
  enabled: boolean;
  rules: Partial<TrenchRules>;
  positions: TrenchPosition[];
  closed: TrenchClosed[];
}

interface CurveWindow {
  trades: CurveTrade[];
  taxBps: number;
}

const CLOSED_CAP = 300;
const TAPE_CAP = 120;
const EQUITY_CAP = 180;
const MARKS_CAP = 40;
const RADAR_SIZE = 8;
/** Curves read for the radar each scan — more than it shows, since non-ETH pairs drop out. */
const RADAR_POOL = 14;
/** Re-measure the block interval this often; between, the clock extrapolates. */
const CLOCK_REFRESH_MS = 300_000;
/** Robinhood Chain's eth_getLogs ceiling is 30k blocks; stay under it. */
const MAX_RANGE = 25_000n;
const SECONDS_PER_BLOCK = 0.1;

export class TrenchService implements Service {
  readonly name = "trench";

  private runtime?: IAgentRuntime;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private file = "";
  private state: TrenchFile = { enabled: false, rules: {}, positions: [], closed: [] };
  private cursor: bigint | null = null;
  private readonly windows = new Map<string, CurveWindow>();
  private readonly launched = new Map<string, Launch>();
  private readonly cooldown = new Map<string, number>();
  /** Curves that emitted CurveCompleted — gone to their v4 pool. */
  private readonly completed = new Set<string>();
  private readonly subscribers = new Set<(event: TrenchEvent) => void>();
  private lastTickAt = 0;
  private lastError = "";
  private intervalMs = 15_000;
  private unregister?: () => void;
  /** The paper account's cash ran out — said once, not every tick. */
  private brokeNoted = false;
  private anchor?: BlockAnchor & { at: number };
  private head: bigint | null = null;
  private tape: (CurveTrade & { seenAt: number })[] = [];
  private journal: TrenchSnapshot["journal"] = [];
  private equity: TrenchSnapshot["equity"] = [];
  private radarRows: RadarRow[] = [];
  private lastScanTrades = 0;
  private pulse: number[] = [];
  /** token → symbol, and curve → token, learned as they come up. */
  private readonly names = new Map<string, string>();
  private readonly curveToken = new Map<string, string>();

  async start(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
    const dataDir = runtime.getSetting("LAINOS_DATA_DIR") ?? "./data";
    this.file = join(dataDir, "paper", String(PONS_CHAIN_ID), "trench.json");
    await this.load();
    const forced = runtime.getSetting("LAINOS_TRENCH");
    if (forced === "1" && !this.stored) this.state.enabled = true;
    this.intervalMs = Math.max(3_000, Number(runtime.getSetting("LAINOS_TRENCH_INTERVAL_MS")) || 5_000);
    this.timer = setInterval(() => void this.safeTick(), this.intervalMs);
    this.timer.unref?.();
    // /paper and the trader loop learn that PONS positions are this engine's.
    const chain = runtime.getService<ChainService>("chain");
    this.unregister = chain?.registerVenue({
      name: "PONS curve",
      owns: (token) => this.state.positions.some((p) => p.token === token.toLowerCase()),
      value: async (token) => {
        const pos = this.state.positions.find((p) => p.token === token.toLowerCase());
        return pos ? BigInt(pos.markValue) : null;
      },
    });
    if (this.state.enabled) log.info("trenching on paper — PONS v2 on Robinhood Chain");
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unregister?.();
  }

  onEvent(fn: (event: TrenchEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  get enabled(): boolean {
    return this.state.enabled;
  }

  get rules(): TrenchRules {
    return { ...DEFAULT_RULES, ...this.state.rules };
  }

  get positions(): readonly TrenchPosition[] {
    return this.state.positions;
  }

  get closed(): readonly TrenchClosed[] {
    return this.state.closed;
  }

  get lastTick(): number {
    return this.lastTickAt;
  }

  get error(): string {
    return this.lastError;
  }

  get interval(): number {
    return this.intervalMs;
  }

  /** Why the engine cannot trade right now, or null. */
  blocker(): string | null {
    const chain = this.runtime?.getService<ChainService>("chain");
    if (!chain?.configured) return "no chain is configured";
    if (chain.chain.id !== PONS_CHAIN_ID) {
      return `PONS lives on Robinhood Chain (${PONS_CHAIN_ID}); this process is on ${chain.chain.name} (${chain.chain.id}) — /network robinhood`;
    }
    return null;
  }

  async setEnabled(on: boolean): Promise<void> {
    this.state.enabled = on;
    this.cursor = null; // a fresh start re-reads the recent past instead of a stale gap
    this.brokeNoted = false;
    await this.persist();
    log.info(on ? "trenching on paper — on" : "trenching — off");
    if (on) void this.safeTick();
  }

  /** Change one rule; returns the error in words, or null. */
  async setRule(key: string, raw: string): Promise<string | null> {
    const name = (Object.keys(DEFAULT_RULES) as (keyof TrenchRules)[]).find((k) => k.toLowerCase() === key.toLowerCase());
    if (!name) return `unknown rule "${key}" — one of: ${Object.keys(DEFAULT_RULES).join(", ")}`;
    if (raw.trim().toLowerCase() === "default") {
      delete this.state.rules[name];
    } else {
      const value = Number(raw.replace("%", "").replace(",", "."));
      if (!Number.isFinite(value) || value < 0) return `${name} must be a non-negative number, not "${raw}"`;
      if (name === "sizeNative" && value <= 0) return "sizeNative must be above 0";
      this.state.rules[name] = value;
    }
    await this.persist();
    return null;
  }

  /** Close one position (or all) at the curve's live state. */
  async close(symbolOrToken: string): Promise<string> {
    const needle = symbolOrToken.trim().toLowerCase();
    const targets = this.state.positions.filter(
      (p) => needle === "all" || p.symbol.toLowerCase() === needle || p.token === needle,
    );
    if (!targets.length) return `no open trench position matches "${symbolOrToken}".`;
    const client = this.client();
    if (!client) return this.blocker() ?? "chain unavailable";
    const states = await curveStates(client, targets.map((p) => p.curve));
    const lines: string[] = [];
    for (const pos of targets) {
      const state = states.get(pos.curve);
      lines.push(await this.exit(pos, state, BigInt(pos.qty), "closed by hand"));
    }
    await this.persist();
    return lines.join("\n");
  }

  // ---------------------------------------------------------------- loop

  private async safeTick(): Promise<void> {
    if (!this.state.enabled || this.ticking) return;
    this.ticking = true;
    try {
      await this.tick();
      this.lastError = "";
    } catch (err) {
      this.lastError = (err as Error).message.split("\n")[0]!.slice(0, 200);
      log.warn("trench tick failed", err);
    } finally {
      this.ticking = false;
    }
  }

  /** One pass: read what happened, walk the open positions, then look for entries. */
  async tick(): Promise<void> {
    const client = this.client();
    if (!client) return;
    this.lastTickAt = Date.now();
    const rules = this.rules;
    const head = await client.getBlockNumber();
    this.head = head;
    const ageBlocks = BigInt(Math.ceil((rules.maxAgeMin * 60) / SECONDS_PER_BLOCK));
    const windowBlocks = BigInt(Math.ceil((rules.windowMin * 60) / SECONDS_PER_BLOCK));
    const fresh = this.cursor === null;
    const from = fresh ? head - windowBlocks : this.cursor! + 1n;
    if (from <= head) {
      const start = head - from > MAX_RANGE ? head - MAX_RANGE : from;
      const launchFrom = fresh ? head - (ageBlocks > MAX_RANGE ? MAX_RANGE : ageBlocks) : start;
      // Two block headers every few minutes; in between the clock extrapolates.
      if (!this.anchor || Date.now() - this.anchor.at > CLOCK_REFRESH_MS) {
        this.anchor = { ...(await measureBlocks(client, head)), at: Date.now() };
      }
      const clock = clockFrom(this.anchor);
      const [activity, born] = await Promise.all([
        curveActivity(client, start, head, clock),
        launches(client, launchFrom, head, clock),
      ]);
      for (const l of born) {
        this.launched.set(l.curve, l);
        this.curveToken.set(l.curve, l.token);
      }
      for (const curve of activity.completed) this.completed.add(curve);
      for (const t of activity.trades) {
        const w = this.windows.get(t.curve) ?? { trades: [], taxBps: DEFAULT_TAX_BPS };
        w.trades.push(t);
        w.taxBps = t.taxBps;
        this.windows.set(t.curve, w);
      }
      // The tape gets this scan's trades in chain order, stamped with when we saw them.
      const seenAt = Date.now();
      const scanned = [...activity.trades].sort((a, b) => (a.block === b.block ? 0 : a.block < b.block ? -1 : 1));
      this.tape = [...this.tape, ...scanned.map((t) => ({ ...t, seenAt }))].slice(-TAPE_CAP);
      this.lastScanTrades = activity.trades.length;
      if (!fresh) this.pulse = [...this.pulse, activity.trades.length].slice(-60);
      this.cursor = head;
    }
    const now = Math.floor(Date.now() / 1000);
    this.prune(now, rules);

    const book = await this.book();
    if (!book) return;

    // Exits first: they free the slots and the cash entries need.
    const held = this.state.positions.map((p) => p.curve);
    const candidates = this.candidates(now, rules);
    const hottest = this.hottest();
    const states = await curveStates(client, [
      ...new Set([...held, ...candidates.map((c) => c.curve), ...hottest.map((h) => h.curve)]),
    ]);
    for (const [curve, st] of states) this.curveToken.set(curve, st.token.toLowerCase());
    for (const pos of [...this.state.positions]) {
      await this.walk(pos, states.get(pos.curve), rules);
    }

    const room = rules.maxOpen - this.state.positions.length;
    if (room > 0 && candidates.length) {
      const picks: { c: (typeof candidates)[number]; state: CurveState }[] = [];
      for (const c of candidates) {
        const state = states.get(c.curve);
        if (!state || state.pairToken.toLowerCase() !== NATIVE_PAIR) continue;
        const pct = progress(state) * 100;
        if (pct < rules.minProgressPct || pct > rules.maxProgressPct) continue;
        picks.push({ c, state });
        if (picks.length >= room) break;
      }
      await this.learnNames(client, picks.map((p) => p.c.token));
      for (const { c, state } of picks) {
        await this.enter(c, state, this.names.get(c.token) ?? "?", rules, book);
      }
    }

    // What the board shows: the radar, the tape's symbols, the equity line.
    // Older curves on the tape launched before the scan horizon: ask them their token.
    const nameless = [...new Set(this.tape.slice(-40).map((t) => t.curve))].filter((c) => !this.curveToken.has(c)).slice(0, 20);
    if (nameless.length) {
      try {
        for (const [curve, token] of await curveTokens(client, nameless)) this.curveToken.set(curve, token);
      } catch {
        // Decoration only.
      }
    }
    await this.learnNames(client, [
      ...hottest.map((h) => this.curveToken.get(h.curve)),
      ...this.tape.slice(-40).map((t) => this.curveToken.get(t.curve)),
    ].filter((t): t is string => Boolean(t)));
    this.radarRows = this.radar(hottest, states, now, rules, book.cashWei);
    const openValue = this.state.positions.reduce((sum, p) => sum + BigInt(p.markValue), 0n);
    this.equity = [...this.equity, { ts: Date.now(), wei: book.cashWei + openValue }].slice(-EQUITY_CAP);
    await this.persist();
    this.emit({ kind: "tick", text: "" });
  }

  /** The curves with the most net ETH coming in right now, whatever the rules say of them. */
  private hottest(): { curve: string; buys: number; buyers: number; inflow: bigint; taxBps: number }[] {
    const rows: { curve: string; buys: number; buyers: number; inflow: bigint; taxBps: number }[] = [];
    for (const [curve, w] of this.windows) {
      if (this.completed.has(curve)) continue;
      const stats = windowStats(w);
      // Only curves money is flowing into; a quiet launchpad shows a short radar.
      if (stats.buys === 0 || stats.inflow <= 0n) continue;
      rows.push({ curve, ...stats, taxBps: w.taxBps });
    }
    return rows.sort((a, b) => (a.inflow === b.inflow ? 0 : a.inflow > b.inflow ? -1 : 1)).slice(0, RADAR_POOL);
  }

  /** The hottest curves with the first rule each one fails — or "in" / "next". */
  private radar(
    hottest: ReturnType<TrenchService["hottest"]>,
    states: Map<string, CurveState>,
    now: number,
    rules: TrenchRules,
    cash: bigint,
  ): RadarRow[] {
    const heldCurves = new Set(this.state.positions.map((p) => p.curve));
    const minInflow = parseEther(String(rules.minInflowNative));
    // Curves paired with USDG or a stock token count their inflow in that
    // currency, and the engine never trades them: they stay off the radar.
    const ethPaired = hottest.filter((h) => {
      const pair = this.launched.get(h.curve)?.pairToken ?? states.get(h.curve)?.pairToken.toLowerCase();
      return pair === undefined || pair === NATIVE_PAIR;
    });
    return ethPaired.slice(0, RADAR_SIZE).map((h) => {
      const born = this.launched.get(h.curve);
      const state = states.get(h.curve);
      const token = born?.token ?? this.curveToken.get(h.curve);
      const ageMin = born ? (now - born.ts) / 60 : null;
      const prog = state ? progress(state) : null;
      const cooled = token ? this.cooldown.get(token) : undefined;
      let verdict = "next";
      if (heldCurves.has(h.curve)) verdict = "in";
      else if (state && state.pairToken.toLowerCase() !== NATIVE_PAIR) verdict = "not ETH";
      else if (ageMin === null || ageMin > rules.maxAgeMin) verdict = "too old";
      else if (cooled && now - cooled < rules.cooldownMin * 60) verdict = "cooldown";
      else if (h.taxBps > rules.maxTaxPct * 100) verdict = `tax ${(h.taxBps / 100).toFixed(0)}%`;
      else if (h.buys < rules.minBuys) verdict = `${h.buys}/${rules.minBuys} buys`;
      else if (h.buyers < rules.minBuyers) verdict = `${h.buyers}/${rules.minBuyers} wallets`;
      else if (h.inflow < minInflow) verdict = "thin inflow";
      else if (prog === null) verdict = "no read";
      else if (prog * 100 < rules.minProgressPct) verdict = "too early";
      else if (prog * 100 > rules.maxProgressPct) verdict = "too late";
      else if (this.state.positions.length >= rules.maxOpen) verdict = "slots full";
      else if (cash < parseEther(String(rules.sizeNative))) verdict = "no cash";
      return {
        curve: h.curve,
        token,
        symbol: (token && this.names.get(token)) || `${h.curve.slice(0, 8)}…`,
        buys: h.buys,
        buyers: h.buyers,
        inflow: h.inflow,
        ageMin,
        progress: prog,
        taxBps: h.taxBps,
        verdict,
      };
    });
  }

  /** Symbols for tokens not yet named (one multicall, at most 40 per scan). */
  private async learnNames(client: PublicClient, tokens: string[]): Promise<void> {
    const missing = [...new Set(tokens)].filter((t) => !this.names.has(t)).slice(0, 40);
    if (!missing.length) return;
    try {
      for (const [token, name] of await symbols(client, missing)) this.names.set(token, name);
    } catch {
      // Names are decoration; a failed read leaves the address showing.
    }
  }

  /** Everything the live board draws. */
  async snapshot(): Promise<TrenchSnapshot> {
    const book = await this.book();
    return {
      enabled: this.state.enabled,
      blocker: this.blocker(),
      error: this.lastError,
      lastTick: this.lastTickAt,
      intervalMs: this.intervalMs,
      head: this.head,
      cash: book?.cashWei ?? 0n,
      start: book?.startWei ?? 0n,
      equity: this.equity,
      positions: this.state.positions,
      radar: this.radarRows,
      tape: this.tape.map((t) => {
        const token = this.curveToken.get(t.curve);
        return { ...t, symbol: (token && this.names.get(token)) || `${t.curve.slice(0, 8)}…` };
      }),
      journal: this.journal,
      closed: this.state.closed,
      rules: this.rules,
      lastScanTrades: this.lastScanTrades,
      pulse: this.pulse,
      launchesSeen: this.launched.size,
    };
  }

  /** Young ETH-paired curves whose window clears the momentum rules, strongest inflow first. */
  private candidates(now: number, rules: TrenchRules) {
    const held = new Set(this.state.positions.map((p) => p.curve));
    const out: { curve: string; token: string; buys: number; buyers: number; inflow: bigint; ageMin: number; taxBps: number }[] = [];
    const minInflow = parseEther(String(rules.minInflowNative));
    for (const [curve, w] of this.windows) {
      const born = this.launched.get(curve);
      if (!born || born.pairToken !== NATIVE_PAIR || held.has(curve) || this.completed.has(curve)) continue;
      const ageMin = (now - born.ts) / 60;
      if (ageMin > rules.maxAgeMin) continue;
      const cooled = this.cooldown.get(born.token);
      if (cooled && now - cooled < rules.cooldownMin * 60) continue;
      if (w.taxBps > rules.maxTaxPct * 100) continue;
      const { buys, buyers, inflow } = windowStats(w);
      if (buys < rules.minBuys || buyers < rules.minBuyers || inflow < minInflow) continue;
      out.push({ curve, token: born.token, buys, buyers, inflow, ageMin, taxBps: w.taxBps });
    }
    return out.sort((a, b) => (a.inflow === b.inflow ? 0 : a.inflow > b.inflow ? -1 : 1)).slice(0, 20);
  }

  private async enter(
    c: ReturnType<TrenchService["candidates"]>[number],
    state: CurveState,
    symbol: string,
    rules: TrenchRules,
    book: NonNullable<Awaited<ReturnType<TrenchService["book"]>>>,
  ): Promise<void> {
    const spend = parseEther(String(rules.sizeNative));
    if (book.cashWei < spend) {
      if (!this.brokeNoted) {
        this.brokeNoted = true;
        this.emit({ kind: "note", text: `⛏ trench: the paper account has ${formatEther(book.cashWei)} ETH left, below one ${rules.sizeNative} ETH entry — /paper reset to refill` });
      }
      return;
    }
    const qty = buyOut(state, spend, c.taxBps);
    if (qty <= 0n) return;
    const pct = progress(state) * 100;
    const why =
      `${c.buys} buys / ${c.buyers} wallets / +${fmt(c.inflow)} ETH in ${rules.windowMin}m, ` +
      `${Math.round(c.ageMin)}m old, ${pct.toFixed(0)}% to graduation, tax ${(c.taxBps / 100).toFixed(1)}%`;
    await book.buy({ token: c.token, symbol, qtyWei: qty, nativeWei: spend, reason: `trench: ${why}` });
    const value = sellOut(withOwn(state, qty, netIn(spend, c.taxBps)), qty, c.taxBps);
    const pos: TrenchPosition = {
      token: c.token,
      curve: c.curve,
      symbol,
      qty: qty.toString(),
      cost: spend.toString(),
      spent: spend.toString(),
      proceeds: "0",
      openedAt: Date.now(),
      taxBps: c.taxBps,
      why,
      tpDone: false,
      peakPx: perToken(value, qty).toString(),
      markValue: value.toString(),
      markProgress: progress(state),
      markedAt: Date.now(),
      marks: [cost0Ret(value, spend)],
    };
    this.state.positions.push(pos);
    this.emit({ kind: "open", text: `🟢 trench (paper) bought ${symbol} for ${rules.sizeNative} ETH — ${why}` });
  }

  /** Mark one position and take whichever exit it has earned. */
  private async walk(pos: TrenchPosition, state: CurveState | undefined, rules: TrenchRules): Promise<void> {
    const qty = BigInt(pos.qty);
    const graduated =
      this.completed.has(pos.curve) || (state !== undefined && (state.tokens <= 0n || state.quote >= state.threshold));
    if (graduated) {
      await this.exit(pos, undefined, qty, "graduated — closed at the last curve price");
      return;
    }
    // An unreadable curve this tick is an RPC hiccup until proven otherwise.
    if (!state) return;
    const value = sellOut(ownCurve(state, pos), qty, pos.taxBps);
    pos.markValue = value.toString();
    pos.markProgress = progress(state);
    pos.markedAt = Date.now();
    const cost = BigInt(pos.cost);
    const ret = cost > 0n ? Number(((value - cost) * 10_000n) / cost) / 100 : 0;
    pos.marks = [...(pos.marks ?? []), ret].slice(-MARKS_CAP);
    const px = perToken(value, qty);
    if (px > BigInt(pos.peakPx)) pos.peakPx = px.toString();
    const held = (Date.now() - pos.openedAt) / 60_000;

    if (ret <= -rules.stopLossPct) {
      await this.exit(pos, state, qty, `stop-loss ${ret.toFixed(1)}%`);
    } else if (!pos.tpDone && ret >= rules.takeProfitPct) {
      pos.tpDone = true;
      await this.exit(pos, state, qty / 2n, `take-profit +${ret.toFixed(0)}% — half off, the rest trails`);
    } else if (pos.tpDone && px * 100n < BigInt(pos.peakPx) * BigInt(100 - Math.min(99, rules.trailPct))) {
      await this.exit(pos, state, qty, `trailing stop, ${rules.trailPct}% off the high`);
    } else if (held >= rules.maxHoldMin) {
      await this.exit(pos, state, qty, `time exit after ${Math.round(held)}m`);
    }
  }

  /**
   * Sell `qty` of a position on paper at the curve's state (or, when the curve
   * is gone to its pool, at the last mark). Returns the line it reported.
   */
  private async exit(pos: TrenchPosition, state: CurveState | undefined, qty: bigint, reason: string): Promise<string> {
    const book = await this.book();
    const held = BigInt(pos.qty);
    const sell = qty > held ? held : qty;
    const proceeds = state ? sellOut(ownCurve(state, pos), sell, pos.taxBps) : (BigInt(pos.markValue) * sell) / (held || 1n);
    if (book && sell > 0n) {
      try {
        await book.sell({ token: pos.token, symbol: pos.symbol, qtyWei: sell, nativeWei: proceeds, reason: `trench: ${reason}` });
      } catch (err) {
        log.warn(`trench: paper sell of ${pos.symbol} failed`, err);
      }
    }
    const basisSold = held > 0n ? (BigInt(pos.cost) * sell) / held : 0n;
    pos.qty = (held - sell).toString();
    pos.cost = (BigInt(pos.cost) - basisSold).toString();
    pos.proceeds = (BigInt(pos.proceeds) + proceeds).toString();
    pos.markValue = held > 0n ? ((BigInt(pos.markValue) * (held - sell)) / held).toString() : "0";
    const full = BigInt(pos.qty) <= 0n;
    const spent = BigInt(pos.spent);
    let line: string;
    if (full) {
      const total = BigInt(pos.proceeds);
      const pnl = total - spent;
      const pnlPct = spent > 0n ? Number((pnl * 10_000n) / spent) / 100 : 0;
      this.state.positions = this.state.positions.filter((p) => p !== pos);
      this.state.closed.push({
        token: pos.token,
        symbol: pos.symbol,
        spent: pos.spent,
        proceeds: total.toString(),
        pnl: pnl.toString(),
        pnlPct,
        openedAt: pos.openedAt,
        closedAt: Date.now(),
        reason,
        why: pos.why,
      });
      if (this.state.closed.length > CLOSED_CAP) this.state.closed = this.state.closed.slice(-CLOSED_CAP);
      this.cooldown.set(pos.token, Math.floor(Date.now() / 1000));
      line =
        `${pnl >= 0n ? "🟩" : "🟥"} trench (paper) closed ${pos.symbol}: ${fmt(spent)} → ${fmt(total)} ETH ` +
        `(${pnl >= 0n ? "+" : ""}${pnlPct.toFixed(1)}%) after ${Math.round((Date.now() - pos.openedAt) / 60_000)}m — ${reason}`;
    } else {
      line = `🟨 trench (paper) sold part of ${pos.symbol} for ${fmt(proceeds)} ETH — ${reason}`;
    }
    this.emit({ kind: "close", text: line });
    return line;
  }

  private prune(now: number, rules: TrenchRules): void {
    const horizon = now - rules.windowMin * 60;
    for (const [curve, w] of this.windows) {
      w.trades = w.trades.filter((t) => t.ts >= horizon);
      if (!w.trades.length) this.windows.delete(curve);
    }
    const ageHorizon = now - rules.maxAgeMin * 60;
    const heldCurves = new Set(this.state.positions.map((p) => p.curve));
    for (const [curve, l] of this.launched) {
      if (l.ts < ageHorizon && !heldCurves.has(curve)) this.launched.delete(curve);
    }
  }

  private client(): PublicClient | undefined {
    if (this.blocker()) return undefined;
    return this.runtime?.getService<ChainService>("chain")?.publicClient;
  }

  /** The Robinhood paper account (whatever the global paper switch says — this engine is paper only). */
  private async book() {
    const chain = this.runtime?.getService<ChainService>("chain");
    if (!chain?.paper) return undefined;
    return chain.paper.account(PONS_CHAIN_ID);
  }

  private emit(event: TrenchEvent): void {
    if (event.kind !== "tick") {
      log.info(event.text);
      this.journal = [...this.journal, { at: Date.now(), kind: event.kind, text: event.text }].slice(-30);
    }
    for (const fn of this.subscribers) {
      try {
        fn(event);
      } catch {
        /* a broken subscriber must never break the engine */
      }
    }
  }

  private stored = false;

  private async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as Partial<TrenchFile>;
      this.state = {
        enabled: Boolean(parsed.enabled),
        rules: parsed.rules ?? {},
        positions: parsed.positions ?? [],
        closed: parsed.closed ?? [],
      };
      this.stored = true;
      // The board's journal survives a restart: rebuilt from what the ledger kept.
      this.journal = [
        ...this.state.positions.map((p) => ({
          at: p.openedAt,
          kind: "open" as const,
          text: `🟢 trench (paper) bought ${p.symbol} for ${fmt(BigInt(p.spent))} ETH — ${p.why}`,
        })),
        ...this.state.closed.slice(-20).map((c) => ({
          at: c.closedAt,
          kind: "close" as const,
          text:
            `${BigInt(c.pnl) >= 0n ? "🟩" : "🟥"} trench (paper) closed ${c.symbol}: ${fmt(BigInt(c.spent))} → ` +
            `${fmt(BigInt(c.proceeds))} ETH (${c.pnlPct >= 0 ? "+" : ""}${c.pnlPct.toFixed(1)}%) — ${c.reason}`,
        })),
      ]
        .sort((a, b) => a.at - b.at)
        .slice(-30);
    } catch {
      // Never trenched here.
    }
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(join(this.file, ".."), { recursive: true });
      await writeFile(this.file, JSON.stringify(this.state, null, 2), "utf8");
      this.stored = true;
    } catch (err) {
      log.warn("could not persist the trench ledger", err);
    }
  }
}

/** The live curve plus what this position's remaining tokens put into it. */
function ownCurve(state: CurveState, pos: TrenchPosition): CurveState {
  return withOwn(state, BigInt(pos.qty), netIn(BigInt(pos.cost), pos.taxBps));
}

/** Buys, distinct buying wallets and net ETH in, over a curve's window. */
function windowStats(w: CurveWindow): { buys: number; buyers: number; inflow: bigint } {
  let buys = 0;
  let inflow = 0n;
  const buyers = new Set<string>();
  for (const t of w.trades) {
    if (t.side === "buy") {
      buys += 1;
      buyers.add(t.wallet);
      inflow += t.quote;
    } else {
      inflow -= t.quote;
    }
  }
  return { buys, buyers: buyers.size, inflow };
}

/** Return of a value against what was paid, percent. */
function cost0Ret(value: bigint, cost: bigint): number {
  return cost > 0n ? Number(((value - cost) * 10_000n) / cost) / 100 : 0;
}

/** Sell-side value per whole token, wei. */
function perToken(value: bigint, qty: bigint): bigint {
  return qty > 0n ? (value * 10n ** 18n) / qty : 0n;
}

/** Four decimals of ETH — enough for a 0.02 ETH trench line. */
export function fmt(wei: bigint): string {
  const s = formatEther(wei);
  return s.includes(".") ? s.replace(/(\.\d{4})\d+$/, "$1") : s;
}
