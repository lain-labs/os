import { createLogger } from "../../logger.js";
import { TaskKind } from "../../models/tasks.js";
import type { IAgentRuntime, ModelRequest, ModelResponse } from "../../types.js";

const log = createLogger("plugin:digest");

/**
 * Analysis may be routed to a cheap pool, and a cheap pool may be gone ("model
 * not found") or answer with nothing. The digest is read every morning, so
 * one failure there moves the same request onto the operator's own chat
 * provider instead of losing the day.
 */
export async function generateWithFallback(runtime: IAgentRuntime, req: ModelRequest): Promise<ModelResponse> {
  try {
    const res = await runtime.model.generate(req);
    if (res.text.trim()) return res;
    log.warn(`${req.task ?? "model"} route answered with nothing — retrying on the chat provider`);
  } catch (err) {
    if (req.task === TaskKind.CHAT) throw err;
    log.warn(`${req.task} route failed (${(err as Error).message.split("\n")[0].slice(0, 160)}) — retrying on the chat provider`);
  }
  return runtime.model.generate({ ...req, task: TaskKind.CHAT });
}


/**
 * The kind of work the digest is routed as. It is about the operator's money
 * and read every morning, so by default it is written by their own chat
 * provider, not a free pool (which on this host answers "model not found",
 * 504, or its reasoning instead of the text). LAINOS_DIGEST_TASK=analysis
 * puts it back on the analysis route, with the fallback above.
 */
export function digestTask(runtime: IAgentRuntime): TaskKind {
  const raw = runtime.getSetting("LAINOS_DIGEST_TASK")?.trim().toLowerCase();
  return raw && (Object.values(TaskKind) as string[]).includes(raw) ? (raw as TaskKind) : TaskKind.CHAT;
}
