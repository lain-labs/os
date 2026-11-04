/**
 * Plan smoke: who is asked about what, in Russian, and what each button does;
 * and which chats get every message in Russian.
 */
import { applyAnswer, moscow, nextItem, planSection, questionText, summaryText, type PlanFile } from "../src/plugins/plan/index.js";
import { isRussianChat, inChatLanguage, looksRussian, setRussianTranslator } from "../src/plugins/telegram/language.js";

const results: [string, boolean][] = [];
const check = (name: string, pass: boolean) => results.push([name, pass]);

const plan = (): PlanFile => ({
  people: { lev: { name: "Лев", chatId: "1" }, orpheus: { name: "Орфей", chatId: "2" } },
  items: [
    { id: "a", owner: "lev", title: "Поднять Guard Mode", due: "2026-11-07", status: "todo", why: "живые сделки", link: "https://chaos.fm/hub" },
    { id: "b", owner: "lev", title: "Решить про главную", due: "2026-11-08", status: "todo" },
    { id: "c", owner: "lev", title: "Уже сделано", due: "2026-11-01", status: "done" },
    { id: "d", owner: "orpheus", title: "Пост в @cyberia_chain", due: "2026-11-09", status: "todo" },
  ],
  log: [],
});

const now = new Date("2026-11-06T08:30:00Z"); // 11:30 in Moscow, a Friday
check("Moscow day and hour", moscow(now).day === "2026-11-06" && moscow(now).hour === 11 && moscow(now).weekday === 5);

const p = plan();
check("asks about the item due soonest, never a done one", nextItem(p, "lev", now)?.id === "a");
p.items[0]!.askedAt = now.getTime();
check("not the same item two days running", nextItem(p, "lev", new Date(now.getTime() + 86_400_000))?.id === "b");

const q = questionText(p.people.lev!, p.items[0]!, "2026-11-06");
check("the question names the person, the item and the deadline", q.startsWith("Лев,") && q.includes("«Поднять Guard Mode» — срок завтра") && q.includes("Зачем: живые сделки") && q.includes("Ссылка: https://chaos.fm/hub"));

const done = applyAnswer(p, "a", "done", "lev", now);
check("done marks it and names what is next", p.items[0]!.status === "done" && done?.reply?.includes("«Решить про главную»") === true);
const later = applyAnswer(p, "b", "later", "lev", now);
check("a week later moves the date by seven days", p.items[1]!.due === "2026-11-15" && later?.note === "→ перенесено на 2026-11-15");
const stuck = applyAnswer(p, "d", "stuck", "orpheus", now);
check("stuck asks what is in the way", p.items[3]!.status === "stuck" && stuck?.reply?.startsWith("Что мешает?") === true);
check("an unknown item or button does nothing", applyAnswer(p, "zzz", "done", "lev", now) === null && applyAnswer(p, "b", "explode", "lev", now) === null);
check("every answer is logged", p.log.length === 3);

p.items[3]!.note = "нет доступа к аккаунту";
const summary = summaryText(p, "2026-11-09");
check("the Monday summary lists open items with their blockers", summary.includes("Лев: 2 из 3 сделано") && summary.includes("мешает: нет доступа к аккаунту"));

const section = planSection(p, "2026-11-09");
const json = JSON.parse(section.slice(section.indexOf("```json") + 7, section.lastIndexOf("```")));
check("the chaos.fm copy has a table and the hub's JSON, without chat ids", section.includes("| Лев | Поднять Guard Mode |") && json.items.length === 4 && !section.includes('"chatId"') && json.people.lev.name === "Лев");

const env: Record<string, string> = { TELEGRAM_RUSSIAN_CHATS: "-1003904310783" };
const g = (k: string) => env[k];
check("bots is a Russian-only chat, the operator's private chat is not", isRussianChat(g, -1003904310783) && !isRussianChat(g, 819914001));
check("Cyrillic text counts as Russian, English does not", looksRussian("Привет, это сводка") && !looksRussian("Social networks built for AI agents digest"));
setRussianTranslator(async () => "Соцсети для ИИ-агентов");
check("English bound for bots is translated", (await inChatLanguage(g, -1003904310783, "Social networks built for AI agents")) === "Соцсети для ИИ-агентов");
check("Russian text and other chats pass untouched", (await inChatLanguage(g, -1003904310783, "Уже по-русски, ничего не трогаем")) === "Уже по-русски, ничего не трогаем" && (await inChatLanguage(g, 5, "keep english here")) === "keep english here");

let failed = 0;
for (const [name, pass] of results) {
  console.log(`${pass ? "ok  " : "FAIL"} ${name}`);
  if (!pass) failed++;
}
console.log(failed ? `\n${failed} failed` : `\nall ${results.length} passed`);
process.exit(failed ? 1 : 0);
