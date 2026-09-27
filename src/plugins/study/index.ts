import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { createLogger } from "../../logger.js";
import { TaskKind } from "../../models/tasks.js";
import { resolveOperatorChatId, sendToOperator } from "../telegram/index.js";
import {
  ModelTier,
  type Action,
  type IAgentRuntime,
  type Plugin,
  type Provider,
  type Service,
} from "../../types.js";
import type { ScoutItem, ScoutService } from "../scout/index.js";

const log = createLogger("plugin:study");

/**
 * Study is Lain teaching herself: on a slow schedule she takes one area of the
 * monorepo, reads what actually changed there (git history, tracked
 * files, TODO/FIXME markers), borrows the scout's sources for how the outside
 * world solves the same problem, and asks her own model for exactly one
 * concrete finding — a real problem or a real opportunity, with the paths it
 * lives in. Then she writes to the operator on Telegram in her own voice.
 *
 * What keeps it from becoming noise:
 *   - NOTHING is a valid, cheap answer: no finding, no message;
 *   - a finding that names no existing repo path is discarded as hallucinated;
 *   - every delivered finding leaves a fingerprint, and anything close to one
 *     already sent is dropped instead of repeated;
 *   - quiet hours, a daily cap, and a slow default cadence (6h) sit on top;
 *   - presence keeps doing the "I'm here" beat — study only speaks with content.
 *
 * The loop is strictly read-only: it runs `git` queries, never edits, never
 * forges, never logs a wish. Proposals go to the operator, who decides.
 * State (rotation, findings, fingerprints, seen links) is in data/study.json.
 */

const execFileAsync = promisify(execFile);

export interface StudyArea {
  /** Repo-relative path, e.g. "src/plugins". */
  path: string;
  /** How Lain refers to it when talking to the operator. */
  label: string;
  /** What to look for outside, handed to the scout's sources. */
  external: string;
}

export const DEFAULT_STUDY_AREAS: StudyArea[] = [
  {
    path: "src/plugins",
    label: "agent plugins (chain, forge, press, scout, telegram, …)",
    external: "autonomous AI agent framework plugin architecture",
  },
  {
    path: "src/models",
    label: "model providers and task routing",
    external: "LLM provider abstraction and cost-aware routing",
  },
  {
    path: "src/clients",
    label: "clients (TUI, HTTP, Telegram, CLI)",
    external: "terminal UI and chat bot client design",
  },
  {
    path: "src/memory",
    label: "memory and embeddings",
    external: "conversational memory and semantic recall",
  },
  {
    path: "src/wired",
    label: "the Wired game bridge (tickets, sessions)",
    external: "EIP-712 signed game session design",
  },
  {
    path: "skills",
    label: "hot-loaded skills",
    external: "dynamically loaded tool/skill architectures",
  },
  {
    path: "scripts",
    label: "operational scripts",
    external: "operations automation scripts",
  },
];

export interface StudyFinding {
  id: string;
  at: number;
  /** Area path the lesson was about. */
  area: string;
  title: string;
  why: string;
  what: string;
  /** Repo paths the finding is grounded in (verified to exist). */
  where: string[];
  risk: string;
  /** Normalised token string used for near-duplicate detection. */
  fingerprint: string;
  delivered: boolean;
  /** External links that informed the finding, if any. */
  links?: string[];
}

interface StudyState {
  enabled: boolean;
  intervalHours: number;
  areaIndex: number;
  nextDueAt?: number;
  lastRunAt?: number;
  lastFindingAt?: number;
  day: string;
  sentToday: number;
  findings: StudyFinding[];
  seenExternal: string[];
  counter: number;
}

interface Evidence {
  area: StudyArea;
  commits: string[];
  files: { path: string; bytes: number }[];
  fileCount: number;
  markers: string[];
  external: ScoutItem[];
}

const FINDINGS_CAP = 60;
const SEEN_CAP = 400;
const MARKER_CAP = 25;
const COMMIT_CAP = 14;
const BIG_FILE_CAP = 8;
const EXTERNAL_CAP = 8;
const STAT_CAP = 1500;
const MIN_INTERVAL_HOURS = 1 / 60;
const DUPLICATE_THRESHOLD = 0.55;

