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
 *      with room, instead of arriving as an empty create_skill;
 *  10. a reply that blames an outage (an RPC answering 403 behind Cloudflare),
 *      or says "can't" about something else, is not taken for a missing
 *      capability: no self-upgrade is forged;
 *  11. edit_skill changes exact spots, shows the diff, logs the operator's
 *      words, refuses a missing or ambiguous target and rolls back a broken edit;
 *  12. the kit: per-skill state across calls, read-only tool calls (spending
 *      and execute refused), BigInt data that cannot break a turn, a skill in
 *      a directory outside the package importing viem, a Cloudflare page
 *      named as one;
 *  13. kit.chain().trades tells a wallet's own buys and sells from airdrops,
 *      one per transaction, over a fake chain, and fails loudly when it cannot
 *      tell who signed;
 *  14. DexScreener prices take the deepest pair where the token is the base;
 *  15. skills.sh: search, install (paths that leave the folder refused),
 *      open, preview without installing, the shelf in her context, remove;
 *  16. an oversized tool result keeps its text whole for the model and cuts
 *      the data instead;
 *  17. a first routine run slower than the conversation waits finishes in
 *      the background and is reported like any routine result;
 *  18. a result marked keep (a skill's source, the kit reference) stays
 *      verbatim in later rounds while an ordinary one is cut to its gist;
 *      kit.chain() works with and without await.
 *
 * Run: npm run skills:smoke
 */
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime, FileMemoryStore, type ModelProvider, type ModelRequest } from "../src/index.js";
import { lain } from "../src/characters/lain.js";
import { describeSkills, skillsPlugin, SkillsService } from "../src/plugins/skills/index.js";
import { chainKit, dexscreenerPrices, flushCache, httpProblem } from "../src/plugins/skills/kit.js";
import { parseSkillRef, registryIo, shelfFor } from "../src/plugins/skills/registry.js";
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
check("writing the same name is a rewrite", edited.ok && /rewritten/.test(edited.text ?? "") && (await call("holder_share")).text === "top-10 (no pools) hold 61.2%");
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

// 10. an outage is not a missing capability
const forged: string[] = [];
const replies = [
  "r1 is scheduled, but I can't show you its first run: the RPC answered HTTP 403 from Cloudflare.",
  "r2 is live. It compares the same number r1 does, so the two routines can't contradict each other.",
];
const outageModel: ModelProvider = {
  name: "outage-stub",
  modelFor: () => "outage-stub",
  async generate() {
    return { text: replies.shift() ?? "done", toolCalls: [], model: "outage-stub" };
  },
};
const outageDir = join(tmp, "outage");
const outageRuntime = new AgentRuntime({
  character: lain,
  memory: new FileMemoryStore(outageDir),
  model: outageModel,
  settings: { LAINOS_DATA_DIR: outageDir, LAINOS_MODEL_TRANSCRIPTS: "0" },
});
outageRuntime.use({
  name: "forge-stub",
  description: "records self-upgrades instead of starting a coding agent",
  actions: [
    {
      name: "learn_skill",
      similes: [],
      description: "stub",
      examples: [],
      async validate() {
        return true;
      },
      async handler(_runtime, _state, params) {
        forged.push(String(params.title ?? ""));
        return { ok: true, text: "forged" };
      },
    },
  ],
});
await outageRuntime.start();
await outageRuntime.handleMessage({ roomId: "outage", userId: "tester", text: "make a new test working tool" });
check("an RPC outage in the reply does not start a self-upgrade", forged.length === 0);
await outageRuntime.handleMessage({ roomId: "outage", userId: "tester", text: "make a new test working tool" });
check("a \"can't\" that is not her refusal does not start a self-upgrade", forged.length === 0);
await outageRuntime.stop();

// 11. edit_skill: exact spots, a diff, the operator's words in the log
const { runtime: rt2, skills: skills2 } = await bootRuntime();
const act2 = (name: string, params: Record<string, unknown>) =>
  rt2.actions.find((a) => a.name === name)!.handler(rt2, state, params);
