import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { bearerMatches, handleAcpTool } from "../acp/tools.js";
import { createLogger } from "../logger.js";
import {
  CHAT_PROVIDER_CHOICES,
  resolveChatProviderKind,
  SwitchableModelProvider,
} from "../models/routing.js";
import type { ForgeService } from "../plugins/forge/index.js";
import type { ScoutService } from "../plugins/scout/index.js";
import type { RoutineService } from "../plugins/skills/routines.js";
import type { SentinelService } from "../plugins/sentinel/index.js";
import { buildRecap } from "../memory/recap.js";
import { TASK_ORDER, isTaskKind } from "../models/tasks.js";
import type { IAgentRuntime } from "../types.js";
import { NodeJobs } from "./node-jobs.js";
import { loadSubagents } from "../plugins/subagents/index.js";

const log = createLogger("http");

export interface HttpOptions {
  host?: string;
  port?: number;
}

/**
 * Minimal dependency-free HTTP bridge so external clients (e.g. the Wired
 * Godot game's NPCs) can talk to the agent.
 *
 *   GET  /health           -> { ok, agent }
 *   GET  /alerts            -> { alerts } (recent sentinel alerts)
 *   GET  /wishes            -> { wishes } (the forge wishboard)
 *   GET  /research          -> { topics } (the scout's subscriptions)
 *   GET  /provider          -> { provider, choices } (who writes the replies)
 *   POST /provider {provider} -> { provider } (switch claude/codex/opencode live)
 *   GET  /tasks             -> { routes } (which model answers which kind of work)
 *   POST /tasks {task,route}  -> { route } (point one kind of work elsewhere)
 *   GET  /sessions[?client=] -> { sessions } (the conversation index)
 *   GET  /sessions/{id}      -> { session, messages }
 *   POST /sessions/{id}/recap -> { recap }
 *   POST /chat {roomId,userId,text,task} -> { text, actions, model, provider, task }
 *   POST /acp/tools {tool,arguments} -> report (bearer LAINOS_ACP_API_KEY; see src/acp/tools.ts)
 *
 * The bridge drives an agent that has a shell and a wallet, so who may reach it
 * is decided here, not by the model:
 *   - a browser request (one carrying an Origin) is refused unless its origin
 *     is on LAINOS_HTTP_ORIGINS (or LAINOS_HTTP_ALLOWED_ORIGINS) — any web page
 *     the operator opens can otherwise POST to localhost — and gets its own
 *     origin back rather than "*". Clients without an Origin (curl, the
 *     console, the Godot game) are unaffected;
 *   - bound to loopback, a request whose Host is not a loopback name (or on
 *     LAINOS_HTTP_ALLOWED_HOSTS) is refused, which defeats DNS rebinding;
 *   - LAINOS_HTTP_TOKEN, when set, is required as a bearer on every route but
 *     /health (and /acp/tools, which has its own key); off loopback (a node's
 *     container port, a tunnel) LAINOS_HTTP_KEY is required the same way. Set
 *     one before binding anywhere but loopback;
 *   - an HTTP caller may never speak as a privileged identity — see
 *     callerIdentity() — unless it holds LAINOS_HTTP_KEY as a bearer, which is
 *     how a gateway that already authenticated a Telegram sender relays them.
 */