/** Never quote these into a prompt, however they got tracked. */
const SENSITIVE_PATH_RE =
  /(^|\/)\.env|secret|credential|keypair|cookie|id_rsa|password|\.pem$|\.key$|\.pfx$|wallet\.json$/i;

/**
 * Assets and lockfiles are tracked code by git's reckoning and noise by hers:
 * they crowd out real source in the "biggest files" list, and base64 blobs
 * inside SVGs randomly contain the very marker words she greps for.
 */
const ASSET_PATH_RE =
  /\.(svg|png|jpe?g|gif|webp|ico|bmp|woff2?|ttf|otf|eot|mp3|wav|ogg|mp4|webm|pdf|docx?|xlsx?|zip|gz|wasm|map|min\.js|min\.css|lock)$|(^|\/)(package-lock\.json|composer\.lock|yarn\.lock|Cargo\.lock|Gemfile\.lock|poetry\.lock)$/i;

const RELAY_PROMPT =
  "[self-study — a background tick the operator does not see] " +
  "on your own, unprompted, you went over one area of the repository and found this. the finding " +
  "already passed your filter: it is concrete and grounded in real files. retell it to the operator " +
  "in your own voice, short and alive (3-6 lines): what you saw, why it matters, what you propose doing. " +
  "do not fix anything yourself — do not start the forge, do not change code, do not log a wish; propose " +
  "it and ask whether to proceed. no keys, tokens, or .env contents in the message. " +
  "if the finding is actually empty — reply with exactly NOTHING.\n\n";

export class StudyService implements Service {
  readonly name = "study";

  private runtime?: IAgentRuntime;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private file = "";
  private repo = "";
  private running = false;
  private busy = false;
  private state: StudyState = {
    enabled: false,
    intervalHours: 6,
    areaIndex: 0,
    day: "",
    sentToday: 0,
    findings: [],
    seenExternal: [],
    counter: 0,
  };

