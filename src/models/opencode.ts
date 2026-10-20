import { execFile, spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createLogger } from "../logger.js";
import {
  ModelTier,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelToolCall,
} from "../types.js";
import {
  parseToolReply,
  renderClosing,
  renderConversation,
  renderToolProtocol,
  resolveCliBin,
} from "./cli-protocol.js";
import { splitReasoning } from "./openrouter.js";
import { parseUsageLimit } from "./limits.js";

export { parseToolReply } from "./cli-protocol.js";

const log = createLogger("model:opencode");

/**
 * OpenCode CLI backend: each completion is one non-interactive `opencode run`
 * run using the machine's own OpenCode setup — providers, models and auth all
 * live in OpenCode's config, so there is no LainOS API key to manage.
 *
 * The CLI is a coding agent, not a chat API, so the ModelProvider contract is
 * emulated exactly as with codex/claude: system + conversation are serialised
 * into a single prompt, and tool calling uses the JSON-in-the-reply protocol
 * from cli-protocol.ts, which {@link parseToolReply} decodes back into
 * ModelResponse.toolCalls.
 *
 * The run is fenced down to a chat: an inline OpenCode config (env var
 * OPENCODE_CONFIG_CONTENT) denies every native tool but `read`, which is held
 * to the empty scratch cwd — the agent cannot shell out, edit, fetch, or read
 * project files. On OpenCode 2+, `run` talks to a shared background service by
 * default; the run is made `--standalone` so the fence (an env var of this
 * process) actually reaches the server and no service outlives the run.
 */
export interface OpencodeProviderOptions {
  /** Path to the opencode binary (see {@link resolveOpenCodeBin}). */
  bin: string;
  /** Model per tier; unset tiers use OpenCode's configured default. */
  models?: Partial<Record<ModelTier, string>>;
  /** Hard timeout for one completion, ms. */
  timeoutMs?: number;
  /** Extra attempts after a failed run (transient CLI/network blips). */
  retries?: number;
  /** Extra args appended to `opencode run` (e.g. --agent plan). */
  extraArgs?: string[];
  /** Scratch working directory the fenced agent is pointed at. */
  cwd: string;
  /** Optional HTTP(S) proxy for the CLI's API traffic. */
  proxy?: string;
}

const DEFAULT_TIMEOUT_MS = 240_000;
const DEFAULT_RETRIES = 1;
const RETRY_DELAY_MS = 2_000;
const OUTPUT_TAIL_CHARS = 4_000;

/**
 * The chat fence for a run in `cwd`. Every native tool is denied by wildcard —
 * OpenCode 2 added tools (execute, question, worktree_create, …) that a list
 * of names would miss — except `read`: OpenCode's free tier refuses a request
 * whose tool list lacks it (403, "can only be used from within OpenCode"), so
 * it stays listed but may only open files in the scratch cwd. external_directory
 * alone would not hold it there — OpenCode lets an agent read its whole git
 * worktree.
 */
function chatFenceConfig(cwd: string): string {
  return JSON.stringify({
    permission: {
      "*": "deny",
      external_directory: "deny",
      read: { "*": "deny", [`${cwd}/*`]: "allow" },
    },
  });
}

/**
 * Per binary: the `opencode run` flags this version knows — --standalone and
 * --thinking (OpenCode 2+; without --thinking the reasoning parts are not
 * emitted at all).
 */
const runFlagSupport = new Map<string, Promise<{ standalone: boolean; thinking: boolean }>>();

function runFlags(bin: string): Promise<{ standalone: boolean; thinking: boolean }> {
  let known = runFlagSupport.get(bin);
  if (!known) {
    known = new Promise((resolveFlags) => {
      execFile(bin, ["run", "--help"], { timeout: 15_000 }, (_err, stdout, stderr) => {
        const help = `${stdout}${stderr}`;
        resolveFlags({ standalone: help.includes("--standalone"), thinking: help.includes("--thinking") });
      });
    });
    runFlagSupport.set(bin, known);
  }
  return known;
}

/** A failed run; `retryable` is false when OpenCode says another try won't help. */
class OpencodeRunError extends Error {
  constructor(message: string, readonly retryable = true) {
    super(message);
  }
}

