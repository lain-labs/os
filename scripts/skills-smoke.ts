#!/usr/bin/env -S npx tsx
/**
 * Skills + routines smoke test (headless, no model, no chain).
 *
 * Pinned here:
 *   1. create_skill makes a live tool; writing it again under the same name is
 *      an edit that keeps the old version, and read_skill returns the source;
 *   2. an edit that fails to load leaves the working version live;
 *   3. revert_skill steps back, remove_skill unloads but keeps history;
 *   4. schedule_skill runs once right away, then on its interval, and reports
 *      only when the result changed (or every run, when asked);
 *   5. a daily routine fires once after its slot and skips a badly late one;
 *   6. a sentinel-triggered routine receives the alert as params.event;
 *   7. routines refuse execute/confirm arguments and unknown skills, and pause
 *      after five failures in a row;
 *   8. a routine created by one process is visible to another (shared store);
 *   9. a skill whose code was cut off by the reply budget is asked for again
 *      with room, instead of arriving as an empty create_skill.
 *
 * Run: npm run skills:smoke
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime, FileMemoryStore, type ModelProvider, type ModelRequest } from "../src/index.js";
import { lain } from "../src/characters/lain.js";
import { skillsPlugin, SkillsService } from "../src/plugins/skills/index.js";
import { isDue, parseInterval, RoutineService, type RoutineEvent } from "../src/plugins/skills/routines.js";
import type { Action, IAgentRuntime, State } from "../src/types.js";

const results: [string, boolean][] = [];
const check = (name: string, pass: boolean) => results.push([name, pass]);

const tmp = await mkdtemp(join(tmpdir(), "lainos-skills-"));
const settings: Record<string, string> = {
  LAINOS_SKILLS_DIR: join(tmp, "skills"),
  LAINOS_DATA_DIR: join(tmp, "data"),
  LAINOS_ROUTINES: "1",
  LAINOS_ROUTINES_TICK_MS: "3600000",
};

/** A runtime with the skills plugin and a sentinel that only relays alerts. */
async function bootRuntime(): Promise<{ runtime: IAgentRuntime; skills: SkillsService; routines: RoutineService; fireAlert: (watchId: string, text: string) => void }> {
  const alertSubs = new Set<(a: { id: string; watchId: string; text: string; at: number; delivered: boolean }) => void>();
  const services: Record<string, unknown> = {
    sentinel: { onAlert: (fn: never) => (alertSubs.add(fn), () => alertSubs.delete(fn)) },
  };
  const actions: Action[] = [];
  const runtime = {
    character: { name: "Lain" },
    actions,
    getSetting: (key: string) => settings[key],
    getService: (name: string) => services[name],
  } as unknown as IAgentRuntime;
  const skills = new SkillsService();
  const routines = new RoutineService();
  services.skills = skills;
  services.routines = routines;
  actions.push(...skillsPlugin.actions!);
  await skills.start(runtime);
  await routines.start(runtime);
  const fireAlert = (watchId: string, text: string) => {
    for (const fn of alertSubs) fn({ id: "a1", watchId, text, at: Date.now(), delivered: false });
  };
  return { runtime, skills, routines, fireAlert };
}

const { runtime, skills, routines, fireAlert } = await bootRuntime();
const state = { roomId: "tg-42", agentName: "Lain", message: { userId: "op" } } as unknown as State;
const act = (name: string, params: Record<string, unknown>) =>
  runtime.actions.find((a) => a.name === name)!.handler(runtime, state, params);
const call = (name: string, params: Record<string, unknown> = {}) =>
  runtime.actions.find((a) => a.name === name)!.handler(runtime, state, params);

const delivered: RoutineEvent[] = [];
routines.onEvent((ev) => delivered.push(ev));

// The value a skill reports is read from a global the test controls.
const g = globalThis as unknown as { holdersShare: number; seenEvent?: unknown };
g.holdersShare = 61.2;

const v1 = `export default {
  name: "holder_share",
  description: "Share of supply the top holders own.",
  async handler(runtime, state, params) {
    globalThis.seenEvent = params.event;
    return { ok: true, text: "top-10 hold " + globalThis.holdersShare + "%", data: { fingerprint: globalThis.holdersShare } };
  },
};`;
const v2 = v1.replace("top-10 hold", "top-10 (no pools) hold");

