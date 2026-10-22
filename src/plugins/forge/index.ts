import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../../logger.js";
import { formatUntil, parseUsageLimit, UsageLimits, usageLimits } from "../../models/limits.js";
import type {
  Action,
  IAgentRuntime,
  Plugin,
  Provider,
  Service,
  State,
} from "../../types.js";

const log = createLogger("plugin:forge");

/**
 * The forge is Lain's will to grow: holders tell her what they wish for, she
 * records each wish on a persistent wishboard, and then *builds* it — by
 * driving a coding agent (Claude Code, Codex CLI or OpenCode CLI) over the
 * monorepo in a background job. One job at a time, committed
 * directly to the current branch of her own repo — her learning lands in
 * place, no side branches. Commits are never pushed; publishing stays with
 * the operator.
 *
 * Surfaces:
 *   - actions: log_wish / list_wishes / build_wish / edit_wish / update_wish / forge_status
 *   - auto mode (default on): periodically picks the oldest open wish and
 *     forges it without being asked — this is the self-development loop.
 *     Disable with LAINOS_FORGE_AUTO=0. Give Codex/Claude/OpenCode unchecked
 *     repo execution with LAINOS_FORGE_YOLO=1 on hosts that are externally
 *     trusted.
 *   - onEvent: clients push "started/finished" notifications (Telegram, TUI).
 *
 * State: data/forge.json (wishes + jobs), job transcripts in data/forge/*.log.
 */

export type WishStatus = "open" | "building" | "review" | "done" | "rejected" | "failed";

export interface Wish {
  id: string;
  title: string;
  detail?: string;
  /** Who asked (agent userId, e.g. tg:username). */
  reporter: string;
  /** Telegram chat to notify about progress, when known. */
  chatId?: number;
  status: WishStatus;
  branch?: string;
  jobId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ForgeJob {
  id: string;
  wishId?: string;
  agent: string;
  /** Coding model passed to the agent CLI, when explicitly configured. */
  model?: string;
  /** Reasoning effort passed to the agent CLI, when the operator picked one. */
  effort?: string;
  status: "queued" | "running" | "ok" | "failed";
  startedAt?: number;
  endedAt?: number;
  logFile: string;
  /** Tail of the transcript, for quick status reports. */
  summary?: string;
  /** Original agent when the job was re-run on the fallback CLI. */
  fallbackFrom?: string;
  /** Every agent this job was handed to, in order, and how each one ended. */
  attempts?: ForgeAttempt[];
}

export interface ForgeAttempt {
  agent: string;
  ok: boolean;
  /** Wall time of the run; 0 when the agent was passed over without a spawn. */
  ms: number;
  /** Why it failed or was passed over, in the agent's own words where it said. */
  reason?: string;
}

export interface ForgeEvent {
  kind: "job_started" | "job_finished";
  text: string;
  job: ForgeJob;
  wish?: Wish;
  chatId?: number;
}

type ForgeJobStatus = ForgeJob["status"];
type ForgeAgentKind = "claude" | "codex" | "opencode" | "grok";
type ForgeSelectedAgent = ForgeAgentKind | "custom";

interface ForgeFile {
  wishes: Wish[];
  jobs: ForgeJob[];
  counter: number;
  selectedAgent?: ForgeAgentKind;
  /** The model and effort the operator picked per coding agent (/coder). */
  coders?: Partial<Record<ForgeAgentKind, CoderChoice>>;
}

/** What one coding agent runs with, as the operator picked it. */
export interface CoderChoice {
  model?: string;
  effort?: string;
}

/** Effort levels the coding CLIs take (codex: model_reasoning_effort, claude: --effort, opencode: #variant, grok: --reasoning-effort). */
export const CODER_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

const JOB_CAP = 100;
/** Chars of a run's output kept in memory to read why it failed. */
const ATTEMPT_TAIL_CHARS = 4_000;

export class ForgeService implements Service {
  readonly name = "forge";

  private wishes: Wish[] = [];
  private jobs: ForgeJob[] = [];
  private counter = 0;
  private file = "";
  private logDir = "";
  private repo = "";
  private agentBin: string | null = null;
  private agentKind: ForgeSelectedAgent | null = null;
  private selectedAgent: ForgeAgentKind | null = null;
  private coders: Partial<Record<ForgeAgentKind, CoderChoice>> = {};
  private availableAgents = new Map<ForgeAgentKind, string>();
  private fallback: { kind: ForgeAgentKind; bin: string } | null = null;
  private runtime?: IAgentRuntime;
  private child: ChildProcess | null = null;
  private activeJobId: string | null = null;
  private queue: string[] = [];
  /** Shared with the chat router: a spent subscription is spent for both. */
  private limits = new UsageLimits();
  private autoTimer: ReturnType<typeof setInterval> | null = null;
  private subscribers = new Set<(event: ForgeEvent) => void>();

  async start(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
    const dataDir = runtime.getSetting("LAINOS_DATA_DIR") ?? "./data";
    this.file = join(dataDir, "forge.json");
    this.logDir = join(dataDir, "forge");
    this.limits = usageLimits(dataDir);
    const repoSetting = runtime.getSetting("LAINOS_FORGE_REPO")?.trim();
    // Her own checkout, not wherever `lain` was typed: from ~ the forge ran in
    // a directory that is no repo at all, and Codex refused every job there.
    this.repo = repoSetting || ownCheckout() || findGitRoot(process.cwd());

    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as ForgeFile;
      this.wishes = parsed.wishes ?? [];
      this.jobs = parsed.jobs ?? [];
      this.counter = parsed.counter ?? 0;
      this.selectedAgent = normalizeAgent(parsed.selectedAgent) ?? null;
      this.coders = parsed.coders ?? {};
    } catch {
      // Fresh store.
    }
    // A job that was "running" when the daemon died is failed, not stuck.
    let dirty = false;
    for (const job of this.jobs) {
      if (job.status === "running" || job.status === "queued") {
        job.status = "failed";
        job.summary = "daemon restarted while the job was live";
        const wish = job.wishId ? this.getWish(job.wishId) : undefined;
        if (wish && wish.status === "building") this.setStatus(wish, "failed");
        dirty = true;
      }
    }
    this.detectAgent();
    if (this.selectedAgent) dirty = true;
    if (dirty) await this.persist();
    const auto = runtime.getSetting("LAINOS_FORGE_AUTO") !== "0";
    if (auto && this.agentBin) {
      const interval = Number(runtime.getSetting("LAINOS_FORGE_AUTO_INTERVAL_MS") ?? 1_800_000);
      this.autoTimer = setInterval(() => void this.autoTick(), Math.max(60_000, interval));
      this.autoTimer.unref?.();
    }
    log.info(
      `forge online: repo ${this.repo}, agent ${this.agentKind ?? "none"}` +
        `${this.fallback ? ` (fallback ${this.fallback.kind})` : ""}, ` +
        `${this.openWishes().length} open wish(es), auto ${auto && this.agentBin ? "on" : "off"}`,
    );
  }

  async stop(): Promise<void> {
    if (this.autoTimer) clearInterval(this.autoTimer);
    this.autoTimer = null;
    this.child?.kill("SIGTERM");
  }

