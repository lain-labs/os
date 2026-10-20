import type { TelegramSender } from "./plugins/telegram/identity.js";
import type { State } from "./types.js";

/**
 * Is this turn's sender the operator? Decided in code from who the message
 * came from, never from what it says about itself: the local terminal, or the
 * Telegram operator — TELEGRAM_OPERATOR_ID / _USERNAME once set, before that
 * any user on TELEGRAM_ALLOWED_USERS. Everyone else (Telegram guests, HTTP
 * callers, background turns) is not.
 */
export function isOperator(state: State, allowedUsers: string | undefined): boolean {
  const who = state.message.userId;
  if (who === "user") return true; // the TUI / CLI on this machine
  if (!who.startsWith("tg:")) return false;
  // Once the operator is named, the client's code-matched role decides: a
  // guest on the allowlist may talk, not configure.
  const sender = state.message.metadata?.telegram as TelegramSender | undefined;
  if (sender?.operatorKnown) return sender.role === "operator";
  const allowed = (allowedUsers ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^@/, "").toLowerCase())
    .filter(Boolean);
  return allowed.includes(who.slice(3).toLowerCase());
}
