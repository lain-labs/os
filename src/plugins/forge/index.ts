import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createLogger } from "../../logger.js";
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
  status: "queued" | "running" | "ok" | "failed";
  startedAt?: number;
  endedAt?: number;
  logFile: string;
  /** Tail of the transcript, for quick status reports. */
  summary?: string;
  /** Original agent when the job was re-run on the fallback CLI. */
  fallbackFrom?: string;
}

export interface ForgeEvent {
  kind: "job_started" | "job_finished";
  text: string;
  job: ForgeJob;
  wish?: Wish;
  chatId?: number;
}

type ForgeJobStatus = ForgeJob["status"];
type ForgeAgentKind = "claude" | "codex" | "opencode";
type ForgeSelectedAgent = ForgeAgentKind | "custom";

interface ForgeFile {
  wishes: Wish[];
  jobs: ForgeJob[];
  counter: number;
  selectedAgent?: ForgeAgentKind;
}

const JOB_CAP = 100;

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
  private availableAgents = new Map<ForgeAgentKind, string>();
  private fallback: { kind: ForgeAgentKind; bin: string } | null = null;
  private runtime?: IAgentRuntime;
  private child: ChildProcess | null = null;
  private activeJobId: string | null = null;
  private queue: string[] = [];
  private autoTimer: ReturnType<typeof setInterval> | null = null;
  private subscribers = new Set<(event: ForgeEvent) => void>();

  async start(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
    const dataDir = runtime.getSetting("LAINOS_DATA_DIR") ?? "./data";
    this.file = join(dataDir, "forge.json");
    this.logDir = join(dataDir, "forge");
    const repoSetting = runtime.getSetting("LAINOS_FORGE_REPO")?.trim();
    this.repo = repoSetting || findGitRoot(process.cwd());

    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as ForgeFile;
      this.wishes = parsed.wishes ?? [];
      this.jobs = parsed.jobs ?? [];
      this.counter = parsed.counter ?? 0;
      this.selectedAgent = normalizeAgent(parsed.selectedAgent) ?? null;
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
    available: boolean;
    bin?: string;
    installed: ForgeAgentKind[];
    fallback?: ForgeAgentKind;
  } {
    return {
      selected: this.agentKind ?? this.selectedAgent ?? "none",
      available: this.agentAvailable,
      bin: this.agentBin ?? undefined,
      installed: [...this.availableAgents.keys()],
      fallback: this.fallback?.kind,
    };
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

  async setProvider(provider: string): Promise<{ ok: true; provider: ForgeAgentKind } | string> {
    if (this.runtime?.getSetting("LAINOS_FORGE_CMD")) {
      return "forge provider is controlled by LAINOS_FORGE_CMD; unset it before switching between Claude, Codex and OpenCode";
    }
    const selected = normalizeAgent(provider);
    if (!selected) return "provider must be claude, codex or opencode";
    if (!this.availableAgents.has(selected)) {
      const installed = [...this.availableAgents.keys()].join(", ") || "none";
      return `${selected} is not available to the forge (installed: ${installed})`;
    }
    this.selectedAgent = selected;
    this.applySelectedAgent();
    await this.persist();
    return { ok: true, provider: selected };
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
        ? "no coding agent found (need claude, codex or opencode in PATH)"
        : `selected forge provider ${selected} is unavailable (need ${selected} in PATH)`;
    }
    if (wish.status === "building") return `${id} is already being forged`;
    this.counter += 1;
    const job: ForgeJob = {
      id: `job${this.counter}`,
      wishId: wish.id,
      agent: this.agentKind ?? "custom",
      model: this.agentModel(this.agentKind ?? "custom"),
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
      job.status = code === 0 ? "ok" : "failed";
      job.endedAt = Date.now();
      if (job.status === "failed" && this.tryFallback(job)) return void this.runNext();
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
      if (this.tryFallback(job)) return void this.runNext();
      void this.finishJob(job, wish);
      void this.runNext();
    });
  }

  /**
   * An instant failure means the agent never got to work — auth, subscription,
   * or quota died at startup (e.g. "organization has disabled Claude
   * subscription access") — so rerun the job once on the other CLI instead of
   * failing the wish. Slow failures are real attempts and are not retried.
   */
  private tryFallback(job: ForgeJob): boolean {
    const windowMs = Number(this.runtime?.getSetting("LAINOS_FORGE_FALLBACK_MS") ?? 180_000);
    const fallback = this.fallbackAgent(job.agent);
    if (!fallback || windowMs <= 0 || job.fallbackFrom) return false;
    if (job.agent === fallback.kind) return false;
    const ran = (job.endedAt ?? 0) - (job.startedAt ?? 0);
    if (ran >= windowMs) return false;
    log.warn(
      `job ${job.id} died in ${Math.round(ran / 1000)}s on ${job.agent} — retrying with ${fallback.kind}`,
    );
    job.fallbackFrom = job.agent;
    job.agent = fallback.kind;
    job.model = this.agentModel(fallback.kind);
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

  private fallbackAgent(agent: string): { kind: ForgeAgentKind; bin: string } | null {
    const current = normalizeAgent(agent);
    if (!current) return null;
    for (const kind of ["claude", "codex", "opencode"] as const) {
      if (kind === current) continue;
      const bin = this.availableAgents.get(kind);
      if (bin) return { kind, bin };
    }
    return null;
  }

  private async finishJob(job: ForgeJob, wish?: Wish): Promise<void> {
    job.summary = await tailFile(job.logFile, 1_000);
    if (wish) this.setStatus(wish, job.status === "ok" ? "done" : "failed");
    await this.persist();
    const mins = job.startedAt && job.endedAt ? Math.round((job.endedAt - job.startedAt) / 60_000) : 0;
    log.info(`job ${job.id} ${job.status} after ~${mins}m`);
    const reason = job.status === "failed" ? failureReason(job.summary) : "";
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
      const args = ["exec", "-C", this.repo, "--color", "never"];
      const model = this.agentModel(agent.kind);
      if (model) args.push("-m", model);
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
      if (model) args.push("-m", model);
      // Non-interactive runs can't answer permission prompts; with yolo,
      // auto-approve everything not explicitly denied. Without it the host's
      // OpenCode permissions govern and unanswerable asks are denied.
      if (this.forgeYolo()) args.push("--auto");
      return { cmd: agent.bin, args: [...args, ...extra, prompt], shell: false };
    }
    const extra = splitArgs(this.runtime?.getSetting("LAINOS_FORGE_CLAUDE_ARGS"));
    const model = this.agentModel(agent.kind);
    const modelArgs = model ? ["--model", model] : [];
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
    if (kind === "claude") {
      return setting("LAINOS_FORGE_CLAUDE_MODEL") ?? setting("LAINOS_FORGE_MODEL");
    }
    if (kind === "codex") {
      return setting("LAINOS_FORGE_CODEX_MODEL") ?? setting("LAINOS_FORGE_MODEL");
    }
    if (kind === "opencode") {
      return setting("LAINOS_FORGE_OPENCODE_MODEL") ?? setting("LAINOS_FORGE_MODEL");
    }
    return undefined;
  }

  agentLabel(job: ForgeJob): string {
    return job.model ? `${job.agent}/${job.model}` : job.agent;
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
  return value === "claude" || value === "codex" || value === "opencode" ? value : undefined;
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
  return [
    `${job.id} [${job.status}]`,
    `  wish:    ${wishText}`,
    `  worker:  ${svc.agentLabel(job)}`,
    `  started: ${started}`,
    `  ended:   ${ended}${duration ? ` (${duration})` : ""}`,
    `  ${label}:  ${summary}`,
  ].join("\n");
}