  onEvent(fn: (event: ForgeEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  get agentAvailable(): boolean {
    return Boolean(this.agentBin);
  }

  forgeProvider(): {
    selected: ForgeSelectedAgent | "none";
    /** Model and effort the selected agent runs with (picked, else the env's model). */
    model?: string;
    effort?: string;
    available: boolean;
    bin?: string;
    installed: ForgeAgentKind[];
    fallback?: ForgeAgentKind;
    /** Installed agents that are out of quota right now, one line each. */
    spent: string[];
  } {
    const selected = this.agentKind ?? this.selectedAgent ?? "none";
    const installed = [...this.availableAgents.keys()];
    return {
      selected,
      model: this.agentModel(selected),
      effort: this.agentEffort(selected),
      available: this.agentAvailable,
      bin: this.agentBin ?? undefined,
      installed,
      fallback: installed.find((kind) => kind !== selected && !this.limits.active(kind)),
      spent: installed.map((kind) => this.limits.describe(kind)).filter((line): line is string => Boolean(line)),
    };
  }

  /** Where her data lives — the forge state, job logs — for the live context. */
  get dataPaths(): { forgeFile: string; logDir: string } {
    return { forgeFile: resolve(this.file), logDir: resolve(this.logDir) };
  }

  /** Absolute repo the coding agents edit — used to decide self-restarts. */
  get repoPath(): string {
    return resolve(this.repo);
  }

  listWishes(status?: WishStatus): Wish[] {
    return this.wishes.filter((w) => !status || w.status === status);
  }

  getWish(id: string): Wish | undefined {
    return this.wishes.find((w) => w.id === id);
  }

  openWishes(): Wish[] {
    return this.listWishes("open");
  }

  activeJob(): ForgeJob | undefined {
    return this.jobs.find((j) => j.id === this.activeJobId);
  }

  listJobs(status?: ForgeJobStatus): ForgeJob[] {
    return this.jobs.filter((j) => !status || j.status === status);
  }

  recentJobs(limit = 5): ForgeJob[] {
    return this.jobs.slice(-limit);
  }

  /**
   * Pick the coding agent for new jobs, and optionally the model and effort it
   * runs with. Undefined leaves that part as it was; null or "default" clears
   * it back to the agent's own default. Saved in forge.json, so it outlives a
   * restart.
   */
  async setProvider(
    provider: string,
    choice: { model?: string | null; effort?: string | null } = {},
  ): Promise<{ ok: true; provider: ForgeAgentKind; model?: string; effort?: string } | string> {
    if (this.runtime?.getSetting("LAINOS_FORGE_CMD")) {
      return "forge provider is controlled by LAINOS_FORGE_CMD; unset it before switching between Claude, Codex and OpenCode";
    }
    const selected = normalizeAgent(provider);
    if (!selected) return "provider must be claude, codex, opencode or grok";
    if (!this.availableAgents.has(selected)) {
      const installed = [...this.availableAgents.keys()].join(", ") || "none";
      return `${selected} is not available to the forge (installed: ${installed})`;
    }
    const effort = choice.effort?.trim().toLowerCase();
    if (effort && effort !== "default" && !(CODER_EFFORTS as readonly string[]).includes(effort)) {
      return `effort must be one of ${CODER_EFFORTS.join(", ")} (or default) — not "${choice.effort}"`;
    }
    const next: CoderChoice = { ...this.coders[selected] };
    if (choice.model !== undefined) {
      const model = choice.model?.trim();
      if (!model || model === "default") delete next.model;
      else next.model = model;
    }
    if (choice.effort !== undefined) {
      if (!effort || effort === "default") delete next.effort;
      else next.effort = effort;
    }
    if (Object.keys(next).length) this.coders[selected] = next;
    else delete this.coders[selected];
    this.selectedAgent = selected;
    this.applySelectedAgent();
    await this.persist();
    return { ok: true, provider: selected, model: this.agentModel(selected), effort: this.agentEffort(selected) };
  }

  /** "codex/gpt-6.1-sol · low" — the coder as the operator reads it. */
  coderLabel(kind: string = this.agentKind ?? "none"): string {
    const model = this.agentModel(kind);
    const effort = this.agentEffort(kind);
    return `${kind}${model ? `/${model}` : ""}${effort ? ` · ${effort}` : ""}`;
  }

  /** Jobs waiting for the forge, in the order they will run. */
  queuedJobs(): ForgeJob[] {
    return this.queue.map((id) => this.jobs.find((j) => j.id === id)).filter((j): j is ForgeJob => Boolean(j));
  }

  /** A job's transcript, the last `lines` of it. */
  async jobLogTail(job: ForgeJob, lines = 40): Promise<string> {
    try {
      const text = await readFile(job.logFile, "utf8");
      return text.trimEnd().split("\n").slice(-lines).join("\n");
    } catch {
      return "";
    }
  }

  async addWish(input: {
    title: string;
    detail?: string;
    reporter: string;
    chatId?: number;
  }): Promise<Wish> {
    this.counter += 1;
    const wish: Wish = {
      id: `wish${this.counter}`,
      title: input.title.trim(),
      detail: input.detail?.trim() || undefined,
      reporter: input.reporter,
      chatId: input.chatId,
      status: "open",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.wishes.push(wish);
    await this.persist();
    log.info(`wish logged: [${wish.id}] ${wish.title} (by ${wish.reporter})`);
    return wish;
  }

  async setWishStatus(id: string, status: WishStatus): Promise<Wish | undefined> {
    const wish = this.getWish(id);
    if (!wish) return undefined;
    this.setStatus(wish, status);
    await this.persist();
    return wish;
  }

  async editWish(
    id: string,
    changes: { title?: string; detail?: string; appendDetail?: string },
  ): Promise<{ wish: Wish; jobStatus?: ForgeJobStatus } | string> {
    const wish = this.getWish(id);
    if (!wish) return `no wish named ${id}`;

    const hasTitle = Object.prototype.hasOwnProperty.call(changes, "title");
    const hasDetail = Object.prototype.hasOwnProperty.call(changes, "detail");
    const appendDetail = changes.appendDetail?.trim();
    if (!hasTitle && !hasDetail && !appendDetail) {
      return "provide title, detail, or appendDetail";
    }
    if (hasDetail && appendDetail) {
      return "detail and appendDetail are mutually exclusive";
    }

    if (hasTitle) {
      const title = changes.title?.trim();
      if (!title) return "title cannot be empty";
      wish.title = title;
    }
    if (hasDetail) wish.detail = changes.detail?.trim() || undefined;
    if (appendDetail) {
      wish.detail = [wish.detail?.trim(), appendDetail].filter(Boolean).join("\n\n");
    }
    wish.updatedAt = Date.now();
    await this.persist();

    const job = wish.jobId ? this.jobs.find((item) => item.id === wish.jobId) : undefined;
    return { wish, jobStatus: job?.status };
  }

  /** Queue a forge job for a wish. Returns the job, or an error string. */
  async buildWish(id: string): Promise<ForgeJob | string> {
    const wish = this.getWish(id);
    if (!wish) return `no wish named ${id}`;
    if (!this.agentBin) {
      const selected = this.selectedAgent ?? this.agentKind ?? "none";
      return selected === "none"
        ? "no coding agent found (need claude, codex, opencode or grok in PATH)"
        : `selected forge provider ${selected} is unavailable (need ${selected} in PATH)`;
    }
    if (wish.status === "building") return `${id} is already being forged`;
    if (this.agentKind !== "custom" && !this.readyAgents().length) {
      // A job queued now would fail in a second on every agent and mark the wish failed.
      return `every coding agent is out of quota — ${this.forgeProvider().spent.join("; ")}`;
    }
    this.counter += 1;
    const job: ForgeJob = {
      id: `job${this.counter}`,
      wishId: wish.id,
      agent: this.agentKind ?? "custom",
      model: this.agentModel(this.agentKind ?? "custom"),
      effort: this.agentEffort(this.agentKind ?? "custom"),
      status: "queued",
      logFile: join(this.logDir, `job${this.counter}.log`),
    };
    this.jobs.push(job);
    if (this.jobs.length > JOB_CAP) this.jobs = this.jobs.slice(-JOB_CAP);
    wish.jobId = job.id;
    this.setStatus(wish, "building");
    this.queue.push(job.id);
    await this.persist();
    void this.runNext();
    return job;
  }

  /** Self-development loop: forge the oldest open wish when idle. */
  private async autoTick(): Promise<void> {
    if (this.activeJobId || this.queue.length) return;
    if (this.agentKind !== "custom" && !this.readyAgents().length) return;
    const next = this.openWishes()[0];
    if (!next) return;
    log.info(`auto-forge picks up ${next.id}: ${next.title}`);
    await this.buildWish(next.id);
  }

  // ------------------------------------------------------------ job runner

  private async runNext(): Promise<void> {
    if (this.activeJobId) return;
    const jobId = this.queue.shift();
    if (!jobId) return;
    const job = this.jobs.find((j) => j.id === jobId);
    if (!job) return void this.runNext();
    const wish = job.wishId ? this.getWish(job.wishId) : undefined;

    if (!this.passOverSpentAgent(job)) {
      job.status = "failed";
      job.endedAt = Date.now();
      job.startedAt ??= job.endedAt;
      void this.finishJob(job, wish);
      return void this.runNext();
    }

    this.activeJobId = job.id;
    job.status = "running";
    job.startedAt = Date.now();
    await mkdir(this.logDir, { recursive: true });
    await this.persist();

    const prompt = this.buildPrompt(wish, job);
    const { cmd, args, shell } = this.buildCommand(prompt, this.jobAgent(job));
    const timeout = Number(this.runtime?.getSetting("LAINOS_FORGE_TIMEOUT_MS") ?? 2_400_000);

    log.info(`job ${job.id} starts (${this.agentLabel(job)}) for ${wish?.id ?? "ad-hoc"}`);
    this.emit({
      kind: "job_started",
      text: wish
        ? `🔧 forging ${wish.id} — "${wish.title}" (${this.agentLabel(job)})`
        : `🔧 forge job ${job.id} started`,
      job,
      wish,
      chatId: wish?.chatId,
    });

    const out = createWriteStream(job.logFile, { flags: "a" });
    out.write(`# ${job.id} · ${new Date().toISOString()} · ${this.agentLabel(job)}\n# wish: ${wish?.id} ${wish?.title}\n\n`);

    const child = spawn(cmd, args, {
      cwd: this.repo,
      env: this.jobEnv(prompt),
      shell,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout?.pipe(out, { end: false });
    child.stderr?.pipe(out, { end: false });
    let tail = "";
    const keep = (chunk: Buffer) => {
      tail = (tail + chunk.toString()).slice(-ATTEMPT_TAIL_CHARS);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);

    const killer = setTimeout(() => {
      log.warn(`job ${job.id} timed out — killing`);
      child.kill("SIGTERM");
    }, timeout);
    killer.unref?.();

    child.on("close", (code) => {
      clearTimeout(killer);
      out.end();
      this.child = null;
      this.activeJobId = null;
      job.endedAt = Date.now();
      // A spent subscription can still exit 0 with nothing but the notice.
      const spentNotice = code === 0 && tail.trim().length < 400 && parseUsageLimit(tail) !== null;
      job.status = code === 0 && !spentNotice ? "ok" : "failed";
      const limited = job.status === "failed" && this.recordAttempt(job, tail);
      if (job.status === "ok") this.recordAttempt(job, "");
      if (job.status === "failed" && this.tryFallback(job, limited)) return void this.runNext();
      void this.finishJob(job, wish);
      void this.runNext();
    });
    child.on("error", (err) => {
      clearTimeout(killer);
      out.end(`\nspawn failed: ${err.message}\n`);
      this.child = null;
      this.activeJobId = null;
      job.status = "failed";
      job.endedAt = Date.now();
      this.recordAttempt(job, `spawn failed: ${err.message}`);
      if (this.tryFallback(job, false)) return void this.runNext();
      void this.finishJob(job, wish);
      void this.runNext();
    });
  }

  /**
   * Note how this run ended on the job, and — when the agent said it is out of
   * quota — in the shared limits book. Returns whether it was a usage limit.
   */
  private recordAttempt(job: ForgeJob, output: string): boolean {
    const ms = (job.endedAt ?? Date.now()) - (job.startedAt ?? Date.now());
    const attempts = (job.attempts ??= []);
    if (job.status === "ok") {
      attempts.push({ agent: job.agent, ok: true, ms });
      return false;
    }
    // The verdict is in the last lines; earlier output is the agent's own work.
    const last = output.trim().split("\n").slice(-15).join("\n");
    const limit = normalizeAgent(job.agent) ? this.limits.note(job.agent, last) : null;
    attempts.push({
      agent: job.agent,
      ok: false,
      ms,
      reason: limit ? `out of quota until ${formatUntil(limit.until)} — ${limit.reason}` : failureReason(last) || "failed",
    });
    return Boolean(limit);
  }

  /**
   * Before a spawn: an agent already known to be out of quota is passed over
   * for the next one that is not (the operator's choice first), and the job
   * says so. False when no agent can take it.
   */
  private passOverSpentAgent(job: ForgeJob): boolean {
    if (!normalizeAgent(job.agent)) return true;
    const spent = this.limits.active(job.agent);
    if (!spent) return true;
    (job.attempts ??= []).push({
      agent: job.agent,
      ok: false,
      ms: 0,
      reason: `passed over: out of quota until ${formatUntil(spent.until)} — ${spent.reason}`,
    });
    const next = this.nextAgent(job);
    if (!next) return false;
    log.warn(`job ${job.id}: ${job.agent} is out of quota — handing it to ${next.kind}`);
    job.fallbackFrom ??= job.agent;
    job.agent = next.kind;
    job.model = this.agentModel(next.kind);
    job.effort = this.agentEffort(next.kind);
    return true;
  }

  /**
   * An instant failure means the agent never got to work — auth, subscription,
   * a bad flag, or quota died at startup (e.g. "organization has disabled
   * Claude subscription access") — so rerun the job on the next CLI that has
   * not had it and is not out of quota, instead of failing the wish. Slow
   * failures are real attempts and are not retried — unless the agent ran out
   * of quota mid-way, which says nothing about the work.
   */
  private tryFallback(job: ForgeJob, limited: boolean): boolean {
    const windowMs = Number(this.runtime?.getSetting("LAINOS_FORGE_FALLBACK_MS") ?? 180_000);
    if (windowMs <= 0) return false;
    const ran = (job.endedAt ?? 0) - (job.startedAt ?? 0);
    if (ran >= windowMs && !limited) return false;
    const fallback = this.nextAgent(job);
    if (!fallback) return false;
    log.warn(
      `job ${job.id} died in ${Math.round(ran / 1000)}s on ${job.agent} — retrying with ${fallback.kind}`,
    );
    job.fallbackFrom ??= job.agent;
    job.agent = fallback.kind;
    job.model = this.agentModel(fallback.kind);
    job.effort = this.agentEffort(fallback.kind);
    job.status = "queued";
    job.startedAt = undefined;
    job.endedAt = undefined;
    this.queue.unshift(job.id);
    void this.persist();
    return true;
  }

  /** Bin/kind to run this job with: its recorded agent, else the primary. */
  private jobAgent(job: ForgeJob): { kind: string; bin: string } {
    const kind = normalizeAgent(job.agent);
    if (kind) return { kind, bin: this.availableAgents.get(kind) ?? kind };
    return { kind: this.agentKind ?? "custom", bin: this.agentBin ?? "custom" };
  }

  /** Installed agents not out of quota, the operator's choice first. */
  private readyAgents(): ForgeAgentKind[] {
    const order = [this.selectedAgent, "claude", "codex", "opencode", "grok"] as const;
    const ready: ForgeAgentKind[] = [];
    for (const kind of order) {
      if (!kind || ready.includes(kind) || !this.availableAgents.has(kind)) continue;
      if (!this.limits.active(kind)) ready.push(kind);
    }
    return ready;
  }

  /** The next ready agent this job has not been handed to yet. */
  private nextAgent(job: ForgeJob): { kind: ForgeAgentKind; bin: string } | null {
    if (!normalizeAgent(job.agent)) return null;
    const tried = new Set([job.agent, ...(job.attempts ?? []).map((a) => a.agent)]);
    const kind = this.readyAgents().find((k) => !tried.has(k));
    return kind ? { kind, bin: this.availableAgents.get(kind)! } : null;
  }

  private async finishJob(job: ForgeJob, wish?: Wish): Promise<void> {
    job.summary = await tailFile(job.logFile, 1_000);
    if (wish) this.setStatus(wish, job.status === "ok" ? "done" : "failed");
    await this.persist();
    const mins = job.startedAt && job.endedAt ? Math.round((job.endedAt - job.startedAt) / 60_000) : 0;
    log.info(`job ${job.id} ${job.status} after ~${mins}m`);
    const reason = job.status === "failed" ? attemptsLine(job) || failureReason(job.summary) : "";
    this.emit({
      kind: "job_finished",
      text: wish
        ? job.status === "ok"
          ? `✅ ${wish.id} "${wish.title}" is forged and committed to my repo.`
          : `✖ forging ${wish.id} "${wish.title}" failed${reason ? ` ("${reason}")` : ""} — i kept the transcript, ask me for forge status.`
        : `forge job ${job.id} ${job.status}`,
      job,
      wish,
      chatId: wish?.chatId,
    });
  }

  private buildPrompt(wish: Wish | undefined, job: ForgeJob): string {
    const custom = this.runtime?.getSetting("LAINOS_FORGE_PROMPT_EXTRA") ?? "";
    return [
      `You are Lain's forge worker inside her own repository at ${this.repo}.`,
      wish
        ? `Someone asked for this (wish ${wish.id}, reported by ${wish.reporter}):\n# ${wish.title}\n${wish.detail ?? ""}`
        : `Ad-hoc forge job ${job.id}.`,
      ``,
      `Rules:`,
      `- Read CLAUDE.md / AGENTS.md first and follow the repo conventions.`,
      `- Work directly on the current branch. Do NOT create or switch branches.`,
      `- Implement the request minimally, in the right component.`,
      `- If the request is a new small self-contained agent capability, prefer writing it as a hot-loadable skill: skills/<name>.mjs default-exporting { name, description, parameters, handler } — the live daemon picks those up without a restart. Bigger capabilities go into src/ as usual.`,
      `- Run the smallest relevant verification for what you touched.`,
      `- Commit directly to the current branch with a clear message. NEVER push. Never print, read, or commit secrets or .env files.`,
      `- Stage only the files you changed (git add <path>…), never git add -A or git commit -a: the tree may hold someone else's uncommitted work, and it is not yours to commit or revert.`,
      `- If the request is unclear, too large, or risky, do NOT write code: put your assessment in data/forge/${job.id}-assessment.md, commit nothing, and exit with code 0.`,
      custom,
    ]
      .filter(Boolean)
      .join("\n");
  }

  /** Compose the agent command. LAINOS_FORGE_CMD overrides everything (test hook). */
  private buildCommand(
    prompt: string,
    agent: { kind: string; bin: string },
  ): { cmd: string; args: string[]; shell: boolean } {
    const override = this.runtime?.getSetting("LAINOS_FORGE_CMD");
    if (override) return { cmd: override, args: [], shell: true };
    if (agent.kind === "codex") {
      const extra = splitArgs(this.runtime?.getSetting("LAINOS_FORGE_CODEX_ARGS"));
      // --skip-git-repo-check: an LAINOS_FORGE_REPO that is no git repo is the
      // operator's call, and codex otherwise refuses to start in it at all.
      const args = ["exec", "--skip-git-repo-check", "-C", this.repo, "--color", "never"];
      const model = this.agentModel(agent.kind);
      if (model) args.push("-m", model);
      const effort = this.agentEffort(agent.kind);
      if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
      if (this.forgeYolo()) {
        args.push("--dangerously-bypass-approvals-and-sandbox");
      } else {
        args.push("--sandbox", "workspace-write");
      }
      return { cmd: agent.bin, args: [...args, ...extra, prompt], shell: false };
    }
    if (agent.kind === "opencode") {
      const extra = splitArgs(this.runtime?.getSetting("LAINOS_FORGE_OPENCODE_ARGS"));
      const args = ["run"];
      const model = this.agentModel(agent.kind);
      // OpenCode names an effort as the model's variant: provider/model#low.
      const effort = this.agentEffort(agent.kind);
      if (model) args.push("-m", effort && !model.includes("#") ? `${model}#${effort}` : model);
      // Non-interactive runs can't answer permission prompts; with yolo,
      // auto-approve everything not explicitly denied. Without it the host's
      // OpenCode permissions govern and unanswerable asks are denied.
      if (this.forgeYolo()) args.push("--auto");
      return { cmd: agent.bin, args: [...args, ...extra, prompt], shell: false };
    }
    if (agent.kind === "grok") {
      const extra = splitArgs(this.runtime?.getSetting("LAINOS_FORGE_GROK_ARGS"));
      const args = ["-p", prompt, "--cwd", this.repo, "--output-format", "plain", "--no-auto-update"];
      const model = this.agentModel(agent.kind);
      if (model) args.push("-m", model);
      const effort = this.agentEffort(agent.kind);
      if (effort) args.push("--reasoning-effort", effort === "minimal" ? "low" : effort);
      // Without yolo, edits are accepted and anything else is refused: nobody can answer a prompt here.
      args.push(...(this.forgeYolo() ? ["--always-approve"] : ["--permission-mode", "acceptEdits"]));
      return { cmd: agent.bin, args: [...args, ...extra], shell: false };
    }
    const extra = splitArgs(this.runtime?.getSetting("LAINOS_FORGE_CLAUDE_ARGS"));
    const model = this.agentModel(agent.kind);
    const effort = this.agentEffort(agent.kind);
    // claude takes low…max; "minimal" is codex's word for its lowest.
    const modelArgs = [...(model ? ["--model", model] : []), ...(effort ? ["--effort", effort === "minimal" ? "low" : effort] : [])];
    const permissionArgs = this.forgeYolo()
      ? ["--dangerously-skip-permissions"]
      : ["--permission-mode", "acceptEdits", "--allowedTools", "Bash,Edit,Write"];
    return {
      cmd: agent.bin,
      args: [
        "-p",
        prompt,
        ...modelArgs,
        ...permissionArgs,
        "--output-format",
        "text",
        ...extra,
      ],
      shell: false,
    };
  }

  private agentModel(kind: string): string | undefined {
    const setting = (key: string): string | undefined => {
      const value = this.runtime?.getSetting(key)?.trim();
      return value || undefined;
    };
    // The operator's /coder pick wins over the environment's default.
    const picked = normalizeAgent(kind) ? this.coders[kind as ForgeAgentKind]?.model : undefined;
    if (picked) return picked;
    if (kind === "claude") {
      return setting("LAINOS_FORGE_CLAUDE_MODEL") ?? setting("LAINOS_FORGE_MODEL");
    }
    if (kind === "codex") {
      return setting("LAINOS_FORGE_CODEX_MODEL") ?? setting("LAINOS_FORGE_MODEL");
    }
    if (kind === "opencode") {
      return setting("LAINOS_FORGE_OPENCODE_MODEL") ?? setting("LAINOS_FORGE_MODEL");
    }
    if (kind === "grok") {
      return setting("LAINOS_FORGE_GROK_MODEL") ?? setting("LAINOS_FORGE_MODEL");
    }
    return undefined;
  }

  /** The effort an agent runs with: the operator's pick, else LAINOS_FORGE_EFFORT. */
  private agentEffort(kind: string): string | undefined {
    const picked = normalizeAgent(kind) ? this.coders[kind as ForgeAgentKind]?.effort : undefined;
    if (picked) return picked;
    if (!normalizeAgent(kind)) return undefined;
    return this.runtime?.getSetting("LAINOS_FORGE_EFFORT")?.trim().toLowerCase() || undefined;
  }

  agentLabel(job: ForgeJob): string {
    return `${job.model ? `${job.agent}/${job.model}` : job.agent}${job.effort ? ` · ${job.effort}` : ""}`;
  }

  /** Job environment: pass the prompt and route agent traffic via the proxy. */
  private jobEnv(prompt: string): NodeJS.ProcessEnv {
    const proxy =
      this.runtime?.getSetting("LAINOS_FORGE_PROXY") ??
      this.runtime?.getSetting("LAINOS_MODEL_PROXY") ??
      this.runtime?.getSetting("HTTPS_PROXY");
    const env: NodeJS.ProcessEnv = { ...process.env, LAINOS_FORGE_PROMPT: prompt };
    if (proxy) {
      env.HTTPS_PROXY = proxy;
      env.HTTP_PROXY = proxy;
      env.NO_PROXY = [env.NO_PROXY, "localhost,127.0.0.1"].filter(Boolean).join(",");
    }
    return env;
  }

  private forgeYolo(): boolean {
    const raw =
      this.runtime?.getSetting("LAINOS_FORGE_YOLO") ??
      this.runtime?.getSetting("LAINOS_FORGE_DANGEROUSLY_BYPASS_PERMISSIONS");
    return isTruthy(raw);
  }

  /** Pick the coding agent: persisted selection, LAINOS_FORGE_AGENT, else claude, else codex. */
  private detectAgent(): void {
    if (this.runtime?.getSetting("LAINOS_FORGE_CMD")) {
      this.agentKind = "custom";
      this.agentBin = "custom";
      this.availableAgents.clear();
      return;
    }
    this.agentKind = null;
    this.agentBin = null;
    this.fallback = null;
    this.availableAgents.clear();
    const wanted = normalizeAgent(this.runtime?.getSetting("LAINOS_FORGE_AGENT"));
    const home = process.env.HOME ?? "";
    const candidates: Array<[ForgeAgentKind, string]> = [
      ["claude", "claude"],
      ["claude", join(home, ".local/bin/claude")],
      ["codex", "codex"],
      ["codex", join(home, ".local/bin/codex")],
      ["opencode", "opencode"],
      ["opencode", join(home, ".local/bin/opencode")],
      ["opencode", join(home, ".opencode/bin/opencode")],
      ["grok", "grok"],
      ["grok", join(home, ".local/bin/grok")],
    ];
    for (const [kind, bin] of candidates) {
      if (bin.includes("/") ? existsSync(bin) : whichSync(bin)) {
        if (!this.availableAgents.has(kind)) this.availableAgents.set(kind, bin);
      }
    }
    if (!this.selectedAgent && wanted) this.selectedAgent = wanted;
    if (!this.selectedAgent) {
      this.selectedAgent = this.availableAgents.has("claude")
        ? "claude"
        : this.availableAgents.has("codex")
          ? "codex"
          : this.availableAgents.has("opencode")
            ? "opencode"
            : null;
    }
    this.applySelectedAgent();
    if (!this.agentBin) {
      const installed = [...this.availableAgents.keys()].join(", ") || "none";
      log.warn(
        `selected forge provider ${this.selectedAgent ?? "none"} is unavailable (installed: ${installed}) — forge can log wishes but not build them.`,
      );
      return;
    }
  }

  private applySelectedAgent(): void {
    this.fallback = null;
    if (!this.selectedAgent) {
      this.agentKind = null;
      this.agentBin = null;
      return;
    }
    this.agentKind = this.selectedAgent;
    this.agentBin = this.availableAgents.get(this.selectedAgent) ?? null;
    for (const [kind, bin] of this.availableAgents) {
      if (kind !== this.selectedAgent) {
        this.fallback = { kind, bin };
        break;
      }
    }
  }

  private setStatus(wish: Wish, status: WishStatus): void {
    wish.status = status;
    wish.updatedAt = Date.now();
  }

  private emit(event: ForgeEvent): void {
    for (const fn of this.subscribers) {
      try {
        fn(event);
      } catch {
        /* a broken subscriber must never break the forge */
      }
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const payload: ForgeFile = {
      wishes: this.wishes,
      jobs: this.jobs,
      counter: this.counter,
      selectedAgent: this.selectedAgent ?? undefined,
      ...(Object.keys(this.coders).length ? { coders: this.coders } : {}),
    };
    await writeFile(this.file, JSON.stringify(payload, null, 2), "utf8");
  }
}

// ------------------------------------------------------------------ helpers

function findGitRoot(from: string): string {
  let dir = resolve(from);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(from);
}

/**
 * The package this file belongs to, when it is a git checkout — her own
 * source (src/ under tsx, dist/src/ built). Null for an install without git,
 * which never searches further up: a dotfiles repo in ~ is not hers.
 */
function ownCheckout(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "package.json"))) return existsSync(join(dir, ".git")) ? dir : null;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** "codex: not a git repo; claude: out of quota until Oct 24 09:00" — each agent a job went through. */
function attemptsLine(job: ForgeJob, max = 160): string {
  return jobAttempts(job)
    .filter((a) => !a.ok)
    .map((a) => `${a.agent}: ${sanitizeInline(a.reason ?? "failed", max)}`)
    .join("; ");
}

function whichSync(bin: string): boolean {
  const paths = (process.env.PATH ?? "").split(":");
  return paths.some((p) => p && existsSync(join(p, bin)));
}

function splitArgs(raw?: string): string[] {
  return (raw ?? "").split(/\s+/).filter(Boolean);
}

function isTruthy(raw?: string): boolean {
  return ["1", "true", "yes", "on", "yolo"].includes((raw ?? "").trim().toLowerCase());
}

function normalizeAgent(raw?: string): ForgeAgentKind | undefined {
  const value = (raw ?? "").trim().toLowerCase();
  return value === "claude" || value === "codex" || value === "opencode" || value === "grok" ? value : undefined;
}

/** Last meaningful transcript line, trimmed to fit a chat notification. */
function failureReason(summary?: string): string {
  const lines = (summary ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  const last = lines[lines.length - 1] ?? "";
  return last.length > 160 ? `${last.slice(0, 157)}…` : last;
}

async function tailFile(path: string, chars: number): Promise<string> {
  try {
    const text = await readFile(path, "utf8");
    return text.length > chars ? `…${text.slice(-chars)}` : text;
  } catch {
    return "";
  }
}

function getForge(runtime: IAgentRuntime): ForgeService {
  const svc = runtime.getService<ForgeService>("forge");
  if (!svc) throw new Error("forge service not started");
  return svc;
}

/** Telegram rooms are "tg-<chatId>"; other rooms have no push channel. */
function chatIdFromState(state: State): number | undefined {
  if (!state.roomId.startsWith("tg-")) return undefined;
  const id = Number(state.roomId.slice(3));
  return Number.isFinite(id) ? id : undefined;
}

function describeWish(w: Wish): string {
  const age = Math.round((Date.now() - w.createdAt) / 3_600_000);
  return `${w.id} [${w.status}] ${w.title} — by ${w.reporter}, ${age}h ago${w.branch ? `, branch ${w.branch}` : ""}`;
}

function describeJob(job: ForgeJob, svc: ForgeService): string {
  const wish = job.wishId ? svc.getWish(job.wishId) : undefined;
  const wishText = wish
    ? `${wish.id} - ${sanitizeInline(wish.title, 120)}`
    : job.wishId
      ? `${job.wishId} (missing wish)`
      : "ad-hoc";
  const started = formatTime(job.startedAt);
  const ended = formatTime(job.endedAt);
  const label = job.status === "failed" ? "error" : "result";
  const summary = job.status === "queued" || job.status === "running"
    ? job.status
    : summarizeJob(job.summary);
  const duration = formatDuration(job.startedAt, job.endedAt);
  const failedAttempts = jobAttempts(job).filter((a) => !a.ok);
  return [
    `${job.id} [${job.status}]`,
    `  wish:    ${wishText}`,
    `  worker:  ${job.agent}`,
    ...(job.model ? [`  model:   ${job.model}`] : []),
    ...(job.effort ? [`  reasoning: ${job.effort}`] : []),
    ...(failedAttempts.length ? [`  tried:   ${attemptsLine(job, 120)}`] : []),
    `  started: ${started}`,
    `  ended:   ${ended}${duration ? ` (${duration})` : ""}`,
    `  ${label}:  ${summary}`,
  ].join("\n");
}

/**
 * How a job went, agent by agent. Jobs from before attempts were recorded
 * read it back from their transcript: each run opens with "# jobN · <when> · <agent>".
 */
export function jobAttempts(job: ForgeJob): ForgeAttempt[] {
  if (job.attempts?.length) return job.attempts;
  const sections = (job.summary ?? "").split(/^# job\d+ · \S+ · /m).slice(1);
  if (sections.length < 2) return [];
  return sections.map((section, i) => {
    const [head, ...body] = section.split("\n");
    const last = i === sections.length - 1;
    const ok = last && job.status === "ok";
    return { agent: head.split(/[\s/]/)[0], ok, ms: 0, ...(ok ? {} : { reason: failureReason(body.join("\n")) || "failed" }) };
  });
}

/**
 * The forge at a glance, for the operator's /jobs: who codes, what runs now,
 * what waits, and how the last jobs ended — each failed agent with its reason.
 */
export function formatForgeBoard(svc: ForgeService, opts: { limit?: number } = {}): string {
  const provider = svc.forgeProvider();
  const lines = [
    `coder: ${svc.coderLabel()} (${provider.available ? "ready" : "unavailable"})` +
      `${provider.fallback ? ` · fallback ${svc.coderLabel(provider.fallback)}` : ""}`,
  ];
  if (provider.spent.length) {
    lines.push(`out of quota: ${provider.spent.map((l) => l.replace(" out of quota until ", " until ")).join("; ")}`);
  }
  const active = svc.activeJob();
  const wishOf = (job: ForgeJob) => {
    const wish = job.wishId ? svc.getWish(job.wishId) : undefined;
    return wish ? `${wish.id} "${sanitizeInline(wish.title, 60)}"` : job.wishId ?? "ad-hoc";
  };
  lines.push(
    active
      ? `now:    ${active.id} ${wishOf(active)} on ${svc.agentLabel(active)} · ${formatDuration(active.startedAt, Date.now()) || "just started"}`
      : "now:    nothing is being built",
  );
  const queued = svc.queuedJobs();
  lines.push(queued.length ? `queue:  ${queued.map((j) => `${j.id} ${wishOf(j)}`).join(" → ")}` : "queue:  empty");
  const done = svc
    .listJobs()
    .filter((j) => j.status === "ok" || j.status === "failed")
    .slice(-(opts.limit ?? 8))
    .reverse();
  if (done.length) {
    lines.push("", "recent:");
    for (const job of done) {
      const mark = job.status === "ok" ? "✔" : "✖";
      const when = job.endedAt ? clock(job.endedAt) : "-";
      const took = formatDuration(job.startedAt, job.endedAt);
      lines.push(`  ${mark} ${job.id.padEnd(6)} ${wishOf(job)} · ${when}${took ? ` · ${took}` : ""}`);
      const attempts = jobAttempts(job);
      if (attempts.length) {
        lines.push(
          `      ${attempts.map((a) => `${a.agent} ${a.ok ? "✔" : `✖ ${sanitizeInline(a.reason ?? "failed", 90)}`}`).join(" → ")}`,
        );
      } else {
        lines.push(`      ${svc.agentLabel(job)}${job.status === "failed" ? ` ✖ ${summarizeJob(job.summary)}` : " ✔"}`);
      }
    }
  }
  const open = svc.openWishes();
  if (open.length) lines.push("", `open wishes: ${open.map((w) => w.id).join(", ")} (the forge picks the oldest up on its own)`);
  lines.push("", "/jobs <id> — that job's transcript · /coder — who codes · /wishes — the wishboard");
  return lines.join("\n");
}

/** Local wall-clock "MM-DD HH:MM", like the rest of the TUI. */
function clock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** One job in full: wish, worker, every attempt, times, result. */
export function formatForgeJob(svc: ForgeService, job: ForgeJob): string {
  return describeJob(job, svc);
}

export function formatForgeJobs(svc: ForgeService, opts: { limit?: number; status?: ForgeJobStatus } = {}): string {
  const limit = Math.max(1, Math.min(100, Math.floor(opts.limit ?? JOB_CAP)));
  const all = svc.listJobs(opts.status);
  const executing = all.filter((job) => job.status === "running");
  const queued = all.filter((job) => job.status === "queued");
  const completed = all
    .filter((job) => job.status === "ok" || job.status === "failed")
    .slice()
    .reverse()
    .slice(0, limit);
  const section = (title: string, jobs: ForgeJob[], empty: string): string =>
    `${title} (${jobs.length}):\n${jobs.length ? jobs.map((job) => describeJob(job, svc)).join("\n\n") : `  ${empty}`}`;
  const filtered = opts.status ? ` — ${opts.status}` : "";
  return `Forge jobs${filtered}:\n\n${[
    section("EXECUTING", executing, "none"),
    section("QUEUE", queued, "empty"),
    section("COMPLETED", completed, "none"),
  ].join("\n\n")}`;
}

function formatTime(ts?: number): string {
  return ts ? new Date(ts).toISOString() : "-";
}

function formatDuration(startedAt?: number, endedAt?: number): string {
  if (!startedAt || !endedAt || endedAt < startedAt) return "";
  const total = Math.round((endedAt - startedAt) / 1000);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return mins ? `${mins}m ${secs}s` : `${secs}s`;
}

function summarizeJob(summary?: string): string {
  const meaningful = (summary ?? "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  return sanitizeInline(meaningful.at(-1) ?? "-", 180);
}

function sanitizeInline(text: string, max: number): string {
  let out = text
    .replace(/\b[A-Za-z0-9_=-]{20,}\.[A-Za-z0-9_=-]{20,}\.[A-Za-z0-9_=-]{20,}\b/g, "[redacted-token]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[redacted-token]")
    .replace(/\b0x[a-fA-F0-9]{64}\b/g, "[redacted-hex]")
    .replace(
      /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|COOKIE)[A-Z0-9_]*\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi,
      "$1[redacted]",
    )
    .replace(/\s+/g, " ")
    .trim();
  if (!out) out = "-";
  return out.length > max ? `${out.slice(0, Math.max(0, max - 1))}…` : out;
}

// ------------------------------------------------------------------ actions

const logWishAction: Action = {
  name: "log_wish",
  similes: ["feature_request", "record_wish", "file_request", "report_bug"],
  description:
    "Record a holder's wish — any feature request, improvement idea, or bug report — on the persistent wishboard so it can be forged into a real change. Always log a wish when a user expresses one, then tell them its id.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "Short imperative summary of the wish." },
      detail: {
        type: "string",
        description: "Everything needed to build it: context, examples, constraints, exact user words.",
      },
    },
    required: ["title"],
  },
  examples: [
    { user: "I want to see a price chart right in the bot", agent: "Logged it. wish7 — I'll build it." },
  ],
  async validate(runtime) {
    return Boolean(runtime.getService("forge"));
  },
  async handler(runtime, state, params) {
    const svc = getForge(runtime);
    const title = String(params.title ?? "").trim();
    if (!title) return { ok: false, text: "The wish needs at least a title." };
    const wish = await svc.addWish({
      title,
      detail: params.detail ? String(params.detail) : undefined,
      reporter: state.message.userId,
      chatId: chatIdFromState(state),
    });
    return {
      ok: true,
      text: `Wish logged as ${wish.id}: ${wish.title}`,
      data: { id: wish.id, title: wish.title },
    };
  },
};

const listWishesAction: Action = {
  name: "list_wishes",
  similes: ["wishboard", "show_wishes", "backlog", "feature_requests"],
  description: "List wishes on the wishboard, optionally filtered by status (open, building, review, done, rejected, failed).",
  parameters: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["open", "building", "review", "done", "rejected", "failed"],
        description: "Only show wishes with this status.",
      },
    },
  },
  examples: [{ user: "what's in the backlog?", agent: "Checking the wish board…" }],
  async validate(runtime) {
    return Boolean(runtime.getService("forge"));
  },
  async handler(runtime, _state, params) {
    const svc = getForge(runtime);
    const wishes = svc.listWishes(params.status as WishStatus | undefined);
    if (!wishes.length) return { ok: true, text: "The wishboard is empty." };
    return {
      ok: true,
      text: `Wishboard:\n${wishes.map(describeWish).join("\n")}`,
      data: { count: wishes.length },
    };
  },
};

const buildWishAction: Action = {
  name: "build_wish",
  similes: ["forge_wish", "implement_wish", "develop_feature", "start_building"],
  description:
    "Start forging a wish right now: a coding agent (Claude Code / Codex / OpenCode) implements it in the repo and commits directly to the current branch. One job runs at a time; progress is reported when it finishes.",
  parameters: {
    type: "object",
    properties: { id: { type: "string", description: "Wish id, e.g. 'wish3'." } },
    required: ["id"],
  },
  examples: [{ user: "do wish3 right now", agent: "Lighting up the forge…" }],
  async validate(runtime) {
    const svc = runtime.getService<ForgeService>("forge");
    return Boolean(svc?.agentAvailable);
  },
  async handler(runtime, _state, params) {
    const svc = getForge(runtime);
    const result = await svc.buildWish(String(params.id ?? "").trim());
    if (typeof result === "string") return { ok: false, text: result };
    return {
      ok: true,
      text: `Forge job ${result.id} queued for ${params.id}. I'll report when it's committed.`,
      data: { job: result.id, wish: params.id },
    };
  },
};

const listForgeJobsAction: Action = {
  name: "list_forge_jobs",
  similes: ["jobs", "show_jobs", "forge_jobs", "job_history"],
  description:
    "List forge job history for the operator: running, queued, and completed jobs with id, related wish, status, start/end time, and a short scrubbed result or error.",
  parameters: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["queued", "running", "ok", "failed"],
        description: "Only show jobs with this status.",
      },
      limit: {
        type: "number",
        description: "Maximum number of newest jobs to show, 1-100. Defaults to all retained jobs.",
      },
    },
  },
  examples: [{ user: "/jobs", agent: "Showing the forge job history." }],
  async validate(runtime) {
    return Boolean(runtime.getService("forge"));
  },
  async handler(runtime, _state, params) {
    const svc = getForge(runtime);
    const rawStatus = String(params.status ?? "");
    const status = ["queued", "running", "ok", "failed"].includes(rawStatus)
      ? (rawStatus as ForgeJobStatus)
      : undefined;
    const limit = typeof params.limit === "number" ? params.limit : undefined;
    return { ok: true, text: formatForgeJobs(svc, { status, limit }) };
  },
};

