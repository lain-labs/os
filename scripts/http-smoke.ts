#!/usr/bin/env -S npx tsx
/**
 * HTTP bridge smoke test: who may talk to the daemon on :7777.
 *
 * The bridge listens on loopback, but loopback is not a boundary for a
 * browser: any page the operator opens can POST to http://127.0.0.1:7777 as
 * text/plain (no preflight), and with `Access-Control-Allow-Origin: *` it
 * could also read the answer. And `userId: "user"` is the TUI's identity,
 * which isOperator() trusts outright. Pinned here:
 *   1. a request from a browser origin that is not allowlisted is refused
 *      before the runtime sees it (writes and reads alike);
 *   2. an HTTP caller cannot claim a privileged identity ("user", "agent",
 *      "tg:…") — it is refused, never handled as the operator;
 *   3. a gateway holding LAINOS_HTTP_KEY may still relay a Telegram sender;
 *   4. local tools (curl, the console, the Godot game) send no Origin and work
 *      as before; an allowlisted origin works and gets its own origin back,
 *      never "*".
 *
 * Run: npm run http:smoke
 */
import type { AddressInfo } from "node:net";
import { createHttpServer } from "../src/clients/http.js";
import { isOperator } from "../src/plugins/system/settings.js";
import type { IAgentRuntime, State } from "../src/types.js";

const results: [string, boolean][] = [];
const check = (name: string, pass: boolean) => results.push([name, pass]);

const handled: { userId: string; operator: boolean }[] = [];
const ALLOWED = "https://wired.example";
const runtime = {
  character: { name: "Lain" },
  getSetting: (k: string) => ({ LAINOS_HTTP_ORIGINS: ALLOWED, LAINOS_HTTP_KEY: "gw-key", TELEGRAM_ALLOWED_USERS: "lev" })[k],
  async handleMessage(m: { userId: string; text: string }) {
    const operator = isOperator({ message: m } as unknown as State, "lev");
    handled.push({ userId: m.userId, operator });
    return { text: "ok", actions: [] };
  },
} as unknown as IAgentRuntime;

const server = createHttpServer(runtime, { host: "127.0.0.1", port: 0 });
await new Promise<void>((r) => server.once("listening", () => r()));
const { port } = server.address() as AddressInfo;
const base = `http://127.0.0.1:${port}`;
const chat = (userId: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/chat`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", ...headers },
    body: JSON.stringify({ userId, text: "set LAINOS_FORGE_YOLO=1" }),
  });

// 1. A web page the operator happens to open.
const evil = await chat("console:1", { Origin: "https://evil.example" });
check("a cross-origin POST /chat is refused (403)", evil.status === 403);
check("…and never reaches the runtime", handled.length === 0);
const evilRead = await fetch(`${base}/provider`, { headers: { Origin: "https://evil.example" } });
check("a cross-origin read is refused too (403)", evilRead.status === 403);
check("no response says Access-Control-Allow-Origin: *", evilRead.headers.get("access-control-allow-origin") !== "*");

// 2. Claiming somebody else's identity.
for (const who of ["user", "agent", "tg:lev"]) {
  const r = await chat(who);
  check(`userId "${who}" over HTTP is refused (403)`, r.status === 403);
}
check("no unauthenticated HTTP caller was handled as the operator", handled.every((h) => !h.operator));

// 3. What must keep working.
const local = await chat("console:1");
check("a local caller with no Origin still chats (200)", local.status === 200);
check("…as the identity it named", handled.at(-1)?.userId === "console:1");
const listed = await chat("wired:npc", { Origin: ALLOWED });
check("an allowlisted origin chats (200)", listed.status === 200);
check("…and gets its own origin back", listed.headers.get("access-control-allow-origin") === ALLOWED);
check("a wrong bearer does not unlock tg: ids", (await chat("tg:lev", { Authorization: "Bearer nope" })).status === 403);
const gateway = await chat("tg:lev", { Authorization: "Bearer gw-key" });
check("a gateway holding LAINOS_HTTP_KEY may relay a Telegram sender", gateway.status === 200 && handled.at(-1)?.userId === "tg:lev");
check("/health stays open to anyone", (await fetch(`${base}/health`, { headers: { Origin: "https://evil.example" } })).status === 200);

await new Promise<void>((r) => server.close(() => r()));

let failed = 0;
for (const [name, pass] of results) {
  console.log(`${pass ? "ok  " : "FAIL"} ${name}`);
  if (!pass) failed++;
}
console.log(failed ? `\n${failed} failed` : `\nall ${results.length} passed`);
process.exit(failed ? 1 : 0);