export class OpencodeModelProvider implements ModelProvider {
  readonly name = "opencode";
  private bin: string;
  private models: Partial<Record<ModelTier, string>>;
  private timeoutMs: number;
  private retries: number;
  private extraArgs: string[];
  private cwd: string;
  private proxy?: string;

  constructor(opts: OpencodeProviderOptions) {
    this.bin = opts.bin;
    this.models = opts.models ?? {};
    this.timeoutMs = Math.max(10_000, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.retries = Math.max(0, opts.retries ?? DEFAULT_RETRIES);
    this.extraArgs = opts.extraArgs ?? [];
    // Absolute: opencode resolves the project against its own cwd, so a
    // relative path (./data/opencode) would land somewhere unexpected.
    this.cwd = resolve(opts.cwd);
    this.proxy = opts.proxy;
    if (opts.proxy) log.info(`routing opencode traffic via proxy ${opts.proxy}`);
  }

  modelFor(tier: ModelTier): string {
    return this.models[tier] ?? "opencode";
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const model = this.models[request.tier];
    log.debug(`generate via opencode run${model ? ` (-m ${model})` : ""}`);

    await mkdir(this.cwd, { recursive: true });
    const args = ["run", "--format", "json"];
    const flags = await runFlags(this.bin);
    if (flags.standalone) args.push("--standalone");
    if (flags.thinking) args.push("--thinking");
    if (model) args.push("-m", model);
    args.push(...this.extraArgs);

    // Transient blips (dropped proxy, brief 5xx) get a quick in-house retry —
    // there is deliberately no other model to fall back to. Timeouts are not
    // retried (doubling a 4-minute wait helps nobody), nor are errors OpenCode
    // itself marks non-retryable, such as a 403.
    const prompt = renderPrompt(request);
    const lainTools = new Set((request.tools ?? []).map((t) => t.name));
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) {
        log.warn(`opencode attempt ${attempt} failed — retrying`, lastErr);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
      try {
        const raw = await this.run(args, prompt, lainTools);
        if (raw.toolCalls.length) {
          log.info(`opencode: ${raw.toolCalls.map((c) => c.name).join(", ")} asked for through OpenCode's own tool calling — run as LainOS tools`);
          return {
            text: "",
            toolCalls: raw.toolCalls,
            model: model ? `opencode/${model}` : "opencode",
            provider: this.name,
            ...(raw.reasoning ? { reasoning: raw.reasoning } : {}),
          };
        }
        // Some models inline their thought in the text even when OpenCode
        // also sends reasoning parts; split it off before any tool-call
        // parsing, so a JSON sketch inside a thought is never run.
        const inline = splitReasoning(raw.text);
        const { text, toolCalls } = parseToolReply(inline.text);
        const reasoning = [raw.reasoning, inline.reasoning].filter(Boolean).join("\n\n");
        return {
          text,
          toolCalls,
          model: model ? `opencode/${model}` : "opencode",
          provider: this.name,
          ...(reasoning ? { reasoning } : {}),
        };
      } catch (err) {
        lastErr = err;
        if (err instanceof OpencodeRunError && !err.retryable) break;
        // Out of quota stays out of quota two seconds later.
        if (err instanceof Error && parseUsageLimit(err.message)) break;
      }
    }
    throw lastErr;
  }

  /**
   * Spawn one opencode run and collect the assistant's text and reasoning parts.
   *
   * With a long prompt some models stop writing the JSON protocol and call a
   * LainOS tool through OpenCode's own tool calling instead. OpenCode has no
   * such tool and answers "No tool named … is currently available"; left to
   * itself the model retries every tool it can name, then reports that none
   * work. So a call to a LainOS tool is taken from the event stream as it
   * fails: the step it came in is let finish (a step may hold several calls),
   * the run is stopped, and the calls go back to LainOS like any other.
   */
  private run(args: string[], prompt: string, lainTools: Set<string> = new Set()): Promise<{ text: string; reasoning: string; toolCalls: ModelToolCall[] }> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(this.bin, [...args, prompt], {
        cwd: this.cwd,
        env: this.env(),
        stdio: ["ignore", "pipe", "pipe"],
      });