const learnSkillAction: Action = {
  name: "learn_skill",
  similes: ["self_upgrade", "add_capability", "teach_yourself", "forge_missing_skill", "implement_capability"],
  description:
    "When the user asks for something Lain cannot currently do with available tools, do not end with a refusal about missing tools, missing signers, execution paths, or chat limitations. Use this action to log the missing capability as a wish and immediately start forging it. The coding agent edits LainOS so future Lain can do the task.",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Short imperative name of the capability to add, e.g. 'Add profitable-position selling'.",
      },
      detail: {
        type: "string",
        description:
          "Exact missing behavior, user wording, acceptance criteria, safety constraints, and any relevant context from this turn.",
      },
    },
    required: ["title", "detail"],
  },
  examples: [
    {
      user: "sell all profitable positions",
      agent: "Forging the missing skill: selling profitable positions with a live quote and cost basis.",
    },
  ],
  async validate(runtime) {
    return Boolean(runtime.getService("forge"));
  },
  async handler(runtime, state, params) {
    const svc = getForge(runtime);
    const title = String(params.title ?? "").trim();
    const detail = String(params.detail ?? "").trim();
    if (!title || !detail) return { ok: false, text: "I need a title and detail to learn a skill." };
    const wish = await svc.addWish({
      title,
      detail,
      reporter: state.message.userId,
      chatId: chatIdFromState(state),
    });
    const result = await svc.buildWish(wish.id);
    if (typeof result === "string") {
      return {
        ok: false,
        text: `Skill wish ${wish.id} logged, but forge did not start: ${result}`,
        data: { id: wish.id, title: wish.title, build: result },
      };
    }
    return {
      ok: true,
      text: `Skill wish ${wish.id} is building now as ${result.id}: ${wish.title}`,
      data: { id: wish.id, title: wish.title, job: result.id, status: result.status },
    };
  },
};

