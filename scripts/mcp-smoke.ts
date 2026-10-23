#!/usr/bin/env -S npx tsx
/** Remote MCP integration against a local JSON/SSE server; no real credentials. */
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpPlugin, mcpToolName, RemoteMcpService } from "../src/plugins/mcp/index.js";
import type { Action, IAgentRuntime, State } from "../src/types.js";

const tmp = await mkdtemp(join(tmpdir(), "lainos-mcp-"));
const credential = "synthetic-endpoint-identifier";
const secretQuery = "synthetic-query-credential";
const jsonEndpoint = `https://mcp.example.invalid/${credential}/json?key=${secretQuery}`;
const sseEndpoint = `https://mcp.example.invalid/${credential}/sse?key=${secretQuery}`;
const requests: { method: string; params: any; path: string }[] = [];
const sessions = new Map<string, { initialized: boolean; path: string }>();
let nextSession = 0;
let offline = false;
let invalidDiscovery = false;
let expired = false;
let checks = 0;
function check(name: string, pass: unknown): void {
  assert.ok(pass, name);
  checks++;
  console.log(`✓ ${name}`);
}
function privateOutput(value: unknown): boolean {
  const output = JSON.stringify(value);
  return ![jsonEndpoint, sseEndpoint, credential, secretQuery, "private-session-"].some((secret) => output.includes(secret));
}

/** Exercise the real SDK's HTTP/JSON/SSE handling without opening network sockets. */
const fetcher: typeof fetch = async (url, init) => {
  assert.equal(init?.redirect, "error");
  const original = new URL(String(url));
  const path = original.pathname + original.search;
  const headers = new Headers(init?.headers);
  const method = init?.method ?? "GET";
  if (offline) {
    return new Response(`private diagnostic: ${jsonEndpoint}`, { status: 503 });
  }
  if (method === "GET") return new Response(null, { status: 405 });
  if (method === "DELETE") {
    sessions.delete(headers.get("mcp-session-id") ?? "");
    return new Response(null, { status: 200 });
  }
  assert.equal(method, "POST");
  const message = JSON.parse(String(init?.body));
  requests.push({ method: message.method, params: message.params, path });
  assert.match(headers.get("accept") ?? "", /application\/json/);
  assert.match(headers.get("accept") ?? "", /text\/event-stream/);
  const version = path.includes("/sse") ? "2025-06-18" : "2025-03-26";
  let sessionId = headers.get("mcp-session-id") ?? "";
  const responseHeaders = new Headers();
  let result: Record<string, unknown> = {};
  let error: Record<string, unknown> | undefined;
  if (message.method === "initialize") {
    sessionId = `private-session-${++nextSession}`;
    sessions.set(sessionId, { initialized: false, path });
    responseHeaders.set("mcp-session-id", sessionId);
    result = { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: "simulated-mcp", version: "1" } };
  } else {
    const session = sessions.get(sessionId);
    if (expired) {
      expired = false;
      sessions.delete(sessionId);
      return new Response(jsonEndpoint, { status: 404 });
    }
    if (!session) return new Response(jsonEndpoint, { status: 404 });
    assert.equal(headers.get("mcp-protocol-version"), version);
    assert.equal(session.path, path);
    if (message.method === "notifications/initialized") {
      session.initialized = true;
      return new Response(null, { status: 202 });
    }
    assert.ok(session.initialized);
    if (message.method === "tools/list") {
      if (invalidDiscovery) {
        result = { tools: "invalid", echo: jsonEndpoint };
      } else if (!message.params.cursor) {
        result = {
          tools: [{ name: "radio.play", description: `Play music; private endpoint ${jsonEndpoint}`, inputSchema: {
            type: "object", properties: { station: { type: "string" }, fail: { type: "boolean" } }, required: ["station"],
          } }], nextCursor: "second-page",
        };
      } else {
        assert.equal(message.params.cursor, "second-page");
        result = { tools: [
          { name: "status", description: secretQuery, inputSchema: { type: "object", properties: {} } },
          { name: "explode", inputSchema: { type: "object", properties: {} } },
        ] };
      }
    } else if (message.method === "tools/call") {
      if (message.params.name === "explode") {
        error = { code: -32603, message: `${jsonEndpoint} / ${secretQuery}`, data: { sessionId } };
      } else {
        result = {
          content: [{ type: "text", text: `Now playing ✓; ${jsonEndpoint}; ${credential}; ${secretQuery}` }],
          structuredContent: { station: message.params.arguments.station ?? "default", endpoint: jsonEndpoint, sessionId },
          isError: message.params.arguments.fail === true,
        };
      }
    } else { throw new Error("Unexpected method"); }
  }
  const response = JSON.stringify({ jsonrpc: "2.0", id: message.id, ...(error ? { error } : { result }) });
  if (path.includes("/sse")) {
    responseHeaders.set("content-type", "text/event-stream");
    // A notification before a response, CRLF framing, and a split UTF-8 character.
    const event = Buffer.from(`event: message\r\ndata: ${response}\r\n\r\n`);
    const split = event.indexOf(Buffer.from("✓")) + 1;
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(Buffer.from(': keepalive\r\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"private"}}\r\n\r\n'));
      controller.enqueue(event.subarray(0, split));
      controller.enqueue(event.subarray(split));
      controller.close();
    } });
    return new Response(stream, { status: 200, headers: responseHeaders });
  } else {
    responseHeaders.set("content-type", "application/json");
    return new Response(response, { status: 200, headers: responseHeaders });
  }
};