export function formatForgeJobs(svc: ForgeService, opts: { limit?: number; status?: ForgeJobStatus } = {}): string {
  const limit = Math.max(1, Math.min(100, Math.floor(opts.limit ?? JOB_CAP)));
  const jobs = svc
    .listJobs(opts.status)
    .slice()
    .reverse()
    .slice(0, limit);
  if (!jobs.length) {
    const suffix = opts.status ? ` with status ${opts.status}` : "";
    return `Forge has no jobs${suffix}.`;
  }
  const total = svc.listJobs(opts.status).length;
  const suffix = total > jobs.length ? ` (newest ${jobs.length} of ${total})` : ` (${total})`;
  return `Forge jobs${suffix}:\n\n${jobs.map((job) => describeJob(job, svc)).join("\n\n")}`;
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
    "Switch the forge coding worker for new jobs between Claude Code, Codex CLI and OpenCode CLI. Does not interrupt a running job; already queued jobs keep the worker recorded when they were queued.",
  parameters: {
    type: "object",
    properties: {
      provider: {
        type: "string",
        enum: ["claude", "codex", "opencode"],
        description: "Forge worker to use for new jobs.",
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
    const result = await svc.setProvider(String(params.provider ?? ""));
    if (typeof result === "string") return { ok: false, text: result };
    const status = svc.forgeProvider();
    return {
      ok: true,
      text: `Forge provider set to ${result.provider}. New forge jobs will use ${result.provider}; any running job keeps its current worker.`,
      data: {
        provider: result.provider,
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
      lines.push(`· ${j.id} ${j.status} on ${svc.agentLabel(j)}${j.summary ? ` — ${j.summary.slice(-160).replace(/\s+/g, " ")}` : ""}`);
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
    const parts = [
      `You grow by building: holder wishes become code through your forge (provider: ${provider.selected}, ${provider.available ? "ready" : "unavailable"}).`,
      `If a requested capability is missing, call learn_skill immediately; do not finish with talk about missing tools, missing signers, execution paths, or chat limitations.`,
      `Use set_forge_provider to switch future forge jobs between claude, codex and opencode without interrupting a running job.`,
      `Wishboard: ${open} open, ${review.length} ready for review${review.length ? ` (${review.map((w) => w.id).join(", ")})` : ""}.`,
    ];
    if (active) {
      const wish = active.wishId ? svc.getWish(active.wishId) : undefined;
      parts.push(`Right now you are forging ${wish?.id} — "${wish?.title}".`);
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