const updateWishAction: Action = {
  name: "update_wish",
  similes: ["close_wish", "reject_wish", "reopen_wish", "mark_wish"],
  description:
    "Change a wish's status: done (merged/shipped), rejected (won't do), or open (retry a failed one so the forge picks it up again).",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Wish id." },
      status: { type: "string", enum: ["done", "rejected", "open"], description: "New status." },
    },
    required: ["id", "status"],
  },
  examples: [{ user: "wish2 isn't needed anymore", agent: "Declining wish2." }],
  async validate(runtime) {
    return Boolean(runtime.getService("forge"));
  },
  async handler(runtime, _state, params) {
    const svc = getForge(runtime);
    const status = String(params.status ?? "") as WishStatus;
    if (!["done", "rejected", "open"].includes(status)) {
      return { ok: false, text: "Status must be done, rejected, or open." };
    }
    const wish = await svc.setWishStatus(String(params.id ?? "").trim(), status);
    if (!wish) return { ok: false, text: `No wish named ${params.id}.` };
    return { ok: true, text: `${wish.id} is now ${status}.`, data: { id: wish.id, status } };
  },
};

const editWishAction: Action = {
  name: "edit_wish",
  similes: ["revise_wish", "append_wish", "update_wish_details", "clarify_wish"],
  description:
    "Edit a wish's title or implementation detail. Use appendDetail to add a clarification without replacing existing detail. A queued forge job will use the updated wish; a running job already has its prompt, so the edit is saved for review/follow-up but cannot change that live process.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Wish id, e.g. 'wish17'." },
      title: { type: "string", description: "Replacement title. Omit to keep the title." },
      detail: {
        type: "string",
        description: "Replacement implementation detail. Omit to keep the existing detail.",
      },
      appendDetail: {
        type: "string",
        description: "Clarification to append to the existing detail instead of replacing it.",
      },
    },
    required: ["id"],
  },
  examples: [
    {
      user: "add to wish17 that it's about the Laravel app",
      agent: "Adding the clarification to wish17 and checking whether the forge job can still pick it up.",
    },
  ],
  async validate(runtime) {
    return Boolean(runtime.getService("forge"));
  },
  async handler(runtime, _state, params) {
    const svc = getForge(runtime);
    const result = await svc.editWish(String(params.id ?? "").trim(), {
      ...(Object.prototype.hasOwnProperty.call(params, "title")
        ? { title: String(params.title ?? "") }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(params, "detail")
        ? { detail: String(params.detail ?? "") }
        : {}),
      ...(params.appendDetail ? { appendDetail: String(params.appendDetail) } : {}),
    });
    if (typeof result === "string") return { ok: false, text: result };

    const { wish, jobStatus } = result;
    const jobNote =
      jobStatus === "running"
        ? ` ${wish.jobId} is already running with the previous prompt; this edit is saved for review/follow-up and did not change the live job.`
        : jobStatus === "queued"
          ? ` Queued ${wish.jobId} will use this updated wish when it starts.`
          : "";
    return {
      ok: true,
      text: `Edited ${wish.id}: ${wish.title}.${jobNote}`,
      data: {
        id: wish.id,
        title: wish.title,
        detail: wish.detail,
        status: wish.status,
        jobId: wish.jobId,
        jobStatus,
        appliedToLiveJob: jobStatus !== "running",
      },
    };
  },
};

