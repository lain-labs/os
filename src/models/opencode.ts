import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createLogger } from "../logger.js";
import {
  ModelTier,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from "../types.js";
import {
  parseToolReply,
  renderClosing,
  renderConversation,
  renderToolProtocol,
  resolveCliBin,
} from "./cli-protocol.js";

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
 * OPENCODE_CONFIG_CONTENT) switches every native tool off, and the scratch cwd
 * is never the repo — the agent cannot shell out, edit, or read project files.
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

/** Every native OpenCode tool, switched off — the chat fence. */
const CHAT_FENCE_CONFIG = JSON.stringify({
  tools: {
    bash: false,
    edit: false,
    glob: false,
    grep: false,
    patch: false,
    read: false,
    skill: false,
    task: false,
    todowrite: false,
    webfetch: false,
    websearch: false,
    write: false,
  },
});

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
    if (model) args.push("-m", model);
    args.push(...this.extraArgs);

    // Transient blips (dropped proxy, brief 5xx) get a quick in-house retry —
    // there is deliberately no other model to fall back to. Timeouts are not
    // retried: doubling a 4-minute wait helps nobody.
    const prompt = renderPrompt(request);
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) {
        log.warn(`opencode attempt ${attempt} failed — retrying`, lastErr);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
      try {
        const raw = await this.run(args, prompt);
        const { text, toolCalls } = parseToolReply(raw);
        return {
          text,
          toolCalls,
          model: model ? `opencode/${model}` : "opencode",
          provider: this.name,
        };
      } catch (err) {
        lastErr = err;
        if (err instanceof Error && err.message.includes("timed out")) break;
      }
    }
    throw lastErr;
  }

  /** Spawn one opencode run and collect the assistant's text parts. */
  private run(args: string[], prompt: string): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(this.bin, [...args, prompt], {
        cwd: this.cwd,
        env: this.env(),
        stdio: ["ignore", "pipe", "pipe"],
      });

      let buffer = "";
      let text = "";
      let stderrTail = "";
      // --format json is one event per line; a multi-part reply arrives as
      // several text events, so join the assistant's text parts as they stream.
      const consume = (chunk: Buffer) => {
        buffer += chunk.toString();
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line.trim()) text += extractTextPart(line);
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
        reject(new Error(`opencode spawn failed: ${err.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(killer);
        if (buffer.trim()) text += extractTextPart(buffer);
        if (timedOut) {
          return reject(new Error(`opencode timed out after ${Math.round(this.timeoutMs / 1000)}s`));
        }
        if (code !== 0) {
          const reason = stderrTail.trim().split("\n").slice(-3).join(" · ").slice(-300);
          return reject(new Error(`opencode exited ${code}${reason ? `: ${reason}` : ""}`));
        }
        resolvePromise(text.trim());
      });
    });
  }

  private env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    // Fence the coding agent down to a chat: no native tools on this run, only
    // the LainOS JSON reply protocol left in the prompt.
    env.OPENCODE_CONFIG_CONTENT = CHAT_FENCE_CONFIG;
    if (this.proxy) {
      env.HTTPS_PROXY = this.proxy;
      env.HTTP_PROXY = this.proxy;
      env.NO_PROXY = [env.NO_PROXY, "localhost,127.0.0.1"].filter(Boolean).join(",");
    }
    return env;
  }
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
      "for LainOS to execute the tool and send the result back.",
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

/** Pull the assistant text out of one NDJSON event line ("" for anything else). */
function extractTextPart(line: string): string {
  try {
    const event = JSON.parse(line) as { type?: string; part?: { type?: string; text?: unknown } };
    if (event.type === "text" && event.part?.type === "text" && typeof event.part.text === "string") {
      return event.part.text;
    }
  } catch {
    // Not JSON — ignore non-event noise.
  }
  return "";
}
