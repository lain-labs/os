#!/usr/bin/env -S npx tsx
/**
 * Usage limits, wasted rounds and turn transcripts smoke test (headless, no network).
 *
 * Pins what a spent subscription and a wandering turn must never do again:
 *   1. the limit parser — "resets Oct 24, 9am" is Oct 24 09:00, a crash is no limit;
 *   2. the forge — a spent agent is passed over (no spawn), a fallback walks every
 *      agent that is not spent, and status says what each one answered;
 *   3. the chat router — a spent chat model hands the reply to a standby, any
 *      other failure still fails loudly;
 *   4. the turn — shell-and-file rounds are capped, a question is told to answer;
 *   5. the transcript — the system prompt and the history are written once.
 *
 * Run: npm run limits:smoke
 */
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime } from "../src/runtime.js";
import { parseUsageLimit, UsageLimits } from "../src/models/limits.js";
import { SwitchableModelProvider } from "../src/models/routing.js";
import {
  forgePlugin,
  ForgeService,
  formatForgeBoard,
  formatForgeJobs,
  jobAttempts,
  type ForgeEvent,
  type ForgeJob,
} from "../src/plugins/forge/index.js";
import {
  ModelTier,
  type Action,
  type Character,
  type Memory,
  type MemoryStore,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from "../src/types.js";

const results: [string, boolean][] = [];
const check = (name: string, pass: boolean) => results.push([name, pass]);

// ------------------------------------------------------------ limit parser

const now = new Date(2026, 9, 19, 12, 40).getTime();
const weekly = parseUsageLimit("You've hit your weekly limit · resets Oct 24, 9am (Europe/Moscow)", now);
check("claude weekly reset read", weekly?.until === new Date(2026, 9, 24, 9, 0).getTime());
const inSpan = parseUsageLimit("You've hit your usage limit. Upgrade to Pro or try again in 2 days 3 hours.", now);
check("codex 'try again in' read", inSpan?.until === now + (2 * 24 + 3) * 3_600_000);
check("clock time rolls to tomorrow", parseUsageLimit("5-hour limit reached ∙ resets 11am", now)?.until === new Date(2026, 9, 20, 11, 0).getTime());
check(
  "a crash is not a limit",
  parseUsageLimit("Not inside a trusted directory and --skip-git-repo-check was not specified.", now) === null &&
    parseUsageLimit("error at src/foo.ts:402 — unexpected status 500", now) === null,
);
const rate = parseUsageLimit("openrouter 429: Rate limit exceeded: free-models-per-min", now);
check("a rate limit lets go soon", Boolean(rate) && rate!.until - now <= 60_000);

// ------------------------------------------------------------------- forge

const character: Character = {
  name: "Lain",
  bio: [],
  lore: [],
  topics: [],
  adjectives: [],
  examples: [],
  style: { all: [], chat: [], post: [] },
  plugins: [],
};

class ArrayMemory implements MemoryStore {
  readonly rows: Memory[] = [];
  async add(memory: Memory) {
    this.rows.push(memory);
  }
  async recent(roomId: string, limit: number) {
    return this.rows.filter((m) => m.roomId === roomId).slice(-limit);
  }
  async search() {
    return [];
  }
  async remember() {}
  async facts() {
    return [];
  }
}

const quiet: ModelProvider = {
  name: "quiet",
  modelFor: () => "quiet",
  async generate() {
    return { text: "ok", toolCalls: [], model: "quiet" };
  },
};

const forgeDir = mkdtempSync(join(tmpdir(), "lainos-limits-forge-"));
const binDir = mkdtempSync(join(tmpdir(), "lainos-limits-bin-"));
const spawns = join(forgeDir, "spawns.log");
const fakeAgent = (name: string, body: string) => {
  const path = join(binDir, name);
  writeFileSync(path, `#!/bin/sh\necho ${name} >> "${spawns}"\n${body}\n`);
  chmodSync(path, 0o755);
};
// The morning of 2026-10-19: codex refused to start, claude was spent for the week.
fakeAgent("codex", `echo "You've hit your usage limit. Upgrade to Pro or try again in 3 hours." >&2\nexit 1`);
fakeAgent("claude", `echo "You've hit your weekly limit · resets Oct 24, 9am (Europe/Moscow)"\nexit 1`);
fakeAgent("opencode", "echo built it\nexit 0");
const prevPath = process.env.PATH;
process.env.PATH = `${binDir}:${prevPath ?? ""}`;

const forgeRuntime = new AgentRuntime({
  character,
  memory: new ArrayMemory(),
  model: quiet,
  settings: {
    ...process.env,
    LAINOS_DATA_DIR: forgeDir,
    LAINOS_FORGE_REPO: forgeDir,
    LAINOS_FORGE_AUTO: "0",
    LAINOS_FORGE_CMD: "",
    LAINOS_FORGE_AGENT: "codex",
    LAINOS_MODEL_TRANSCRIPTS: "0",
  },
});
forgeRuntime.use({ ...forgePlugin, services: [new ForgeService()] });
await forgeRuntime.start();
const forge = forgeRuntime.getService<ForgeService>("forge")!;
const finished = () =>
  new Promise<ForgeEvent | null>((res) => {
    const off = forge.onEvent((ev) => {
      if (ev.kind !== "job_finished") return;
      off();
      res(ev);
    });
    setTimeout(() => res(null), 15_000);
  });

const spawned = () => (existsSync(spawns) ? readFileSync(spawns, "utf8").trim().split("\n") : []);
const firstWish = await forge.addWish({ title: "limits smoke one", reporter: "tester" });
const firstDone = finished();
const firstJob = await forge.buildWish(firstWish.id);
const first = await firstDone;
check(
  "forge walks past spent agents",
  typeof firstJob !== "string" &&
    first?.job.status === "ok" &&
    first.job.agent === "opencode" &&
    first.job.attempts?.map((a) => `${a.agent}:${a.ok}`).join(",") === "codex:false,claude:false,opencode:true",
);
const book = JSON.parse(readFileSync(join(forgeDir, "limits.json"), "utf8")) as { limits: Record<string, unknown> };
check("forge records who is spent", Boolean(book.limits.codex) && Boolean(book.limits.claude));

const before = spawned().length;
const secondWish = await forge.addWish({ title: "limits smoke two", reporter: "tester" });
const secondDone = finished();
await forge.buildWish(secondWish.id);
const second = await secondDone;
check(
  "a spent agent is not spawned",
  second?.job.status === "ok" && second.job.agent === "opencode" && spawned().slice(before).join(",") === "opencode",
);
const status = await forgeRuntime.actions.find((a) => a.name === "forge_status")!.handler(forgeRuntime, {} as never, {});
check(
  "status names each agent's verdict",
  /out of quota \(passed over until then\): .*codex out of quota until/.test(status.text ?? "") &&
    /claude out of quota until .*weekly limit/.test(status.text ?? ""),
);
check("job list shows the attempts", formatForgeJobs(forge, { limit: 2 }).includes("tried:   codex: out of quota"));

fakeAgent("opencode", `echo "Error: insufficient_quota — out of credits"\nexit 1`);
const thirdWish = await forge.addWish({ title: "limits smoke three", reporter: "tester" });
const thirdDone = finished();
await forge.buildWish(thirdWish.id);
await thirdDone;
const refused = await forge.buildWish((await forge.addWish({ title: "limits smoke four", reporter: "tester" })).id);
check(
  "all spent: no doomed job queued",
  typeof refused === "string" && refused.startsWith("every coding agent is out of quota") && forge.getWish("wish7")?.status === "open",
);
await forgeRuntime.stop();
process.env.PATH = prevPath;

// ----------------------------------------------------------- coder choice

// The operator's "codex gpt-6.1-sol low": saved, handed to the CLI, shown, kept over a restart.
const coderDir = mkdtempSync(join(tmpdir(), "lainos-limits-coder-"));
const coderBin = mkdtempSync(join(tmpdir(), "lainos-limits-coder-bin-"));
const argsSeen = join(coderDir, "args.log");
for (const name of ["claude", "codex", "opencode"]) {
  writeFileSync(join(coderBin, name), `#!/bin/sh\nfor a in "$@"; do echo "$a" >> "${argsSeen}"; done\nexit 0\n`);
  chmodSync(join(coderBin, name), 0o755);
}
process.env.PATH = `${coderBin}:${prevPath ?? ""}`;
const coderSettings = {
  ...process.env,
  LAINOS_DATA_DIR: coderDir,
  LAINOS_FORGE_REPO: coderDir,
  LAINOS_FORGE_AUTO: "0",
  LAINOS_FORGE_CMD: "",
  LAINOS_FORGE_AGENT: "claude",
  LAINOS_MODEL_TRANSCRIPTS: "0",
};
const startForge = async () => {
  const rt = new AgentRuntime({ character, memory: new ArrayMemory(), model: quiet, settings: coderSettings });
  rt.use({ ...forgePlugin, services: [new ForgeService()] });
  await rt.start();
  return { rt, svc: rt.getService<ForgeService>("forge")! };
};
const booted = await startForge();
const picked = await booted.svc.setProvider("codex", { model: "gpt-6.1-sol", effort: "low" });
const badEffort = await booted.svc.setProvider("codex", { effort: "turbo" });
const coderWish = await booted.svc.addWish({ title: "coder smoke", reporter: "tester" });
const coderDone = new Promise<ForgeEvent | null>((res) => {
  booted.svc.onEvent((ev) => ev.kind === "job_finished" && res(ev));
  setTimeout(() => res(null), 15_000);
});
await booted.svc.buildWish(coderWish.id);
const coderEv = await coderDone;
const argv = existsSync(argsSeen) ? readFileSync(argsSeen, "utf8").split("\n") : [];
check(
  "coder runs with model and effort",
  typeof picked !== "string" &&
    typeof badEffort === "string" &&
    coderEv?.job.agent === "codex" &&
    argv.includes("--skip-git-repo-check") &&
    argv.includes("gpt-6.1-sol") &&
    argv.includes('model_reasoning_effort="low"'),
);
check("coder label reads like the ask", booted.svc.coderLabel() === "codex/gpt-6.1-sol · low" && coderEv?.job.effort === "low");
await booted.rt.stop();
const again = await startForge();
check("coder choice outlives a restart", again.svc.coderLabel() === "codex/gpt-6.1-sol · low");
const cleared = await again.svc.setProvider("codex", { model: null, effort: null });
check("coder default clears it", typeof cleared !== "string" && again.svc.coderLabel() === "codex");

// ------------------------------------------------------------- jobs board

// A job from before attempts were recorded: both runs live in its transcript tail.
const legacy = {
  id: "job10",
  agent: "claude",
  status: "failed",
  logFile: "/dev/null",
  summary:
    "# job10 · 2026-10-19T09:17:47.618Z · codex\n# wish: wish7 fix /paper\n\nReading additional input from stdin...\n" +
    "Not inside a trusted directory and --skip-git-repo-check was not specified.\n" +
    "# job10 · 2026-10-19T09:17:47.737Z · claude\n# wish: wish7 fix /paper\n\nYou've hit your weekly limit · resets Oct 24, 9am (Europe/Moscow)\n",
  fallbackFrom: "codex",
} as ForgeJob;
const legacyAttempts = jobAttempts(legacy);
check(
  "old jobs show every agent's verdict",
  legacyAttempts.map((a) => `${a.agent}:${a.ok}`).join(",") === "codex:false,claude:false" &&
    /trusted directory/.test(legacyAttempts[0].reason ?? "") &&
    /weekly limit/.test(legacyAttempts[1].reason ?? ""),
);
const board = formatForgeBoard(again.svc);
check(
  "board says who codes and what runs",
  board.startsWith("coder: codex (ready)") &&
    board.includes("now:    nothing is being built") &&
    board.includes("queue:  empty") &&
    /✔ job2 +wish1 "coder smoke"/.test(board) &&
    board.includes("codex ✔"),
);
await again.rt.stop();
process.env.PATH = prevPath;

// ------------------------------------------------------------- chat router

let claudeCalls = 0;
const spentClaude: ModelProvider = {
  name: "claude",
  modelFor: () => "opus",
  async generate() {
    claudeCalls += 1;
    throw new Error("claude exited 1: You've hit your weekly limit · resets Oct 24, 9am (Europe/Moscow)");
  },
};
const codex: ModelProvider = {
  name: "codex",
  modelFor: () => "gpt",
  async generate() {
    return { text: "still here", toolCalls: [], model: "codex/gpt", provider: "codex" };
  },
};
const broken: ModelProvider = {
  name: "codex",
  modelFor: () => "gpt",
  async generate() {
    throw new Error("codex exited 1: unexpected status 500");
  },
};
const chatRequest = { tier: ModelTier.LARGE, system: "s", messages: [{ role: "user", content: "hi" }] } as ModelRequest;
const router = (initial: ModelProvider, standby: ModelProvider) =>
  new SwitchableModelProvider({
    initial,
    kind: initial.name,
    envKind: initial.name,
    assemble: () => initial,
    persist: () => {},
    buildRoute: (route) => (route.provider === standby.name ? standby : undefined),
    limits: new UsageLimits(),
    standbys: ["claude", "codex", "opencode"],
  });
const chat = router(spentClaude, codex);
const firstReply = await chat.generate(chatRequest);
const secondReply = await chat.generate(chatRequest);
check("spent chat model hands over", firstReply.text === "still here" && secondReply.model === "codex/gpt");
check("a spent chat model is skipped", claudeCalls === 1);
const lapsed: ModelProvider = {
  name: "opencode",
  modelFor: () => "free",
  async generate() {
    throw new Error("opencode exited 1: Missing Authentication header");
  },
};
const handed = await router(lapsed, codex).generate(chatRequest);
check("a lapsed login hands over too   ", handed.model === "codex/gpt");
let loud = "";
await router(broken, codex)
  .generate(chatRequest)
  .catch((err: Error) => (loud = err.message));
check("nobody left: the error says why", loud.includes("no model can answer") && loud.includes("unexpected status 500"));

// -------------------------------------------------------- wasted rounds

/** Reads one more file every round, forever, unless told to stop. */
class Wanderer implements ModelProvider {
  readonly name = "wanderer";
  readonly requests: ModelRequest[] = [];
  modelFor(): string {
    return "wanderer";
  }
  async generate(request: ModelRequest): Promise<ModelResponse> {
    // A copy: the turn keeps appending to the array it sent.
    this.requests.push({ ...request, messages: request.messages.map((m) => ({ ...m })) });
    if (!request.tools?.length) return { text: "here is what i found", toolCalls: [], model: "wanderer" };
    const n = this.requests.length;
    return { text: "", toolCalls: [{ name: "read_file", input: { path: `f${n}` } }], model: "wanderer" };
  }
}
const readFileAction: Action = {
  name: "read_file",
  similes: [],
  description: "read a file",
  examples: [],
  async validate() {
    return true;
  },
  async handler(_rt, _st, params) {
    return { ok: true, text: `contents of ${String(params.path)}`, data: { path: params.path } };
  },
};
const transcriptDir = mkdtempSync(join(tmpdir(), "lainos-limits-turn-"));
const wanderer = new Wanderer();
const wanderRuntime = new AgentRuntime({
  character,
  memory: new ArrayMemory(),
  model: wanderer,
  settings: { LAINOS_DATA_DIR: transcriptDir },
});
wanderRuntime.use({ name: "t", description: "test", actions: [readFileAction] });
const wandered = await wanderRuntime.handleMessage({ roomId: "tui-limits", userId: "u", text: "dig into the logs" });
const lastSent = (i: number) => wanderer.requests[i]?.messages.at(-1)?.content ?? "";
check(
  "look-around rounds are capped",
  wanderer.requests.length === 6 && !wanderer.requests[5].tools && wandered.text === "here is what i found",
);
check("the wander is told to answer", lastSent(3).includes("rounds in a row of shell and file reads"));

const asker = new Wanderer();
const askRuntime = new AgentRuntime({
  character,
  memory: new ArrayMemory(),
  model: asker,
  settings: { LAINOS_DATA_DIR: transcriptDir, LAINOS_MODEL_TRANSCRIPTS: "0" },
});
askRuntime.use({ name: "t", description: "test", actions: [readFileAction] });
await askRuntime.handleMessage({ roomId: "tui-ask", userId: "u", text: "so nothing is being built?" });
check("a question is told to answer", (asker.requests[1]?.messages.at(-1)?.content ?? "").includes("I asked a question"));

// --------------------------------------------------------------- transcript

const file = readdirSync(join(transcriptDir, "model-transcripts")).find((name) => name.endsWith(".json"))!;
const raw = readFileSync(join(transcriptDir, "model-transcripts", file), "utf8");
const transcript = JSON.parse(raw) as {
  version: number;
  system?: string;
  tools?: string[];
  messages: unknown[];
  modelCalls: Array<Record<string, unknown>>;
  toolResults: Array<{ summary: string; ms: number }>;
};
const systemCopies = raw.split(JSON.stringify(transcript.system ?? "").slice(1, 60)).length - 1;
check(
  "system prompt written once",
  transcript.version === 2 && typeof transcript.system === "string" && systemCopies === 1,
);
check(
  "calls name messages, not copy them",
  transcript.modelCalls.length === 6 &&
    transcript.modelCalls.every((c) => !("request" in c) && typeof c.messages === "string") &&
    // The same "(called tools: read_file)" every round is written once.
    transcript.messages.length === 7 &&
    transcript.modelCalls[5].messages === "0-2,1,3,1,4,1,5,1,6" &&
    transcript.modelCalls[5].tools === 0 &&
    transcript.tools?.join(",") === "read_file",
);
check(
  "tool results drop echoed input",
  transcript.toolResults.length === 5 &&
    transcript.toolResults.every((t) => !t.summary.includes('"path"') && typeof t.ms === "number"),
);

// ------------------------------------------------------------------ report

let failed = 0;
for (const [name, pass] of results) {
  if (!pass) failed += 1;
  console.log(`${name.padEnd(36)}: ${pass ? "PASS" : "FAIL"}`);
}
console.log(failed ? `LIMITS PROBE FAILED (${failed})` : "LIMITS PROBE OK");
process.exit(failed ? 1 : 0);