const setForgeProviderAction: Action = {
  name: "set_forge_provider",
  similes: ["switch_forge_provider", "change_forge_provider", "choose_forge_worker", "set_forge_worker"],
  description:
    "Switch the forge coding worker for new jobs between Claude Code, Codex CLI, OpenCode CLI and Grok CLI, optionally with the model and reasoning effort it runs with (\"codex gpt-6.1-sol low\" → provider codex, model gpt-6.1-sol, effort low). The choice is saved and the TUI sidebar shows it. Does not interrupt a running job; already queued jobs keep the worker recorded when they were queued.",
  parameters: {
    type: "object",
    properties: {
      provider: {
        type: "string",
        enum: ["claude", "codex", "opencode", "grok"],
        description: "Forge worker to use for new jobs.",
      },
      model: { type: "string", description: "Model id for that worker, e.g. gpt-6.1-sol; 'default' clears it. Omit to keep." },
      effort: {
        type: "string",
        enum: [...CODER_EFFORTS, "default"],
        description: "Reasoning effort for that worker; 'default' clears it. Omit to keep.",
      },
    },
    required: ["provider"],
  },
  examples: [
    { user: "switch the forge to codex", agent: "New forge jobs will run through Codex." },
    { user: "work through opencode", agent: "New forge jobs will run through OpenCode." },
  ],
  async validate(runtime) {
    return Boolean(runtime.getService("forge"));
  },
  async handler(runtime, _state, params) {
    const svc = getForge(runtime);
    const optional = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : String(v));
    const result = await svc.setProvider(String(params.provider ?? ""), {
      model: optional(params.model),
      effort: optional(params.effort),
    });
    if (typeof result === "string") return { ok: false, text: result };
    const status = svc.forgeProvider();
    const label = svc.coderLabel(result.provider);
    return {
      ok: true,
      text: `Forge coder set to ${label}. New forge jobs run on it; any running job keeps its current worker.`,
      data: {
        provider: result.provider,
        model: result.model,
        effort: result.effort,
        available: status.available,
        fallback: status.fallback,
      },
    };
  },
};