const buysV1 = `export default {
  name: "wallet_buys",
  description: "Buys of the watched wallets.",
  async handler() {
    const trades = [{ usd: 120 }, { usd: 900 }, { usd: 5000 }];
    const kept = trades.filter((t) => t.usd > 0);
    return { ok: true, text: kept.length + " buys", data: { fingerprint: kept.length } };
  },
};`;
await act2("create_skill", { name: "wallet_buys", code: buysV1, note: "find tokens 5 of them buy" });
const patched = await act2("edit_skill", {
  name: "wallet_buys",
  edits: [{ old: "t.usd > 0", new: "t.usd >= 500" }],
  note: "ignore trades below $500",
});
check("edit_skill changes the exact spot and the tool follows", patched.ok && (await act2("wallet_buys", {})).text === "2 buys");
check("…and shows the before and after", /- .*t\.usd > 0/.test(patched.text ?? "") && /\+ .*t\.usd >= 500/.test(patched.text ?? "") && /v2/.test(patched.text ?? ""));
const log2 = await skills2.readSkill("wallet_buys");
check("…and logs the operator's words", log2.changes.map((c) => c.kind).join(",") === "create,edit" && log2.changes[1].note === "ignore trades below $500");
const readBack = await act2("read_skill", { name: "wallet_buys" });
check("read_skill shows the change log", /ignore trades below \$500/.test(readBack.text ?? ""));
const missing = await act2("edit_skill", { name: "wallet_buys", edits: [{ old: "t.usd > 9999", new: "x" }] });
check("an edit whose text is not there is refused", !missing.ok && /not in wallet_buys/.test(missing.text ?? ""));
const ambiguous = await act2("edit_skill", { name: "wallet_buys", edits: [{ old: "usd", new: "value" }] });
check("an ambiguous edit is refused", !ambiguous.ok && /occurs \d+ times/.test(ambiguous.text ?? ""));
const breaking = await act2("edit_skill", { name: "wallet_buys", edits: [{ old: "async handler() {", new: "async handler() { return {" }] });
check("an edit that does not load leaves the working version", !breaking.ok && (await act2("wallet_buys", {})).text === "2 buys" && (await skills2.readSkill("wallet_buys")).versions === 1);
const undone = await act2("revert_skill", { name: "wallet_buys" });
check("revert_skill undoes an edit", undone.ok && (await act2("wallet_buys", {})).text === "3 buys");

