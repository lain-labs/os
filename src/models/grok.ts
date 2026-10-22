import { execFile, spawn } from "node:child_process";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createLogger } from "../logger.js";
import { parseUsageLimit } from "./limits.js";
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

const log = createLogger("model:grok");

/**
 * Grok CLI backend (xAI's `grok`, "Grok Build"): each completion is one
 * headless `grok --prompt-file … --output-format json` run, billed to the
 * machine's own xAI login (`grok login`) — no LainOS API key.
 *
 * Like codex/claude/opencode it is a coding agent, not a chat API, so the
 * conversation is serialised into one prompt and tool calling uses the
 * JSON-in-the-reply protocol from cli-protocol.ts.
 *
 * The run is fenced down to a chat: an empty scratch cwd, `read_file` as the
 * only native tool, the `strict` sandbox (reads held to that cwd), no web search, no
 * subagents, no plan mode, and --verbatim so a "@handle" in a Telegram message
 * is not read as a file mention. The prompt goes in a file, never argv (a
 * long system prompt overflows argv: E2BIG). Every run leaves a session under
 * ~/.grok/sessions; it is removed once the reply is read.
 */
export interface GrokProviderOptions {
  /** Path to the grok binary (see {@link resolveGrokBin}). */
  bin: string;
  /** Model per tier (grok-4.7, grok-4.7-build-fast, …); unset tiers use the CLI's default. */
  models?: Partial<Record<ModelTier, string>>;
  /** Hard timeout for one completion, ms. */
  timeoutMs?: number;
  /** Extra attempts after a failed run (transient CLI/network blips). */
  retries?: number;
  /** Extra args appended to the run (e.g. --reasoning-effort low). */
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
/** A session left by a run that failed is swept once it is this old. */
const SESSION_TTL_MS = 3_600_000;

/** What `--output-format json` prints: the reply, or `{type: "error", message}`. */
interface GrokResult {
  type?: string;
  message?: string;
  text?: string;
  thought?: string;
  sessionId?: string;
  modelUsage?: Record<string, unknown>;
}

export class GrokModelProvider implements ModelProvider {
  readonly name = "grok";
  private bin: string;
  private models: Partial<Record<ModelTier, string>>;
  private timeoutMs: number;
  private retries: number;
  private extraArgs: string[];
  private cwd: string;
  private proxy?: string;

  constructor(opts: GrokProviderOptions) {
    this.bin = opts.bin;
    this.models = opts.models ?? {};
    this.timeoutMs = Math.max(10_000, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.retries = Math.max(0, opts.retries ?? DEFAULT_RETRIES);
    this.extraArgs = opts.extraArgs ?? [];
    // Absolute: grok files the session under its cwd, and the cleanup finds it there.
    this.cwd = resolve(opts.cwd);
    this.proxy = opts.proxy;
    if (opts.proxy) log.info(`routing grok traffic via proxy ${opts.proxy}`);
  }

  modelFor(tier: ModelTier): string {
    return this.models[tier] ?? "grok";
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const model = this.models[request.tier];
    await mkdir(this.cwd, { recursive: true });
    const promptFile = join(tmpdir(), `lainos-grok-${randomUUID()}.md`);
    await writeFile(promptFile, renderGrokPrompt(request), { encoding: "utf8", mode: 0o600 });
    const args = [
      "--prompt-file",
      promptFile,
      "--output-format",
      "json",
      "--cwd",
      this.cwd,
      "--verbatim",
      "--tools",
      "read_file",
      // Landlock: reads held to the scratch cwd (plus system paths and ~/.grok), no child network.
      "--sandbox",
      "strict",
      "--disable-web-search",
      "--no-subagents",
      "--no-plan",
      "--max-turns",
      "3",
      "--no-auto-update",
    ];
    if (model) args.push("-m", model);
    args.push(...this.extraArgs);

    let lastErr: unknown;
    try {
      for (let attempt = 0; attempt <= this.retries; attempt++) {
        if (attempt > 0) {
          log.warn(`grok attempt ${attempt} failed — retrying`, lastErr);
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        }
        try {
          const result = await this.run(args);
          void this.forget(result.sessionId);
          const { text, toolCalls } = parseToolReply((result.text ?? "").trim());
          const observed = Object.keys(result.modelUsage ?? {})[0];
          return {
            text,
            toolCalls,
            ...(result.thought ? { reasoning: result.thought } : {}),
            model: observed ? `grok/${observed}` : (model ?? "grok"),
            provider: this.name,
          };
        } catch (err) {
          lastErr = err;
          void this.forget(undefined);
          if (err instanceof Error && err.message.includes("timed out")) break;
          // An exhausted balance stays exhausted two seconds later.
          if (err instanceof Error && parseUsageLimit(err.message)) break;
        }
      }
    } finally {
      await rm(promptFile, { force: true }).catch(() => {});
    }
    throw lastErr;
  }

  /** Spawn one headless run and read the JSON object it prints. */
  private run(args: string[]): Promise<GrokResult> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(this.bin, args, { cwd: this.cwd, env: this.env(), stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let tail = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        tail = (tail + chunk.toString()).slice(-OUTPUT_TAIL_CHARS);
      });

      let timedOut = false;
      const killer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, this.timeoutMs);
      killer.unref?.();