// 1. create, edit, read
const created = await act("create_skill", { name: "holder_share", code: v1 });
check("create_skill makes a live tool", created.ok && (await call("holder_share")).text === "top-10 hold 61.2%");
const edited = await act("create_skill", { name: "holder_share", code: v2 });
check("writing the same name is an edit", edited.ok && /updated/.test(edited.text ?? "") && (await call("holder_share")).text === "top-10 (no pools) hold 61.2%");
const source = await act("read_skill", { name: "holder_share" });
check("read_skill returns the live source and counts versions", source.ok && /no pools/.test(source.text ?? "") && source.data?.versions === 1);

// 2. a broken edit keeps the working version
const broken = await act("create_skill", { name: "holder_share", code: "export default { name: 'holder_share' };" });
check("a broken edit is refused", !broken.ok && /still live/.test(broken.text ?? ""));
check("…and the working version stays live", (await call("holder_share")).text === "top-10 (no pools) hold 61.2%");
check("…and leaves no extra version behind", (await skills.readSkill("holder_share")).versions === 1);
const misnamed = await act("create_skill", { name: "other_tool", code: v1 });
check("a module named differently from its skill is refused", !misnamed.ok && !runtime.actions.some((a) => a.name === "other_tool"));
check("…without touching the live skill of that name", (await call("holder_share")).text === "top-10 (no pools) hold 61.2%");

// 3. revert, remove
const reverted = await act("revert_skill", { name: "holder_share" });
check("revert_skill puts the previous version back", reverted.ok && (await call("holder_share")).text === "top-10 hold 61.2%");
const nothingLeft = await act("revert_skill", { name: "holder_share" });
check("revert_skill says when there is nothing older", !nothingLeft.ok);
await act("create_skill", { name: "holder_share", code: v2 });

// 4. interval routine: first run now, reports on change only
const scheduled = await act("schedule_skill", { skill: "holder_share", every: "6h", note: "tell me when the share moves" });
check("schedule_skill runs once right away and returns it", scheduled.ok && /First run \(ok\): top-10 \(no pools\) hold 61\.2%/.test(scheduled.text ?? ""));
const [r1] = await routines.list();
check("the routine remembers the Telegram chat it was set up from", r1?.chatId === 42 && r1.notify === "change");
const t0 = Date.now();
await routines.tick(t0 + 3_600_000);
check("not due before its interval", (await routines.list())[0].runs === 1);
await routines.tick(t0 + 6 * 3_600_000 + 1_000);
check("an unchanged result is not reported", (await routines.list())[0].runs === 2 && delivered.length === 0);
g.holdersShare = 58.9;
await routines.tick(t0 + 12 * 3_600_000 + 2_000);
check("a changed result is reported to the chat", delivered.length === 1 && delivered[0].chatId === 42 && /58\.9%/.test(delivered[0].text) && /tell me when the share moves/.test(delivered[0].text));
const always = await act("schedule_skill", { skill: "holder_share", every: "1h", notify: "always" });
const alwaysId = String((always.data?.routine as { id: string }).id);
await routines.run(alwaysId, { deliver: true });
check("notify=always reports an unchanged result", delivered.length === 2 && delivered[1].routine.id === alwaysId);

// 5. daily routine
const daily = await act("schedule_skill", { skill: "holder_share", at: "09:00" });
const dailyRoutine = (await routines.list()).find((r) => r.trigger.kind === "daily")!;
const nine = new Date(); nine.setHours(9, 0, 0, 0);
const dailyFresh = { ...dailyRoutine, lastRunAt: nine.getTime() - 86_400_000 };
check("a daily routine is due just after its slot", daily.ok && isDue(dailyFresh, nine.getTime() + 60_000));
check("…not before it", !isDue(dailyFresh, nine.getTime() - 60_000));
check("…and a badly late slot is skipped", !isDue(dailyFresh, nine.getTime() + 4 * 3_600_000));
check("…and it fires once per day", !isDue({ ...dailyFresh, lastRunAt: nine.getTime() + 60_000 }, nine.getTime() + 120_000));

// 6. sentinel-triggered routine
const onAlert = await act("schedule_skill", { skill: "holder_share", on: "sentinel", watch: "w3" });
check("an event routine is stored without a first run", onAlert.ok && !/First run/.test(onAlert.text ?? ""));
fireAlert("w9", "w9: some other wallet moved");
await new Promise((r) => setTimeout(r, 50));
check("alerts from other watches are ignored", g.seenEvent === undefined || (g.seenEvent as { watchId?: string }).watchId !== "w9");
fireAlert("w3", "w3: 0xab… bought TOKA");
await new Promise((r) => setTimeout(r, 50));
check("the matching alert runs the skill with params.event", (g.seenEvent as { text?: string } | undefined)?.text === "w3: 0xab… bought TOKA");

