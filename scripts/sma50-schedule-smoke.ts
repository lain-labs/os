import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillsService } from "../src/plugins/skills/index.js";
import { describeTrigger, isDue, RoutineService, type Routine, type RoutineEvent } from "../src/plugins/skills/routines.js";
import type { Action, IAgentRuntime, State } from "../src/types.js";

const root = await mkdtemp(join(tmpdir(), "lainos-sma50-schedule-"));
const originalNow = Date.now;
const originalFetch = globalThis.fetch;
const originalTZ = process.env.TZ;
process.env.TZ = "UTC";
let now = Date.parse("2026-10-19T19:00:00Z");
Date.now = () => now;
const STEP = 4 * 3_600_000;
const actions: Action[] = [];
const services: Record<string, unknown> = {};
const settings: Record<string, string> = {
  LAINOS_DATA_DIR: root, LAINOS_SKILLS_DIR: join(root, "skills"),
  LAINOS_ROUTINES: "1", LAINOS_ROUTINES_TICK_MS: "3600000",
};
const runtime = { actions, character: { name: "Lain" },
  getSetting: (key: string) => settings[key], getService: (name: string) => services[name],
} as unknown as IAgentRuntime;
const state = { roomId: "tg-42", message: { userId: "tester" } } as State;
const skills = new SkillsService();
let routines = new RoutineService();
services.skills = skills;
services.routines = routines;
let requests = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  requests++;
  const url = new URL(String(input));
  assert.equal(url.origin, "https://data-api.binance.vision");
  assert.equal(url.pathname, "/api/v3/klines");
  assert.equal(init?.method, "GET");
  const cutoff = Math.floor(now / STEP) * STEP;
  const rows = Array.from({ length: 60 }, (_, i) => {
    const start = cutoff - (60 - i) * STEP;
    return [start, "100", "100", "100", "100", "1", start + STEP - 1];
  });
  return new Response(JSON.stringify(rows), { status: 200 });
}) as typeof fetch;

try {
  const sample = { trigger: { kind: "daily", at: "03:00", timeZone: "Europe/Moscow" }, lastRunAt: 0 } as Routine;
  assert.equal(isDue(sample, Date.parse("2026-10-18T23:59:59Z")), false);
  assert.equal(isDue(sample, Date.parse("2026-10-19T00:00:00Z")), true);
  assert.equal(isDue({ ...sample, lastRunAt: Date.parse("2026-10-19T00:00:00Z") }, Date.parse("2026-10-19T00:01:00Z")), false);
  assert.equal(isDue(sample, Date.parse("2026-10-19T03:00:00Z")), false);
  assert.match(describeTrigger(sample.trigger), /Europe\/Moscow/);
  // Existing host-local routines retain their behavior.
  assert.equal(isDue({ ...sample, trigger: { kind: "daily", at: "03:00" } }, Date.parse("2026-10-19T03:00:00Z")), true);

  await skills.start(runtime);
  await copyFile(new URL("../skills/sma50_paper.mjs", import.meta.url), join(settings.LAINOS_SKILLS_DIR!, "sma50_paper.mjs"));
  await skills.syncAll();
  await routines.start(runtime);
  const action = actions.find((a) => a.name === "sma50_paper")!;
  assert.ok(action);
  const setup = await action.handler(runtime, state, { mode: "setup" });
  assert.equal(setup.ok, true, setup.text);
  assert.equal(setup.data?.launched, true);
  assert.equal((await routines.list()).length, 7);
  assert.equal(requests, 2);

  // Restart the actual scheduler over the same file before the next close.
  await routines.stop();
  routines = new RoutineService();
  services.routines = routines;
  await routines.start(runtime);
  const events: RoutineEvent[] = [];
  routines.onEvent((e) => events.push(e));
  now = Date.parse("2026-10-19T20:00:30Z"); // 23:00 Moscow, not 23:00 UTC.
  await routines.tick(now);
  assert.equal(requests, 4);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.routine.trigger.kind, "daily");
  assert.equal(events[0]!.routine.params.mode, "check");
  now += 30_000;
  await routines.tick(now);
  assert.equal(requests, 4);
  now = Date.parse("2026-10-19T20:05:00Z");
  await routines.tick(now);
  assert.equal(requests, 4); // A report does not fetch or trade.
  assert.equal(events.length, 2);
  assert.equal(events[1]!.routine.params.mode, "report");
  assert.match(events[1]!.text, /hold benchmark 1 SOL/);
  assert.match(events[1]!.text, /hold benchmark 1 ETH/);
  assert.match(events[1]!.text, /Total trades: 0/);
  await routines.tick(now);
  assert.equal(events.length, 2);
  const ledger = JSON.parse(await readFile(join(root, "sma50-paper-wish14", "state.json"), "utf8"));
  assert.equal(ledger.lastCandleClose, Date.parse("2026-10-19T20:00:00Z"));
  await assert.rejects(() => routines.add({ skill: "sma50_paper", trigger: { kind: "daily", at: "03:00", timeZone: "invalid" }, reporter: "test" }));
  console.log("SMA50 schedule smoke passed: hot loading, Moscow slots on a UTC host, persistent restart, one check and daily delivery.");
} finally {
  await routines.stop();
  await skills.stop();
  Date.now = originalNow;
  globalThis.fetch = originalFetch;
  if (originalTZ === undefined) delete process.env.TZ;
  else process.env.TZ = originalTZ;
  await rm(root, { recursive: true, force: true });
}