export function createHttpServer(runtime: IAgentRuntime, opts: HttpOptions = {}): Server {
  const host = opts.host ?? process.env.LAINOS_HTTP_HOST ?? "127.0.0.1";
  const port = Number(opts.port ?? process.env.LAINOS_HTTP_PORT ?? 7777);
  const token = runtime.getSetting("LAINOS_HTTP_TOKEN")?.trim() ?? "";
  const key = runtime.getSetting("LAINOS_HTTP_KEY")?.trim() ?? "";
  const jobs = new NodeJobs(runtime, runtime.getSetting("LAINOS_DATA_DIR") ?? "data");
  const origins = new Set([
    ...csv(runtime.getSetting("LAINOS_HTTP_ORIGINS")),
    ...csv(runtime.getSetting("LAINOS_HTTP_ALLOWED_ORIGINS")),
  ]);
  const hosts = new Set(csv(runtime.getSetting("LAINOS_HTTP_ALLOWED_HOSTS")).map((h) => h.toLowerCase()));
  const loopback = isLoopbackName(host);
  if (!loopback && !token && !key) {
    log.warn(
      `HTTP bridge bound to ${host} without LAINOS_HTTP_TOKEN or LAINOS_HTTP_KEY — anyone who can reach this port ` +
        `can talk to ${runtime.character.name}. Set LAINOS_HTTP_TOKEN.`,
    );
  }

  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    const health = req.method === "GET" && req.url === "/health";
    if (origin !== undefined) {
      // /health answers any page (it says only the agent's name); without the
      // CORS headers a foreign page still cannot read it.
      if (!origins.has(origin) && !health) return json(res, 403, { error: "origin not allowed" });
      if (origins.has(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
        res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      }
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    if (loopback && req.headers.host) {
      const name = hostName(req.headers.host);
      if (!isLoopbackName(name) && !hosts.has(name)) return json(res, 403, { error: "host not allowed" });
    }

    if (health) {
      return json(res, 200, { ok: true, agent: runtime.character.name });
    }

    // Loopback: LAINOS_HTTP_KEY is an optional gateway key and other local
    // callers still chat as themselves. Anywhere else it is the door's key.
    if (
      (token || (key && !loopback)) &&
      req.url !== "/acp/tools" &&
      !(token && bearerMatches(req.headers.authorization, token)) &&
      !trustedCaller(runtime, req.headers.authorization)
    ) {
      return json(res, 401, { error: "unauthorized" });
    }

    if (req.method === "GET" && req.url === "/node-status") {
      return json(res, 200, {
        ok: true, agent: runtime.character.name,
        model: runtime.model instanceof SwitchableModelProvider ? runtime.model.state() : { provider: runtime.model.name },
        coder: runtime.getService<ForgeService>("forge")?.forgeProvider(),
        subagents: loadSubagents(k => runtime.getSetting(k)).map(({ name, model, about }) => ({ name, model, about })),
        note: "Installed does not mean authenticated or within quota. Health does not test a model completion.",
      });
    }

    if (req.url?.split("?")[0] === "/jobs" && (req.method === "GET" || req.method === "POST")) {
      try {
        if (req.method === "GET") {
          const url = new URL(req.url, "http://localhost");
          const owner = url.searchParams.get("owner");
          if (!owner) return json(res, 400, { error: "owner is required" });
          const id = url.searchParams.get("id");
          const found = await jobs.list(owner, id ?? undefined);
          if (!id) return json(res, 200, { jobs: found });
          const job = found.find(job => job.id === id);
          return json(res, job ? 200 : 404, job ? { job } : { error: "No such task." });
        }
        const body = JSON.parse(await readBody(req));
        if (typeof body.owner !== "string" || !body.owner.trim() || body.owner.length > 100 || typeof body.task !== "string" || (body.id !== undefined && typeof body.id !== "string")) {
          return json(res, 400, { error: "owner and task are required strings; id is an optional string" });
        }
        const job = await jobs.submit(body.owner, body.task, body.id);
        return json(res, 202, { job });
      } catch (error) {
        log.error("node job request failed", error);
        return json(res, 409, { error: error instanceof Error && /^(Invalid task|Task |The node is busy)/.test(error.message) ? error.message : "Could not process node task." });
      }
    }

    if (req.method === "GET" && req.url?.startsWith("/alerts")) {
      const sentinel = runtime.getService<SentinelService>("sentinel");
      return json(res, 200, { alerts: sentinel?.recentAlerts(50) ?? [] });
    }

    if (req.method === "GET" && req.url?.startsWith("/wishes")) {
      const forge = runtime.getService<ForgeService>("forge");
      return json(res, 200, { wishes: forge?.listWishes() ?? [] });
    }

    if (req.method === "GET" && req.url?.startsWith("/research")) {
      const scout = runtime.getService<ScoutService>("scout");
      return json(res, 200, { topics: scout?.listTopics() ?? [] });
    }

    if (req.method === "GET" && req.url?.startsWith("/routines")) {
      const routines = runtime.getService<RoutineService>("routines");
      return json(res, 200, { routines: (await routines?.list()) ?? [] });
    }

    // Switching the live daemon (Telegram, sentinel, initiative) between
    // claude, codex and opencode without a restart — the TUI runs its own
    // process, so its /model only persists the choice for the daemon's next
    // boot.
    if (req.url?.startsWith("/provider") && (req.method === "GET" || req.method === "POST")) {
      const model = runtime.model;
      if (!(model instanceof SwitchableModelProvider)) {
        return json(res, 409, { error: "model provider is fixed for this run" });
      }
      if (req.method === "GET") {
        return json(res, 200, { provider: model.state(), choices: CHAT_PROVIDER_CHOICES });
      }
      try {
        const body = await readBody(req);
        const { provider } = JSON.parse(body || "{}");
        const kind = resolveChatProviderKind(String(provider ?? ""));
        if (!kind) {
          return json(res, 400, {
            error: `field 'provider' must be one of: ${CHAT_PROVIDER_CHOICES.map((c) => c.name).join(", ")}`,
          });
        }
        const result = model.switchTo(kind);
        if (typeof result === "string") return json(res, 409, { error: result });
        return json(res, 200, { provider: result });
      } catch (err) {
        log.error("provider switch failed", err);
        return json(res, 500, { error: "internal error" });
      }
    }

    // Which model answers which kind of work. The daemon is the one paying
    // for background digests, so this must be readable and changeable without
    // a restart, exactly like /provider.
    if (req.url?.startsWith("/tasks") && (req.method === "GET" || req.method === "POST")) {
      const model = runtime.model;
      if (!(model instanceof SwitchableModelProvider)) {
        return json(res, 409, { error: "model provider is fixed for this run" });
      }
      if (req.method === "GET") {
        return json(res, 200, { routes: model.taskRoutes(), kinds: TASK_ORDER });
      }
      try {
        const body = await readBody(req);
        const { task, route } = JSON.parse(body || "{}");
        const kind = String(task ?? "").trim().toLowerCase();
        if (!isTaskKind(kind)) {
          return json(res, 400, { error: `field 'task' must be one of: ${TASK_ORDER.join(", ")}` });
        }
        const raw = String(route ?? "").trim();
        const clearing = !raw || ["default", "none", "base"].includes(raw.toLowerCase());
        const result = model.setTaskRoute(kind, clearing ? null : raw);
        if (typeof result === "string") return json(res, 409, { error: result });
        return json(res, 200, { route: result });
      } catch (err) {
        log.error("task route change failed", err);
        return json(res, 500, { error: "internal error" });
      }
    }

    // The session index: what has been talked about, where, and by which
    // models. Read-only apart from asking for a recap.
    if (req.method === "GET" && req.url?.startsWith("/sessions")) {
      if (!runtime.sessions) return json(res, 503, { error: "no session index" });
      const url = new URL(req.url, "http://localhost");
      const id = url.pathname.slice("/sessions".length).replace(/^\//, "");
      if (!id) {
        const limit = Number(url.searchParams.get("limit")) || 20;
        const client = url.searchParams.get("client") ?? undefined;
        return json(res, 200, { sessions: await runtime.sessions.list(limit, { client }) });
      }
      const session = await runtime.sessions.resolve(decodeURIComponent(id));
      if (!session) return json(res, 404, { error: "no such session" });
      const messages = await runtime.memory.recent(session.roomId, 200);
      return json(res, 200, { session, messages });
    }

    if (req.method === "POST" && /^\/sessions\/[^/]+\/recap$/.test(req.url ?? "")) {
      if (!runtime.sessions) return json(res, 503, { error: "no session index" });
      const id = decodeURIComponent((req.url ?? "").split("/")[2]);
      const session = await runtime.sessions.resolve(id);
      if (!session) return json(res, 404, { error: "no such session" });
      const result = await buildRecap(runtime, session);
      if (result.summarised && result.model) {
        await runtime.sessions.setRecap(session.id, {
          text: result.text,
          at: Date.now(),
          model: result.model,
        });
      }
      return json(res, 200, { recap: result });
    }

    // Paid jobs from the Virtuals ACP marketplace, relayed by the local
    // lain-acp-bridge after the buyer funds them (see src/acp/tools.ts).
    if (req.method === "POST" && req.url === "/acp/tools") {
      try {
        const result = await handleAcpTool(runtime, req.headers.authorization, await readBody(req));
        return json(res, result.status, result.body);
      } catch (err) {
        log.error("acp tool failed", err);
        return json(res, 500, { error: "internal error" });
      }
    }

    if (req.method === "POST" && req.url === "/chat") {
      try {
        const body = await readBody(req);
        const { roomId, userId, text, task, metadata } = JSON.parse(body || "{}");
        if (typeof text !== "string" || !text.trim()) {
          return json(res, 400, { error: "field 'text' is required" });
        }
        // A caller that already knows what it is asking for (a digest job, a
        // translation) says so; anything else is classified from the text.
        const declared = typeof task === "string" ? task.trim().toLowerCase() : undefined;
        if (declared && !isTaskKind(declared)) {
          return json(res, 400, { error: `field 'task' must be one of: ${TASK_ORDER.join(", ")}` });
        }
        const trusted = trustedCaller(runtime, req.headers.authorization);
        const caller = trusted ? String(userId ?? "anon") : callerIdentity(userId);
        if (!caller) return json(res, 403, { error: "this userId is reserved for local and Telegram clients" });
        const result = await runtime.handleMessage({
          roomId: typeof roomId === "string" ? roomId : "http",
          userId: caller,
          text,
          task: declared && isTaskKind(declared) ? declared : undefined,
          ...(trusted && metadata && typeof metadata === "object" && !Array.isArray(metadata) ? { metadata } : {}),
        });
        return json(res, 200, result);
      } catch (err) {
        log.error("chat handler failed", err);
        return json(res, 500, { error: "internal error" });
      }
    }

    json(res, 404, { error: "not found" });
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      log.error(
        `port ${port} is already taken — another LainOS instance is probably running ` +
          `(try: systemctl --user status lainos.service). ` +
          `Stop it first, or set LAINOS_HTTP_PORT to a free port. ` +
          `Never run two instances of one agent: they would fight over memory files and the Telegram poller.`,
      );
      process.exit(1);
    }
    throw err;
  });
  server.listen(port, host, () => {
    log.info(`HTTP bridge for ${runtime.character.name} on http://${host}:${port}`);
  });
  return server;
}

