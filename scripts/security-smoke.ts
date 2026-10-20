#!/usr/bin/env -S npx tsx
/**
 * Security smoke test (headless, no model, no chain).
 *
 * Pinned here:
 *   1. a tool whose validate() refuses is not run, even when the model calls
 *      it by name or by simile without having been offered it;
 *   2. the HTTP bridge: a browser origin off the allowlist is refused, an
 *      allowed one gets its own origin back (never `*`), a rebinding Host is
 *      refused, LAINOS_HTTP_TOKEN is required when set, and a caller's userId
 *      can never pass for the local operator;
 *   3. an operatorOnly tool is offered to and run for the operator only: the
 *      terminal, or the Telegram operator; never a Telegram guest, an HTTP
 *      caller or a background turn, and the shipped shell, skill, forge and
 *      money tools are all marked;
 *   4. a Telegram proxy URL is logged without its credentials.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime, FileMemoryStore, type ModelProvider, type ModelRequest } from "../src/index.js";
import { lain } from "../src/characters/lain.js";
import { createHttpServer } from "../src/clients/http.js";
import { redactUrl } from "../src/clients/telegram.js";
import { chainPlugin } from "../src/plugins/chain/index.js";
import { forgePlugin } from "../src/plugins/forge/index.js";
import { metamaskPlugin } from "../src/plugins/metamask/index.js";
import { skillsPlugin } from "../src/plugins/skills/index.js";
import { systemPlugin } from "../src/plugins/system/index.js";
import type { TelegramSender } from "../src/plugins/telegram/identity.js";
import type { Action, Plugin } from "../src/types.js";

const results: [string, boolean][] = [];
const check = (name: string, pass: boolean) => results.push([name, pass]);
const tmp = await mkdtemp(join(tmpdir(), "lainos-security-"));

/** A model that calls the given tools once, then answers. */
function callingModel(calls: { name: string; input?: Record<string, unknown> }[]): ModelProvider {
  return {
    name: "call-stub",
    modelFor: () => "call-stub",
    async generate(request: ModelRequest) {
      const last = request.messages.at(-1)?.content ?? "";
      if (last.startsWith("Tool results")) return { text: "done", toolCalls: [], model: "call-stub" };
      return {
        text: "",
        toolCalls: calls.map((c) => ({ name: c.name, input: c.input ?? {} })),
        model: "call-stub",
      };
    },
  };
}

function runtimeWith(
  dir: string,
  model: ModelProvider,
  actions: Action[],
  settings: Record<string, string> = {},
): AgentRuntime {
  const runtime = new AgentRuntime({
    character: lain,
    memory: new FileMemoryStore(dir),
    model,
    settings: { LAINOS_DATA_DIR: dir, LAINOS_MODEL_TRANSCRIPTS: "0", ...settings },
  });
  runtime.use({ name: "probe", description: "security probes", actions });
  return runtime;
}

/** An action that records whether its handler ran. */
function probe(name: string, allowed: () => boolean, similes: string[] = []): Action & { ran: number } {
  const action = {
    ran: 0,
    name,
    similes,
    description: "stub",
    examples: [],
    async validate() {
      return allowed();
    },
    async handler() {
      action.ran += 1;
      return { ok: true, text: `${name} ran` };
    },
  };
  return action;
}

// ------------------------------------------------- 1. validate() is enforced

{
  const locked = probe("locked_probe", () => false, ["locked_alias"]);
  const open = probe("open_probe", () => true);
  const rt = runtimeWith(
    join(tmp, "validate"),
    callingModel([{ name: "locked_probe" }, { name: "locked_alias", input: { again: 1 } }, { name: "open_probe" }]),
    [locked, open],
  );
  const result = await rt.handleMessage({ roomId: "sec", userId: "user", text: "go" });
  check("a tool that fails validate() never runs", locked.ran === 0);
  check("…not even through a simile", result.actions.filter((a) => a.name === "locked_probe").every((a) => !a.result.ok));
  check("a tool that passes validate() still runs", open.ran === 1);
}

// ----------------------------------------------------------- 2. HTTP bridge

