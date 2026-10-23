import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, McpError, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Action, ActionResult, IAgentRuntime, Plugin, Service } from "../../types.js";

const SERVER_NAME = /^[a-z][a-z0-9_]{0,23}$/;
const TIMEOUT = 30_000;
class SafeError extends Error {}

interface Connection {
  client: Client;
  transport: StreamableHTTPClientTransport;
  tools: Tool[];
  actions: Action[];
}

/** Endpoint files and the connection registry are credentials, never tool output. */
async function readPrivate(file: string): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) {
      throw new SafeError("MCP configuration must be an owner-only regular file (mode 0600).");
    }
    if (info.size > 1_048_576) throw new SafeError("MCP configuration is too large.");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function serverName(value: unknown): string {
  if (typeof value !== "string" || !SERVER_NAME.test(value)) {
    throw new SafeError("Use a server name matching [a-z][a-z0-9_]{0,23}.");
  }
  return value;
}

function endpointUrl(value: unknown): string {
  try {
    if (typeof value !== "string" || value.length > 16_384) throw new Error();
    if (/[\u0000-\u0020\u007f]/.test(value.trim())) throw new Error();
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error();
    return value.trim();
  } catch {
    throw new SafeError("The endpoint file must contain one HTTPS URL without userinfo or a fragment.");
  }
}

/** Stable, provider-safe names; normalization must not merge distinct remote tools. */
export function mcpToolName(server: string, tool: string): string {
  const prefix = `mcp_${server}__`;
  const clean = tool.replace(/[^a-zA-Z0-9_-]/g, "_");
  const suffix = clean === tool && prefix.length + clean.length <= 64
    ? clean
    : `${clean.slice(0, 64 - prefix.length - 11)}_${createHash("sha256").update(tool).digest("hex").slice(0, 10)}`;
  return prefix + suffix;
}

function failure(error: unknown): ActionResult {
  // SDK errors can contain the endpoint, response body, session ID or secret token.
  const text = error instanceof SafeError ? error.message
    : error instanceof StreamableHTTPError ? `MCP HTTP request failed (status ${error.code ?? "unknown"}).`
    : error instanceof McpError ? `MCP request failed (code ${error.code}).`
    : "MCP connection or request failed. Check the private endpoint file, authorization, TLS and reachability locally.";
  return { ok: false, text };
}

