/**
 * The money, as the sidebar shows it: Lain's current paper wallet (or the
 * real one when paper mode is off) — equity, P&L, balances — and the stock
 * desk and the trench beside it. Read from the same report /paper prints, so
 * the two never disagree.
 *
 * The equity is sampled into data/tui-equity.json as it is read, so the
 * sparkline has a history the moment the TUI opens, not a flat line.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { formatUnits } from "viem";
import type { IAgentRuntime } from "../../types.js";
import { paperReport } from "../../plugins/chain/actions/paper.js";
import type { ChainService } from "../../plugins/chain/service.js";
import type { TrenchService } from "../../plugins/trench/index.js";
import type { StockDeskService } from "../../plugins/stocks/index.js";
import { USDG_DECIMALS } from "../../plugins/stocks/robinhood.js";

export interface PortfolioView {
  /** paper: Lain's paper wallet · live: the real wallet · none: nothing to read. */
  mode: "paper" | "live" | "none";
  wallet: string;
  symbol: string;
  equity: number | null;
  pnl: number | null;
  /** Return since the start, percent. */
  pnlPct: number | null;
  balances: { symbol: string; amount: number; usd: number | null }[];
  positions: number;
  positionsValue: number;
  /** Equity samples, oldest first — the sparkline. */
  series: number[];
  trench: { on: boolean; open: number } | null;
  stocks: { on: boolean; equityUsd: number; pnlPct: number; open: number } | null;
  /** Why there is nothing to show, when there is nothing. */
  note?: string;
  at: number;
}

type Sample = { ts: number; eq: number };
/** Samples kept per wallet, and the spacing between them: about a day at full spacing. */
const SAMPLES = 96;
const SAMPLE_GAP_MS = 15 * 60_000;

function seriesFile(): string {
  return join(process.env.LAINOS_DATA_DIR ?? "./data", "tui-equity.json");
}

function readSeries(): Record<string, Sample[]> {
  try {
    return JSON.parse(readFileSync(seriesFile(), "utf8")) as Record<string, Sample[]>;
  } catch {
    return {};
  }
}

/**
 * Add a reading to a wallet's series. Readings closer together than the gap
 * replace the newest sample instead of piling up, so the line spans hours, and
 * still moves with every refresh.
 */
function record(key: string, eq: number, now: number): number[] {
  const all = readSeries();
  const list = (all[key] ?? []).filter((s) => typeof s?.eq === "number" && Number.isFinite(s.eq));
  const last = list.at(-1);
  if (last && now - last.ts < SAMPLE_GAP_MS && list.length > 1) list[list.length - 1] = { ts: last.ts, eq };
  else list.push({ ts: now, eq });
  all[key] = list.slice(-SAMPLES);
  try {
    mkdirSync(process.env.LAINOS_DATA_DIR ?? "./data", { recursive: true });
    writeFileSync(seriesFile(), JSON.stringify(all));
  } catch {
    /* best-effort only */
  }
  return all[key].map((s) => s.eq);
}

const num = (s: unknown): number => (typeof s === "string" || typeof s === "number" ? Number(s) : NaN);

/** One reading of everything the wallet panel shows. Never throws: a failure is a note. */
export async function readPortfolio(runtime: IAgentRuntime): Promise<PortfolioView> {
  const now = Date.now();
  const chain = runtime.getService<ChainService>("chain");
  const base: PortfolioView = {
    mode: "none",
    wallet: "",
    symbol: chain?.nativeSymbol ?? "ETH",
    equity: null,
    pnl: null,
    pnlPct: null,
    balances: [],
    positions: 0,
    positionsValue: 0,
    series: [],
    trench: null,
    stocks: null,
    at: now,
  };
  const view = { ...base, ...(await desks(runtime)) };
  if (!chain?.configured) return { ...view, note: "no chain configured" };
  try {
    if (chain.paperMode) {
      const { data } = await paperReport(chain);
      const coins = Array.isArray(data.coins) ? (data.coins as { symbol: string; amount: string; priceUsd: number | null }[]) : [];
      const equity = num(data.equityNative);
      return {
        ...view,
        mode: "paper",
        wallet: String(data.wallet ?? ""),
        equity,
        pnl: num(data.pnlNative),
        pnlPct: parseFloat(String(data.returnPct ?? "")) || 0,
        balances: [
          { symbol: chain.nativeSymbol, amount: num(data.cashNative), usd: null },
          ...coins.map((c) => ({
            symbol: c.symbol,
            amount: num(c.amount),
            usd: typeof c.priceUsd === "number" ? num(c.amount) * c.priceUsd : null,
          })),
        ],
        positions: Array.isArray(data.positions) ? data.positions.length : 0,
        positionsValue: num(data.positionsValueNative),
        series: Number.isFinite(equity) ? record(`paper:${chain.chain.id}:${data.wallet}`, equity, now) : [],
      };
    }
    if (!chain.agentAddress) return { ...view, mode: "live", note: "no wallet configured" };
    const balance = num(await chain.nativeBalance(chain.agentAddress));
    return {
      ...view,
      mode: "live",
      wallet: `${chain.agentAddress.slice(0, 6)}…${chain.agentAddress.slice(-4)}`,
      equity: balance,
      balances: [{ symbol: chain.nativeSymbol, amount: balance, usd: null }],
      series: record(`live:${chain.chain.id}:${chain.agentAddress}`, balance, now),
    };
  } catch (err) {
    return { ...view, mode: chain.paperMode ? "paper" : "live", note: (err as Error).message.slice(0, 80) };
  }
}

/** The stock desk and the trench, from their in-memory snapshots (no network). */
async function desks(runtime: IAgentRuntime): Promise<Pick<PortfolioView, "trench" | "stocks">> {
  const out: Pick<PortfolioView, "trench" | "stocks"> = { trench: null, stocks: null };
  const trench = runtime.getService<TrenchService>("trench");
  const desk = runtime.getService<StockDeskService>("stocks");
  try {
    if (trench) {
      const snap = await trench.snapshot();
      out.trench = { on: snap.enabled, open: snap.positions.length };
    }
  } catch {
    /* a desk that cannot answer is left off */
  }
  try {
    if (desk) {
      const snap = await desk.snapshot();
      const usd = (raw: bigint) => Number(formatUnits(raw, USDG_DECIMALS));
      const marks = snap.positions.reduce((sum, p) => sum + usd(BigInt(p.mark || "0")), 0);
      const equityUsd = usd(snap.cash) + marks;
      const startUsd = usd(snap.start);
      out.stocks = {
        on: snap.enabled,
        equityUsd,
        pnlPct: startUsd > 0 ? ((equityUsd - startUsd) / startUsd) * 100 : 0,
        open: snap.positions.length,
      };
    }
  } catch {
    /* a desk that cannot answer is left off */
  }
  return out;
}

/** "1.0434", "0.006052", "12,345.67": as many digits as the size of the number earns. */
export function fmtAmount(n: number): string {
  const a = Math.abs(n);
  if (a >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  if (a >= 1) return n.toFixed(4);
  if (a === 0) return "0";
  return n.toPrecision(4).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

export function fmtUsd(n: number): string {
  const a = Math.abs(n);
  return `${n < 0 ? "-" : ""}$${a >= 100 ? a.toLocaleString("en-US", { maximumFractionDigits: 0 }) : a.toFixed(2)}`;
}

export function fmtSigned(n: number, digits?: (n: number) => string): string {
  const body = digits ? digits(Math.abs(n)) : fmtAmount(Math.abs(n));
  return `${n > 0 ? "+" : n < 0 ? "−" : "±"}${body}`;
}
