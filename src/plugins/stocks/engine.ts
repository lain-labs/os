/**
 * The stock desk: paper trading of the tokenized stocks Robinhood issues on
 * its chain, at the fills their Uniswap pools would really give.
 *
 * Two strategies run side by side. The first is the one these tokens invite. They trade around the clock on
 * chain while their stocks trade in New York, so the token drifts from its
 * stock and is pulled back by arbitrage. The desk buys a token when it trades
 * below Wall Street by more than a round trip would cost — the cost measured
 * at the live pools for the very size it would trade, fees and impact along
 * the whole route — and sells when the gap has closed, at a take-profit, a
 * stop-loss or a time limit. It trades only on a fresh Wall Street price (a
 * stale close is not a fair value), so overnight it watches and waits.
 *
 * The second runs around the clock on the token's own price, Wall Street or
 * not (so it also trades SPCX, BTC and ETH): trend. A token up at least trendPct
 * over trendWindowMin and still rising, whose round trip costs under half of
 * that move, is bought and ridden on a trailing stop.
 *
 * It also takes orders: the operator (/stocks buy NVDA 500) or Lain (the
 * stock_desk tool) can buy and sell any listed asset on paper. Everything is
 * booked in a dollar account of its own (USDG units, data/paper/4663/stocks.json).
 * Nothing is ever sent.
 */
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { PublicClient } from "viem";
import { createLogger } from "../../logger.js";
import type { ChainService } from "../chain/index.js";
import type { IAgentRuntime, Service } from "../../types.js";
import {
  ASSETS,
  deskSwaps,
  historyFromSwaps,
  poolStates,
  ROBINHOOD_CHAIN_ID,
  routeSwap,
  streetQuotes,
  USDG_DECIMALS,
  usdPrices,
  usSession,
  type AssetSpec,
  type DeskSwap,
  type PoolState,
  type Session,
  type StreetQuote,
} from "./robinhood.js";

const log = createLogger("plugin:stocks");

export interface DeskRules {
  /** Paper dollars per automatic entry. */
  sizeUsd: number;
  maxOpen: number;
  /** Discount below Wall Street, beyond the round-trip cost, that buys — percent. */
  minEdgePct: number;
  /** Sell once the token is back at this premium to Wall Street (0 = at parity), percent. */
  exitPremiumPct: number;
  takeProfitPct: number;
  stopLossPct: number;
  maxHoldHours: number;
  cooldownMin: number;
  /** Trade only on a Wall Street price at most this old, minutes. */
  maxStreetAgeMin: number;
  /** Trend entry: up this much over the window, percent (0 turns trend off). */
  trendPct: number;
  trendWindowMin: number;
  /** Trend exit: this far below the position's best value, percent. */
  trailPct: number;
}

export const DEFAULT_DESK_RULES: DeskRules = {
  sizeUsd: 1000,
  maxOpen: 4,
  minEdgePct: 0.15,
  exitPremiumPct: 0,
  takeProfitPct: 1.5,
  stopLossPct: 1.5,
  maxHoldHours: 24,
  cooldownMin: 30,
  maxStreetAgeMin: 15,
  trendPct: 0.6,
  trendWindowMin: 15,
  trailPct: 0.5,
};

export const DESK_RULE_HELP: Record<keyof DeskRules, string> = {
  sizeUsd: "paper dollars per automatic entry",
  maxOpen: "most positions open at once",
  minEdgePct: "buy when the discount to Wall Street beats the round-trip cost by this, %",
  exitPremiumPct: "sell when the token is back at this premium to Wall Street, %",
  takeProfitPct: "take-profit, %",
  stopLossPct: "stop-loss, %",
  maxHoldHours: "time exit, hours",
  cooldownMin: "no automatic re-entry for N minutes after an exit",
  maxStreetAgeMin: "trade only on a Wall Street price this fresh, minutes",
  trendPct: "trend: buy a token up this much over the window and still rising, % (0 = off)",
  trendWindowMin: "trend window, minutes",
  trailPct: "trend: sell this far below the position's best value, %",
};

export const DEFAULT_START_USD = 10_000;

