/**
 * The morning brief's raw material. What the model gets to read is decided
 * here, without the model: the portfolio with each position's move since the
 * last brief, the watched wallets' moves of the last day (marked when they
 * touch a token the operator holds), and the alerts of the last day. The
 * model's job is only to cut it down to what matters, or to say NOTHING.
 */
import type { Address } from "viem";
import type { WalletMove } from "./activity.js";

export interface BriefPosition {
  token: string;
  symbol: string;
  /** Live sell-side value in the native currency. */
  valueNative: number;
}

export interface BriefSnapshot {
  at: number;
  positions: BriefPosition[];
}

/** "08:00" → {8, 0}; null when it is not a clock time. */
export function parseClock(raw: string): { hour: number; minute: number } | null {
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  return hour < 24 && minute < 60 ? { hour, minute } : null;
}

/** The local calendar day, "YYYY-MM-DD". */
export function localDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Position value changes this large since the last brief are called out. */
const SHARP_MOVE = 0.1;

/** The text handed to the model, or null when there is nothing to read at all. */
export function briefMaterial(input: {
  portfolioText?: string;
  positions: BriefPosition[];
  previous?: BriefSnapshot;
  moves: WalletMove[];
  alerts: { text: string; at: number }[];
  labelFor: (wallet: Address) => string;
}): string | null {
  const held = new Set(input.positions.map((p) => p.token.toLowerCase()));
  const sections: string[] = [];

  if (input.portfolioText) {
    const changes: string[] = [];
    const before = new Map((input.previous?.positions ?? []).map((p) => [p.token.toLowerCase(), p]));
    for (const p of input.positions) {
      const prev = before.get(p.token.toLowerCase());
      before.delete(p.token.toLowerCase());
      if (!prev) {
        if (input.previous) changes.push(`${p.symbol}: new since the last brief`);
        continue;
      }
      if (prev.valueNative <= 0) continue;
      const delta = (p.valueNative - prev.valueNative) / prev.valueNative;
      if (Math.abs(delta) >= SHARP_MOVE) {
        changes.push(`${p.symbol}: ${delta > 0 ? "+" : ""}${(delta * 100).toFixed(1)}% in value since the last brief`);
      }
    }
    for (const gone of before.values()) changes.push(`${gone.symbol}: no longer held`);
    sections.push(
      `Portfolio now:\n${input.portfolioText}` +
        (input.previous
          ? `\n\nSince the last brief: ${changes.length ? `\n${changes.map((c) => `- ${c}`).join("\n")}` : "no position moved 10% or more."}`
          : "\n\n(No earlier brief to compare against.)"),
    );
  }

  if (input.moves.length) {
    const lines = input.moves.map((m) => {
      const what =
        m.side === "buy"
          ? m.fresh
            ? `opened a new position in ${m.symbol}`
            : `bought more ${m.symbol}`
          : m.fresh
            ? `sold out of ${m.symbol}`
            : `sold some ${m.symbol}`;
      const mark = held.has(m.token.toLowerCase()) ? " [OPERATOR HOLDS THIS]" : "";
      return `- ${new Date(m.at).toISOString().slice(11, 16)}Z ${input.labelFor(m.wallet)} ${what} (${m.amount}, now ${m.balance}; ${m.token})${mark}`;
    });
    sections.push(`Watched wallets, last 24h:\n${lines.join("\n")}`);
  }

  if (input.alerts.length) {
    sections.push(`Alerts, last 24h:\n${input.alerts.map((a) => `- ${a.text}`).join("\n")}`);
  }

  if (!input.moves.length && !input.alerts.length && !input.portfolioText) return null;
  return sections.join("\n\n");
}