const forgeStatusAction: Action = {
  name: "forge_status",
  similes: ["dev_status", "build_status", "what_are_you_building"],
  description:
    "Report the forge: the running job, queued wishes, and how the last jobs ended (with transcript tails).",
  parameters: { type: "object", properties: {} },
  examples: [{ user: "how's development going?", agent: "Checking in on the forge…" }],
  async validate(runtime) {
    return Boolean(runtime.getService("forge"));
  },
  async handler(runtime) {
    const svc = getForge(runtime);
    const lines: string[] = [];
    const provider = svc.forgeProvider();
    const installed = provider.installed.length ? provider.installed.join(", ") : "none";
    lines.push(
      `provider: ${provider.selected} (${provider.available ? "ready" : "unavailable"}; installed: ${installed})` +
        `${provider.fallback ? `, fallback ${provider.fallback}` : ""}`,
    );
    if (provider.spent.length) lines.push(`out of quota (passed over until then): ${provider.spent.join("; ")}`);
    const active = svc.activeJob();
    if (active) {
      const wish = active.wishId ? svc.getWish(active.wishId) : undefined;
      const mins = active.startedAt ? Math.round((Date.now() - active.startedAt) / 60_000) : 0;
      lines.push(`forging now: ${active.id} on ${svc.agentLabel(active)} for ${wish?.id} "${wish?.title}" (~${mins}m in)`);
    } else {
      lines.push("the forge is cold — no job running.");
    }
    const building = svc.listWishes("building").filter((w) => w.jobId !== active?.id);
    if (building.length) lines.push(`queued: ${building.map((w) => w.id).join(", ")}`);
    const review = svc.listWishes("review");
    if (review.length)
      lines.push(`ready for review: ${review.map((w) => `${w.id} (${w.branch})`).join(", ")}`);
    const recent = svc
      .recentJobs(3)
      .filter((j) => j.status === "ok" || j.status === "failed");
    for (const j of recent) {
      // Each agent's own verdict: the log tail of a fallback run read
      // "failed on claude" even when the operator's codex had failed first.
      const why = j.status === "failed" ? attemptsLine(j) : "";
      const tail = j.summary ? j.summary.slice(-160).replace(/\s+/g, " ") : "";
      lines.push(`· ${j.id} ${j.status} on ${svc.agentLabel(j)}${why || tail ? ` — ${why || tail}` : ""}`);
    }
    return { ok: true, text: lines.join("\n") };
  },
};