      child.on("error", (err) => {
        clearTimeout(killer);
        reject(new Error(`grok spawn failed: ${err.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(killer);
        if (timedOut) return reject(new Error(`grok timed out after ${Math.round(this.timeoutMs / 1000)}s`));
        const result = parseGrokOutput(stdout);
        if (code !== 0 || !result || result.type === "error") {
          const reason = grokErrorText(result?.message ?? "") || tail.trim().split("\n").slice(-3).join(" · ").slice(-300);
          return reject(new Error(`grok exited ${code}${reason ? `: ${reason}` : ""}`));
        }
        resolvePromise(result);
      });
    });
  }

  /**
   * Drop the session a run left behind, and any a failed run left (an error
   * names no session) once it is an hour old. Only under this provider's own
   * cwd, which nothing else runs grok in.
   */
  private async forget(sessionId: string | undefined): Promise<void> {
    const dir = join(process.env.GROK_HOME || join(homedir(), ".grok"), "sessions", encodeURIComponent(this.cwd));
    if (sessionId && /^[\w-]+$/.test(sessionId)) await rm(join(dir, sessionId), { recursive: true, force: true }).catch(() => {});
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      const age = Date.now() - ((await stat(path).catch(() => null))?.mtimeMs ?? Date.now());
      if (age > SESSION_TTL_MS) await rm(path, { recursive: true, force: true }).catch(() => {});
    }
  }

  private env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (this.proxy) {
      env.HTTPS_PROXY = this.proxy;
      env.HTTP_PROXY = this.proxy;
      env.NO_PROXY = [env.NO_PROXY, "localhost,127.0.0.1"].filter(Boolean).join(",");
    }
    return env;
  }
}

/** The last JSON object on stdout (a warning line may come first). */
export function parseGrokOutput(stdout: string): GrokResult | null {
  const lines = stdout.trim().split("\n").reverse();
  for (const line of lines) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    try {
      return JSON.parse(s) as GrokResult;
    } catch {
      // A pretty-printed object spans lines; try the whole output below.
    }
  }
  try {
    return JSON.parse(stdout) as GrokResult;
  } catch {
    return null;
  }
}

/**
 * Grok wraps the API's error in "Internal error: {json}"; the inner message is
 * the line worth showing ("API error (status 402 Payment Required): Grok Build
 * usage balance exhausted"), and the one the limits book reads.
 */
export function grokErrorText(message: string): string {
  const inner = message.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1];
  return (inner ? inner.replace(/\\"/g, '"') : message).split("\n")[0]!.trim().slice(0, 300);
}

/** The models `grok models` lists ("* grok-4.7 (default)", "- grok-4.6"), in its order; empty when it can't say. */
export function listGrokModels(bin: string): Promise<string[]> {
  return new Promise((resolveList) => {
    execFile(bin, ["models"], { timeout: 20_000 }, (_err, stdout) => {
      resolveList([...String(stdout).matchAll(/^\s*[*-]\s+([\w.-]+)/gm)].map((m) => m[1]!));
    });
  });
}

/** Locate the grok binary: explicit override, PATH, then ~/.local/bin. */
export function resolveGrokBin(explicit?: string): string | null {
  return resolveCliBin("grok", explicit);
}

/** Serialise a ModelRequest into the single prompt one grok run receives. */
export function renderGrokPrompt(request: ModelRequest): string {
  const lines: string[] = [
    "This response is generated through the Grok CLI model provider. You are not a coding " +
      "agent in this run: do not read, search or edit files, run commands, or plan. Answer as " +
      "the persona below. If LainOS tools are listed, they are allowed: request them by " +
      "emitting the exact tool-call JSON, then wait for LainOS to run the tool and send the result back.",
    "",
    "# Persona and context",
    request.system,
  ];
  if (request.tools?.length) lines.push("", "# Tools", renderToolProtocol(request.tools));
  lines.push("", "# Conversation", renderConversation(request.messages));
  lines.push("", renderClosing(Boolean(request.tools?.length)));
  return lines.join("\n");
}