/** A gateway holding LAINOS_HTTP_KEY (bearer) has already authenticated who it speaks for. */
function trustedCaller(runtime: IAgentRuntime, authorization: string | undefined): boolean {
  const key = String(runtime.getSetting("LAINOS_HTTP_KEY") ?? "");
  if (!key || !authorization?.startsWith("Bearer ")) return false;
  const given = Buffer.from(authorization.slice(7));
  const want = Buffer.from(key);
  return given.length === want.length && timingSafeEqual(given, want);
}

/**
 * The identity an HTTP caller may speak as, or null. "user" is the TUI on
 * this machine and isOperator() trusts it outright; "tg:…" is matched against
 * TELEGRAM_ALLOWED_USERS; "agent" is Lain herself. None of them arrive over
 * this bridge, so naming one here is an impersonation, not a mistake.
 */
export function callerIdentity(userId: unknown): string | null {
  if (typeof userId !== "string" || !userId.trim()) return "anon";
  const id = userId.trim();
  const lower = id.toLowerCase();
  if (lower === "user" || lower === "agent" || lower.startsWith("tg:")) return null;
  return id;
}

const LOOPBACK_NAMES = ["localhost", "127.0.0.1", "::1"];

function isLoopbackName(name: string): boolean {
  return LOOPBACK_NAMES.includes(name.toLowerCase()) || /^127\./.test(name);
}

/** `localhost:7777` -> `localhost`, `[::1]:7777` -> `::1`. */
function hostName(header: string): string {
  const h = header.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(1, h.indexOf("]"));
  return h.split(":")[0];
}

function csv(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(new Error("payload too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function json(res: import("node:http").ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}
