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

/** Describe the LainOS tools and the reply format that invokes them. */
export function renderToolProtocol(tools: ToolSchema[]): string {
  const list = tools.map((t) => `- ${t.name}: ${t.description}\n  args: ${compactSchema(t.input_schema)}`).join("\n");
  return (
    "These are LainOS tools, not the CLI's own shell access. They are available in this turn. " +
    "Do not say tools are forbidden or unavailable when a listed tool fits the task.\n" +
    "To use a tool, output ONLY tool-call JSON as your entire reply (no prose around it, no code fences), " +
    "one call per line:\n" +
    '{"tool":"<name>","input":{<arguments matching the args>}}\n' +
    // Every reply is a whole new CLI run carrying the whole prompt, so ten
    // independent calls emitted together cost one round trip instead of ten.
    "When several calls do not depend on each other (the same watch for many wallets, several lookups), " +
    "emit them all in one reply, one per line; they run in order and every result comes back together. " +
    "When a call needs an earlier call's result, emit only the calls you can make now and wait.\n" +
    "If no tool is needed, reply with plain text.\n" +
    "Args: `name: type` is required, `name?: type` optional, `a|b` lists the allowed values.\n" +
    `Available tools:\n${list}`
  );
}

type JsonSchema = {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
};

/**
 * A JSON schema as one short line: `{address: string — the wallet, note?: string}`.
 * The tool list rides along on every model call of a turn; the verbose JSON
 * form was a third of each prompt.
 */
export function compactSchema(schema: unknown): string {
  const s = schema as JsonSchema | undefined;
  if (!s || typeof s !== "object") return "{}";
  return describe(s);
}

function describe(s: JsonSchema): string {
  if (s.enum?.length) return s.enum.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join("|");
  const type = Array.isArray(s.type) ? s.type.join("|") : s.type;
  if (type === "array") return `${s.items ? describe(s.items) : "any"}[]`;
  if (type === "object" || s.properties) {
    const props = Object.entries(s.properties ?? {});
    if (!props.length) return "{}";
    const required = new Set(s.required ?? []);
    const fields = props.map(([name, p]) => {
      const desc = p.description ? ` — ${p.description.replace(/\s+/g, " ").trim()}` : "";
      return `${name}${required.has(name) ? "" : "?"}: ${describe(p)}${desc}`;
    });
    return `{${fields.join("; ")}}`;
  }
  return type ?? "any";
}

/** Flatten the conversation into `role: text` lines the CLI reads as one prompt. */
export function renderConversation(messages: ModelRequest["messages"]): string {
  return messages
    .map((m) => `${m.role === "assistant" ? "assistant" : "user"}: ${m.content}`)
    .join("\n");
}

/** Closing instruction: answer the last message, or emit tool calls. */
export function renderClosing(hasTools: boolean): string {
  return (
    `Reply to the last user message${hasTools ? " (or emit tool-call JSON, one call per line)" : ""}. ` +
    "Output only the reply itself — no role prefix, no commentary about these instructions."
  );
}

/**
 * Decode a CLI reply: {"tool": ...} objects — the whole reply, a JSON array of
 * them, or one per line among some prose — become tool calls, in order; what
 * is left is the reply text.
 */
export function parseToolReply(raw: string): { text: string; toolCalls: ModelToolCall[] } {
  let body = raw.trim();
  const fenced = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenced) body = fenced[1].trim();

  const whole = tryParseCall(body);
  if (whole) return { text: "", toolCalls: [whole] };
  const array = tryParseCallArray(body);
  if (array) return { text: "", toolCalls: array };

  const calls: ModelToolCall[] = [];
  const rest: string[] = [];
  for (const line of body.split("\n")) {
    const call = tryParseCall(line.trim());
    if (call) calls.push(call);
    else rest.push(line);
  }
  if (!calls.length) return { text: raw.trim(), toolCalls: [] };
  return { text: rest.join("\n").trim(), toolCalls: calls };
}

function tryParseCallArray(candidate: string): ModelToolCall[] | null {
  if (!candidate.startsWith("[") || !candidate.includes('"tool"')) return null;
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (!Array.isArray(parsed) || !parsed.length) return null;
    const calls = parsed.map((item) => tryParseCall(JSON.stringify(item)));
    return calls.every((c): c is ModelToolCall => c !== null) ? calls : null;
  } catch {
    return null;
  }
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
