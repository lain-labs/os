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

const log = createLogger("model:claude");

/**
 * Claude Code CLI backend: each completion is one `claude --print` run billed
 * to the machine's Claude subscription (`claude` login) — no API key. The
 * key-based sibling is {@link AnthropicModelProvider} in anthropic.ts.
 *
 * The CLI is a coding agent, so the run is fenced down to a chat: `--tools ""`
 * removes every built-in tool, `--safe-mode` drops CLAUDE.md/skills/hooks/MCP,
 * `--system-prompt` replaces the Claude Code persona with Lain's, and the
 * scratch cwd is never the repo. LainOS tools travel over the JSON-in-the-reply
 * protocol in cli-protocol.ts, exactly as with codex and opencode.
 */
export interface ClaudeCliProviderOptions {
  /** Path to the claude binary (see {@link resolveClaudeBin}). */
  bin: string;
  /** Model per tier; aliases like "opus" track the latest snapshot. */
  models?: Partial<Record<ModelTier, string>>;
  /** Hard timeout for one completion, ms. */
  timeoutMs?: number;
  /** Extra attempts after a failed run (transient CLI/network blips). */
  retries?: number;
  /** Extra args appended to the `claude` invocation. */
  extraArgs?: string[];
  /** Scratch working directory the fenced agent is pointed at. */
  cwd: string;
  /** Optional HTTP(S) proxy for the CLI's API traffic. */
  proxy?: string;
}

/** Model aliases per tier — an alias always resolves to the latest snapshot. */
export const DEFAULT_MODELS: Record<ModelTier, string> = {
  [ModelTier.SMALL]: "haiku",
  [ModelTier.MEDIUM]: "sonnet",
  [ModelTier.LARGE]: "opus",
};

const DEFAULT_TIMEOUT_MS = 240_000;
const DEFAULT_RETRIES = 1;
const RETRY_DELAY_MS = 2_000;
const OUTPUT_TAIL_CHARS = 4_000;

/** One `claude --print --output-format json` result envelope (fields we read). */
interface ClaudeResult {
  result?: string;
  is_error?: boolean;
  subtype?: string;
  total_cost_usd?: number;
  /** Keyed by the snapshot ids the run touched, e.g. "claude-opus-5". */
  modelUsage?: Record<string, unknown>;
}

export class ClaudeCliModelProvider implements ModelProvider {
  readonly name = "claude";
  private bin: string;
  private models: Record<ModelTier, string>;
  private timeoutMs: number;
  private retries: number;
  private extraArgs: string[];
  private cwd: string;
  private proxy?: string;

  constructor(opts: ClaudeCliProviderOptions) {
    this.bin = opts.bin;
    this.models = { ...DEFAULT_MODELS, ...opts.models };
    this.timeoutMs = Math.max(10_000, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.retries = Math.max(0, opts.retries ?? DEFAULT_RETRIES);
    this.extraArgs = opts.extraArgs ?? [];
    this.cwd = resolve(opts.cwd);
    this.proxy = opts.proxy;
    if (opts.proxy) log.info(`routing claude traffic via proxy ${opts.proxy}`);
  }

  modelFor(tier: ModelTier): string {
    return this.models[tier];
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const model = this.modelFor(request.tier);
    log.debug(`generate via claude --print (--model ${model})`);

    await mkdir(this.cwd, { recursive: true });
    const args = [
      "--print",
      "--output-format",
      "json",
      // Fence the coding agent down to a chat model.
      "--tools",
      "",
      "--safe-mode",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--no-session-persistence",
      "--model",
      model,
      "--system-prompt",
      request.system,
      ...this.extraArgs,
    ];

    // Transient blips (dropped proxy, brief 5xx) get a quick in-house retry.
    // Timeouts are not retried: doubling a 4-minute wait helps nobody.
    const prompt = renderPrompt(request);
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) {
        log.warn(`claude attempt ${attempt} failed — retrying`, lastErr);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
      try {
        const envelope = await this.run(args, prompt);
        const { text, toolCalls } = parseToolReply(envelope.result ?? "");
        if (typeof envelope.total_cost_usd === "number") {
          log.debug(`claude run cost $${envelope.total_cost_usd.toFixed(4)}`);
        }
        // The envelope names the snapshots an alias resolved to — surface that
        // instead of echoing "opus" back.
        return {
          text,
          toolCalls,
          model: `claude/${observedModel(envelope, model) ?? model}`,
          provider: this.name,
        };
      } catch (err) {
        lastErr = err;
        if (err instanceof Error && err.message.includes("timed out")) break;
      }
    }
    throw lastErr;
  }

  /** Spawn one claude run, feed the prompt on stdin, return the JSON envelope. */
  private run(args: string[], prompt: string): Promise<ClaudeResult> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(this.bin, args, {
        cwd: this.cwd,
        env: this.env(),
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderrTail = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
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
        reject(new Error(`claude spawn failed: ${err.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(killer);
        if (timedOut) {
          return reject(new Error(`claude timed out after ${Math.round(this.timeoutMs / 1000)}s`));
        }
        if (code !== 0) {
          const reason = stderrTail.trim().split("\n").slice(-3).join(" · ").slice(-300);
          return reject(new Error(`claude exited ${code}${reason ? `: ${reason}` : ""}`));
        }
        let envelope: ClaudeResult;
        try {
          envelope = JSON.parse(stdout.trim()) as ClaudeResult;
        } catch {
          return reject(new Error(`claude returned no JSON envelope: ${stdout.trim().slice(-300)}`));
        }
        if (envelope.is_error) {
          const detail = envelope.subtype ?? envelope.result ?? "unknown error";
          return reject(new Error(`claude reported an error: ${String(detail).slice(0, 300)}`));
        }
        resolvePromise(envelope);
      });

      child.stdin?.on("error", () => {}); // a dead child must not crash the daemon
      child.stdin?.end(prompt);
    });
  }

  private env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    // An empty ANTHROPIC_API_KEY (a blank line in .env) makes the CLI pick the
    // API path with no credential instead of the subscription login.
    if (!env.ANTHROPIC_API_KEY?.trim()) delete env.ANTHROPIC_API_KEY;
    if (this.proxy) {
      env.HTTPS_PROXY = this.proxy;
      env.HTTP_PROXY = this.proxy;
      env.NO_PROXY = [env.NO_PROXY, "localhost,127.0.0.1"].filter(Boolean).join(",");
    }
    return env;
  }
}

/** Locate the claude binary: explicit override, PATH, then ~/.local/bin. */
export function resolveClaudeBin(explicit?: string): string | null {
  return resolveCliBin("claude", explicit);
}

/**
 * Serialise a ModelRequest into the stdin prompt of one claude run. The
 * persona travels separately via --system-prompt, so only the tool protocol
 * and the conversation go here.
 */
export function renderPrompt(request: ModelRequest): string {
  const lines: string[] = [];
  if (request.tools?.length) {
    lines.push("# Tools", renderToolProtocol(request.tools), "");
  }
  lines.push("# Conversation", renderConversation(request.messages), "");
  lines.push(renderClosing(Boolean(request.tools?.length)));
  return lines.join("\n");
}

/**
 * Snapshot behind the alias we asked for. The CLI also bills small background
 * calls to a cheap model, so the busiest entry in `modelUsage` is not the one
 * that wrote the reply — match the requested name instead.
 */
function observedModel(envelope: ClaudeResult, requested: string): string | undefined {
  const keys = Object.keys(envelope.modelUsage ?? {});
  const want = requested.toLowerCase();
  return keys.find((k) => {
    const key = k.toLowerCase();
    return key.includes(want) || want.includes(key);
  });
}
