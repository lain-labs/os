import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createLogger } from "../../logger.js";
import { TaskKind } from "../../models/tasks.js";
import { ModelTier, type IAgentRuntime } from "../../types.js";
import { decimalString } from "./index.js";

const log = createLogger("plugin:arena:book");

/**
 * Lain's arena book: a paper bankroll she trades on the arena's own board.
 *
 * The house season has its own "Lain" (a free model the season's rules froze);
 * this is the real one. Every LAINOS_ARENA_BOOK_MINUTES (default 60) she reads
 * the board at /api/arena (the tokens in view, their USD price, liquidity and
 * 24h change, plus what she holds), decides one order on the cheap analysis
 * route, and the order fills on paper at the board's price with the house
 * season's costs (0.3% fee, 0.5% slippage). Each fill goes to the league as a
 * paper trade with her reason, so the page shows a record with a thesis.
 *
 * Off unless LAINOS_ARENA_BOOK=1. Paper only: nothing here can sign anything.
 */

export interface BoardToken {
  key: string;
  symbol: string;
  chain: string;
  address: string;
  usd: number;
  changePct?: number;
  liquidityUsd?: number;
}

export interface BookPosition {
  symbol: string;
  chain: string;
  address: string;
  qty: number;
  costUsd: number;
}

export interface BookTrade {
  id: string;
  at: number;
  side: "buy" | "sell";
  key: string;
  symbol: string;
  chain: string;
  address: string;
  qty: number;
  usd: number;
  realizedUsd?: number;
  reason: string;
}

export interface BookState {
  startUsd: number;
  cash: number;
  positions: Record<string, BookPosition>;
  trades: BookTrade[];
  lastAt?: number;
  seq: number;
}

export interface Decision {
  action: "hold" | "buy" | "sell";
  token: string | null;
  bps: number;
  reason: string;
}

const FEE = 0.003;
const SLIPPAGE = 0.005;
const MIN_LIQUIDITY = 5000;

export function freshBook(startUsd: number): BookState {
  return { startUsd, cash: startUsd, positions: {}, trades: [], seq: 0 };
}

/** The decision from the model's text: one JSON object, or null when it is not one. */
export function parseDecision(text: string): Decision | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const raw = JSON.parse(match[0]) as Record<string, unknown>;
    const action = raw.action;
    if (action !== "hold" && action !== "buy" && action !== "sell") return null;
    const bps = Number(raw.bps ?? 0);
    return {
      action,
      token: typeof raw.token === "string" && raw.token.trim() ? raw.token.trim() : null,
      bps: action === "hold" ? 0 : [2500, 5000, 10000].includes(bps) ? bps : 2500,
      reason: String(raw.reason ?? "").slice(0, 600),
    };
  } catch {
    return null;
  }
}

/** Fill a decision on paper against the board; returns the trade, or why not. */
export function fill(book: BookState, decision: Decision, board: BoardToken[], now: number): BookTrade | string {
  if (decision.action === "hold") return "hold";
  const token = board.find((t) => t.key === decision.token || t.address === decision.token);
  if (!token || !(token.usd > 0)) return `not on the board: ${decision.token}`;
  if ((token.liquidityUsd ?? 0) < MIN_LIQUIDITY) return `pool below $${MIN_LIQUIDITY}: ${token.symbol}`;
  const share = decision.bps / 10_000;
  if (decision.action === "buy") {
    const spend = book.cash * share;
    if (spend < 1) return "no cash to buy with";
    const price = token.usd * (1 + SLIPPAGE);
    const qty = (spend * (1 - FEE)) / price;
    const held = book.positions[token.key] ?? { symbol: token.symbol, chain: token.chain, address: token.address, qty: 0, costUsd: 0 };
    held.qty += qty;
    held.costUsd += spend;
    book.positions[token.key] = held;
    book.cash -= spend;
    return record(book, { side: "buy", key: token.key, symbol: token.symbol, chain: token.chain, address: token.address, qty, usd: spend, reason: decision.reason }, now);
  }
  const held = book.positions[token.key];
  if (!held || held.qty <= 0) return `nothing to sell: ${token.symbol}`;
  const qty = share >= 1 ? held.qty : held.qty * share;
  const proceeds = qty * token.usd * (1 - SLIPPAGE) * (1 - FEE);
  const basis = held.costUsd * (qty / held.qty);
  held.qty -= qty;
  held.costUsd -= basis;
  if (held.qty <= held.qty * 1e-9 || share >= 1) delete book.positions[token.key];
  book.cash += proceeds;
  return record(book, { side: "sell", key: token.key, symbol: token.symbol, chain: token.chain, address: token.address, qty, usd: proceeds, realizedUsd: proceeds - basis, reason: decision.reason }, now);
}

function record(book: BookState, trade: Omit<BookTrade, "id" | "at">, now: number): BookTrade {
  book.seq += 1;
  const full: BookTrade = { id: `book:${book.seq}:${now}`, at: now, ...trade };
  book.trades.push(full);
  return full;
}

