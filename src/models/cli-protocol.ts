import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ModelRequest, ModelToolCall, ToolSchema } from "../types.js";

/**
 * Shared glue for the CLI-backed model providers (codex, claude, opencode).
 *
 * Both drive a coding-agent CLI that is an agent, not a chat API: there is no
 * tool-use block in the wire format, so tool calling is emulated with a
 * JSON-in-the-reply protocol ({"tool": ..., "input": ...}) that
 * {@link parseToolReply} decodes back into ModelResponse.toolCalls.
 */

/** Describe the LainOS tools and the reply format that invokes one. */
export function renderToolProtocol(tools: ToolSchema[]): string {
  const list = tools
    .map((t) => `- ${t.name}: ${t.description}\n  input schema: ${JSON.stringify(t.input_schema)}`)
    .join("\n");
  return (
    "These are LainOS tools, not the CLI's own shell access. They are available in this turn. " +
    "Do not say tools are forbidden or unavailable when a listed tool fits the task.\n" +
    "To use a tool, output ONLY this JSON as your entire reply (no prose around it, no code fences):\n" +
    '{"tool":"<name>","input":{<arguments matching the schema>}}\n' +
    "One tool call per reply; you will receive the result and can then answer or call another.\n" +
    "If no tool is needed, reply with plain text.\n" +
    `Available tools:\n${list}`
  );
}

/** Flatten the conversation into `role: text` lines the CLI reads as one prompt. */
export function renderConversation(messages: ModelRequest["messages"]): string {
  return messages
    .map((m) => `${m.role === "assistant" ? "assistant" : "user"}: ${m.content}`)
    .join("\n");
}

/** Closing instruction: answer the last message, or emit one tool call. */
export function renderClosing(hasTools: boolean): string {
  return (
    `Reply to the last user message${hasTools ? " (or emit exactly one tool-call JSON)" : ""}. ` +
    "Output only the reply itself — no role prefix, no commentary about these instructions."
  );
}

/**
 * Decode a CLI reply: a bare {"tool": ...} object (possibly fenced, possibly
 * after some prose on its own line) becomes a tool call; anything else is the
 * reply text.
 */
export function parseToolReply(raw: string): { text: string; toolCalls: ModelToolCall[] } {
  let body = raw.trim();
  const fenced = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenced) body = fenced[1].trim();

  const whole = tryParseCall(body);
  if (whole) return { text: "", toolCalls: [whole] };

  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const call = tryParseCall(lines[i].trim());
    if (call) {
      const rest = [...lines.slice(0, i), ...lines.slice(i + 1)].join("\n").trim();
      return { text: rest, toolCalls: [call] };
    }
  }
  return { text: raw.trim(), toolCalls: [] };
}

function tryParseCall(candidate: string): ModelToolCall | null {
  if (!candidate.startsWith("{") || !candidate.includes('"tool"')) return null;
  try {
    const parsed = JSON.parse(candidate) as { tool?: unknown; input?: unknown };
    if (typeof parsed.tool !== "string" || !parsed.tool) return null;
    const input =
      typeof parsed.input === "object" && parsed.input !== null
        ? (parsed.input as Record<string, unknown>)
        : {};
    return { name: parsed.tool, input };
  } catch {
    return null;
  }
}

/** Locate a CLI binary: explicit override, PATH, then ~/.local/bin. */
export function resolveCliBin(name: string, explicit?: string): string | null {
  if (explicit) return explicit;
  const home = process.env.HOME ?? "";
  // ~/.opencode/bin is where the opencode installer drops the binary; it is a
  // no-op candidate for codex/claude but lets opencode autodetect everywhere.
  for (const bin of [name, join(home, ".local/bin", name), join(home, ".opencode/bin", name)]) {
    if (bin.includes("/") ? existsSync(bin) : onPath(bin)) return bin;
  }
  return null;
}

function onPath(bin: string): boolean {
  const paths = (process.env.PATH ?? "").split(":");
  return paths.some((p) => p && existsSync(join(p, bin)));
}