// 12. the kit
rt2.actions.push(
  {
    name: "token_info",
    similes: [],
    description: "reads a token",
    examples: [],
    async validate() {
      return true;
    },
    async handler(_r, _s, p) {
      return { ok: true, text: `info ${String(p.token)}` };
    },
  },
  {
    name: "send_native",
    similes: [],
    description: "spends",
    examples: [],
    async validate() {
      return true;
    },
    async handler() {
      return { ok: true, text: "SENT" };
    },
  },
);
const kitSkill = `import { formatUnits } from "viem";
export default {
  name: "kit_probe",
  description: "exercises the kit",
  async handler(runtime, state, params, kit) {
    const runs = (await kit.store.get("runs", 0)) + 1;
    await kit.store.set("runs", runs);
    const info = await kit.tool("token_info", { token: "LAIN" });
    let spend = "allowed";
    try { await kit.tool("send_native", { to: "0x0", amount: "1" }); } catch (e) { spend = e.message; }
    let exec = "allowed";
    try { await kit.tool("token_info", { execute: true }); } catch (e) { exec = e.message; }
    return { ok: true, text: [runs, info.text, spend, exec, formatUnits(1500000000000000000n, 18), kit.viem.formatUnits(5n, 1)].join("|"), data: { raw: 10n ** 20n } };
  },
};`;
const kitMade = await act2("create_skill", { name: "kit_probe", code: kitSkill });
check("a skill outside the package can import viem", kitMade.ok);
await act2("kit_probe", {});
const probe = await act2("kit_probe", {});
const parts = (probe.text ?? "").split("|");
check("kit.store keeps a skill's state across calls", parts[0] === "2");
check("kit.tool calls a tool that reads", parts[1] === "info LAIN");
check("kit.tool refuses a tool that moves funds", /moves funds/.test(parts[2] ?? ""));
check("kit.tool refuses execute arguments", /never passes "execute"/.test(parts[3] ?? ""));
check("kit.viem is the viem module", parts[4] === "1.5" && parts[5] === "0.5");
check("BigInt data comes back as plain JSON", probe.data?.raw === "100000000000000000000" && JSON.stringify(probe).length > 0);
check("a Cloudflare page is named as one", /Cloudflare challenge/.test(httpProblem("https://x.example/api", 403, "text/html", "<!DOCTYPE html><title>Just a moment...</title>") ?? ""));
const kitDoc = await act2("skill_kit", {});
check("skill_kit documents the helpers", kitDoc.ok && /kit\.chain/.test(kitDoc.text ?? "") && /trades\(/.test(kitDoc.text ?? ""));

// 13. kit.chain().moves over a fake chain: a signed buy counts, an airdrop does not
const W1 = "0x1111111111111111111111111111111111111111";
const W2 = "0x2222222222222222222222222222222222222222";
const POOL = "0x9999999999999999999999999999999999999999";
const TOKA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TRANSFER_SIG = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const topic = (a: string) => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}`;
const logs = [
  { address: TOKA, from: POOL, to: W1, value: 500n, tx: "0x01", block: 990n, signer: W1 }, // W1 buys TOKA
  { address: TOKA, from: POOL, to: W2, value: 7n, tx: "0x02", block: 995n, signer: POOL }, // airdrop to W2
  { address: TOKB, from: W2, to: POOL, value: 40n, tx: "0x03", block: 998n, signer: W2 }, // W2 sells TOKB
  { address: TOKA, from: W1, to: POOL, value: 200n, tx: "0x05", block: 999n, signer: W1 }, // W1 takes some profit
  { address: TOKB, from: POOL, to: W1, value: 1n, tx: "0x04", block: 10n, signer: W1 }, // long before the window
];
const fakeClient = {
  getBlockNumber: async () => 1000n,
  getBlock: async (args?: { blockNumber?: bigint }) => {
    const n = args?.blockNumber ?? 1000n;
    return { number: n, timestamp: n * 2n }; // two seconds a block
  },
  request: async ({ params }: { params: [{ fromBlock: string; toBlock: string; topics: (string | string[] | null)[] }] }) => {
    const [q] = params;
    const from = BigInt(q.fromBlock);
    const to = BigInt(q.toBlock);
    const match = (want: string | string[] | null | undefined, have: string) =>
      want == null || (Array.isArray(want) ? want.includes(have) : want === have);
    return logs
      .filter((l) => l.block >= from && l.block <= to)
      .map((l) => ({
        address: l.address,
        topics: [TRANSFER_SIG, topic(l.from), topic(l.to)],
        data: `0x${l.value.toString(16).padStart(64, "0")}`,
        transactionHash: l.tx,
        blockNumber: `0x${l.block.toString(16)}`,
      }))
      .filter((l) => match(q.topics[1], l.topics[1]) && match(q.topics[2], l.topics[2]));
  },
  getTransaction: async ({ hash }: { hash: string }) => ({ from: logs.find((l) => l.tx === hash)!.signer }),
  readContract: async ({ address, functionName, args }: { address: string; functionName: string; args?: string[] }) => {
    if (functionName === "symbol") return address === TOKA ? "TOKA" : "TOKB";
    if (functionName === "decimals") return 0;
    if (functionName === "name") return "Token";
    if (functionName === "balanceOf") {
      const w = args![0].toLowerCase();
      return logs.filter((l) => l.address === address).reduce((n, l) => n + (l.to.toLowerCase() === w ? l.value : 0n) - (l.from.toLowerCase() === w ? l.value : 0n), address === TOKB && w === W2 ? 100n : 0n);
    }
    throw new Error(`unexpected ${functionName}`);
  },
  getCode: async () => undefined,
};
const chain = chainKit(
  { name: "fake", title: "Fake", chainId: 7, rpcUrl: "http://fake", nativeSymbol: "F", maxLogSpan: 100 },
  fakeClient as never,
);
const trades = await chain.trades([W1, W2], { hours: 0.01 }); // 36 s = 18 blocks: 982…1000
const w1Buy = trades.find((t) => t.wallet === W1 && t.side === "buy");
check("trades: a buy the wallet signed is a trade, and it opened the position", w1Buy?.symbol === "TOKA" && w1Buy.opens && w1Buy.value === 500 && w1Buy.balance === 300);
check("trades: a later sell in the window is its own trade, not netted away", trades.some((t) => t.wallet === W1 && t.side === "sell" && t.value === 200 && t.tx === "0x05"));
check("trades: an airdrop is not a trade, a signed sell is", trades.length === 3 && !trades.some((t) => t.wallet === W2 && t.side === "buy") && trades.some((t) => t.wallet === W2 && t.side === "sell" && t.symbol === "TOKB" && !t.opens));
check("trades: each carries an estimated time, oldest first", Math.abs((w1Buy?.at ?? 0) - (Date.now() - 20_000)) < 5_000 && trades[0].block <= trades[2].block);
const blind = chainKit(
  { name: "fake2", title: "Fake", chainId: 8, rpcUrl: "http://fake2", nativeSymbol: "F", maxLogSpan: 100 },
  { ...fakeClient, getTransaction: async () => { throw new Error("node is down"); } } as never,
);
const blindErr = await blind.trades([W1, W2], { hours: 0.01 }).then(() => "", (e: Error) => e.message);
check("trades: signers that cannot be read fail the scan instead of hiding buys", /could not tell who signed 4 of 4 transactions \(node is down\)/.test(blindErr));
let logCalls = 0;
let txCalls = 0;
const settledClient = {
  ...fakeClient,
  getBlockNumber: async () => 20_000n,
  getBlock: async (args?: { blockNumber?: bigint }) => {
    const n = args?.blockNumber ?? 20_000n;
    return { number: n, timestamp: n * 2n };
  },
  request: async (args: never) => {
    logCalls += 1;
    return fakeClient.request(args);
  },
  getTransaction: async (args: { hash: string }) => {
    txCalls += 1;
    return fakeClient.getTransaction(args);
  },
};
const settledKit = () =>
  chainKit({ name: "fake3", title: "Fake", chainId: 9, rpcUrl: "http://fake3", nativeSymbol: "F", maxLogSpan: 100 }, settledClient as never);
await settledKit().trades([W1, W2], { fromBlock: 900n });
const firstCost = { logs: logCalls, txs: txCalls };
await settledKit().trades([W1, W2], { fromBlock: 900n });
check("a re-run reads only unsettled windows and looks up no known signer again", firstCost.logs > 0 && logCalls - firstCost.logs < firstCost.logs && txCalls === firstCost.txs);
await flushCache();
const onDisk = JSON.parse(await readFile(join(tmp, "data", "kit-cache.json"), "utf8")) as { windows: [string, { value: string }[]][]; senders: [string, string][] };
check("…and the settled windows and signers are kept on disk for the next process", onDisk.windows.length > 0 && onDisk.senders.length > 0 && onDisk.windows.some(([, list]) => list.some((t) => typeof t.value === "string")));
const transfers = await chain.transfers([W1, W2], { hours: 0.01, dir: "in" });
check("transfers: in-transfers of the window only", transfers.length === 2 && transfers.every((t) => t.block >= 990n));

// 14. prices: the deepest pair where the token is the base
const prices = await dexscreenerPrices("robinhood", [TOKA, TOKB], {
  json: async () =>
    [
      { baseToken: { address: TOKA, symbol: "TOKA" }, priceUsd: "2", liquidity: { usd: 1_000 }, pairAddress: "0xp1", dexId: "uniswap" },
      { baseToken: { address: TOKA, symbol: "TOKA" }, priceUsd: "2.5", liquidity: { usd: 90_000 }, pairAddress: "0xp2", dexId: "uniswap" },
      { baseToken: { address: "0xcccccccccccccccccccccccccccccccccccccccc" }, quoteToken: { address: TOKB }, priceUsd: "9" },
    ] as never,
});
check("prices take the deepest pair", prices[TOKA]?.usd === 2.5 && prices[TOKA]?.pair === "0xp2");
check("…and never price a token from a pair where it is only the quote", prices[TOKB] === undefined);

// 15. skills.sh
const skillMd = `---
name: solidity-security
description: >
  Patterns for secure Solidity:
  reentrancy, access control.