export class RemoteMcpService implements Service {
  readonly name = "mcp";
  private runtime!: IAgentRuntime;
  private dir = "";
  private saved = new Map<string, string>();
  private live = new Map<string, Connection>();
  private problems = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private fetcher: FetchLike = globalThis.fetch) {}

  async start(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
    this.dir = resolve(runtime.getSetting("LAINOS_DATA_DIR") || "./data", "mcp");
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const info = await lstat(this.dir);
      if (!info.isDirectory() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) {
        throw new SafeError("The MCP configuration directory must be owner-only (mode 0700), without a symlink.");
      }
      let contents: string;
      try {
        contents = await readPrivate(join(this.dir, "connections.json"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      const config = JSON.parse(contents);
      if (config.version !== 1 || !Array.isArray(config.servers)) throw new SafeError("Invalid private MCP registry.");
      for (const entry of config.servers) {
        const name = serverName(entry.name);
        if (this.saved.has(name)) throw new SafeError("Duplicate server in the private MCP registry.");
        this.saved.set(name, endpointUrl(entry.endpoint));
      }
    } catch (error) {
      // Fail closed, with no raw filesystem/JSON/URL error reaching runtime logging.
      throw new Error(failure(error).text);
    }
    for (const name of this.saved.keys()) {
      const result = await this.manage(() => this.connect(name));
      if (!result.ok) this.problems.set(name, result.text!);
    }
  }

  async stop(): Promise<void> {
    await this.queue;
    for (const connection of this.live.values()) {
      this.unregister(connection);
      await connection.client.close().catch(() => {});
    }
    this.live.clear();
  }

  /** Serialize registry changes so concurrent rooms cannot lose a saved connection. */
  manage(work: () => Promise<ActionResult>): Promise<ActionResult> {
    const task = this.queue.then(work).catch(failure);
    this.queue = task;
    return task;
  }

  private scrub<T>(value: T, extra?: string, sessionId?: string): T {
    const secrets = new Set<string>();
    for (const id of [...this.live.values()].map((connection) => connection.transport.sessionId).concat(sessionId)) {
      if (id) secrets.add(id);
    }
    for (const endpoint of [...this.saved.values(), ...(extra ? [extra] : [])]) {
      const url = new URL(endpoint);
      secrets.add(endpoint);
      secrets.add(url.href);
      // Also cover server errors/results that echo just a credential component.
      for (const part of [...url.pathname.split("/").filter((part) => part.length >= 6), ...url.searchParams.values()]) {
        if (!part) continue;
        secrets.add(part);
        try { secrets.add(decodeURIComponent(part)); } catch { /* Keep the encoded value. */ }
      }
    }
    const ordered = [...secrets].sort((a, b) => b.length - a.length);
    const redact = (text: string) => ordered.reduce((out, secret) => out.split(secret).join("[redacted:mcp]"), text);
    // Redact JSON strings and keys, never the JSON syntax (a short token may be "true").
    return JSON.parse(JSON.stringify(value, (_key, raw) => {
      if (typeof raw === "string") return redact(raw);
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        return Object.fromEntries(Object.entries(raw).map(([key, item]) => [redact(key), item]));
      }
      return raw;
    })) as T;
  }

  private unregister(connection: Connection): void {
    for (const action of connection.actions) {
      const index = this.runtime.actions.indexOf(action);
      if (index >= 0) this.runtime.actions.splice(index, 1);
    }
  }

  private async persist(saved: Map<string, string>): Promise<void> {
    const temp = join(this.dir, `.connections-${randomUUID()}.tmp`);
    try {
      const handle = await open(temp, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ version: 1, servers: [...saved].map(([name, endpoint]) => ({ name, endpoint })) }));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, join(this.dir, "connections.json"));
    } finally {
      await rm(temp, { force: true }).catch(() => {});
    }
  }

  async connect(rawName: unknown, file?: unknown): Promise<ActionResult> {
    const name = serverName(rawName);
    const endpoint = file === undefined && this.saved.has(name) ? this.saved.get(name)!
      : endpointUrl(await readPrivate(file === undefined ? join(this.dir, `${name}.endpoint`) : this.endpointFile(file)));
    const client = new Client({ name: "lainos", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      // Never forward a credential-bearing endpoint through a redirect.
      fetch: (url, init) => this.fetcher(url, {
        ...init, redirect: "error",
        signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(TIMEOUT)]),
      }),
    });
    client.onerror = () => {}; // Raw SDK errors are private; actions return safe diagnostics.
    try {
      await client.connect(transport, { timeout: TIMEOUT });
      const tools: Tool[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await client.listTools(cursor ? { cursor } : {}, { timeout: TIMEOUT });
        tools.push(...page.tools);
        cursor = page.nextCursor;
        if (tools.length > 1000 || (cursor && seen.has(cursor)) || seen.size >= 100) {
          throw new SafeError("MCP tool discovery exceeded its pagination limit.");
        }
        if (cursor) seen.add(cursor);
      } while (cursor);

      const previous = this.live.get(name);
      const actions = tools.map((tool): Action => {
        if (this.scrub(tool.name, endpoint, transport.sessionId) !== tool.name) throw new SafeError("A remote tool name contains endpoint credentials.");
        return {
          name: mcpToolName(name, tool.name), similes: [], examples: [],
          description: this.scrub(`Remote MCP tool from ${name} (third-party): ${tool.description || tool.name}`, endpoint, transport.sessionId),
          parameters: this.scrub({ ...tool.inputSchema, properties: tool.inputSchema.properties ?? {} }, endpoint, transport.sessionId),
          validate: async () => true,
          handler: async (_runtime, _state, args) => this.call(name, tool.name, args),
        };
      });
      const names = new Set<string>();
      for (const action of actions) {
        if (names.has(action.name) || this.runtime.actions.some((existing) =>
          !previous?.actions.includes(existing) && (existing.name === action.name || existing.similes.includes(action.name)))) {
          throw new SafeError("A remote MCP tool conflicts with an existing tool name.");
        }
        names.add(action.name);
      }
      const saved = new Map(this.saved).set(name, endpoint);
      await this.persist(saved);
      if (previous) {
        this.unregister(previous);
        await previous.client.close().catch(() => {});
      }
      this.saved = saved;
      this.live.set(name, { client, transport, tools, actions });
      this.problems.delete(name);
      this.runtime.actions.push(...actions);
      return { ok: true, text: `Connected MCP server ${name}; tools/list found ${tools.length} tool(s).`, data: this.describe(name) };
    } catch (error) {
      await client.close().catch(() => {});
      return failure(error);
    }
  }

  private endpointFile(file: unknown): string {
    if (typeof file !== "string" || !file || /[\r\n]/.test(file)) throw new SafeError("endpoint_file must be a local file path.");
    return resolve(file);
  }

  describe(name: string): Record<string, unknown> {
    const connection = this.live.get(name);
    return this.scrub({
      server: name, connected: !!connection, saved: this.saved.has(name),
      ...(this.problems.has(name) ? { error: this.problems.get(name) } : {}),
      ...(connection ? {
        protocol: connection.transport.protocolVersion,
        tools: connection.tools.map((tool, index) => ({
          name: connection.actions[index].name, remote_name: tool.name,
          description: tool.description ?? "", inputSchema: tool.inputSchema,
        })),
      } : {}),
    });
  }

  list(): ActionResult {
    const servers = [...this.saved.keys()].map((name) => this.describe(name));
    return { ok: true, text: `${servers.length} saved MCP server(s).`, data: { servers } };
  }

  async call(rawName: unknown, tool: unknown, args: unknown = {}): Promise<ActionResult> {
    let name: string | undefined;
    let connection: Connection | undefined;
    try {
      name = serverName(rawName);
      connection = this.live.get(name);
      if (!connection && this.saved.has(name)) {
        const result = await this.manage(() => this.connect(name!));
        if (!result.ok) return result;
        connection = this.live.get(name);
      }
      if (!connection) throw new SafeError("MCP server is not connected. Use connect_remote_mcp first.");
      const remote = connection.tools.find((item, index) => item.name === tool || connection!.actions[index].name === tool);
      if (!remote) throw new SafeError("Unknown MCP tool. Use list_remote_mcp_tools for discovery.");
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new SafeError("MCP arguments must be an object.");
      const result = this.scrub(CallToolResultSchema.parse(await connection.client.callTool({ name: remote.name, arguments: args as Record<string, unknown> }, undefined, { timeout: TIMEOUT })));
      return {
        ok: result.isError !== true,
        text: result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n") || "MCP tool returned content.",
        data: { server: name, tool: mcpToolName(name, remote.name), result },
      };
    } catch (error) {
      // Never replay a tools/call after a failure: it may already have changed remote state.
      if (name && error instanceof StreamableHTTPError && error.code === 404) {
        const result = await this.manage(async () => {
          if (connection && this.live.get(name!) === connection) {
            this.unregister(connection);
            this.live.delete(name!);
            await connection.client.close().catch(() => {});
          }
          return this.connect(name!);
        });
        if (!result.ok) this.problems.set(name, result.text!);
        return {
          ok: false,
          text: result.ok
            ? "The MCP session expired. A fresh session and tool inventory are available. The failed call was not replayed; check remote state before retrying."
            : `The MCP session expired and reconnect failed. The call was not replayed. ${result.text}`,
        };
      }
      return failure(error);
    }
  }

  async disconnect(rawName: unknown): Promise<ActionResult> {
    const name = serverName(rawName);
    const saved = new Map(this.saved);
    saved.delete(name);
    await this.persist(saved);
    const connection = this.live.get(name);
    if (connection) {
      this.unregister(connection);
      await connection.transport.terminateSession().catch(() => {});
      await connection.client.close().catch(() => {});
      this.live.delete(name);
    }
    this.saved = saved;
    this.problems.delete(name);
    return { ok: true, text: `Disconnected and forgot MCP server ${name}.` };
  }
}