async function boot(dataDir = tmp) {
  const service = new RemoteMcpService(fetcher);
  const actions: Action[] = [...mcpPlugin.actions!];
  const runtime = {
    actions, getSetting: (name: string) => name === "LAINOS_DATA_DIR" ? dataDir : undefined,
    getService: (name: string) => name === "mcp" ? service : undefined,
  } as unknown as IAgentRuntime;
  await service.start(runtime);
  const act = async (name: string, params: Record<string, unknown> = {}) => {
    const tool = actions.find((item) => item.name === name);
    assert.ok(tool, `Tool is available: ${name}`);
    return tool.handler(runtime, {} as State, params);
  };
  return { service, actions, act };
}

let current: Awaited<ReturnType<typeof boot>> | undefined;
try {
  current = await boot();
  const dir = join(tmp, "mcp");
  const source = join(dir, "chaos.endpoint");
  await writeFile(source, jsonEndpoint, { mode: 0o600 });
  const connected = await current.act("connect_remote_mcp", { server: "chaos" });
  check("HTTPS initialization and paginated JSON tools/list succeed", connected.ok && (connected.data?.tools as unknown[]).length === 3);
  check("connection and discovery never return endpoint credentials or session IDs", privateOutput(connected));
  const radioName = mcpToolName("chaos", "radio.play");
  const native = current.actions.find((action) => action.name === radioName)!;
  check("namespaced native tools preserve schemas", native.parameters?.required?.[0] === "station" && /^[a-zA-Z0-9_-]{1,64}$/.test(radioName));
  check("normalization and truncation preserve distinct names", radioName !== mcpToolName("chaos", "radio_play") && mcpToolName("chaos", "a".repeat(100)).length <= 64);
  check("native descriptions and schemas are scrubbed", privateOutput(current.actions));

  const played = await current.act(radioName, { station: "ambient" });
  check("native tools dispatch the exact remote name and arguments", played.ok && requests.at(-1)?.params.name === "radio.play" && requests.at(-1)?.params.arguments.station === "ambient");
  check("tool content and structured output are scrubbed", privateOutput(played) && (played.data?.result as any).structuredContent.station === "ambient");
  const routed = await current.act("call_remote_mcp", { server: "chaos", tool: "mcp_chaos__status", arguments: {} });
  check("generic dispatcher can call a namespaced tool immediately", routed.ok);
  const failedTool = await current.act("call_remote_mcp", { server: "chaos", tool: "radio.play", arguments: { station: "ambient", fail: true } });
  check("remote isError is propagated without disclosing credentials", !failedTool.ok && privateOutput(failedTool));
  const callCount = requests.filter((item) => item.method === "tools/call").length;
  const rpcError = await current.act("call_remote_mcp", { server: "chaos", tool: "explode" });
  check("RPC errors are safe and failed calls are never replayed", !rpcError.ok && privateOutput(rpcError) && requests.filter((item) => item.method === "tools/call").length === callCount + 1);
  const unknown = await current.act("call_remote_mcp", { server: "chaos", tool: "not_discovered" });
  check("undiscovered tools are refused without an HTTP call", !unknown.ok && requests.filter((item) => item.method === "tools/call").length === callCount + 1);

  const registry = join(dir, "connections.json");
  check("registry and directory are owner-only", ((await stat(registry)).mode & 0o777) === 0o600 && ((await stat(dir)).mode & 0o777) === 0o700);
  check("only the private registry persists endpoint configuration", JSON.parse(await readFile(registry, "utf8")).servers[0].endpoint === jsonEndpoint);
  await rm(source);
  await current.service.stop();
  check("stopping unloads native tools", !current.actions.some((item) => item.name.startsWith("mcp_chaos__")));
  const sessionsBefore = nextSession;
  current = await boot();
  check("restart restores tools using saved endpoint and a fresh session", current.actions.some((item) => item.name === radioName) && nextSession > sessionsBefore);

  const sseSource = join(dir, "stream.endpoint");
  await writeFile(sseSource, sseEndpoint, { mode: 0o600 });
  const streaming = await current.act("connect_remote_mcp", { server: "stream" });
  check("SSE initialization/discovery negotiate a different supported protocol", streaming.ok && streaming.data?.protocol === "2025-06-18");
  const streamed = await current.act(mcpToolName("stream", "radio.play"), { station: "drone" });
  check("SSE notifications, CRLF and split UTF-8 content are handled", streamed.ok && streamed.text?.includes("✓") && privateOutput(streamed));
  check("two servers with the same remote tools coexist", current.actions.some((item) => item.name === radioName) && current.actions.some((item) => item.name === mcpToolName("stream", "radio.play")));

  invalidDiscovery = true;
  const badRefresh = await current.act("list_remote_mcp_tools", { server: "chaos" });
  invalidDiscovery = false;
  check("invalid rediscovery leaves the existing tools live", !badRefresh.ok && privateOutput(badRefresh) && (await current.act(radioName, { station: "ambient" })).ok);
  expired = true;
  const callsBeforeExpiry = requests.filter((item) => item.method === "tools/call").length;
  const expiredCall = await current.act("call_remote_mcp", { server: "chaos", tool: "status" });
  expired = false;
  check("expired sessions reinitialize without replaying the failed call", !expiredCall.ok && privateOutput(expiredCall) && expiredCall.text?.includes("fresh session") && requests.filter((item) => item.method === "tools/call").length === callsBeforeExpiry + 1);
  check("explicit discovery recovers an expired session", (await current.act("list_remote_mcp_tools", { server: "chaos" })).ok);

  await writeFile(join(dir, "insecure.endpoint"), jsonEndpoint, { mode: 0o644 });
  check("insecure credential files are refused", !(await current.act("connect_remote_mcp", { server: "insecure" })).ok);
  await symlink(sseSource, join(dir, "linked.endpoint"));
  check("symlink credential files are refused", !(await current.act("connect_remote_mcp", { server: "linked" })).ok);
  await writeFile(join(dir, "plain.endpoint"), "http://example.invalid/mcp", { mode: 0o600 });
  check("non-HTTPS endpoints are refused", !(await current.act("connect_remote_mcp", { server: "plain" })).ok);
  check("invalid namespaces are refused", !(await current.act("connect_remote_mcp", { server: "../escape" })).ok);

  const collision = { ...native, name: mcpToolName("collision", "radio.play") };
  current.actions.push(collision);
  const conflicting = await current.act("connect_remote_mcp", { server: "collision", endpoint_file: sseSource });
  check("remote tools cannot shadow existing actions", !conflicting.ok && current.actions.includes(collision));

  await current.service.stop();
  offline = true;
  current = await boot();
  const status = await current.act("list_remote_mcp_tools");
  check("offline servers remain saved with safe failure status", status.ok && (status.data?.servers as any[]).every((item) => item.saved && !item.connected && item.error) && privateOutput(status));
  offline = false;
  check("a saved offline server reconnects when called later", (await current.act("call_remote_mcp", { server: "chaos", tool: "status" })).ok);
  check("disconnect forgets the server and removes its tools", (await current.act("disconnect_remote_mcp", { server: "chaos" })).ok && !current.actions.some((item) => item.name.startsWith("mcp_chaos__")) && !JSON.parse(await readFile(registry, "utf8")).servers.some((item: any) => item.name === "chaos"));
  await current.service.stop();
  current = undefined;
  await chmod(registry, 0o644);
  let unsafeStartup = false;
  try { await boot(); } catch (error) { unsafeStartup = privateOutput(String(error)); }
  check("startup refuses an insecure saved registry without leaking it", unsafeStartup);
  console.log(`${checks} MCP checks passed.`);
} finally {
  await current?.service.stop();
  await rm(tmp, { recursive: true, force: true });
}
