import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fetch as undiciFetch, ProxyAgent } from "undici";
import { createLogger } from "../../logger.js";
import type { Action, IAgentRuntime, Plugin, Service } from "../../types.js";
import { onTelegramCallback, onTelegramText } from "../telegram/callbacks.js";
import { SEED_PLAN } from "./seed.js";

const log = createLogger("plugin:plan");

/**
 * The team's plan, asked about in Telegram.
 *
 * The plan (data/plan.json, seeded from the review of 2026-11-04) is a list of
 * items with an owner, a due date and a status. On working days at
 * LAINOS_PLAN_HOUR (Moscow time, default 11) Lain writes to each person in
 * plan.people about the item that is due soonest and not done — in Russian, by
 * name, with four buttons: done, in progress, stuck, a week later. "Stuck" asks
 * what is in the way and keeps the next message as the note. On Mondays the
 * operator also gets the whole plan, item by item.
 *
 * Off unless LAINOS_PLAN=1. Nothing here moves money or runs code.
 */

export type PlanStatus = "todo" | "doing" | "done" | "stuck";

export interface PlanItem {
  id: string;
  owner: string;
  title: string;
  /** YYYY-MM-DD */
  due: string;
  status: PlanStatus;
  /** Why it matters, one line — said in the question. */
  why?: string;
  note?: string;
  askedAt?: number;
  updatedAt?: number;
}

export interface PlanPerson {
  name: string;
  chatId: string;
}

export interface PlanFile {
  people: Record<string, PlanPerson>;
  items: PlanItem[];
  log: { at: number; item: string; by: string; status: PlanStatus; note?: string }[];
  lastAskedDay?: string;
  lastSummaryDay?: string;
}

const STATUS_WORDS: Record<PlanStatus, string> = { todo: "не начато", doing: "в работе", done: "сделано", stuck: "застряло" };
const BUTTONS: { label: string; action: string }[] = [
  { label: "✅ Сделано", action: "done" },
  { label: "⏳ В работе", action: "doing" },
  { label: "🧱 Застрял", action: "stuck" },
  { label: "📅 +неделя", action: "later" },
];

/** Moscow calendar day and hour; the plan's days are Moscow days. */
export function moscow(now: Date): { day: string; hour: number; weekday: number } {
  const shifted = new Date(now.getTime() + 3 * 3_600_000);
  return { day: shifted.toISOString().slice(0, 10), hour: shifted.getUTCHours(), weekday: shifted.getUTCDay() };
}

const daysBetween = (from: string, to: string): number => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

const addDays = (day: string, n: number): string => new Date(Date.parse(day) + n * 86_400_000).toISOString().slice(0, 10);

/** The one item to ask this person about: not done, not asked in the last two days, due soonest. */
export function nextItem(plan: PlanFile, owner: string, now: Date): PlanItem | undefined {
  const twoDays = 2 * 86_400_000;
  return plan.items
    .filter((item) => item.owner === owner && item.status !== "done" && (!item.askedAt || now.getTime() - item.askedAt >= twoDays))
    .sort((a, b) => a.due.localeCompare(b.due))
    .at(0);
}

export function whenWords(today: string, due: string): string {
  const d = daysBetween(today, due);
  if (d < -1) return `срок был ${-d} дн. назад`;
  if (d === -1) return "срок был вчера";
  if (d === 0) return "срок сегодня";
  if (d === 1) return "срок завтра";
  return `срок через ${d} дн.`;
}

/** The question, in Russian, by name. */
export function questionText(person: PlanPerson, item: PlanItem, today: string): string {
  const status = item.status === "todo" ? "" : ` Сейчас отмечено: ${STATUS_WORDS[item.status]}.`;
  return [
    `${person.name}, сверяемся с планом.`,
    "",
    `«${item.title}» — ${whenWords(today, item.due)}.${status}`,
    ...(item.why ? [`Зачем: ${item.why}`] : []),
    "",
    "Как с этим?",
  ].join("\n");
}