export interface DeskPosition {
  symbol: string;
  /** Token units held, raw. */
  qty: string;
  /** Dollars paid, micro-USD (USDG raw). */
  cost: string;
  openedAt: number;
  /** "auto", "operator" or "lain" — who opened it. */
  by: string;
  /** Which automatic strategy opened it. */
  strategy?: "basis" | "trend";
  /** Best marked value so far, micro-USD — the trailing stop's reference. */
  peak?: string;
  why: string;
  /** Last marked sale value, micro-USD, and the return history (percent) for the sparkline. */
  mark: string;
  marks: number[];
}

export interface DeskClosed {
  symbol: string;
  cost: string;
  proceeds: string;
  pnl: string;
  pnlPct: number;
  openedAt: number;
  closedAt: number;
  reason: string;
  by: string;
}

/** One listed asset as the board shows it. */
export interface DeskQuote {
  symbol: string;
  name: string;
  /** On-chain price in USD, null when its pools could not be read. */
  price: number | null;
  /** Price history per scan (last 120). */
  history: number[];
  street: StreetQuote | null;
  /** On-chain vs Wall Street, percent (negative = token cheaper). */
  premiumPct: number | null;
  /** Round-trip cost of a sizeUsd trade at the live pools, percent. */
  costPct: number | null;
  /** Discount beyond the cost, percent — what the strategy acts on. */
  edgePct: number | null;
  /** On-chain move over the trend window, percent. */
  trendPct: number | null;
  /** The strategy that would buy it now, if any. */
  signal: "basis" | "trend" | null;
  /** Swap volume seen in the last 5 minutes, USD. */
  volume5m: number;
  /** "in", "buy", or why not. */
  verdict: string;
}

export interface DeskEvent {
  kind: "open" | "close" | "note" | "tick";
  text: string;
}

export interface DeskSnapshot {
  enabled: boolean;
  blocker: string | null;
  error: string;
  lastTick: number;
  intervalMs: number;
  head: bigint | null;
  session: Session;
  nextOpenMs: number;
  cash: bigint;
  start: bigint;
  startedAt: number;
  equity: { ts: number; usd: bigint }[];
  quotes: DeskQuote[];
  positions: DeskPosition[];
  closed: DeskClosed[];
  tape: (DeskSwap & { seenAt: number })[];
  journal: { at: number; kind: DeskEvent["kind"]; text: string }[];
  rules: DeskRules;
  pulse: number[];
}

interface DeskFile {
  enabled: boolean;
  rules: Partial<DeskRules>;
  cash: string;
  start: string;
  startedAt: number;
  positions: DeskPosition[];
  closed: DeskClosed[];
}

const MICRO = 10n ** BigInt(USDG_DECIMALS);
/** Price samples kept per asset: an hour at 5-second scans covers any trend window. */
const HISTORY_CAP = 720;
const TAPE_CAP = 150;
const STREET_EVERY_MS = 60_000;
/** The USDG/WETH pool carries the chain's whole bot flow: only big ETH swaps make the tape. */
const ETH_TAPE_MIN_USD = 5_000;
const SECONDS_PER_BLOCK = 0.1;
/** Blocks per backfill request: ~5 minutes, a few thousand swaps — under the RPC's 10k-log cap. */
const BACKFILL_CHUNK = 3_000n;
const MAX_RANGE = 25_000n;

const usd = (micro: bigint): number => Number(micro) / Number(MICRO);
const micro = (dollars: number): bigint => BigInt(Math.round(dollars * Number(MICRO)));

export class StockDeskService implements Service {
  readonly name = "stocks";

  private runtime?: IAgentRuntime;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** The scan in flight, if any — there is never more than one. */
  private inflight: Promise<void> | null = null;
  private file = "";
  private state: DeskFile = fresh(DEFAULT_START_USD);
  private intervalMs = 5_000;
  private watchers = 0;
  private lastTickAt = 0;
  private lastError = "";
  private head: bigint | null = null;
  private cursor: bigint | null = null;
  private states = new Map<string, PoolState>();
  private poolsAt = 0;
  private prices = new Map<string, number>();
  private street = new Map<string, StreetQuote>();
  private streetAt = 0;
  private history = new Map<string, number[]>();
  private tape: (DeskSwap & { seenAt: number })[] = [];
  private journal: DeskSnapshot["journal"] = [];
  private equity: DeskSnapshot["equity"] = [];
  private pulse: number[] = [];
  private quotes: DeskQuote[] = [];
  private readonly cooldown = new Map<string, number>();
  private readonly subscribers = new Set<(event: DeskEvent) => void>();