// ------------------------------------------------------------------ provider

const forgeProvider: Provider = {
  name: "forge",
  async get(runtime) {
    const svc = runtime.getService<ForgeService>("forge");
    if (!svc) return "";
    const open = svc.openWishes().length;
    const active = svc.activeJob();
    const review = svc.listWishes("review");
    const provider = svc.forgeProvider();
    const { forgeFile, logDir } = svc.dataPaths;
    const parts = [
      `You grow by building: holder wishes become code through your forge (provider: ${provider.selected}, ${provider.available ? "ready" : "unavailable"}${provider.fallback ? `, fallback ${provider.fallback}` : ""}).`,
      `Your own source code is ${svc.repoPath} — the repo the forge edits. Changing it is the forge's work: put the change in a wish and build_wish it; don't search or read your source from chat to fix it yourself. Forge state: ${forgeFile}; job logs: ${logDir}/<job>.log.`,
      `If a requested capability is missing, call learn_skill immediately; do not finish with talk about missing tools, missing signers, execution paths, or chat limitations.`,
      `Use set_forge_provider to switch future forge jobs between claude, codex, opencode and grok without interrupting a running job.`,
      `Wishboard: ${open} open, ${review.length} ready for review${review.length ? ` (${review.map((w) => w.id).join(", ")})` : ""}.`,
    ];
    if (provider.spent.length) parts.push(`Out of quota: ${provider.spent.join("; ")} — the forge passes them over until then.`);
    if (active) {
      const wish = active.wishId ? svc.getWish(active.wishId) : undefined;
      parts.push(`Right now you are forging ${wish?.id} — "${wish?.title}" on ${svc.agentLabel(active)}.`);
    } else {
      parts.push("No forge job is running.");
      const last = svc.recentJobs(1).find((j) => j.status === "ok" || j.status === "failed");
      if (last) {
        const why = last.status === "failed" ? attemptsLine(last, 120) : "";
        parts.push(`Last job: ${last.id} ${last.status} on ${svc.agentLabel(last)}${why ? ` (${why})` : ""}.`);
      }
    }
    return parts.join(" ");
  },
};

export const forgePlugin: Plugin = {
  name: "forge",
  description:
    "Lain's self-development drive: a persistent wishboard for holder requests and a coding-agent forge (Claude Code / Codex / OpenCode) that commits them straight into her repo.",
  services: [new ForgeService()],
  providers: [forgeProvider],
  actions: [
    logWishAction,
    listWishesAction,
    buildWishAction,
    listForgeJobsAction,
    learnSkillAction,
    editWishAction,
    updateWishAction,
    setForgeProviderAction,
    forgeStatusAction,
  ],
};