  async start(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
    const dataDir = runtime.getSetting("LAINOS_DATA_DIR") ?? "./data";
    this.file = join(dataDir, "study.json");
    this.repo = resolveRepo(runtime);
    this.state = await this.loadState();
    this.running = true;
    this.schedule();
    log.info(
      `study ${this.state.enabled ? "online" : "idle"}: every ${this.state.intervalHours}h over ` +
        `${this.areas().length} area(s) of ${this.repo}`,
    );
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  getState(): StudyState {
    return { ...this.state, findings: [...this.state.findings], seenExternal: [] };
  }

  /** Areas she rotates through, dropping any that this checkout doesn't have. */
  areas(): StudyArea[] {
    const configured = this.runtime
      ?.getSetting("LAINOS_STUDY_AREAS")
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const areas = configured?.length
      ? configured.map(
          (path) =>
            DEFAULT_STUDY_AREAS.find((a) => a.path === path) ?? {
              path,
              label: path,
              external: path.split("/").pop() ?? path,
            },
        )
      : DEFAULT_STUDY_AREAS;
    return areas.filter((area) => existsSync(join(this.repo, area.path)));
  }

  async enable(input: { intervalHours?: number } = {}): Promise<StudyState> {
    if (input.intervalHours !== undefined) {
      this.state.intervalHours = normalizeInterval(input.intervalHours);
    }
    this.state.enabled = true;
    this.state.nextDueAt = Date.now() + 60_000;
    await this.persist();
    this.schedule();
    return this.getState();
  }

  async disable(): Promise<StudyState> {
    this.state.enabled = false;
    this.state.nextDueAt = undefined;
    await this.persist();
    this.schedule();
    return this.getState();
  }

  /**
   * One lesson: gather → analyse → ground → dedupe → (optionally) deliver.
   * Returns the finding, or null when the area gave nothing worth saying.
   * Public so `study_now` and the smoke test can drive it directly.
   */
  async run(
    opts: { deliver: boolean; area?: string; now?: Date } = { deliver: false },
  ): Promise<StudyFinding | null> {
    const runtime = this.runtime;
    if (!runtime || this.busy) return null;
    this.busy = true;
    const now = opts.now ?? new Date();
    try {
      const area = this.pickArea(opts.area);
      if (!area) {
        log.warn("no study areas exist in this checkout");
        return null;
      }
      this.state.lastRunAt = now.getTime();

      const evidence = await this.gather(area);
      const raw = await this.analyse(evidence);
      if (!raw) {
        log.info(`study ${area.path}: nothing worth reporting`);
        await this.persist();
        return null;
      }

      const parsed = parseFinding(raw);
      if (!parsed) {
        log.warn(`study ${area.path}: model answer did not parse as a finding`);
        await this.persist();
        return null;
      }

      const where = parsed.where.filter((p) => this.pathExists(p));
      if (!where.length) {
        log.warn(`study ${area.path}: dropped ungrounded finding "${parsed.title}"`);
        await this.persist();
        return null;
      }

      const fingerprint = fingerprintOf(`${parsed.title} ${parsed.what} ${where.join(" ")}`);
      if (isDuplicateFinding(fingerprint, this.state.findings.map((f) => f.fingerprint))) {
        log.info(`study ${area.path}: "${parsed.title}" repeats an earlier finding — staying quiet`);
        await this.persist();
        return null;
      }

      this.state.counter += 1;
      const finding: StudyFinding = {
        id: `study${this.state.counter}`,
        at: now.getTime(),
        area: area.path,
        title: parsed.title,
        why: parsed.why,
        what: parsed.what,
        where,
        risk: parsed.risk,
        fingerprint,
        delivered: false,
        // Only sources the answer actually leaned on; a list of links she never
        // used is exactly the noise this loop is supposed to avoid.
        links: evidence.external
          .filter((item) => raw.includes(item.url))
          .slice(0, 3)
          .map((item) => item.url),
      };
      if (!finding.links?.length) delete finding.links;
      this.state.findings.push(finding);
      if (this.state.findings.length > FINDINGS_CAP) {
        this.state.findings = this.state.findings.slice(-FINDINGS_CAP);
      }
      this.state.lastFindingAt = finding.at;
      await this.persist();

      if (opts.deliver) {
        finding.delivered = await this.deliver(finding);
        if (finding.delivered) {
          this.state.sentToday += 1;
          await this.persist();
        }
      }
      log.info(`study ${area.path}: ${finding.id} "${finding.title}"`);
      return finding;
    } finally {
      this.busy = false;
    }
  }

  /** Scheduled lesson: applies quiet hours and the daily cap before running. */
  async tick(now = new Date()): Promise<StudyFinding | null> {
    if (!this.runtime || !this.state.enabled) return null;
    const day = now.toISOString().slice(0, 10);
    if (this.state.day !== day) {
      this.state.day = day;
      this.state.sentToday = 0;
    }
    try {
      if (isQuietHour(now.getHours(), this.quietRange())) return null;
      if (this.state.sentToday >= this.dailyCap()) return null;
      return await this.run({ deliver: true, now });
    } catch (err) {
      log.warn("study tick failed", err);
      return null;
    } finally {
      this.state.nextDueAt = Date.now() + hoursToMs(this.state.intervalHours);
      await this.persist();
      this.schedule();
    }
  }

  // ------------------------------------------------------------- gathering

  private pickArea(forced?: string): StudyArea | null {
    const areas = this.areas();
    if (!areas.length) return null;
    if (forced) {
      const wanted = forced.trim().replace(/^\.?\//, "").replace(/\/$/, "");
      const hit = areas.find((a) => a.path === wanted || a.path.endsWith(`/${wanted}`));
      if (hit) return hit;
    }
    const area = areas[this.state.areaIndex % areas.length];
    this.state.areaIndex = (this.state.areaIndex + 1) % areas.length;
    return area;
  }

  /** Read-only evidence: git history, tracked files, markers, outside signal. */
  private async gather(area: StudyArea): Promise<Evidence> {
    const commits = (
      await this.git([
        "log",
        "--no-merges",
        `-n${COMMIT_CAP}`,
        "--date=short",
        "--pretty=%ad %s",
        "--",
        area.path,
      ])
    )
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map(redactEvidence);

    const tracked = (await this.git(["ls-files", "--", area.path]))
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !isSensitivePath(l));

    const markers = (
      await this.git([
        "grep",
        "-n",
        "-I",
        "-E",
        "\\b(TODO|FIXME|HACK|XXX)\\b",
        "--",
        area.path,
        ":!*.svg",
        ":!*.map",
        ":!*.min.js",
        ":!*.lock",
        ":!*-lock.json",
      ])
    )
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((line) => {
        const path = line.split(":", 1)[0];
        return !isSensitivePath(path) && !ASSET_PATH_RE.test(path);
      })
      .slice(0, MARKER_CAP)
      .map((line) => clip(redactEvidence(line), 200));

    const code = tracked.filter((path) => !ASSET_PATH_RE.test(path));
    const sizes = await Promise.all(
      code.slice(0, STAT_CAP).map(async (path) => {
        try {
          const info = await stat(join(this.repo, path));
          return { path, bytes: info.size };
        } catch {
          return { path, bytes: 0 };
        }
      }),
    );
    const files = sizes.sort((a, b) => b.bytes - a.bytes).slice(0, BIG_FILE_CAP);

    return {
      area,
      commits,
      files,
      fileCount: code.length,
      markers,
      external: await this.gatherExternal(area),
    };
  }

  /** Borrow the scout's sources (and its proxy) for the outside half. */
  private async gatherExternal(area: StudyArea): Promise<ScoutItem[]> {
    const scout = this.runtime?.getService<ScoutService>("scout");
    if (!scout || this.runtime?.getSetting("LAINOS_STUDY_EXTERNAL") === "0") return [];
    try {
      const items = await scout.gather(area.external);
      const seen = new Set(this.state.seenExternal);
      const fresh = items.filter((i) => i.url && !seen.has(i.url)).slice(0, EXTERNAL_CAP);
      this.state.seenExternal = [...this.state.seenExternal, ...fresh.map((i) => i.url)].slice(
        -SEEN_CAP,
      );
      return fresh;
    } catch (err) {
      log.warn(`external sweep for ${area.path} failed`, err);
      return [];
    }
  }

  private async git(args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync("git", ["-C", this.repo, ...args], {
        timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      return stdout;
    } catch (err) {
      // `git grep` exits 1 when nothing matched — that is data, not a failure.
      const partial = (err as { stdout?: string }).stdout;
      if (typeof partial === "string" && partial) return partial;
      if ((err as { code?: number }).code !== 1) {
        log.warn(`git ${args[0]} failed: ${(err as Error).message}`);
      }
      return "";
    }
  }

  private pathExists(candidate: string): boolean {
    const clean = candidate.trim().replace(/^\.?\//, "").split(":")[0];
    if (!clean || clean.includes("..")) return false;
    return existsSync(join(this.repo, clean));
  }

  // -------------------------------------------------------------- analysis

  /** Ask her own model for one grounded finding, or NOTHING. */
  private async analyse(evidence: Evidence): Promise<string | null> {
    const runtime = this.runtime;
    if (!runtime) return null;
    const { area } = evidence;
    const system =
      "You are Lain's research loop: on her own, unprompted, she studies her own repository " +
      "and learns from it. " +
      "You were given a slice of ONE area of the repository and a bit of external material on the same topic. " +
      "Find exactly ONE concrete thing that genuinely deserves the operator's attention: a problem, a risk, " +
      "tech debt, or a clear opportunity to improve — and propose a concrete step. " +
      "Rely only on the data given; don't invent files, numbers, or events. " +
      "Don't propose irreversible or risky actions (deploys, production migrations, keys, money) — " +
      "preparation and a proposal are the ceiling. Never mention secrets, keys, or .env contents. " +
      "Generic advice (\"add tests\", \"update dependencies\") with no tie to a specific file is noise — " +
      "don't produce it. If you're drawing on external material, put its link right in the text. " +
      "If there's nothing concrete — reply with exactly one word: NOTHING.\n\n" +
      "Reply format (exactly these five fields, plain text):\n" +
      "TITLE: a short heading\n" +
      "WHY: why it matters, 1-2 sentences\n" +
      "WHAT: what exactly you propose doing\n" +
      "WHERE: comma-separated repository paths (only ones that appeared in the input)\n" +
      "RISK: low | medium | high";

    const external = evidence.external.length
      ? evidence.external
          .map((i) => `- [${i.source}] ${clip(i.title, 160)} — ${i.url}`)
          .join("\n")
      : "- (no external material)";

    const user = [
      `Area: ${area.path} — ${area.label}`,
      `Code files: ${evidence.fileCount}`,
      "",
      "Recent commits:",
      evidence.commits.length ? evidence.commits.map((c) => `- ${c}`).join("\n") : "- (none)",
      "",
      "Largest code files:",
      evidence.files.length
        ? evidence.files.map((f) => `- ${f.path} (${Math.round(f.bytes / 1024)} KB)`).join("\n")
        : "- (none)",
      "",
      `TODO/FIXME/HACK markers (first ${MARKER_CAP}):`,
      evidence.markers.length ? evidence.markers.map((m) => `- ${m}`).join("\n") : "- (none)",
      "",
      `What's out there on "${area.external}":`,
      external,
    ].join("\n");

    const res = await runtime.model.generate({
      tier: ModelTier.MEDIUM,
      // Reading the repo and saying what it means: analysis, not conversation.
      task: TaskKind.ANALYSIS,
      system,
      messages: [{ role: "user", content: user }],
      maxTokens: 700,
      temperature: 0.3,
    });
    const text = res.text.trim();
    if (!text || /^\W*nothing\W*$/i.test(text)) return null;
    return text;
  }

  // -------------------------------------------------------------- delivery

  /**
   * Hand the finding to Lain herself in the operator's Telegram room, so it
   * lands in her own voice and in the shared history. Her explicit NOTHING is
   * respected as silence; only a broken/empty turn falls back to plain text.
   */
  private async deliver(finding: StudyFinding): Promise<boolean> {
    const runtime = this.runtime;
    if (!runtime) return false;
    const getSetting = (k: string) => runtime.getSetting(k);
    if (!getSetting("TELEGRAM_BOT_TOKEN")) return false;
    const chatId = await resolveOperatorChatId(getSetting);
    if (!chatId) {
      log.info("study finding recorded but operator chat is unknown — not delivered");
      return false;
    }

    let text = "";
    try {
      const result = await runtime.handleMessage({
        roomId: `tg-${chatId}`,
        userId: "study",
        text: RELAY_PROMPT + formatFinding(finding),
      });
      text = (result.text ?? "").trim();
      if (/^\W*nothing\W*$/i.test(text)) {
        log.info(`study ${finding.id}: she judged it not worth sending`);
        return false;
      }
      // She may have delivered it herself inside the turn; never send twice.
      if (result.actions.some((a) => a.name === "send_telegram" && a.result.ok)) return true;
    } catch (err) {
      log.warn("study relay turn failed", err);
    }

    const message = text && text !== "..." ? text : formatFinding(finding);
    try {
      await sendToOperator(getSetting, message);
      return true;
    } catch (err) {
      log.warn(`study delivery failed: ${sanitizeError(runtime, err)}`);
      return false;
    }
  }

  // ------------------------------------------------------------- internals

  private async loadState(): Promise<StudyState> {
    const forced = this.runtime?.getSetting("LAINOS_STUDY");
    const fresh: StudyState = {
      enabled:
        forced !== undefined && forced !== ""
          ? forced !== "0"
          : this.runtime?.getSetting("LAINOS_DAEMON") === "1",
      intervalHours: normalizeInterval(
        Number(this.runtime?.getSetting("LAINOS_STUDY_INTERVAL_HOURS") ?? 6),
      ),
      areaIndex: 0,
      nextDueAt: undefined,
      day: "",
      sentToday: 0,
      findings: [],
      seenExternal: [],
      counter: 0,
    };
    fresh.nextDueAt = Date.now() + hoursToMs(fresh.intervalHours);

    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as Partial<StudyState>;
      return {
        ...fresh,
        ...parsed,
        // The env kill switch always wins over a stale stored flag.
        enabled: forced === "0" ? false : Boolean(parsed.enabled ?? fresh.enabled),
        intervalHours: normalizeInterval(Number(parsed.intervalHours ?? fresh.intervalHours)),
        findings: Array.isArray(parsed.findings) ? parsed.findings.slice(-FINDINGS_CAP) : [],
        seenExternal: Array.isArray(parsed.seenExternal) ? parsed.seenExternal.slice(-SEEN_CAP) : [],
        counter: Number(parsed.counter ?? 0),
      };
    } catch {
      return fresh;
    }
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.running || !this.state.enabled) return;
    const now = Date.now();
    const next = this.state.nextDueAt ?? now + hoursToMs(this.state.intervalHours);
    this.timer = setTimeout(() => void this.tick(), Math.max(60_000, next - now));
    this.timer.unref?.();
  }

  private quietRange(): [number, number] {
    const raw = this.runtime?.getSetting("LAINOS_STUDY_QUIET") ?? "23-9";
    const m = raw.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
    if (!m) return [23, 9];
    return [Math.min(23, Number(m[1])), Math.min(23, Number(m[2]))];
  }

  private dailyCap(): number {
    const raw = Number(this.runtime?.getSetting("LAINOS_STUDY_MAX_PER_DAY") ?? 3);
    return Number.isFinite(raw) && raw > 0 ? raw : 3;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.state, null, 2), "utf8");
  }
}