      let buffer = "";
      let text = "";
      let reasoning = "";
      let stderrTail = "";
      // API failures arrive on stdout as error events, not on stderr.
      let failure: { message: string; retryable: boolean } | undefined;
      const caught: ModelToolCall[] = [];
      const seen = new Set<string>();
      let stopped = false;
      // --format json is one event per line; a multi-part reply arrives as
      // several text events, so join the assistant's text parts as they stream.
      const take = (line: string) => {
        if (!line.trim()) return;
        const event = readEvent(line);
        if (event.text) text += event.text;
        if (event.reasoning) reasoning += `${reasoning ? "\n\n" : ""}${event.reasoning.trim()}`;
        if (event.error) failure = event.error;
        if (event.toolUse && lainTools.has(event.toolUse.name) && !seen.has(event.toolUse.key)) {
          seen.add(event.toolUse.key);
          caught.push({ name: event.toolUse.name, input: event.toolUse.input });
        }
        if (event.stepEnd && caught.length && !stopped) {
          stopped = true;
          child.kill("SIGTERM");
        }
      };
      const consume = (chunk: Buffer) => {
        buffer += chunk.toString();
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          take(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
        }
      };
      child.stdout?.on("data", consume);
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-OUTPUT_TAIL_CHARS);
      });

      let timedOut = false;
      const killer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, this.timeoutMs);
      killer.unref?.();

      child.on("error", (err) => {
        clearTimeout(killer);
        reject(new OpencodeRunError(`opencode spawn failed: ${err.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(killer);
        take(buffer);
        if (caught.length) return resolvePromise({ text: "", reasoning, toolCalls: caught });
        if (timedOut) {
          return reject(
            new OpencodeRunError(`opencode timed out after ${Math.round(this.timeoutMs / 1000)}s`, false),
          );
        }
        if (code !== 0 || (failure && !text.trim())) {
          const reason =
            failure?.message.slice(0, 300) ??
            stderrTail.trim().split("\n").slice(-3).join(" · ").slice(-300);
          return reject(
            new OpencodeRunError(
              `opencode exited ${code}${reason ? `: ${reason}` : ""}`,
              failure?.retryable ?? true,
            ),
          );
        }
        resolvePromise({ text: text.trim(), reasoning, toolCalls: [] });
      });
    });
  }

  private env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    // Fence the coding agent down to a chat: no native tools on this run, only
    // the LainOS JSON reply protocol left in the prompt.
    env.OPENCODE_CONFIG_CONTENT = chatFenceConfig(this.cwd);
    if (this.proxy) {
      env.HTTPS_PROXY = this.proxy;
      env.HTTP_PROXY = this.proxy;
      env.NO_PROXY = [env.NO_PROXY, "localhost,127.0.0.1"].filter(Boolean).join(",");
    }
    return env;
  }
}

/**
 * Every `provider/model` this machine's OpenCode can run — what `/model` offers
 * for the opencode agent. Same environment as a run, so a provider whose key
 * only LainOS's env carries is listed exactly when a run could use it; and
 * --standalone on OpenCode 2, so listing never starts the shared service.
 */
export async function listOpencodeModels(bin: string): Promise<string[]> {
  const args = ["models"];
  if ((await runFlags(bin)).standalone) args.push("--standalone");
  return new Promise((resolveList, reject) => {
    execFile(bin, args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error(`opencode models failed: ${err.message}`));
      resolveList(
        stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => /^[\w.-]+\/\S+$/.test(line)),
      );
    });
  });
}

interface CatalogueModel {
  cost?: { input?: number; output?: number };
  modalities?: { output?: string[] };
}

/**
 * Which of `ids` are free writers, by the models.dev catalogue OpenCode
 * caches (~/.cache/opencode/models.json): zero per token in and out, text out
 * and nothing else — the rule OpenRouter's free pool follows (Lyria is $0 per
 * token and makes music). Without the cache only a name that says so
 * (`…-free`) counts — `big-pickle` is free and does not say so.
 */
export async function opencodeFreeModels(ids: string[]): Promise<Set<string>> {
  let catalogue: Record<string, { models?: Record<string, CatalogueModel> }> = {};
  try {
    const cache = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
    catalogue = JSON.parse(await readFile(join(cache, "opencode", "models.json"), "utf8"));
  } catch {
    // No catalogue yet: names alone.
  }
  const free = new Set<string>();
  for (const id of ids) {
    const slash = id.indexOf("/");
    const entry = catalogue[id.slice(0, slash)]?.models?.[id.slice(slash + 1)];
    const cost = entry?.cost;
    const priced = cost?.input !== undefined && cost.output !== undefined;
    const writer = !entry?.modalities?.output?.some((m) => m !== "text");
    const zero = priced ? cost.input === 0 && cost.output === 0 && writer : /[-:]free$/.test(id);
    if (zero) free.add(id);
  }
  return free;
}

/** Locate the opencode binary: explicit override, PATH, then ~/.local/bin. */
export function resolveOpenCodeBin(explicit?: string): string | null {
  return resolveCliBin("opencode", explicit);
}

/**
 * Serialise a ModelRequest into the single prompt one opencode run receives.
 * The persona travels as plain context; native tools are already disabled by
 * the fence, so the rest is the LainOS tool protocol and the conversation.
 */
export function renderPrompt(request: ModelRequest): string {
  const lines: string[] = [
    "This response is generated through the OpenCode CLI model provider — you are not " +
      "the forge worker for this reply. Do not use OpenCode's own shell, file " +
      "access, or workspace exploration. If LainOS tools are listed below, they " +
      "are allowed: request them by emitting the exact tool-call JSON, then wait " +
      "for LainOS to execute the tool and send the result back. They are not " +
      "OpenCode tools — OpenCode's own tool calling cannot reach them and answers " +
      '"No tool named …"; write the JSON as the text of your reply.',
    "",
    "# Persona and context",
    request.system,
  ];
  if (request.tools?.length) {
    lines.push("", "# Tools", renderToolProtocol(request.tools));
  }
  lines.push("", "# Conversation", renderConversation(request.messages));
  lines.push("", renderClosing(Boolean(request.tools?.length)));
  return lines.join("\n");
}

/** Pull the assistant text, its reasoning, or an error event's message out of one NDJSON line. */
function readEvent(line: string): {
  text?: string;
  reasoning?: string;
  error?: { message: string; retryable: boolean };
  /** A tool the model called through OpenCode's own tool calling; key tells one call from the same call's updates. */
  toolUse?: { name: string; input: Record<string, unknown>; key: string };
  stepEnd?: boolean;
} {
  try {
    const event = JSON.parse(line) as {
      type?: string;
      part?: {
        id?: unknown;
        callID?: unknown;
        type?: string;
        text?: unknown;
        tool?: unknown;
        state?: { input?: unknown; metadata?: { rawInput?: unknown } };
      };
      error?: {
        name?: string;
        type?: string;
        message?: unknown;
        status?: unknown;
        data?: { message?: unknown; isRetryable?: unknown };
      };
    };
    if (event.type === "text" && event.part?.type === "text" && typeof event.part.text === "string") {
      return { text: event.part.text };
    }
    if (event.type === "reasoning" && typeof event.part?.text === "string") {
      return { reasoning: event.part.text };
    }
    if (event.type === "tool_use" && typeof event.part?.tool === "string") {
      const p = event.part;
      let input = p.state?.input;
      if ((typeof input !== "object" || input === null) && typeof p.state?.metadata?.rawInput === "string") {
        try {
          input = JSON.parse(p.state.metadata.rawInput);
        } catch {
          input = {};
        }
      }
      const args = typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
      const key = String(p.callID ?? p.id ?? `${p.tool}:${JSON.stringify(args)}`);
      return { toolUse: { name: p.tool as string, input: args, key } };
    }
    if (event.type === "step_finish") return { stepEnd: true };
    if (event.type === "error") {
      // OpenCode 1 nests the message under data (with isRetryable); OpenCode 2
      // puts message and HTTP status on the error itself.
      const err = event.error;
      const message =
        typeof err?.data?.message === "string"
          ? err.data.message
          : typeof err?.message === "string"
            ? err.message
            : (err?.name ?? err?.type ?? "unknown error");
      const status = typeof err?.status === "number" ? err.status : undefined;
      const retryable =
        typeof err?.data?.isRetryable === "boolean"
          ? err.data.isRetryable
          : status === undefined || status === 429 || status >= 500;
      return { error: { message, retryable } };
    }
  } catch {
    // Not JSON — ignore non-event noise.
  }
  return {};
}