  async start(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
    const dataDir = runtime.getSetting("LAINOS_DATA_DIR") ?? "./data";
    this.file = join(dataDir, "paper", String(ROBINHOOD_CHAIN_ID), "stocks.json");
    await this.load();
    this.intervalMs = Math.max(3_000, Number(runtime.getSetting("LAINOS_STOCKS_INTERVAL_MS")) || 5_000);
    this.timer = setInterval(() => void this.safeTick(), this.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  onEvent(fn: (event: DeskEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /** Keep the market data flowing while someone watches, auto-trading or not. Returns the release. */
  watch(): () => void {
    this.watchers += 1;
    void this.safeTick();
    let released = false;
    return () => {
      if (!released) this.watchers -= 1;
      released = true;
    };
  }

  get enabled(): boolean {
    return this.state.enabled;
  }

  get rules(): DeskRules {
    return { ...DEFAULT_DESK_RULES, ...this.state.rules };
  }

  get positions(): readonly DeskPosition[] {
    return this.state.positions;
  }

  get closed(): readonly DeskClosed[] {
    return this.state.closed;
  }

  get cash(): bigint {
    return BigInt(this.state.cash);
  }

  get startCash(): bigint {
    return BigInt(this.state.start);
  }

  blocker(): string | null {
    const chain = this.runtime?.getService<ChainService>("chain");
    if (!chain?.configured) return "no chain is configured";
    if (chain.chain.id !== ROBINHOOD_CHAIN_ID) {
      return `Robinhood's stock tokens live on Robinhood Chain (${ROBINHOOD_CHAIN_ID}); this process is on ${chain.chain.name} — /network robinhood`;
    }
    return null;
  }

  async setEnabled(on: boolean): Promise<void> {
    this.state.enabled = on;
    await this.persist();
    log.info(on ? "stock desk auto-trading on" : "stock desk auto-trading off");
    if (on) void this.safeTick();
  }

  async setRule(key: string, raw: string): Promise<string | null> {
    const name = (Object.keys(DEFAULT_DESK_RULES) as (keyof DeskRules)[]).find((k) => k.toLowerCase() === key.toLowerCase());
    if (!name) return `unknown rule "${key}" — one of: ${Object.keys(DEFAULT_DESK_RULES).join(", ")}`;
    if (raw.trim().toLowerCase() === "default") delete this.state.rules[name];
    else {
      const value = Number(raw.replace(/[%$,]/g, ""));
      if (!Number.isFinite(value) || value < 0) return `${name} must be a non-negative number, not "${raw}"`;
      this.state.rules[name] = value;
    }
    await this.persist();
    return null;
  }

  /** Start the dollar account over (positions and history go with it). */
  async reset(startUsd = DEFAULT_START_USD): Promise<void> {
    const enabled = this.state.enabled;
    const rules = this.state.rules;
    this.state = { ...fresh(startUsd), enabled, rules };
    this.equity = [];
    this.journal = [];
    await this.persist();
  }

  /** A paper buy of `dollars` worth of an asset at the live route. Returns the line it reported. */
  async buy(symbol: string, dollars: number, by: string, why = "", strategy?: "basis" | "trend"): Promise<string> {
    return (await this.order(symbol, dollars, by, why, strategy)).line;
  }

  /** The same buy, with the raw units it got and the dollars paid per coin (qty 0 when nothing was bought). */
  async order(symbol: string, dollars: number, by: string, why = "", strategy?: "basis" | "trend"): Promise<{ line: string; qty: bigint; px: number }> {
    const fail = (line: string) => ({ line, qty: 0n, px: 0 });
    const asset = findAsset(symbol);
    if (!asset) return fail(`no listed asset "${symbol}" — ${ASSETS.map((a) => a.symbol).join(", ")}`);
    if (!(dollars > 0)) return fail("the amount must be a positive number of dollars");
    await this.ensureFresh();
    const spend = micro(dollars);
    if (spend > this.cash) return fail(`the desk has $${usd(this.cash).toFixed(2)} — not enough for $${dollars}`);
    const qty = routeSwap(asset, this.states, "buy", spend);
    if (!qty || qty <= 0n) return fail(`${asset.symbol}: its pools could not be read just now`);
    this.state.cash = (this.cash - spend).toString();
    const existing = this.state.positions.find((p) => p.symbol === asset.symbol);
    if (existing) {
      existing.qty = (BigInt(existing.qty) + qty).toString();
      existing.cost = (BigInt(existing.cost) + spend).toString();
    } else {
      this.state.positions.push({
        symbol: asset.symbol,
        qty: qty.toString(),
        cost: spend.toString(),
        openedAt: Date.now(),
        by,
        why,
        ...(strategy ? { strategy } : {}),
        mark: (routeSwap(asset, this.states, "sell", qty) ?? spend).toString(),
        marks: [],
      });
    }
    await this.persist();
    const avg = dollars / (Number(qty) / 10 ** asset.decimals);
    const line =
      `🟢 desk (paper) bought ${fmtQty(qty, asset.decimals)} ${asset.symbol} for $${dollars.toFixed(2)} at $${avg.toFixed(2)}` +
      (why ? ` — ${why}` : by !== "auto" ? ` — by ${by}` : "");
    this.emit({ kind: "open", text: line });
    return { line, qty, px: avg };
  }

  /** Sell exactly `qty` raw units of a holding (all of it at most); proceeds in dollars, null when nothing sold. */
  async sellUnits(symbol: string, qty: bigint, by: string, reason: string): Promise<{ line: string; proceeds: number | null }> {
    const asset = findAsset(symbol);
    const pos = asset ? this.state.positions.find((p) => p.symbol === asset.symbol) : undefined;
    if (!asset || !pos) return { line: `the desk holds no ${symbol.toUpperCase()}`, proceeds: null };
    if (qty <= 0n) return { line: "nothing to sell", proceeds: null };
    await this.ensureFresh();
    const held = BigInt(pos.qty);
    const sold = await this.exit(pos, asset, qty > held ? held : qty, reason || `by ${by}`);
    return { line: sold.line, proceeds: sold.proceeds === null ? null : usd(sold.proceeds) };
  }

  /** An asset's on-chain price in dollars right now, null when its pools could not be read. */
  async price(symbol: string): Promise<number | null> {
    const asset = findAsset(symbol);
    if (!asset || this.blocker()) return null;
    await this.ensureFresh();
    return this.prices.get(asset.token) ?? null;
  }

  /** What `qty` raw units of an asset would sell for at the live route, in dollars. */
  async saleValue(symbol: string, qty: bigint): Promise<number | null> {
    const asset = findAsset(symbol);
    if (!asset || qty <= 0n || this.blocker()) return null;
    await this.ensureFresh();
    const value = routeSwap(asset, this.states, "sell", qty);
    return value === null || value === undefined ? null : usd(value);
  }

  /** Raw units of an asset the desk holds. */
  holding(symbol: string): bigint {
    const asset = findAsset(symbol);
    const pos = asset ? this.state.positions.find((p) => p.symbol === asset.symbol) : undefined;
    return pos ? BigInt(pos.qty) : 0n;
  }

  /** A paper sale of a holding ("all", a token amount, or a dollar amount like "$300"). */
  async sell(symbol: string, amount: string, by: string, reason = ""): Promise<string> {
    const asset = findAsset(symbol);
    const pos = asset ? this.state.positions.find((p) => p.symbol === asset.symbol) : undefined;
    if (!asset || !pos) return `the desk holds no ${symbol.toUpperCase()}`;
    await this.ensureFresh();
    const held = BigInt(pos.qty);
    let qty = held;
    const a = amount.trim().toLowerCase();
    if (a && a !== "all") {
      const n = Number(a.replace(/[$,]/g, ""));
      if (!(n > 0)) return "amount must be 'all', a token amount, or dollars like $250";
      if (a.startsWith("$")) {
        const value = routeSwap(asset, this.states, "sell", held) ?? 0n;
        qty = value > 0n ? (held * micro(n)) / value : 0n;
      } else {
        qty = BigInt(Math.floor(n * 10 ** asset.decimals));
      }
      if (qty > held) qty = held;
    }
    if (qty <= 0n) return "nothing to sell";
    return (await this.exit(pos, asset, qty, reason || `by ${by}`)).line;
  }

  /** Close one position, or all of them. */
  async closeAll(symbol: string, by: string): Promise<string> {
    const targets = symbol.toLowerCase() === "all" ? [...this.state.positions] : this.state.positions.filter((p) => p.symbol === symbol.toUpperCase());
    if (!targets.length) return `no open position matches "${symbol}"`;
    const lines: string[] = [];
    for (const p of targets) lines.push(await this.sell(p.symbol, "all", by, `closed by ${by}`));
    return lines.join("\n");
  }

  // ---------------------------------------------------------------- loop

  private async safeTick(): Promise<void> {
    if ((!this.state.enabled && this.watchers <= 0 && !this.state.positions.length) || this.inflight) return;
    this.inflight = this.tick()
      .then(() => {
        this.lastError = "";
      })
      .catch((err: Error) => {
        this.lastError = err.message.split("\n")[0]!.slice(0, 200);
        log.warn("stock desk tick failed", err);
      })
      .finally(() => {
        this.inflight = null;
      });
    await this.inflight;
  }

  /**
   * An order needs the pools as they are now — one multicall, not a scan: the
   * first scan reaches back half an hour of swaps, and an order must not wait
   * behind it.
   */
  private async ensureFresh(): Promise<void> {
    if (this.states.size && Date.now() - this.poolsAt < this.intervalMs) return;
    const client = this.client();
    if (!client) return;
    this.states = await poolStates(client);
    this.prices = usdPrices(this.states);
    this.poolsAt = Date.now();
  }

  /** One scan: pools, Wall Street (once a minute), the tape, marks and exits, then entries. */
  async tick(): Promise<void> {
    const client = this.client();
    if (!client) return;
    this.lastTickAt = Date.now();
    const head = await client.getBlockNumber();
    this.head = head;
    this.states = await poolStates(client);
    this.prices = usdPrices(this.states);
    this.poolsAt = Date.now();
    if (Date.now() - this.streetAt > STREET_EVERY_MS) {
      const tickers = ASSETS.map((a) => a.ticker).filter((t): t is string => Boolean(t));
      const got = await streetQuotes(tickers, this.runtime?.getSetting("LAINOS_STOCKS_PROXY"));
      for (const [t, q] of got) this.street.set(t, q);
      this.streetAt = Date.now();
    }

    // The tape: everything since the last scan. The first scan reaches back
    // twice the trend window, in log-sized chunks, and rebuilds every asset's
    // price history from those swaps — the board has a past from its first second.
    const nowSec = Date.now() / 1000;
    const clock = (b: bigint) => Math.round(nowSec - Number(head - b) * SECONDS_PER_BLOCK);
    if (this.cursor === null) {
      const span = BigInt(Math.ceil((this.rules.trendWindowMin * 2 * 60) / SECONDS_PER_BLOCK));
      const swaps: DeskSwap[] = [];
      for (let from = head - span; from <= head; from += BACKFILL_CHUNK) {
        const to = from + BACKFILL_CHUNK - 1n < head ? from + BACKFILL_CHUNK - 1n : head;
        swaps.push(...(await deskSwaps(client, from, to, clock, this.prices)));
      }
      const step = this.intervalMs / 1000;
      for (const [symbol, h] of historyFromSwaps(swaps, this.states, clock(head - span), nowSec, step)) {
        this.history.set(symbol, h.slice(-HISTORY_CAP));
      }
      const recent = swaps.filter((s) => s.ts >= nowSec - 300 && (s.symbol !== "ETH" || s.usd >= ETH_TAPE_MIN_USD));
      this.tape = recent.map((s) => ({ ...s, seenAt: Date.now() })).slice(-TAPE_CAP);
      this.cursor = head;
    } else if (this.cursor < head) {
      const from = head - this.cursor > MAX_RANGE ? head - MAX_RANGE : this.cursor + 1n;
      const swaps = await deskSwaps(client, from, head, clock, this.prices);
      const seenAt = Date.now();
      const shown = swaps.filter((s) => s.symbol !== "ETH" || s.usd >= ETH_TAPE_MIN_USD);
      this.tape = [...this.tape, ...shown.map((s) => ({ ...s, seenAt }))].slice(-TAPE_CAP);
      this.pulse = [...this.pulse, swaps.length].slice(-60);
      this.cursor = head;
      for (const a of ASSETS) {
        const p = this.prices.get(a.token);
        if (p) this.history.set(a.symbol, [...(this.history.get(a.symbol) ?? []), p].slice(-HISTORY_CAP));
      }
    }

    const rules = this.rules;
    const { session } = usSession(Date.now());
    this.quotes = ASSETS.map((a) => this.quote(a, rules));

    // Marks and exits first, then entries.
    await this.walk(rules);
    if (this.state.enabled) await this.enter(rules, session);

    const open = this.state.positions.reduce((s, p) => s + BigInt(p.mark), 0n);
    this.equity = [...this.equity, { ts: Date.now(), usd: this.cash + open }].slice(-180);
    await this.persist();
    this.emit({ kind: "tick", text: "" });
  }

  /** Mark every position at the live route and take the exits automatic ones have earned. */
  private async walk(rules: DeskRules): Promise<void> {
    for (const pos of [...this.state.positions]) {
      const asset = findAsset(pos.symbol);
      if (!asset) continue;
      const value = routeSwap(asset, this.states, "sell", BigInt(pos.qty));
      if (value === null) continue;
      pos.mark = value.toString();
      const cost = BigInt(pos.cost);
      const ret = cost > 0n ? Number(((value - cost) * 10_000n) / cost) / 100 : 0;
      pos.marks = [...pos.marks, ret].slice(-60);
      if (!pos.peak || value > BigInt(pos.peak)) pos.peak = value.toString();
      if (pos.by !== "auto") continue; // a position opened by hand is closed by hand
      const q = this.quotes.find((x) => x.symbol === pos.symbol);
      const held = (Date.now() - pos.openedAt) / 3_600_000;
      const trend = pos.strategy === "trend";
      const offPeak = pos.peak ? Number(((BigInt(pos.peak) - value) * 10_000n) / BigInt(pos.peak)) / 100 : 0;
      let reason = "";
      if (ret <= -rules.stopLossPct) reason = `stop-loss ${ret.toFixed(2)}%`;
      else if (trend && offPeak >= rules.trailPct) reason = `trailing stop ${offPeak.toFixed(2)}% off the high (${ret >= 0 ? "+" : ""}${ret.toFixed(2)}%)`;
      else if (!trend && ret >= rules.takeProfitPct) reason = `take-profit +${ret.toFixed(2)}%`;
      else if (!trend && q?.premiumPct !== null && q?.premiumPct !== undefined && this.streetFresh(asset, rules) && q.premiumPct >= rules.exitPremiumPct)
        reason = `gap closed (${q.premiumPct >= 0 ? "+" : ""}${q.premiumPct.toFixed(2)}% vs Wall Street)`;
      else if (held >= rules.maxHoldHours) reason = `time exit after ${held.toFixed(1)}h`;
      if (reason) await this.exit(pos, asset, BigInt(pos.qty), reason);
    }
  }

  /** Buy what the strategies signal, strongest edge first, while slots and cash last. */
  private async enter(rules: DeskRules, session: Session): Promise<void> {
    for (const q of this.quotes.filter((x) => x.signal !== null).sort((a, b) => (b.edgePct ?? 0) - (a.edgePct ?? 0))) {
      if (this.state.positions.length >= rules.maxOpen) break;
      if (this.cash < micro(rules.sizeUsd)) break;
      const why =
        q.signal === "basis"
          ? `basis: ${q.premiumPct!.toFixed(2)}% below Wall Street, cost ${q.costPct!.toFixed(2)}%, edge +${q.edgePct!.toFixed(2)}%` +
            (session !== "open" ? ` (${session}-market)` : "")
          : `trend: +${q.trendPct!.toFixed(2)}% in ${rules.trendWindowMin}m and rising, cost ${q.costPct!.toFixed(2)}%`;
      await this.buy(q.symbol, rules.sizeUsd, "auto", why, q.signal!);
    }
    // The verdicts move with what was just bought.
    this.quotes = ASSETS.map((a) => this.quote(a, rules));
  }

  private streetFresh(asset: AssetSpec, rules: DeskRules): boolean {
    const q = asset.ticker ? this.street.get(asset.ticker) : undefined;
    return Boolean(q && Date.now() / 1000 - q.at <= rules.maxStreetAgeMin * 60);
  }

  /** Price, Wall Street, premium, round-trip cost, edge and verdict for one asset. */
  private quote(asset: AssetSpec, rules: DeskRules): DeskQuote {
    const price = this.prices.get(asset.token) ?? null;
    const street = asset.ticker ? (this.street.get(asset.ticker) ?? null) : null;
    const premiumPct = price !== null && street ? (price / street.price - 1) * 100 : null;
    const size = micro(rules.sizeUsd);
    const got = routeSwap(asset, this.states, "buy", size);
    const back = got ? routeSwap(asset, this.states, "sell", got) : null;
    const costPct = back !== null && back !== undefined ? (1 - Number(back) / Number(size)) * 100 : null;
    const edgePct = premiumPct !== null && costPct !== null ? -premiumPct - costPct : null;
    const cutoff = Date.now() / 1000 - 300;
    const volume5m = this.tape.filter((t) => t.symbol === asset.symbol && t.ts >= cutoff).reduce((s, t) => s + t.usd, 0);

    // Trend: the move over the window, and whether the last few scans are still going up.
    const hist = this.history.get(asset.symbol) ?? [];
    const lookback = Math.max(2, Math.round((rules.trendWindowMin * 60_000) / this.intervalMs));
    const enough = hist.length > Math.min(lookback, 12);
    const past = hist.length > lookback ? hist[hist.length - 1 - lookback]! : hist[0];
    const trendPct = enough && past && price !== null ? (price / past - 1) * 100 : null;
    const rising = hist.length >= 4 && hist.at(-1)! >= hist.at(-4)!;
    const trendOk = rules.trendPct > 0 && trendPct !== null && trendPct >= rules.trendPct && rising && costPct !== null && costPct < trendPct / 2;
    const basisOk = asset.ticker !== null && edgePct !== null && this.streetFresh(asset, rules) && edgePct >= rules.minEdgePct;

    let verdict = "watch";
    let signal: DeskQuote["signal"] = null;
    const cooled = this.cooldown.get(asset.symbol);
    if (this.state.positions.some((p) => p.symbol === asset.symbol)) verdict = "in";
    else if (cooled && Date.now() - cooled < rules.cooldownMin * 60_000) verdict = "cooldown";
    else if (basisOk || trendOk) {
      signal = basisOk ? "basis" : "trend";
      verdict = this.state.enabled ? `buy · ${signal}` : `${signal} signal — auto off`;
      if (!this.state.enabled) signal = null;
    } else if (rules.trendPct > 0 && trendPct !== null && trendPct >= rules.trendPct / 2) verdict = `trend ${trendPct >= 0 ? "+" : ""}${trendPct.toFixed(2)}%`;
    else if (!asset.ticker) verdict = trendPct === null ? "warming up" : "no Wall St price";
    else if (!street) verdict = "no Wall St quote";
    else if (!this.streetFresh(asset, rules)) verdict = "Wall St closed";
    else if (edgePct === null) verdict = "no read";
    else verdict = premiumPct! < 0 ? "below cost" : "rich";
    return {
      symbol: asset.symbol,
      name: asset.name,
      price,
      history: this.history.get(asset.symbol) ?? [],
      street,
      premiumPct,
      costPct,
      edgePct,
      trendPct,
      signal,
      volume5m,
      verdict,
    };
  }

  private async exit(pos: DeskPosition, asset: AssetSpec, qty: bigint, reason: string): Promise<{ line: string; proceeds: bigint | null }> {
    const held = BigInt(pos.qty);
    const proceeds = routeSwap(asset, this.states, "sell", qty);
    if (proceeds === null) return { line: `${asset.symbol}: its pools could not be read just now`, proceeds: null };
    const basis = held > 0n ? (BigInt(pos.cost) * qty) / held : 0n;
    this.state.cash = (this.cash + proceeds).toString();
    pos.qty = (held - qty).toString();
    pos.cost = (BigInt(pos.cost) - basis).toString();
    pos.mark = held > 0n ? ((BigInt(pos.mark) * (held - qty)) / held).toString() : "0";
    const pnl = proceeds - basis;
    const pnlPct = basis > 0n ? Number((pnl * 10_000n) / basis) / 100 : 0;
    const whole = BigInt(pos.qty) <= 0n;
    if (whole) {
      this.state.positions = this.state.positions.filter((p) => p !== pos);
      this.cooldown.set(asset.symbol, Date.now());
    }
    this.state.closed.push({
      symbol: asset.symbol,
      cost: basis.toString(),
      proceeds: proceeds.toString(),
      pnl: pnl.toString(),
      pnlPct,
      openedAt: pos.openedAt,
      closedAt: Date.now(),
      reason,
      by: pos.by,
    });
    if (this.state.closed.length > 300) this.state.closed = this.state.closed.slice(-300);
    await this.persist();
    const line =
      `${pnl >= 0n ? "🟩" : "🟥"} desk (paper) sold ${fmtQty(qty, asset.decimals)} ${asset.symbol} for $${usd(proceeds).toFixed(2)} ` +
      `(${pnl >= 0n ? "+" : ""}$${usd(pnl).toFixed(2)}, ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%) — ${reason}`;
    this.emit({ kind: "close", text: line });
    return { line, proceeds };
  }

  async snapshot(): Promise<DeskSnapshot> {
    const { session, nextOpenMs } = usSession(Date.now());
    return {
      enabled: this.state.enabled,
      blocker: this.blocker(),
      error: this.lastError,
      lastTick: this.lastTickAt,
      intervalMs: this.intervalMs,
      head: this.head,
      session,
      nextOpenMs,
      cash: this.cash,
      start: this.startCash,
      startedAt: this.state.startedAt,
      equity: this.equity,
      quotes: this.quotes,
      positions: this.state.positions,
      closed: this.state.closed,
      tape: this.tape,
      journal: this.journal,
      rules: this.rules,
      pulse: this.pulse,
    };
  }

  private client(): PublicClient | undefined {
    if (this.blocker()) return undefined;
    return this.runtime?.getService<ChainService>("chain")?.publicClient;
  }

  private emit(event: DeskEvent): void {
    if (event.kind !== "tick") {
      log.info(event.text);
      this.journal = [...this.journal, { at: Date.now(), kind: event.kind, text: event.text }].slice(-30);
    }
    for (const fn of this.subscribers) {
      try {
        fn(event);
      } catch {
        /* a broken subscriber must never break the desk */
      }
    }
  }

  private async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as Partial<DeskFile>;
      const base = fresh(DEFAULT_START_USD);
      this.state = {
        enabled: Boolean(parsed.enabled),
        rules: parsed.rules ?? {},
        cash: parsed.cash ?? base.cash,
        start: parsed.start ?? base.start,
        startedAt: parsed.startedAt ?? base.startedAt,
        positions: parsed.positions ?? [],
        closed: parsed.closed ?? [],
      };
      // The board's journal survives a restart: rebuilt from what the ledger kept.
      this.journal = [
        ...this.state.positions.map((p) => ({
          at: p.openedAt,
          kind: "open" as const,
          text: `🟢 desk (paper) bought ${p.symbol} for $${usd(BigInt(p.cost)).toFixed(2)} — ${p.why || `by ${p.by}`}`,
        })),
        ...this.state.closed.slice(-10).map((c) => ({
          at: c.closedAt,
          kind: "close" as const,
          text: `${BigInt(c.pnl) >= 0n ? "🟩" : "🟥"} desk (paper) sold ${c.symbol} (${c.pnlPct >= 0 ? "+" : ""}${c.pnlPct.toFixed(2)}%) — ${c.reason}`,
        })),
      ]
        .sort((a, b) => a.at - b.at)
        .slice(-30);
    } catch {
      // A fresh desk.
    }
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(join(this.file, ".."), { recursive: true });
      await writeFile(this.file, JSON.stringify(this.state, null, 2), "utf8");
    } catch (err) {
      log.warn("could not persist the stock desk", err);
    }
  }
}

function fresh(startUsd: number): DeskFile {
  const start = micro(startUsd).toString();
  return { enabled: false, rules: {}, cash: start, start, startedAt: Date.now(), positions: [], closed: [] };
}

export function findAsset(symbol: string): AssetSpec | undefined {
  const s = symbol.trim().toUpperCase().replace(/^\$/, "");
  return ASSETS.find((a) => a.symbol === s || a.ticker === s);
}

function fmtQty(raw: bigint, decimals: number): string {
  const n = Number(raw) / 10 ** decimals;
  return n >= 100 ? n.toFixed(1) : n >= 1 ? n.toFixed(3) : n.toPrecision(3);
}
