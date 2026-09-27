/**
 * `/recap` — what a session was, in a form you can read after a week away.
 *
 * Two halves, and the split is the point. The **header** is counted, not
 * written: when it ran, how long, how many turns, which models answered them,
 * which kinds of work they were, which tools fired. Those are facts the store
 * already holds, so they cost nothing and cannot be hallucinated. The
 * **summary** underneath is the only part a model writes, and it is written by
 * the cheapest route the operator allows (task kind `memory`), because
 * summarising your own log is exactly the drudgery that must never cost Opus
 * rates. If that call fails, the header still stands and says so — a recap
 * that quietly invents the conversation would be worse than none.
 */
import { ModelTier, type IAgentRuntime, type Memory } from "../types.js";
import { TASKS, TaskKind, isTaskKind } from "../models/tasks.js";
import type { SessionRecord } from "./sessions.js";

export interface RecapResult {
  /** Header + summary, ready to print. */
  text: string;
  /** Model that wrote the summary half, if one did. */
  model?: string;
  /** False when only the counted half could be produced. */
  summarised: boolean;
}

function stamp(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function humanDuration(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  if (hours < 24) return rest ? `${hours}h ${rest}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function counted(map: Record<string, number>, top = 4): string {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([name, n]) => `${name} ×${n}`)
    .join(", ");
}

/** The half that is counted rather than written. Pure. */
export function recapHeader(session: SessionRecord): string {
  const lines: string[] = [];
  lines.push(
    `${session.id} · ${session.client}${session.title ? ` · «${session.title}»` : ""}`,
  );
  lines.push(
    `started ${stamp(session.createdAt)} · lasted ${humanDuration(
      session.updatedAt - session.createdAt,
    )} · ${session.turns} turn${session.turns === 1 ? "" : "s"}`,
  );
  const models = counted(session.models);
  if (models) lines.push(`models: ${models}`);
  const tasks = Object.entries(session.tasks)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => `${isTaskKind(kind) ? `${TASKS[kind].emoji} ${kind}` : kind} ×${n}`)
    .join(", ");
  if (tasks) lines.push(`tasks: ${tasks}`);
  const tools = counted(session.tools, 6);
  if (tools) lines.push(`tools: ${tools}`);
  return lines.join("\n");
}

/** The transcript as the summariser sees it: newest kept, each line clipped. */
export function transcriptFor(memories: Memory[], maxTurns = 60, maxChars = 400): string {
  return memories
    .filter((m) => m.role !== "system")
    .slice(-maxTurns)
    .map((m) => {
      const who = m.role === "agent" ? "lain" : "operator";
      const body = m.content.replace(/\s+/g, " ").trim();
      return `${who}: ${body.length > maxChars ? `${body.slice(0, maxChars - 1)}…` : body}`;
    })
    .join("\n");
}

const SYSTEM =
  "You summarise a chat log for the person who was in it. Answer in the language the log is " +
  "mostly written in. Give 3-6 short bullets: what was asked, what was actually done or " +
  "decided, and what is still open. Only what the log shows — never guess at outcomes. " +
  "No preamble, no closing line.";

/**
 * Build a recap for one session. Never throws: a failed summary degrades to
 * the counted header with one honest line saying the model could not be
 * reached.
 */
export async function buildRecap(
  runtime: IAgentRuntime,
  session: SessionRecord,
): Promise<RecapResult> {
  const header = recapHeader(session);
  const memories = await runtime.memory.recent(session.roomId, 200);
  const transcript = transcriptFor(memories);
  if (!transcript.trim()) {
    return { text: `${header}\n\n(nothing was said in this session yet)`, summarised: false };
  }

  try {
    const res = await runtime.model.generate({
      tier: TASKS[TaskKind.MEMORY].tier ?? ModelTier.SMALL,
      task: TaskKind.MEMORY,
      system: SYSTEM,
      messages: [{ role: "user", content: `Log of session ${session.id}:\n\n${transcript}` }],
      maxTokens: 600,
    });
    const body = res.text.trim();
    if (!body) {
      return {
        text: `${header}\n\n(the summariser returned nothing — the counts above are all that is certain)`,
        summarised: false,
      };
    }
    return { text: `${header}\n\n${body}`, model: res.model, summarised: true };
  } catch (err) {
    return {
      text: `${header}\n\n(could not reach the summarising model: ${(err as Error).message})`,
      summarised: false,
    };
  }
}