/** What a button does to an item, and what Lain says back. */
export function applyAnswer(plan: PlanFile, itemId: string, action: string, by: string, now: Date): { toast: string; note: string; reply?: string } | null {
  const item = plan.items.find((i) => i.id === itemId);
  if (!item) return null;
  const today = moscow(now).day;
  let note: string;
  let reply: string | undefined;
  if (action === "later") {
    item.due = addDays(item.due < today ? today : item.due, 7);
    item.status = item.status === "todo" ? "todo" : item.status;
    note = `→ перенесено на ${item.due}`;
  } else if (action === "done" || action === "doing" || action === "stuck") {
    item.status = action;
    note = `→ ${STATUS_WORDS[action]}`;
    if (action === "stuck") reply = "Что мешает? Напиши одной фразой — запишу и вынесу на разбор в понедельник.";
    if (action === "done") {
      const next = plan.items.filter((i) => i.owner === item.owner && i.status !== "done" && i.id !== item.id).sort((a, b) => a.due.localeCompare(b.due)).at(0);
      reply = next ? `Записала. Следующее по плану: «${next.title}» (${whenWords(today, next.due)}).` : "Записала. По плану у тебя больше ничего не осталось.";
    }
  } else {
    return null;
  }
  item.updatedAt = now.getTime();
  plan.log.push({ at: now.getTime(), item: item.id, by, status: item.status });
  return { toast: note.replace("→ ", ""), note, reply };
}