---
# Solidity security
Check effects before interactions.`;
const fetched: string[] = [];
registryIo.fetch = async (url) => {
  fetched.push(url);
  if (url.includes("/api/search")) {
    return {
      status: 200,
      body: JSON.stringify({
        skills: [
          { id: "mindrally/skills/solidity", source: "mindrally/skills", skillId: "solidity", name: "solidity", installs: 701 },
          { id: "wshobson/agents/solidity-security", source: "wshobson/agents", skillId: "solidity-security", name: "solidity-security", installs: 15017 },
        ],
      }),
    };
  }
  if (url.includes("/api/download/evil/repo/")) {
    return { status: 200, body: JSON.stringify({ files: [{ path: "SKILL.md", contents: "---\nname: evil\n---\nx" }, { path: "../../escape.txt", contents: "x" }] }) };
  }
  if (url.includes("/api/download/wshobson/agents/solidity-security")) {
    return { status: 200, body: JSON.stringify({ files: [{ path: "SKILL.md", contents: skillMd }, { path: "references/details.md", contents: "# details" }] }) };
  }
  return { status: 404, body: "not found" };
};
const found = await act2("find_skills", { query: "solidity" });
check("find_skills lists skills.sh results, most installed first", found.ok && /1\. solidity-security — wshobson\/agents · 15,017 installs/.test(found.text ?? "") && /skills\.sh\/wshobson\/agents\/solidity-security/.test(found.text ?? ""));
check("…through the skills.sh search API", /^https:\/\/skills\.sh\/api\/search\?q=solidity/.test(fetched[0] ?? ""));
const preview = await act2("use_agent_skill", { name: "wshobson/agents/solidity-security" });
check("use_agent_skill previews a skill by id without installing", preview.ok && /not installed/.test(preview.text ?? "") && /Check effects/.test(preview.text ?? "") && !(await shelfFor(rt2).get("solidity-security")));
const installed = await act2("install_agent_skill", { id: "npx skills add wshobson/agents@solidity-security" });
check("install_agent_skill puts it on the shelf", installed.ok && /Installed solidity-security/.test(installed.text ?? "") && /reentrancy, access control/.test(installed.text ?? ""));
const opened = await act2("use_agent_skill", { name: "solidity-security" });
check("use_agent_skill opens it as third-party instructions", opened.ok && /third-party instructions/.test(opened.text ?? "") && /Check effects/.test(opened.text ?? "") && /references\/details\.md/.test(opened.text ?? ""));
const ref = await act2("use_agent_skill", { name: "solidity-security", file: "references/details.md" });
const escape = await act2("use_agent_skill", { name: "solidity-security", file: "../../../etc/passwd" });
check("…and reads its own files, nothing outside them", ref.ok && /# details/.test(ref.text ?? "") && !escape.ok);
const evil = await act2("install_agent_skill", { id: "evil/repo/x" });
check("a skill whose files leave its folder is refused", !evil.ok && /leaves the skill folder/.test(evil.text ?? "") && !(await shelfFor(rt2).get("evil")));
const context = await skillsPlugin.providers![0].get(rt2, state);
check("the shelf and her tools are in her context, with what they do", /solidity-security — Patterns for secure Solidity/.test(context) && /wallet_buys — Buys of the watched wallets/.test(context));
check("/skills lists her tools and the shelf", /wallet_buys v1/.test(await describeSkills(rt2)) && /solidity-security \(wshobson\/agents\/solidity-security\)/.test(await describeSkills(rt2)));
check("parseSkillRef reads every way a skill is named", ["wshobson/agents/solidity-security", "wshobson/agents@solidity-security", "https://skills.sh/wshobson/agents/solidity-security"].every((r) => parseSkillRef(r)?.skillId === "solidity-security"));
const gone = await act2("remove_agent_skill", { name: "solidity-security" });
check("remove_agent_skill takes it off the shelf", gone.ok && !(await shelfFor(rt2).get("solidity-security")));
await skills2.stop();

// 16. an oversized result: the text survives, the data is cut
let followup = "";
const bigModel: ModelProvider = {
  name: "big-stub",
  modelFor: () => "big-stub",
  async generate(request: ModelRequest) {
    if (!followup && request.messages.length > 1 && request.messages.at(-1)!.content.startsWith("Tool results")) {
      followup = request.messages.at(-1)!.content;
      return { text: "seen", toolCalls: [], model: "big-stub" };
    }
    return followup ? { text: "seen", toolCalls: [], model: "big-stub" } : { text: "", toolCalls: [{ name: "big_probe", input: {} }], model: "big-stub" };
  },
};
const bigDir = join(tmp, "big");
const bigRuntime = new AgentRuntime({
  character: lain,
  memory: new FileMemoryStore(bigDir),
  model: bigModel,
  settings: { LAINOS_DATA_DIR: bigDir, LAINOS_MODEL_TRANSCRIPTS: "0" },
});
bigRuntime.use({
  name: "big-probe",
  description: "returns a long answer and a huge data dump",
  actions: [
    {
      name: "big_probe",
      similes: [],
      description: "stub",
      examples: [],
      async validate() {
        return true;
      },
      async handler() {
        const text = ["9 tokens bought by ≥5 of 30 wallets", ...Array.from({ length: 30 }, (_, i) => `• TOKEN${i} — 7 wallets, 30 buys`), "END-OF-ANSWER"].join("\n");
        return { ok: true, text, data: { hits: Array.from({ length: 400 }, (_, i) => ({ wallet: `0x${String(i).padStart(40, "0")}`, buys: i })), fingerprint: "TAIL-OF-DATA" } };
      },
    },
  ],
});
await bigRuntime.start();
await bigRuntime.handleMessage({ roomId: "big", userId: "tester", text: "run the probe" });
check("an oversized result keeps the whole text for the model", followup.includes("TOKEN29") && followup.includes("END-OF-ANSWER"));
check("…and cuts the data instead, saying where the rest is", /\[data, \d+ chars: /.test(followup) && /full output saved to/.test(followup) && followup.length < 6_500);
await bigRuntime.stop();

// 17. a slow first run finishes in the background and is reported
settings.LAINOS_ROUTINE_FIRST_WAIT_MS = "150";
const { runtime: rt3, routines: routines3, skills: skills3 } = await bootRuntime();
const late: RoutineEvent[] = [];
routines3.onEvent((ev) => late.push(ev));
await rt3.actions.find((a) => a.name === "create_skill")!.handler(rt3, state, {
  name: "slow_scan",
  code: `export default { name: "slow_scan", description: "takes a while", async handler() { await new Promise((r) => setTimeout(r, 500)); return { ok: true, text: "scan done: 9 tokens", data: { fingerprint: "9" } }; } };`,
});
const slow = await rt3.actions.find((a) => a.name === "schedule_skill")!.handler(rt3, state, { skill: "slow_scan", every: "1h" });
check("a slow first run does not hold the turn", slow.ok && /still going/.test(slow.text ?? "") && late.length === 0);
await new Promise((r) => setTimeout(r, 700));
check("…and its result is reported when it finishes", late.length === 1 && /scan done: 9 tokens/.test(late[0].text) && late[0].chatId === 42);
delete settings.LAINOS_ROUTINE_FIRST_WAIT_MS;
await routines3.stop();
await skills3.stop();

// 18. keep: the source she edits survives later rounds; kit.chain needs no await
const roundsSeen: string[] = [];
const keepModel: ModelProvider = {
  name: "keep-stub",
  modelFor: () => "keep-stub",
  async generate(request: ModelRequest) {
    const n = roundsSeen.push(request.messages.map((m) => m.content).join("\n"));
    if (n === 1) return { text: "", toolCalls: [{ name: "source_probe", input: {} }, { name: "noise_probe", input: {} }], model: "keep-stub" };
    if (n === 2) return { text: "", toolCalls: [{ name: "noise_probe", input: { again: 1 } }], model: "keep-stub" };
    return { text: "done", toolCalls: [], model: "keep-stub" };
  },
};
const keepDir = join(tmp, "keep");
const keepRuntime = new AgentRuntime({
  character: lain,
  memory: new FileMemoryStore(keepDir),
  model: keepModel,
  settings: { LAINOS_DATA_DIR: keepDir, LAINOS_MODEL_TRANSCRIPTS: "0" },
});
const keepProbe = (name: string, keep: boolean, marker: string) => ({
  name,
  similes: [],
  description: "stub",
  examples: [],
  async validate() {
    return true;
  },
  async handler() {
    return { ok: true, text: `${"x".repeat(1500)}\n${marker}\n${"y".repeat(1500)}`, keep };
  },
});
keepRuntime.use({ name: "keep-probe", description: "keep", actions: [keepProbe("source_probe", true, "LAST-LINE-OF-SOURCE"), keepProbe("noise_probe", false, "END-OF-NOISE")] });
await keepRuntime.start();
await keepRuntime.handleMessage({ roomId: "keep", userId: "tester", text: "edit the tool" });
check("a kept result is still whole two rounds later", roundsSeen.length === 3 && roundsSeen[2].includes("LAST-LINE-OF-SOURCE"));
check("…while an ordinary one from that round is cut to its gist", (roundsSeen[2].match(/END-OF-NOISE/g) ?? []).length === 1);
await keepRuntime.stop();
const chainProbe = await act2("create_skill", {
  name: "chain_probe",
  code: `export default { name: "chain_probe", description: "kit.chain without await", async handler(runtime, state, params, kit) {
    const a = kit.chain("robinhood");
    const b = await kit.chain("robinhood");
    return { ok: true, text: [a.network.title, typeof a.trades, b.network.chainId].join("|") };
  } };`,
});
check("kit.chain() works with and without await", chainProbe.ok && (await act2("chain_probe", {})).text === "Robinhood Chain|function|4663");

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
