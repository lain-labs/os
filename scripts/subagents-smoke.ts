#!/usr/bin/env -S npx tsx
/**
 * Subagents + HTTP bridge key smoke test (offline: a fake OpenAI-compatible
 * subagent on a local port).
 *
 * Pinned here:
 *   1. LAINOS_SUBAGENTS is parsed into agents; a bad name or a missing URL is
 *      skipped, not fatal;
 *   2. a delegation sends the task, the model and the bearer, and returns the
 *      answer labelled as third-party;
 *   3. an HTTP error, an empty answer, an unreachable agent and a timeout are
 *      short errors that never carry the key or the response body;
 *   4. the action refuses an unknown agent and an empty task;
 *   5. with LAINOS_HTTP_KEY the bridge keeps /health open and answers 401 to
 *      a missing or wrong bearer everywhere else.
 *
 * Run: npm run subagents:smoke
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createHttpServer } from "../src/clients/http.js";
import { delegate, loadSubagents, subagentsPlugin } from "../src/plugins/subagents/index.js";
import type { IAgentRuntime, State } from "../src/types.js";

const results: [string, boolean][] = [];
const check = (name: string, pass: boolean) => results.push([name, pass]);

const KEY = "sub-key-123";
let seen: { auth?: string; body?: { model?: string; messages?: { content?: string }[] } } = {};
let mode: "ok" | "500" | "empty" | "slow" = "ok";
const fake = createServer((req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => {
    seen = { auth: req.headers.authorization, body: JSON.parse(data || "{}") };
    if (mode === "500") return res.writeHead(500).end(`secret ${KEY} in a stack trace`);
    if (mode === "slow") return setTimeout(() => res.writeHead(200).end("{}"), 2_000);
    const content = mode === "empty" ? "" : "validator healthy, 3 peers";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ model: "nemotron:free", choices: [{ message: { role: "assistant", content } }] }));
  });
});
await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
const fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`;

const settings: Record<string, string> = {
  LAINOS_SUBAGENTS: "hermes, OpenClaw, bad name!, ghost",
  LAINOS_SUBAGENT_HERMES_URL: `${fakeUrl}/`,
  LAINOS_SUBAGENT_HERMES_KEY: KEY,
  LAINOS_SUBAGENT_HERMES_ABOUT: "ops of the validator",
  LAINOS_SUBAGENT_OPENCLAW_URL: fakeUrl,
};
const agents = loadSubagents((k) => settings[k]);
check("names parsed, bad and URL-less skipped", agents.map((a) => a.name).join(",") === "hermes,openclaw");
check("trailing slash trimmed, model defaults to the name", agents[0].url === fakeUrl && agents[1].model === "openclaw");

const ok = await delegate(agents[0], "is the validator healthy?");
check("delegation returns the answer", ok.ok && ok.text === "validator healthy, 3 peers" && ok.model === "nemotron:free");
check("task, model and bearer are sent", seen.auth === `Bearer ${KEY}` && seen.body?.model === "hermes" && seen.body?.messages?.[0]?.content === "is the validator healthy?");
await delegate(agents[1], "hi");
check("no key, no Authorization header", seen.auth === undefined);

mode = "500";
const failed = await delegate(agents[0], "x");
check("HTTP error is short and leaks nothing", !failed.ok && failed.error === "hermes answered HTTP 500" && !JSON.stringify(failed).includes(KEY));
mode = "empty";
const empty = await delegate(agents[0], "x");
check("empty answer is an error", !empty.ok && empty.error.includes("empty"));
mode = "slow";
const slow = await delegate(agents[0], "x", { timeoutMs: 200 });
check("timeout is named", !slow.ok && slow.error.includes("did not answer"));
const gone = await delegate({ ...agents[0], url: "http://127.0.0.1:1/v1" }, "x");
check("unreachable is named", !gone.ok && gone.error === "hermes is unreachable");
mode = "ok";

const runtime = {
  character: { name: "Lain" },
  getSetting: (k: string) => settings[k],
} as unknown as IAgentRuntime;
const action = subagentsPlugin.actions![0];
const state = {} as State;
check("action is available when agents are configured", await action.validate(runtime, state));
const unknown = await action.handler(runtime, state, { agent: "nobody", task: "x" });
check("unknown agent is refused with the list", !unknown.ok && String(unknown.text).includes("hermes, openclaw"));
const blank = await action.handler(runtime, state, { agent: "hermes", task: "  " });
check("empty task is refused", !blank.ok);
const done = await action.handler(runtime, state, { agent: "Hermes", task: "status?" });
check("answer is labelled third-party", done.ok && String(done.text).startsWith("[hermes · nemotron:free · third-party answer"));
const context = await subagentsPlugin.providers![0].get(runtime, state);
check("context lists the agents with what they do", context.includes("- hermes: ops of the validator") && context.includes("- openclaw"));
const none = { ...runtime, getSetting: () => undefined } as unknown as IAgentRuntime;
check("no agents: action unavailable, no context", !(await action.validate(none, state)) && (await subagentsPlugin.providers![0].get(none, state)) === "");

const HTTP_KEY = "bridge-key-456";
const bridgeRuntime = {
  character: { name: "Lain" },
  model: {},
  getSetting: (k: string) => ({ LAINOS_HTTP_KEY: HTTP_KEY })[k as "LAINOS_HTTP_KEY"],
} as unknown as IAgentRuntime;
// Bound as the node binds it in its container: off loopback the key is the door.
const server = createHttpServer(bridgeRuntime, { host: "0.0.0.0", port: 0 });
await new Promise<void>((r) => server.once("listening", () => r()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
check("/health needs no key", (await fetch(`${base}/health`)).status === 200);
check("no bearer is a 401", (await fetch(`${base}/tasks`)).status === 401);
check("wrong bearer is a 401", (await fetch(`${base}/tasks`, { headers: { Authorization: "Bearer nope" } })).status === 401);
check("right bearer passes", (await fetch(`${base}/tasks`, { headers: { Authorization: `Bearer ${HTTP_KEY}` } })).status !== 401);
check("/chat is behind the key too", (await fetch(`${base}/chat`, { method: "POST", body: "{}" })).status === 401);
await new Promise<void>((r) => server.close(() => r()));
await new Promise<void>((r) => fake.close(() => r()));

let failedCount = 0;
for (const [name, pass] of results) {
  console.log(`${pass ? "✓" : "✗"} ${name}`);
  if (!pass) failedCount++;
}
console.log(`\n${results.length - failedCount}/${results.length} passed`);
process.exit(failedCount ? 1 : 0);