// 7. refusals and failure pause
const unsafe = await act("schedule_skill", { skill: "holder_share", every: "1h", params: { execute: true } });
check("a routine never passes execute", !unsafe.ok && /never passes "execute"/.test(unsafe.text ?? ""));
const unknown = await act("schedule_skill", { skill: "portfolio_pnl", every: "1h" });
check("only self-written skills can be scheduled", !unknown.ok);
const tooFast = await act("schedule_skill", { skill: "holder_share", every: "1m" });
check("intervals under 5 minutes are refused", !tooFast.ok);
const twoTriggers = await act("schedule_skill", { skill: "holder_share", every: "1h", at: "09:00" });
check("exactly one trigger is required", !twoTriggers.ok);
await act("create_skill", {
  name: "flaky",
  code: `export default { name: "flaky", description: "always fails", async handler() { return { ok: false, text: "RPC down" }; } };`,
});
const flaky = await act("schedule_skill", { skill: "flaky", every: "5m" });
const flakyId = String((flaky.data?.routine as { id: string }).id);
const before = delivered.length;
for (let i = 0; i < 4; i++) await routines.run(flakyId, { deliver: true });
const flakyRoutine = (await routines.list()).find((r) => r.id === flakyId)!;
check("a failing routine pauses after five failures", flakyRoutine.paused === true && flakyRoutine.failures === 5);
check("…and reports the pause, not every failure", delivered.length - before === 1 && /paused/.test(delivered.at(-1)!.text));

// 8. shared store across processes
const other = new RoutineService();
await other.start({ ...runtime, getSetting: (key: string) => (key === "LAINOS_ROUTINES" ? "0" : settings[key]) } as IAgentRuntime);
check("another process sees the same routines", (await other.list()).length === (await routines.list()).length);
await other.stop();

const removed = await act("remove_skill", { name: "holder_share" });
const history = await readdir(join(tmp, "data", "skills-history", "holder_share"));
check("remove_skill unloads the tool and keeps its history", removed.ok && !runtime.actions.some((a) => a.name === "holder_share") && history.length >= 2);
check("parseInterval reads 15m / 2h / 1d", parseInterval("15m") === 900_000 && parseInterval("2h") === 7_200_000 && parseInterval("1d") === 86_400_000 && parseInterval("soon") === null);

await routines.stop();
await skills.stop();

// 9. a tool call cut off by the reply budget is asked for again with room
const budgets: number[] = [];
const cutModel: ModelProvider = {
  name: "cut-stub",
  modelFor: () => "cut-stub",
  async generate(request: ModelRequest) {
    budgets.push(request.maxTokens ?? 0);
    if (budgets.length === 1) {
      // What a provider returns when the module did not fit: the call, with its arguments lost.
      return { text: "", toolCalls: [{ name: "create_skill", input: {} }], model: "cut-stub", truncated: true };
    }
    if (budgets.length === 2) {
      return { text: "", toolCalls: [{ name: "create_skill", input: { name: "roomy_tool", code: v1.replace(/holder_share/g, "roomy_tool") } }], model: "cut-stub" };
    }
    return { text: "built it", toolCalls: [], model: "cut-stub" };
  },
};
const cutDir = join(tmp, "cut");
const cutRuntime = new AgentRuntime({
  character: lain,
  memory: new FileMemoryStore(cutDir),
  model: cutModel,
  settings: { LAINOS_DATA_DIR: cutDir, LAINOS_SKILLS_DIR: join(cutDir, "skills"), LAINOS_MODEL_TRANSCRIPTS: "0" },
});
cutRuntime.use({ ...skillsPlugin, services: [new SkillsService(), new RoutineService()] });
await cutRuntime.start();
await cutRuntime.handleMessage({ roomId: "cut", userId: "tester", text: "build me a tool" });
check("a cut-off tool call is asked for again with an 8192-token budget", budgets[0] === 1024 && budgets[1] === 8192);
check("…and the full module becomes a live skill", cutRuntime.actions.some((a) => a.name === "roomy_tool"));
await cutRuntime.stop();

await rm(tmp, { recursive: true, force: true });

let failed = 0;
for (const [name, pass] of results) {
  console.log(`${pass ? "✓" : "✗"} ${name}`);
  if (!pass) failed += 1;
}
if (failed) {
  console.error(`${failed} skills check(s) failed`);
  process.exit(1);
}
console.log(`skills smoke ok (${results.length} checks)`);
