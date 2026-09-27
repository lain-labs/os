/**
 * The content plan: a calendar of what the account says on which day, plus the
 * standing brief that governs how any of it is said.
 *
 * It is data, not code, because it comes from outside the daemon — an analyst
 * read the account's last fifty posts and wrote a 28-day calendar out
 * of what actually worked. `content-plan.json` next to `soul.md` is that
 * document, parsed once and then only read. Everything here is pure so the
 * whole schedule can be tested against a fixed clock.
 */

/** One day of the calendar: the angle, its evidence, and the one question. */
export interface PostSlot {
  /** YYYY-MM-DD, host-local. */
  date: string;
  /** Weekday label as the plan wrote it ("Mon"). */
  day: string;
  /** Which of the four series this day belongs to. */
  pillar: string;
  /** The day's thesis — what the post is about. */
  primary: string;
  /** What the operator attaches: a clip, a screenshot, a poll. */
  asset: string;
  /** The single question the post ends on. */
  cta: string;
}

export interface ContentPlan {
  title: string;
  source?: string;
  /** X account the posts are published from. */
  account?: string;
  /** Telegram channel the same text goes to (and which proves it went out). */
  channel?: string;
  /** Language of the *post* — the brief itself may be written in another. */
  language: string;
  audience?: string;
  goal?: string;
  rhythm?: string;
  pillars: { name: string; share?: number; what: string }[];
  rules: string[];
  voice: string[];
  range: { from: string; to: string };
  slots: PostSlot[];
}

/** Host-local calendar day as YYYY-MM-DD — the plan's dates are local days. */
export function planDay(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Whole days between two YYYY-MM-DD dates (b - a), calendar arithmetic only. */
export function daysBetween(a: string, b: string): number {
  const parse = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  return Math.round((parse(b) - parse(a)) / 86_400_000);
}

/**
 * Read a plan document. Throws with a plain reason rather than returning a
 * half-plan: a press room running on a plan it misread would publish the wrong
 * day's thesis every day and never say why.
 */
export function parsePlan(raw: string): ContentPlan {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw new Error(`content plan is not valid JSON: ${(err as Error).message}`);
  }
  const p = doc as Partial<ContentPlan>;
  const slots = Array.isArray(p.slots) ? p.slots : [];
  const clean: PostSlot[] = [];
  for (const s of slots) {
    if (!s || typeof s !== "object") continue;
    const date = String((s as PostSlot).date ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    clean.push({
      date,
      day: String((s as PostSlot).day ?? "").trim(),
      pillar: String((s as PostSlot).pillar ?? "").trim(),
      primary: String((s as PostSlot).primary ?? "").trim(),
      asset: String((s as PostSlot).asset ?? "").trim(),
      cta: String((s as PostSlot).cta ?? "").trim(),
    });
  }
  if (!clean.length) throw new Error("content plan holds no dated slots");
  clean.sort((a, b) => a.date.localeCompare(b.date));
  return {
    title: p.title ?? "content plan",
    source: p.source,
    account: p.account,
    channel: p.channel,
    language: p.language?.trim() || "en",
    audience: p.audience,
    goal: p.goal,
    rhythm: p.rhythm,
    pillars: Array.isArray(p.pillars) ? p.pillars : [],
    rules: Array.isArray(p.rules) ? p.rules : [],
    voice: Array.isArray(p.voice) ? p.voice : [],
    range: p.range ?? { from: clean[0].date, to: clean[clean.length - 1].date },
    slots: clean,
  };
}

export function slotFor(plan: ContentPlan, day: string): PostSlot | undefined {
  return plan.slots.find((s) => s.date === day);
}

/** True once the calendar has run out — the plan ends, the daemon does not. */
export function planExhausted(plan: ContentPlan, day: string): boolean {
  return day > plan.range.to;
}

/**
 * What still owes a post, oldest first: every slot up to and including today
 * that nothing has been written for yet.
 *
 * Two guards decide the shape of a backlog. `maxBacklogDays` drops slots too
 * old to be worth publishing — a thesis from eleven days ago is not news, and
 * a daemon that was off for a month must not wake up owing thirty posts. And
 * the caller's `done` covers written, published *and* skipped alike, because
 * from the queue's side those are the same answer: this day is handled.
 */
export function pendingSlots(
  plan: ContentPlan,
  day: string,
  opts: { done: (date: string) => boolean; maxBacklogDays?: number },
): PostSlot[] {
  const maxAge = opts.maxBacklogDays ?? 3;
  return plan.slots.filter(
    (s) => s.date <= day && daysBetween(s.date, day) <= maxAge && !opts.done(s.date),
  );
}

/** The standing brief, rendered for the prompt exactly as the plan states it. */
export function briefText(plan: ContentPlan): string {
  const lines: string[] = [];
  if (plan.audience) lines.push(`Audience: ${plan.audience}`);
  if (plan.goal) lines.push(`Goal: ${plan.goal}`);
  if (plan.rhythm) lines.push(`Rhythm: ${plan.rhythm}`);
  if (plan.pillars.length) {
    lines.push("Pillars:");
    for (const pil of plan.pillars) {
      lines.push(`- ${pil.name}${pil.share ? ` (${pil.share}%)` : ""} — ${pil.what}`);
    }
  }
  if (plan.rules.length) {
    lines.push("Rules:");
    for (const r of plan.rules) lines.push(`- ${r}`);
  }
  if (plan.voice.length) {
    lines.push("Voice:");
    for (const v of plan.voice) lines.push(`- ${v}`);
  }
  return lines.join("\n");
}

/** The day's assignment, rendered for the prompt. */
export function slotText(slot: PostSlot): string {
  return [
    `Date: ${slot.date} (${slot.day})`,
    `Pillar: ${slot.pillar}`,
    `Today's thesis: ${slot.primary}`,
    `Asset the operator will attach: ${slot.asset}`,
    `Today's CTA: ${slot.cta}`,
  ].join("\n");
}
