import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createLogger } from "../logger.js";

const log = createLogger("model:limits");

/**
 * A spent subscription — Claude's weekly cap, Codex's usage limit, an API
 * account with no credit left — is not a failed call: it fails every call
 * until a known moment. Retrying it, or falling back onto it, only burns
 * another spawn and hides the one fact that matters ("claude is out until
 * Oct 24"). The chat router and the forge both read this book before they
 * pick an agent, and write to it when an agent says it is spent.
 */
export interface UsageLimit {
  /** When the agent says it is back (epoch ms) — a short guess when it did not say. */
  until: number;
  /** The agent's own words, one line. */
  reason: string;
  /** When the limit was seen. */
  at: number;
}

/** How long an agent that ran out without naming a reset time is left alone. */
const DEFAULT_COOLDOWN_MS = 15 * 60_000;
/** A per-minute rate limiter lets go much sooner than a spent subscription. */
const RATE_COOLDOWN_MS = 60_000;

const QUOTA_RE =
  /hit your (?:[\w-]+ )?limit|usage limit|(?:weekly|daily|monthly|session|hourly|\d+-hour) limit|quota|insufficient[_ ](?:credits?|quota|funds|balance)|credit balance is too low|out of (?:credits|tokens)|payment required/i;
const RATE_RE = /rate.?limit(?:ed)?\b|too many requests/i;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * Read an agent's error output for a usage limit. Null when the failure is
 * anything else (a crash, a bad flag, a timeout) — those are not quota and
 * must not take the agent out of rotation.
 */
export function parseUsageLimit(output: string, now = Date.now()): UsageLimit | null {
  const lines = output.split("\n").map((l) => l.trim());
  const quota = lines.find((l) => QUOTA_RE.test(l));
  const line = quota ?? lines.find((l) => RATE_RE.test(l));
  if (!line) return null;
  return {
    until: resetTime(output, now) ?? now + (quota ? DEFAULT_COOLDOWN_MS : RATE_COOLDOWN_MS),
    reason: line.length > 200 ? `${line.slice(0, 199)}…` : line,
    at: now,
  };
}

/**
 * The reset moment an agent names, in the forms the CLIs print:
 * "resets Oct 24, 9am (Europe/Moscow)", "resets 3pm", "try again at 3:04 PM",
 * "try again in 2 days 3 hours", "usage limit reached|1760000000".
 * Clock times are read in this machine's time zone.
 */
export function resetTime(output: string, now = Date.now()): number | undefined {
  const epoch = output.match(/limit[^|\n]*\|(\d{10})\b/i);
  if (epoch) return Number(epoch[1]) * 1000;

  const span = output.match(
    /(?:try again|retry|resets?|available again)(?: after| in)\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,]*(?:and\s+)?)+)/i,
  );
  if (span) {
    const units: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 };
    let total = 0;
    for (const [, n, unit] of span[1].matchAll(/(\d+)\s*([a-z]+)/gi)) {
      total += Number(n) * (units[unit[0].toLowerCase()] ?? 0);
    }
    if (total > 0) return now + total;
  }

  const at = output.match(
    /(?:resets?|again at)\s+(?:on\s+|at\s+)?(?:([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:(\d{4}),?\s+)?(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap])?\.?m?\b/i,
  );
  if (!at) return undefined;
  const [, monthName, day, year, hourRaw, minute, meridiem] = at;
  const month = monthName ? MONTHS.indexOf(monthName.slice(0, 3).toLowerCase()) : -1;
  if (monthName && month < 0) return undefined;
  // A bare number is not a time ("resets 24"): a clock time needs am/pm or minutes.
  if (!monthName && !meridiem && !minute) return undefined;
  let hour = Number(hourRaw) % (meridiem ? 12 : 24);
  if (meridiem?.toLowerCase() === "p") hour += 12;
  const base = new Date(now);
  const date = new Date(
    year ? Number(year) : base.getFullYear(),
    month >= 0 ? month : base.getMonth(),
    day ? Number(day) : base.getDate(),
    hour,
    Number(minute ?? 0),
  );
  // "resets 3pm" said at 4pm means tomorrow; "Jan 2" said in December means next year.
  if (date.getTime() <= now) {
    if (month < 0) date.setDate(date.getDate() + 1);
    else if (!year && now - date.getTime() > 86_400_000) date.setFullYear(date.getFullYear() + 1);
  }
  return date.getTime();
}

/** "Oct 24 09:00" — what an operator reads in a status line. */
export function formatUntil(until: number, now = Date.now()): string {
  const d = new Date(until);
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return sameDay ? time : `${MONTHS[d.getMonth()][0].toUpperCase()}${MONTHS[d.getMonth()].slice(1)} ${d.getDate()} ${time}`;
}

/**
 * The agents that are out right now, by kind ("claude", "codex", "opencode",
 * "openrouter", …), kept in <data>/limits.json so a restart does not spend a
 * spawn rediscovering what it already knew.
 */
export class UsageLimits {
  private limits: Record<string, UsageLimit> = {};

  constructor(private readonly file?: string) {
    if (!file) return;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { limits?: Record<string, UsageLimit> };
      this.limits = parsed.limits ?? {};
    } catch {
      // Nothing recorded yet.
    }
  }

  /** Record a limit when `output` is one; returns it, or null for any other failure. */
  note(kind: string, output: string, now = Date.now()): UsageLimit | null {
    const limit = parseUsageLimit(output, now);
    if (!limit) return null;
    this.limits[kind] = limit;
    log.warn(`${kind} is out of quota until ${formatUntil(limit.until, now)} — ${limit.reason}`);
    this.save();
    return limit;
  }

  /** The limit `kind` is under now, if any; a passed one is forgotten. */
  active(kind: string, now = Date.now()): UsageLimit | undefined {
    const limit = this.limits[kind];
    if (!limit) return undefined;
    if (limit.until > now) return limit;
    delete this.limits[kind];
    this.save();
    return undefined;
  }

  /** Every live limit, soonest back first. */
  list(now = Date.now()): Array<{ kind: string } & UsageLimit> {
    return Object.keys(this.limits)
      .map((kind) => ({ kind, limit: this.active(kind, now) }))
      .filter((e): e is { kind: string; limit: UsageLimit } => Boolean(e.limit))
      .map(({ kind, limit }) => ({ kind, ...limit }))
      .sort((a, b) => a.until - b.until);
  }

  /** One line for a status report: "claude out until Oct 24 09:00 (weekly limit …)". */
  describe(kind: string, now = Date.now()): string | undefined {
    const limit = this.active(kind, now);
    return limit ? `${kind} out of quota until ${formatUntil(limit.until, now)} (${limit.reason})` : undefined;
  }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, `${JSON.stringify({ limits: this.limits }, null, 2)}\n`, "utf8");
    } catch (err) {
      log.warn("could not persist usage limits", err);
    }
  }
}

const books = new Map<string, UsageLimits>();

/** The one book for a data dir: the chat router and the forge must see the same limits. */
export function usageLimits(dataDir: string): UsageLimits {
  const file = resolve(join(dataDir, "limits.json"));
  let book = books.get(file);
  if (!book) books.set(file, (book = new UsageLimits(file)));
  return book;
}
