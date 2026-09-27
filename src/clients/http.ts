import { createServer, type Server } from "node:http";
import { createLogger } from "../logger.js";
import {
  CHAT_PROVIDER_CHOICES,
  resolveChatProviderKind,
  SwitchableModelProvider,
} from "../models/routing.js";
import type { ForgeService } from "../plugins/forge/index.js";
import type { ScoutService } from "../plugins/scout/index.js";
import type { SentinelService } from "../plugins/sentinel/index.js";
import { buildRecap } from "../memory/recap.js";
import { TASK_ORDER, isTaskKind } from "../models/tasks.js";
import type { IAgentRuntime } from "../types.js";

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
 */
export function createHttpServer(runtime: IAgentRuntime, opts: HttpOptions = {}): Server {
  const host = opts.host ?? process.env.LAINOS_HTTP_HOST ?? "127.0.0.1";
  const port = Number(opts.port ?? process.env.LAINOS_HTTP_PORT ?? 7777);

  const server = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      return json(res, 200, { ok: true, agent: runtime.character.name });
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

    if (req.method === "POST" && req.url === "/chat") {
      try {
        const body = await readBody(req);
        const { roomId, userId, text, task } = JSON.parse(body || "{}");
        if (typeof text !== "string" || !text.trim()) {
          return json(res, 400, { error: "field 'text' is required" });
        }
        // A caller that already knows what it is asking for (a digest job, a
        // translation) says so; anything else is classified from the text.
        const declared = typeof task === "string" ? task.trim().toLowerCase() : undefined;
        if (declared && !isTaskKind(declared)) {
          return json(res, 400, { error: `field 'task' must be one of: ${TASK_ORDER.join(", ")}` });
        }
        const result = await runtime.handleMessage({
          roomId: typeof roomId === "string" ? roomId : "http",
          userId: typeof userId === "string" ? userId : "anon",
          text,
          task: declared && isTaskKind(declared) ? declared : undefined,
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

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
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