/** A raw request, so Host and Origin go out exactly as given. */
function call(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

async function listen(runtime: AgentRuntime) {
  const server = createHttpServer(runtime, { host: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => server.once("listening", () => r()));
  return { server, port: (server.address() as AddressInfo).port };
}

{
  const seen: string[] = [];
  const whoami: Action = {
    name: "whoami_probe",
    similes: [],
    description: "stub",
    examples: [],
    async validate() {
      return true;
    },
    async handler(_rt, state) {
      seen.push(state.message.userId);
      return { ok: true, text: "noted" };
    },
  };
  const rt = runtimeWith(join(tmp, "http"), callingModel([{ name: "whoami_probe" }]), [whoami], {
    LAINOS_HTTP_ALLOWED_ORIGINS: "https://game.example",
  });
  const { server, port } = await listen(rt);
  const chat = { roomId: "http-sec", userId: "user", text: "hi" };

  const evil = await call(port, "POST", "/chat", { Origin: "https://evil.example", "Content-Type": "text/plain" }, chat);
  check("a foreign origin cannot POST /chat", evil.status === 403 && seen.length === 0);
  const peek = await call(port, "GET", "/sessions", { Origin: "https://evil.example" });
  check("…nor read the session index", peek.status === 403);
  const preflight = await call(port, "OPTIONS", "/chat", { Origin: "https://evil.example" });
  check("…nor pass a preflight", preflight.status === 403 && !preflight.headers["access-control-allow-origin"]);
  const allowed = await call(port, "GET", "/health", { Origin: "https://game.example" });
  check(
    "an allowed origin gets itself back, never *",
    allowed.status === 200 && allowed.headers["access-control-allow-origin"] === "https://game.example",
  );
  const rebound = await call(port, "GET", "/sessions", { Host: `attacker.example:${port}` });
  check("a rebinding Host is refused", rebound.status === 403);
  const local = await call(port, "GET", "/health", { Host: `localhost:${port}` });
  check("a loopback Host is fine", local.status === 200);

  const spoof = await call(port, "POST", "/chat", { "Content-Type": "application/json" }, chat);
  check("curl-style /chat still works", spoof.status === 200);
  check("an HTTP caller cannot pass for the local operator", seen.length === 1 && seen[0] === "http:user");
  await new Promise<void>((r) => server.close(() => r()));
}

{
  const rt = runtimeWith(join(tmp, "http-token"), callingModel([]), [], { LAINOS_HTTP_TOKEN: "s3cret" });
  const { server, port } = await listen(rt);
  check("with a token, /health stays open", (await call(port, "GET", "/health")).status === 200);
  check("…other routes need it", (await call(port, "GET", "/sessions")).status === 401);
  check("…a wrong one is refused", (await call(port, "GET", "/routines", { Authorization: "Bearer nope" })).status === 401);
  check("…the right one gets in", (await call(port, "GET", "/routines", { Authorization: "Bearer s3cret" })).status === 200);
  await new Promise<void>((r) => server.close(() => r()));
}

// ------------------------------------------------------ 3. operator-only tools

{
  const guarded = probe("guarded_probe", () => true);
  (guarded as Action).operatorOnly = true;
  let offered: string[] = [];
  const model: ModelProvider = {
    name: "op-stub",
    modelFor: () => "op-stub",
    async generate(request: ModelRequest) {
      const last = request.messages.at(-1)?.content ?? "";
      if (last.startsWith("Tool results")) return { text: "done", toolCalls: [], model: "op-stub" };
      offered = (request.tools ?? []).map((t) => t.name);
      return { text: "", toolCalls: [{ name: "guarded_probe", input: {} }], model: "op-stub" };
    },
  };
  const rt = runtimeWith(join(tmp, "operator"), model, [guarded], { TELEGRAM_OPERATOR_ID: "42" });
  const tg = (id: number, role: TelegramSender["role"]): Record<string, unknown> => ({
    telegram: { id, role, operatorKnown: true } satisfies TelegramSender,
  });
  const turn = async (userId: string, metadata?: Record<string, unknown>) => {
    const before = guarded.ran;
    await rt.handleMessage({ roomId: `op-${userId}`, userId, text: "do it", metadata });
    return { ran: guarded.ran > before, offered: offered.includes("guarded_probe") };
  };

  const local = await turn("user");
  check("the terminal operator is offered and runs it", local.ran && local.offered);
  const op = await turn("tg:42", tg(42, "operator"));
  check("the Telegram operator runs it", op.ran && op.offered);
  const guest = await turn("tg:7", tg(7, "guest"));
  check("a Telegram guest is neither offered it nor runs it", !guest.ran && !guest.offered);
  const stranger = await turn("tg:8", tg(8, "unknown"));
  check("…nor does an unknown sender", !stranger.ran);
  check("…nor an HTTP caller posing as the operator", !(await turn("http:user")).ran);
  check("…nor a background turn", !(await turn("heartbeat")).ran && !(await turn("study")).ran);
}

{
  const marked = (plugins: Plugin[]) =>
    new Set(plugins.flatMap((p) => p.actions ?? []).filter((a) => a.operatorOnly).map((a) => a.name));
  const guardedNames = marked([systemPlugin, skillsPlugin, forgePlugin, chainPlugin, metamaskPlugin]);
  const must = [
    "run_shell", "write_file", "create_skill", "edit_skill", "learn_skill", "log_wish",
    "send_native", "buy_token", "sell_token", "metamask_send", "metamask",
  ];
  const missing = must.filter((n) => !guardedNames.has(n));
  check(`shell, code and money tools are operator-only${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`, !missing.length);
}

// ------------------------------------------------- 4. proxy credentials

check("a proxy's password never reaches the log", !redactUrl("http://alice:hunter2@10.0.0.1:8080").includes("hunter2"));
check("…nor its user", !redactUrl("socks5://alice:hunter2@proxy.example:1080").includes("alice"));
check("a proxy without credentials is shown as is", redactUrl("http://127.0.0.1:10808") === "http://127.0.0.1:10808");

await rm(tmp, { recursive: true, force: true });

let failed = 0;
for (const [name, pass] of results) {
  console.log(`${pass ? "✓" : "✗"} ${name}`);
  if (!pass) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