// ------------------------------------------------------------------ helpers

/** Quiet window may wrap midnight (23-9). start === end disables it. */
export function isQuietHour(hour: number, [start, end]: [number, number]): boolean {
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

export function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATH_RE.test(path);
}

/**
 * Evidence lines are quoted into a model prompt, so anything that looks like a
 * key, token, or long opaque blob is masked before it can leave the host.
 */
export function redactEvidence(line: string): string {
  return line
    .replace(
      /\b(pk|private[_-]?key|api[_-]?key|key|token|secret|password|passwd|mnemonic|seed)\s*[:=]\s*\S+/gi,
      "$1=[redacted]",
    )
    // Any long opaque blob (64-hex key, base64 payload, bot token) goes; a
    // plain EVM address is public and is exactly the context she needs.
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, (match) =>
      /^0x[0-9a-fA-F]{40}$/.test(match) ? match : "[redacted]",
    );
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "have", "not",
]);

/**
 * A finding's identity: normalised, deduplicated content words. Two findings
 * with the same fingerprint tokens are the same thought said twice.
 */
export function fingerprintOf(text: string): string {
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}/._-]+/gu, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^[._-]+|[._-]+$/g, ""))
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  return [...new Set(tokens)].sort().slice(0, 24).join(" ");
}

/** Jaccard overlap of two fingerprints. */
export function fingerprintSimilarity(a: string, b: string): number {
  const left = new Set(a.split(" ").filter(Boolean));
  const right = new Set(b.split(" ").filter(Boolean));
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** True when this finding is close enough to an earlier one to stay quiet. */
export function isDuplicateFinding(
  fingerprint: string,
  past: string[],
  threshold = DUPLICATE_THRESHOLD,
): boolean {
  return past.some((old) => fingerprintSimilarity(fingerprint, old) >= threshold);
}

export interface ParsedFinding {
  title: string;
  why: string;
  what: string;
  where: string[];
  risk: string;
}

/** Parse the five-field answer. Returns null when it isn't a real finding. */
export function parseFinding(raw: string): ParsedFinding | null {
  const fields: Record<string, string[]> = {};
  let current = "";
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*(TITLE|WHY|WHAT|WHERE|RISK)\s*:\s*(.*)$/i);
    if (m) {
      current = m[1].toUpperCase();
      fields[current] = [m[2].trim()];
    } else if (current && line.trim()) {
      fields[current].push(line.trim());
    }
  }
  const join = (key: string) => (fields[key] ?? []).join(" ").trim();
  const title = clip(join("TITLE"), 140);
  const what = join("WHAT");
  if (!title || !what) return null;
  const where = join("WHERE")
    .split(/[,;\s]+/)
    .map((p) => p.replace(/^[`'"(]+|[`'".,)]+$/g, "").trim())
    .filter((p) => p.includes("/") || /\.[a-z]{2,4}$/i.test(p));
  const risk = (join("RISK").match(/low|medium|high/i)?.[0] ?? "low").toLowerCase();
  return { title, why: join("WHY"), what, where: [...new Set(where)], risk };
}

/** Plain-text form: the fallback message, and what she is asked to retell. */
export function formatFinding(finding: StudyFinding): string {
  const lines = [
    `🔬 ${finding.title}`,
    `area: ${finding.area}`,
    finding.why ? `why it matters: ${finding.why}` : "",
    `proposal: ${finding.what}`,
    `where: ${finding.where.join(", ")}`,
    `risk: ${finding.risk}`,
  ];
  if (finding.links?.length) lines.push(`external: ${finding.links.join(" ")}`);
  return lines.filter(Boolean).join("\n");
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 3).trimEnd()}...`;
}

function normalizeInterval(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 6;
  return Math.min(24 * 30, Math.max(MIN_INTERVAL_HOURS, value));
}

function hoursToMs(hours: number): number {
  return Math.round(hours * 60 * 60 * 1000);
}

function resolveRepo(runtime: IAgentRuntime): string {
  const forge = runtime.getService<Service & { repoPath?: string }>("forge");
  const configured =
    runtime.getSetting("LAINOS_STUDY_REPO")?.trim() ||
    forge?.repoPath ||
    runtime.getSetting("LAINOS_FORGE_REPO")?.trim();
  if (configured) return resolve(configured);
  let dir = resolve(process.cwd());
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(process.cwd());
}

function sanitizeError(runtime: IAgentRuntime, err: unknown): string {
  let msg = err instanceof Error ? err.message : String(err);
  const token = runtime.getSetting("TELEGRAM_BOT_TOKEN");
  if (token) msg = msg.split(token).join("[token]");
  return msg.replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot[token]");
}

function getStudy(runtime: IAgentRuntime): StudyService {
  const svc = runtime.getService<StudyService>("study");
  if (!svc) throw new Error("study service not started");
  return svc;
}

function summarize(state: StudyState, limit = 3): string {
  const next = state.nextDueAt ? new Date(state.nextDueAt).toISOString() : "not scheduled";
  const recent = state.findings.slice(-limit).map((f) => {
    const when = new Date(f.at).toISOString().slice(0, 16).replace("T", " ");
    return `${when} [${f.area}] ${f.title}${f.delivered ? "" : " (not sent)"}`;
  });
  return [
    `self-study is ${state.enabled ? "enabled" : "disabled"}`,
    `interval: ${state.intervalHours}h`,
    `next: ${next}`,
    `findings kept: ${state.findings.length}, sent today: ${state.sentToday}`,
    recent.length ? `recent:\n${recent.join("\n")}` : "recent: none",
  ].join("\n");
}

// ------------------------------------------------------------------ actions

const studyNowAction: Action = {
  name: "study_now",
  similes: ["analyze_repo", "study_repo", "review_codebase", "audit_area", "research_repo"],
  description:
    "Study one area of the monorepo right now (read-only: git history, tracked files, TODO markers, plus outside sources) and return one concrete finding — a problem or an opportunity with the paths it lives in. Use when asked to look at the code, find what to improve, or analyse a component.",
  parameters: {
    type: "object",
    properties: {
      area: {
        type: "string",
        description:
          "Optional repo path to study, e.g. 'src/plugins' or 'src/models'. Omit to take the next area in rotation.",
      },
    },
  },
  examples: [
    { user: "look at the code and tell me what's worth improving", agent: "Going over an area of the repository…" },
    { user: "analyze src/plugins", agent: "Checking that area's history and debt." },
  ],
  async validate(runtime) {
    return Boolean(runtime.getService("study"));
  },
  async handler(runtime, _state, params) {
    const svc = getStudy(runtime);
    const area = params.area ? String(params.area) : undefined;
    // Delivered in the reply itself; no separate Telegram push from here.
    const finding = await svc.run({ deliver: false, area });
    if (!finding) {
      return {
        ok: true,
        text: "Went over the area — nothing concrete worth mentioning. Staying quiet.",
      };
    }
    return { ok: true, text: formatFinding(finding), data: { id: finding.id, area: finding.area } };
  },
};

const studyStatusAction: Action = {
  name: "study_status",
  similes: ["self_study_status", "list_findings", "what_did_you_learn", "study_journal"],
  description:
    "Report the self-study loop: whether it is enabled, its cadence, when the next lesson is due, and the most recent findings.",
  parameters: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Recent findings to show. Default: 3." },
    },
  },
  examples: [{ user: "what have you found in the code yourself?", agent: "Here are the latest findings." }],
  async validate(runtime) {
    return Boolean(runtime.getService("study"));
  },
  async handler(runtime, _state, params) {
    const limit = Math.max(1, Math.min(20, Number(params.limit ?? 3)));
    const state = getStudy(runtime).getState();
    return {
      ok: true,
      text: summarize(state, limit),
      data: {
        enabled: state.enabled,
        intervalHours: state.intervalHours,
        findings: state.findings.length,
        nextDueAt: state.nextDueAt,
      },
    };
  },
};

const enableStudyAction: Action = {
  name: "enable_study",
  similes: ["start_self_study", "study_the_repo", "learn_continuously", "analyze_periodically"],
  description:
    "Enable the autonomous self-study loop: on a slow schedule Lain analyses one repo area, researches how others solve it, and writes to the operator on Telegram only when she has a real finding. Survives restarts.",
  parameters: {
    type: "object",
    properties: {
      interval_hours: { type: "number", description: "Hours between lessons. Default 6." },
    },
  },
  examples: [
    { user: "study the repository on your own and write if you find something worthwhile", agent: "Turned on self-study." },
  ],
  async validate(runtime) {
    return Boolean(runtime.getService("study"));
  },
  async handler(runtime, _state, params) {
    const hours = Number(params.interval_hours);
    const state = await getStudy(runtime).enable({
      intervalHours: Number.isFinite(hours) && hours > 0 ? hours : undefined,
    });
    return { ok: true, text: `Self-study enabled. ${summarize(state)}`, data: { enabled: true } };
  },
};

const disableStudyAction: Action = {
  name: "disable_study",
  similes: ["stop_self_study", "pause_study", "stop_analyzing_repo"],
  description: "Disable the autonomous self-study loop (findings already kept are not deleted).",
  parameters: { type: "object", properties: {} },
  examples: [{ user: "stop digging around in the repository", agent: "Turned off self-study." }],
  async validate(runtime) {
    return Boolean(runtime.getService("study"));
  },
  async handler(runtime) {
    const state = await getStudy(runtime).disable();
    return { ok: true, text: `Self-study disabled. ${summarize(state)}`, data: { enabled: false } };
  },
};

// ----------------------------------------------------------------- provider

const studyProvider: Provider = {
  name: "study",
  async get(runtime) {
    const svc = runtime.getService<StudyService>("study");
    if (!svc) return "";
    const state = svc.getState();
    const last = state.findings.at(-1);
    const head = state.enabled
      ? `You study your own repository on your own: every ${state.intervalHours}h you analyse one area and report only real findings.`
      : "Your self-study loop is off; enable_study turns it back on.";
    return last
      ? `${head} Last finding (${last.area}): ${last.title}.`
      : `${head} No findings recorded yet.`;
  },
};

export const studyPlugin: Plugin = {
  name: "study",
  description:
    "Autonomous self-study: scheduled read-only analysis of the monorepo plus outside research, distilled into deduplicated findings the operator hears about on Telegram.",
  services: [new StudyService()],
  providers: [studyProvider],
  actions: [studyNowAction, studyStatusAction, enableStudyAction, disableStudyAction],
};