function action(name: string, description: string, properties: Record<string, unknown>, required: string[],
  run: (service: RemoteMcpService, params: Record<string, unknown>) => Promise<ActionResult> | ActionResult): Action {
  return {
    name, description, similes: [], examples: [], parameters: { type: "object", properties, required },
    validate: async (runtime) => !!runtime.getService("mcp"),
    async handler(runtime, _state, params) {
      const service = runtime.getService<RemoteMcpService>("mcp");
      if (!service) return { ok: false, text: "The MCP service is unavailable." };
      try { return await run(service, params); } catch (error) { return failure(error); }
    },
  };
}

const serverParam = { type: "string", description: "Local server namespace, e.g. chaos." };
export const mcpPlugin: Plugin = {
  name: "mcp", description: "Persistent remote MCP connections over Streamable HTTP, with private endpoints and namespaced tools.",
  services: [new RemoteMcpService()],
  actions: [
    action("connect_remote_mcp", "Connect or reconnect a remote MCP server and discover tools/list. Read the HTTPS endpoint from an owner-only local file; never put URLs or credentials in tool arguments, messages, wishes or logs. endpoint_file defaults to <LAINOS_DATA_DIR>/mcp/<server>.endpoint for a new server; omit it to reuse a saved connection. A successful connection returns the actual discovered tools. Creating this capability alone does not connect a server.", {
      server: serverParam, endpoint_file: { type: "string", description: "Path to a local mode-0600 file containing only the HTTPS endpoint. Pass its path, never its contents." },
    }, ["server"], (service, p) => service.manage(() => service.connect(p.server, p.endpoint_file))),
    action("list_remote_mcp_tools", "List saved MCP servers, connection status and discovered namespaced tools with input schemas. With server, repeat tools/list using a fresh connection, also recovering expired sessions. Endpoints and credentials are never returned.", {
      server: serverParam,
    }, [], (service, p) => p.server === undefined ? service.list() : service.manage(() => service.connect(p.server))),
    action("call_remote_mcp", "Call a discovered remote MCP tool by server namespace and tool name (original or mcp_<server>__<tool>). Available immediately after connect_remote_mcp, including in the same turn. Remote tools may change state; follow the operator's instructions. Failed calls are never replayed automatically.", {
      server: serverParam, tool: { type: "string" }, arguments: { type: "object", additionalProperties: true },
    }, ["server", "tool"], (service, p) => service.call(p.server, p.tool, p.arguments)),
    action("disconnect_remote_mcp", "Disconnect a remote MCP server, unload its tools and remove its saved endpoint. The operator's original endpoint file is retained.", {
      server: serverParam,
    }, ["server"], (service, p) => service.manage(() => service.disconnect(p.server))),
  ],
};