/** Marked to the board: cash plus every position at its board price. */
export function bookValue(book: BookState, board: BoardToken[]): number {
  let value = book.cash;
  for (const [key, pos] of Object.entries(book.positions)) {
    const price = board.find((t) => t.key === key)?.usd;
    value += price ? pos.qty * price : pos.costUsd;
  }
  return value;
}

const BOOK_PROMPT =
  "You are Lain, an autonomous trading agent, playing in a public paper-trading arena where people watch every move. " +
  "You trade a paper USD bankroll on the tokens of the board below; every order pays a 0.3% fee and 0.5% slippage, and thin pools are risky. " +
  "Make one decision now. Be decisive when the board gives you a reason (momentum, a drawdown worth buying, taking profit, cutting a loser) " +
  "and hold only when nothing does. Never invent news or data beyond the board. " +
  'Output only JSON: {"action":"buy"|"sell"|"hold","token":"<board key or null>","bps":2500|5000|10000,"reason":"<at most 280 characters, first person, why this and why now>"}. ' +
  "Buying spends that share of cash; selling sells that share of the position.";

export function boardText(board: BoardToken[], book: BookState): string {
  const rows = board
    .filter((t) => t.usd > 0 && (t.liquidityUsd ?? 0) >= MIN_LIQUIDITY)
    .slice(0, 24)
    .map((t) => `${t.symbol} key=${t.key} usd=${t.usd} 24h=${t.changePct ?? "?"}% liq=$${Math.round(t.liquidityUsd ?? 0)}`);
  const held = Object.entries(book.positions).map(([key, p]) => {
    const price = board.find((t) => t.key === key)?.usd;
    return `${p.symbol} key=${key} qty=${p.qty} cost=$${p.costUsd.toFixed(2)}${price ? ` now=$${(p.qty * price).toFixed(2)}` : ""}`;
  });
  return [
    `Cash: $${book.cash.toFixed(2)} of a $${book.startUsd} start; value now $${bookValue(book, board).toFixed(2)}.`,
    `Holdings: ${held.length ? held.join("; ") : "none"}.`,
    `Recent trades: ${book.trades.slice(-4).map((t) => `${t.side} ${t.symbol} $${t.usd.toFixed(0)}`).join(", ") || "none"}.`,
    "Board:",
    ...rows,
  ].join("\n");
}

/** The league's shape for one book trade. */
export function leagueTrade(trade: BookTrade): Record<string, unknown> | null {
  const qty = decimalString(trade.qty);
  const amount = decimalString(trade.usd);
  if (!qty || !amount) return null;
  return {
    id: trade.id.slice(0, 100),
    side: trade.side,
    chain: trade.chain,
    token: trade.address,
    symbol: trade.symbol.slice(0, 24),
    qty,
    quote: { symbol: "USD", amount },
    ...(trade.realizedUsd !== undefined ? { realized: trade.realizedUsd.toFixed(6) } : {}),
    paper: true,
    reason: `arena book: ${trade.reason}`.slice(0, 2000),
    at: trade.at,
  };
}

export class ArenaBook {
  private file = "";
  private state: BookState = freshBook(1000);
  private loaded = false;

  constructor(
    private readonly runtime: IAgentRuntime,
    private readonly url: string,
    private readonly getBoard: () => Promise<BoardToken[]>,
    private readonly report: (trades: Record<string, unknown>[]) => Promise<void>,
  ) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.file = join(this.runtime.getSetting("LAINOS_DATA_DIR") ?? "./data", "arena-book.json");
    const start = Number(this.runtime.getSetting("LAINOS_ARENA_BOOK_USD") ?? 1000) || 1000;
    try {
      this.state = JSON.parse(await readFile(this.file, "utf8")) as BookState;
    } catch {
      this.state = freshBook(start);
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.state, null, 2));
  }

  /** One round: read the board, decide, fill, report. */
  async round(now = Date.now()): Promise<string> {
    await this.load();
    const board = await this.getBoard();
    if (!board.length) return "board empty";
    const res = await this.runtime.model.generate({
      tier: ModelTier.MEDIUM,
      task: TaskKind.ANALYSIS,
      system: BOOK_PROMPT,
      messages: [{ role: "user", content: boardText(board, this.state) }],
      maxTokens: 400,
      temperature: 0.7,
    });
    const decision = parseDecision(res.text ?? "");
    this.state.lastAt = now;
    if (!decision) {
      await this.persist();
      return "no decision";
    }
    const outcome = fill(this.state, decision, board, now);
    await this.persist();
    if (typeof outcome === "string") {
      log.info(`arena book: ${outcome}${decision.reason ? ` — ${decision.reason.slice(0, 120)}` : ""}`);
      return outcome;
    }
    const shaped = leagueTrade(outcome);
    if (shaped) await this.report([shaped]);
    log.info(`arena book: ${outcome.side} ${outcome.symbol} $${outcome.usd.toFixed(2)} — ${outcome.reason.slice(0, 120)}`);
    return `${outcome.side} ${outcome.symbol}`;
  }

  get book(): BookState {
    return this.state;
  }
}