export function summaryText(plan: PlanFile, today: string): string {
  const lines = ["План на неделю — где мы.", ""];
  for (const [owner, person] of Object.entries(plan.people)) {
    const items = plan.items.filter((i) => i.owner === owner).sort((a, b) => a.due.localeCompare(b.due));
    const done = items.filter((i) => i.status === "done").length;
    lines.push(`${person.name}: ${done} из ${items.length} сделано`);
    for (const item of items.filter((i) => i.status !== "done")) {
      lines.push(`• ${item.title} — ${STATUS_WORDS[item.status]}, ${whenWords(today, item.due)}${item.note ? `; мешает: ${item.note}` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

export class PlanService implements Service {
  readonly name = "plan";
  private runtime?: IAgentRuntime;
  private file = "";
  private plan: PlanFile | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** chatId → item waiting for a "what is in the way" note. */
  private awaitingNote = new Map<string, string>();

  async start(runtime: IAgentRuntime): Promise<void> {
    if (runtime.getSetting("LAINOS_PLAN") !== "1") return;
    this.runtime = runtime;
    this.file = join(runtime.getSetting("LAINOS_DATA_DIR") ?? "./data", "plan.json");
    await this.load();
    onTelegramCallback("plan", async (press) => {
      const [itemId, action] = press.data.split(":");
      if (!itemId || !action || !this.plan) return null;
      const owner = this.ownerOf(String(press.chatId));
      const answer = applyAnswer(this.plan, itemId, action, owner ?? String(press.fromId), new Date());
      if (!answer) return { toast: "Этого пункта уже нет в плане" };
      if (action === "stuck") this.awaitingNote.set(String(press.chatId), itemId);
      await this.persist();
      return answer;
    });
    onTelegramText(async (chatId, text) => {
      const itemId = this.awaitingNote.get(String(chatId));
      if (!itemId || !this.plan) return null;
      this.awaitingNote.delete(String(chatId));
      const item = this.plan.items.find((i) => i.id === itemId);
      if (!item) return null;
      item.note = text.slice(0, 500);
      item.updatedAt = Date.now();
      this.plan.log.push({ at: Date.now(), item: item.id, by: this.ownerOf(String(chatId)) ?? String(chatId), status: item.status, note: item.note });
      await this.persist();
      return "Записала. Вынесу на разбор в понедельник.";
    });
    this.timer = setInterval(() => void this.tick(new Date()).catch((err) => log.warn(`plan tick failed: ${err instanceof Error ? err.message : String(err)}`)), 5 * 60_000);
    this.timer.unref?.();
    log.info(`plan: ${this.plan?.items.length ?? 0} items for ${Object.values(this.plan?.people ?? {}).map((p) => p.name).join(", ")}; asks on working days at ${this.hour()}:00 Moscow`);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): PlanFile | null {
    return this.plan;
  }

  private hour(): number {
    return Number(this.runtime?.getSetting("LAINOS_PLAN_HOUR") ?? 11) || 11;
  }

  private ownerOf(chatId: string): string | undefined {
    return Object.entries(this.plan?.people ?? {}).find(([, person]) => person.chatId === chatId)?.[0];
  }

  /** Ask once per working day at the hour; the Monday summary goes to the operator first. */
  async tick(now: Date): Promise<void> {
    if (!this.plan) return;
    const { day, hour, weekday } = moscow(now);
    if (weekday === 0 || weekday === 6 || hour < this.hour() || this.plan.lastAskedDay === day) return;
    this.plan.lastAskedDay = day;
    const operator = Object.keys(this.plan.people).at(0);
    if (weekday === 1 && this.plan.lastSummaryDay !== day && operator) {
      this.plan.lastSummaryDay = day;
      await this.send(this.plan.people[operator]!.chatId, summaryText(this.plan, day));
    }
    for (const [owner, person] of Object.entries(this.plan.people)) {
      const item = nextItem(this.plan, owner, now);
      if (!item) continue;
      const sent = await this.send(person.chatId, questionText(person, item, day), item.id);
      if (sent) item.askedAt = now.getTime();
    }
    await this.persist();
  }

  private async send(chatId: string, text: string, itemId?: string): Promise<boolean> {
    const runtime = this.runtime;
    if (!runtime) return false;
    const token = runtime.getSetting("TELEGRAM_BOT_TOKEN") ?? "";
    if (!token) return false;
    const proxy = runtime.getSetting("TELEGRAM_PROXY") ?? runtime.getSetting("HTTPS_PROXY");
    const body: Record<string, unknown> = { chat_id: chatId, text };
    if (itemId) body.reply_markup = { inline_keyboard: [BUTTONS.slice(0, 2), BUTTONS.slice(2)].map((row) => row.map((b) => ({ text: b.label, callback_data: `plan:${itemId}:${b.action}` }))) };
    try {
      const res = await undiciFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        dispatcher: proxy ? new ProxyAgent(proxy) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
      const json = (await res.json()) as { ok: boolean; description?: string };
      if (!json.ok) log.warn(`plan message to ${chatId} refused: ${json.description}`);
      return json.ok;
    } catch (err) {
      log.warn(`plan message to ${chatId} failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private async load(): Promise<void> {
    try {
      this.plan = JSON.parse(await readFile(this.file, "utf8")) as PlanFile;
    } catch {
      this.plan = structuredClone(SEED_PLAN);
      await this.persist();
    }
  }

  private async persist(): Promise<void> {
    if (!this.plan) return;
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.plan, null, 2));
  }
}

const planStatusAction: Action = {
  name: "plan_status",
  similes: ["team_plan", "plan_progress", "how_is_the_plan"],
  description:
    "The team's plan for November (Lev and Orpheus): every item with its owner, due date, status and the note on what is in the way. Use it when someone asks how the plan is going or what is next.",
  parameters: { type: "object", properties: {} },
  examples: [{ user: "как там план?", agent: "(plan_status) Лев: 1 из 9 сделано; Guard Mode — срок завтра…" }],
  validate: async (runtime) => Boolean(runtime.getService<PlanService>("plan")?.status()),
  handler: async (runtime) => {
    const plan = runtime.getService<PlanService>("plan")?.status();
    if (!plan) return { ok: false, text: "The plan is not switched on (LAINOS_PLAN=1)." };
    return { ok: true, text: summaryText(plan, moscow(new Date()).day) };
  },
};

export const planPlugin: Plugin = {
  name: "plan",
  description: "The team's plan in Telegram: daily personal questions with buttons, Monday summary (LAINOS_PLAN=1).",
  actions: [planStatusAction],
  providers: [],
  services: [new PlanService()],
};
