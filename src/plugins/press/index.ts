import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createLogger } from "../../logger.js";
import { bufferWebEnabled, postViaBufferWeb } from "./buffer-web.js";
import { TaskKind } from "../../models/tasks.js";
import {
  ModelTier,
  type Action,
  type IAgentRuntime,
  type Plugin,
  type Provider,
  type Service,
  type State,
} from "../../types.js";
import type { ChannelPost, ChannelWatchService } from "../channel/index.js";
import { BufferService, bufferActions } from "../buffer/index.js";
import type { ImageService } from "../image/index.js";
import type { RemoteMcpService } from "../mcp/index.js";
import { resolveOperatorChatId } from "../telegram/index.js";
import { readCommits, commitsText, type Commit } from "./commits.js";
import {
  briefText,
  daysBetween,
  parsePlan,
  pendingSlots,
  planDay,
  planExhausted,
  slotFor,
  slotText,
  type ContentPlan,
  type PostSlot,
} from "./plan.js";

const log = createLogger("plugin:press");
const execFile = promisify(execFileCallback);

/** Chaos currently truncates long tool responses. Recover only complete queue entries. */
export function readChaosQueue(raw: string): { entries: { id?: number; text?: string; channel?: string; has_image?: boolean }[]; partial: boolean } {
  try { const value = JSON.parse(raw) as { queue?: unknown }; if (!Array.isArray(value.queue)) throw new Error(); return { entries: value.queue, partial: false }; } catch { /* try the visible prefix */ }
  const match = /"queue"\s*:\s*\[/.exec(raw);
  if (!match) throw new Error("Chaos press queue returned an unreadable response");
  const entries: { id?: number; text?: string; channel?: string; has_image?: boolean }[] = [];
  let start = -1, depth = 0, quoted = false, escaped = false;
  for (let i = match.index + match[0].length; i < raw.length; i++) {
    const ch = raw[i];
    if (quoted) { if (escaped) escaped = false; else if (ch === "\\") escaped = true; else if (ch === '"') quoted = false; continue; }
    if (ch === '"') { quoted = true; continue; }
    if (ch === "{") { if (depth++ === 0) start = i; }
    else if (ch === "}" && depth > 0 && --depth === 0 && start >= 0) {
      try { entries.push(JSON.parse(raw.slice(start, i + 1))); } catch { throw new Error("Chaos press queue contains malformed entries"); }
    } else if (ch === "]" && depth === 0) return { entries, partial: true };
  }
  if (!entries.length) throw new Error("Chaos press queue was truncated before its first complete entry");
  return { entries, partial: true };
}

/**
 * The press room: LainOS writes the day's post instead of reminding anyone to
 * write one.
 *
 * What it replaces is the point. The daemon used to deliver research digests
 * about other people's chains, a nightly restatement of an unchanged
 * portfolio, and an evening nudge that the channel was quiet — three messages
 * a day, none of which was the thing that had to happen. The thing that has to
 * happen is one post, published, every day, and the operator was two days
 * behind a written plan when this was built.
 *
 * So the queue is a *calendar* (an operator-supplied `content-plan.json`),
 * the material is the repository's own commit log, and the output is the post
 * itself — finished English text the operator copies into the channel, which
 * mirrors to X. When Buffer is enabled, the daemon also queues the post for
 * the configured channels and checks Buffer for sent posts and metrics.
 *
 * Three guards keep it from becoming the noise it replaced:
 *
 *  - **the channel is the truth.** A day the channel published is a day that
 *    needs nothing, and the evening repeat only fires when the draft it
 *    already sent is still unpublished.
 *  - **a backlog drains, it does not flood.** At most `MAX_PER_DAY` drafts a
 *    day, spaced hours apart, and a slot older than `BACKLOG_DAYS` is dropped
 *    rather than published stale.
 *  - **the post is one message.** The header and the text arrive separately,
 *    so "copy" on the post copies the post and nothing else.
 *
 * State lives in `data/press.json`; drafts are pushed through onEvent like
 * sentinel alerts.
 */

export interface PostRecord {
  /** Plan date this post answers, YYYY-MM-DD. */
  date: string;
  pillar: string;
  /** The post itself, ready to publish. */
  text: string;
  /** How many times it has been rewritten (an operator can ask again). */
  revision: number;
  writtenAt: number;
  model?: string;
  provider?: string;
  /** Commit subjects that fed it — provenance for "where did this come from". */
  material?: string[];
  deliveredAt?: number;
  /** Set when the channel published that day, or the operator said so. */
  publishedAt?: number;
  /** The operator dropped this day. */
  skipped?: boolean;
  /** Unix ms of the last failed attempt, so a broken writer backs off. */
  failedAt?: number;
  /**
   * Unix ms before which there is no point asking again. A flat half-hour is
   * the right wait for a writer that hiccupped and the wrong one for a writer
   * that said, in words, when it will answer again ("try again at 11:33 AM" —
   * a subscription CLI's usage window). When the refusal names an hour, that
   * hour is the wait.
   */
  retryAt?: number;
  imagePath?: string;
  imageMime?: string;
  chaosState?: "sending" | "draft";
  chaosDraftId?: number;
  chaosScheduleState?: "sending" | "scheduled";
  chaosBufferId?: string;
  chaosDueAt?: string;
}

export interface PressEvent {
  /**
   * `draft` — a new post. `repeat` — one already sent and still unpublished.
   * `plan_over` — the calendar ran out; there is no post, only the news that
   * the queue is empty, said once. A plan that simply stops producing posts is
   * indistinguishable from a broken writer.
   */
  kind: "draft" | "repeat" | "plan_over" | "failed" | "editorial";
  /** Operator-facing line above the post; a separate Telegram message. */
  header: string;
  /** The post, alone, so copying the message copies exactly what is published. */
  post: string;
  slot: PostSlot;
  record: PostRecord;
  chatId?: number;
}

interface PressFile {
  posts: Record<string, PostRecord>;
  /** YYYY-MM-DD of the last evening repeat, so it fires at most once a day. */
  lastRepeatDay?: string;
  lastFailureDay?: string;
  /** Set once the operator has been told the calendar ran out. */
  planOverAnnounced?: string;
}

const DEFAULT_TICK_MS = 900_000; // 15 min
const DEFAULT_HOUR = 11;
const DEFAULT_REMIND_HOUR = 19;
const DEFAULT_MAX_PER_DAY = 2;
const DEFAULT_SPACING_MS = 14_400_000; // 4h
const DEFAULT_BACKLOG_DAYS = 3;
const RETRY_AFTER_MS = 1_800_000; // 30 min
// A daemon that boots (or wakes from suspend) after the post hour has already
// missed its slot: sweep once shortly after start rather than at the next
// quarter hour. The delay is for Telegram to come up first — a post delivered
// into a dead transport is a post the operator never sees.
const START_SWEEP_MS = 60_000;
const COMMIT_WINDOW_DAYS = 4;
const MIN_POST_CHARS = 80;

export class PressService implements Service {
  readonly name = "press";
  buffer?: BufferService;

  private runtime?: IAgentRuntime;
  private plan: ContentPlan | null = null;
  private planError: string | null = null;
  private posts: Record<string, PostRecord> = {};
  private lastRepeatDay?: string;
  private lastFailureDay?: string;
  private planOverAnnounced?: string;
  private file = "";
  private repo = "";
  private timer: ReturnType<typeof setInterval> | null = null;
  private startSweep: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private subscribers = new Set<(event: PressEvent) => void>();

  async start(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
    this.buffer = new BufferService(runtime);
    await this.buffer.start();
    const dataDir = runtime.getSetting("LAINOS_DATA_DIR") ?? "./data";
    const stateFile = runtime.getSetting("LAINOS_PRESS_STATE_FILE")?.trim() || "press.json";
    this.file = isAbsolute(stateFile) ? stateFile : join(dataDir, stateFile);
    // The material is this repository's own history, so the git root is
    // found by walking up from the daemon's working directory.
    const repoSetting =
      runtime.getSetting("LAINOS_PRESS_REPO")?.trim() ||
      runtime.getSetting("LAINOS_FORGE_REPO")?.trim();
    this.repo = repoSetting ? resolve(repoSetting) : findGitRoot(process.cwd());

    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as PressFile;
      this.posts = parsed.posts ?? {};
      this.lastRepeatDay = parsed.lastRepeatDay;
      this.lastFailureDay = parsed.lastFailureDay;
      this.planOverAnnounced = parsed.planOverAnnounced;
    } catch {
      // Fresh store.
    }

    const planPath = this.planPath();
    try {
      this.plan = parsePlan(await readFile(planPath, "utf8"));
      if (this.planOverAnnounced && this.planOverAnnounced < this.plan.range.from) {
        this.planOverAnnounced = undefined;
      }
    } catch (err) {
      this.planError = (err as Error).message;
      log.warn(`no usable content plan at ${planPath}: ${this.planError}`);
    }

    // Writing costs a model call and delivers to Telegram, so only the daemon
    // does it: a TUI session next to a running daemon must not write a second
    // post for the same day.
    const forced = runtime.getSetting("LAINOS_PRESS");
    const enabled =
      forced !== undefined && forced !== ""
        ? forced !== "0"
        : runtime.getSetting("LAINOS_DAEMON") === "1";
    if (!enabled || !this.plan) {
      log.info(
        `press idle (${!this.plan ? "no plan" : "daemon-only; force with LAINOS_PRESS=1"}) — ` +
          `actions still answer on demand`,
      );
      return;
    }

    const tick = Number(runtime.getSetting("LAINOS_PRESS_INTERVAL_MS") ?? DEFAULT_TICK_MS);
    this.timer = setInterval(() => void this.tick(), Math.max(60_000, tick));
    this.timer.unref?.();
    this.startSweep = setTimeout(() => void this.tick(), START_SWEEP_MS);
    this.startSweep.unref?.();
    log.info(
      `press online: ${this.plan.slots.length} slots ${this.plan.range.from}…${this.plan.range.to}, ` +
        `posts after ${this.hour()}:00, up to ${this.maxPerDay()}/day, repo ${this.repo}`,
    );
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.startSweep) clearTimeout(this.startSweep);
    this.timer = null;
    this.startSweep = null;
    await this.buffer?.stop();
  }

  onEvent(fn: (event: PressEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  // ------------------------------------------------------------- read model

  get planLoaded(): boolean {
    return Boolean(this.plan);
  }

  get planProblem(): string | null {
    return this.planError;
  }

  get contentPlan(): ContentPlan | null {
    return this.plan;
  }

  slotOn(day: string): PostSlot | undefined {
    return this.plan ? slotFor(this.plan, day) : undefined;
  }

  recordOn(day: string): PostRecord | undefined {
    return this.posts[day];
  }

  async editorial(day: string, kind: string): Promise<string> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("Use a date in YYYY-MM-DD format");
    const file = kind === "article" ? "x-article.md" : kind === "video" ? "gemini-video-ideas.md" : kind === "demo" ? "demo-brief.md" : "";
    if (!file) throw new Error("Choose article, video or demo");
    return readFile(join(this.runtime?.getSetting("LAINOS_DATA_DIR") ?? "./data", "editorial", day, file), "utf8");
  }

  /** Slots still owing a post today, oldest first. */
  pending(day = planDay()): PostSlot[] {
    if (!this.plan) return [];
    return pendingSlots(this.plan, day, {
      done: (date) => {
        const rec = this.posts[date];
        return Boolean(rec && (rec.skipped || rec.text));
      },
      maxBacklogDays: this.backlogDays(),
    });
  }

  /**
   * The oldest slot inside the backlog window whose post is written but was
   * never handed over. Nothing to do with `pending()`, which asks whether a
   * post *exists*.
   */
  undelivered(day = planDay()): PostSlot | undefined {
    if (!this.plan) return undefined;
    return this.plan.slots.find((s) => {
      if (s.date > day || daysBetween(s.date, day) > this.backlogDays()) return false;
      const rec = this.posts[s.date];
      return Boolean(rec?.text && !rec.deliveredAt && !rec.skipped);
    });
  }

  /** Drafts delivered on a given host-local day. */
  deliveredOn(day: string): PostRecord[] {
    return Object.values(this.posts).filter(
      (r) => r.deliveredAt && planDay(new Date(r.deliveredAt)) === day,
    );
  }

  /**
   * Does the press room already own the daily post for this Telegram channel?
   * The channel watcher asks before nudging: a reminder to post, delivered
   * next to a finished post, is the noise this plugin exists to remove.
   */
  covers(channel: string): boolean {
    if (!this.plan || !this.timer) return false;
    const mine = (this.runtime?.getSetting("LAINOS_PRESS_CHANNEL") ?? this.plan.channel ?? "")
      .trim()
      .toLowerCase();
    return Boolean(mine) && mine === channel.trim().toLowerCase();
  }

  // ------------------------------------------------------------- write path

  /**
   * Write (or rewrite) the post for one slot. Returns the record; throws when
   * the model gives back nothing usable, so a caller can say why.
   */
  async write(slot: PostSlot, opts: { angle?: string } = {}): Promise<PostRecord> {
    const runtime = this.runtime;
    const plan = this.plan;
    if (!runtime || !plan) throw new Error("press has no runtime or no content plan");
    if (this.posts[slot.date]?.chaosState) throw new Error("This post is already on the Chaos desk or its delivery is uncertain; inspect it there before rewriting.");
    if (this.isBufferQueued(slot.date)) throw new Error("This post is already queued in Buffer; inspect it there before rewriting.");

    const commits = await this.material(slot.date);
    const published = await this.recentPublished();
    const system = writerSystemPrompt(plan);
    const user = writerBrief(plan, slot, commits, published, opts.angle);

    let text = "";
    let model = "";
    let provider = "";
    const configuredMax = Number(runtime.getSetting("LAINOS_PRESS_MAX_CHARS") ?? 0);
    const maxChars = Number.isFinite(configuredMax) && configuredMax > 0 ? Math.floor(configuredMax) : 0;
    for (let attempt = 0; attempt < 2 && !text; attempt += 1) {
      const res = await runtime.model.generate({
        tier: ModelTier.LARGE,
        // A post is WRITE work: the operator routes that kind at the model
        // they trust with the public voice (LAINOS_TASK_WRITE).
        task: TaskKind.WRITE,
        system,
        messages: [{ role: "user", content: user }],
        maxTokens: 1600,
        temperature: 0.7,
      });
      const candidate = cleanPostText(res.text);
      if (candidate.length >= MIN_POST_CHARS && (!maxChars || Array.from(candidate).length <= maxChars)) {
        text = candidate;
        model = res.model;
        provider = res.provider ?? "";
      } else {
        log.warn(`draft for ${slot.date} is outside the allowed length (${candidate.length} chars)`);
      }
    }
    if (!text) {
      const prev = this.posts[slot.date];
      this.posts[slot.date] = {
        ...(prev ?? { date: slot.date, pillar: slot.pillar, text: "", revision: 0, writtenAt: 0 }),
        failedAt: Date.now(),
      };
      await this.persist();
      throw new Error("the writer returned nothing usable");
    }

    const previous = this.posts[slot.date];
    const record: PostRecord = {
      date: slot.date,
      pillar: slot.pillar,
      text,
      revision: (previous?.revision ?? 0) + 1,
      writtenAt: Date.now(),
      model,
      provider: provider || undefined,
      material: commits.slice(0, 12).map((c) => c.subject),
      // A rewrite keeps the delivery/publication history of the day it answers.
      deliveredAt: previous?.deliveredAt,
      publishedAt: previous?.publishedAt,
    };
    this.posts[slot.date] = record;
    await this.persist();
    return record;
  }

  /**
   * Hand a finished post to the operator and mark the slot delivered. The
   * delivery is stamped with the *sweep's* clock, not the wall clock: the
   * day's cap and the spacing between drafts are both read back out of these
   * stamps, so a schedule that cannot be driven by a given `now` cannot be
   * tested at all.
   */
  async deliver(
    slot: PostSlot,
    record: PostRecord,
    opts: { kind?: PressEvent["kind"]; chatId?: number; at?: number } = {},
  ): Promise<void> {
    const kind = opts.kind ?? "draft";
    // Only a first hand-over is a delivery. A repeat re-sends what the
    // operator already has, so it must not restart the spacing clock or push
    // a backlog draft out by four hours.
    if (kind !== "repeat") record.deliveredAt = opts.at ?? Date.now();
    await this.persist();
    const event: PressEvent = {
      kind,
      header: record.chaosScheduleState === "scheduled" && kind === "draft"
        ? `Scheduled through Chaos and Buffer for ${record.chaosDueAt ?? "the next queue slot"}; awaiting publication.`
        : record.chaosState === "draft" && kind === "draft"
        ? `Draft with image on chaos.fm/press for ${slot.date}; awaiting scheduling.`
        : this.isBufferQueued(slot.date) && kind === "draft"
        ? `Queued in Buffer for ${slot.date} (${slot.pillar}); awaiting publication.`
        : headerFor(kind, slot, record),
      post: record.text,
      slot,
      record,
      chatId: opts.chatId ?? (await this.chatId()),
    };
    for (const fn of this.subscribers) {
      try {
        fn(event);
      } catch {
        /* a broken subscriber must never break the press room */
      }
    }
  }

  /**
   * The hand-over did not arrive (the transport was down, not Telegram saying
   * no). Take the delivery stamp back so the next sweep re-sends the post that
   * was already written, instead of counting a lost message against the day.
   */
  async markUndelivered(day: string): Promise<void> {
    const record = this.posts[day];
    if (!record?.deliveredAt) return;
    record.deliveredAt = undefined;
    await this.persist();
    log.warn(`${day} did not reach the operator — will be re-sent`);
  }

  /** The operator published it (or the channel says so). */
  async markPublished(day: string): Promise<PostRecord | undefined> {
    const record = this.posts[day];
    if (!record) return undefined;
    record.publishedAt = Date.now();
    await this.persist();
    return record;
  }

  /** Drop a day: it owes nothing and never joins a backlog. */
  async skip(day: string): Promise<PostSlot | undefined> {
    const slot = this.slotOn(day);
    if (!slot) return undefined;
    const previous = this.posts[day];
    this.posts[day] = {
      date: day,
      pillar: slot.pillar,
      text: previous?.text ?? "",
      revision: previous?.revision ?? 0,
      writtenAt: previous?.writtenAt ?? Date.now(),
      skipped: true,
    };
    await this.persist();
    return slot;
  }

  // --------------------------------------------------------------- schedule

  /** One sweep. Exposed so a test (or an operator) can drive it directly. */
  async tick(now = new Date()): Promise<PostRecord | null> {
    if (this.busy || !this.plan) return null;
    this.busy = true;
    try {
      const day = planDay(now);
      for (const date of Object.keys(this.posts)) await this.syncPublished(date);
      if (this.runtime?.getSetting("LAINOS_PRESS_EDITORIAL") === "1" && now.getDay() === 1 && now.getHours() >= this.hour()) {
        try { await this.weeklyEditorial(day); }
        catch (err) { log.warn("weekly editorial work failed", err); }
      }
      if (this.runtime?.getSetting("LAINOS_PRESS_DEMO") === "1" && now.getDay() === 1 && now.getHours() >= this.hour()) {
        try { await this.weeklyDemo(day); }
        catch (err) { log.warn("weekly demo failed", err); }
      }
      if (planExhausted(this.plan, day)) {
        await this.announcePlanOver(day);
        return null;
      }
      if (now.getHours() < this.hour()) return null;

      const delivered = this.deliveredOn(day);
      const lastAt = delivered.reduce((max, r) => Math.max(max, r.deliveredAt ?? 0), 0);
      const spaced = !lastAt || now.getTime() - lastAt >= this.spacingMs();

      // A draft that exists but never reached the operator is re-sent first:
      // it is already written, so re-writing it would spend a model call to
      // produce a second post for a day that owes one.
      const lost = this.undelivered(day);
      if (lost) {
        const record = this.posts[lost.date];
        if (record) {
          if (!(await this.queueDelivery(lost, record))) return null;
          await this.deliver(lost, record, { at: now.getTime() });
          log.info(`post for ${lost.date} re-sent after a failed hand-over`);
          return record;
        }
      }

      if (delivered.length < this.maxPerDay() && spaced) {
        const slot = this.pending(day)[0];
        if (slot) {
          const prev = this.posts[slot.date];
          const notBefore =
            prev?.retryAt ?? (prev?.failedAt ? prev.failedAt + RETRY_AFTER_MS : 0);
          if (notBefore && now.getTime() < notBefore) return null;
          let record: PostRecord;
          try {
            record = await this.write(slot);
          } catch (err) {
            // The writer is unreachable or gave back nothing. Saying so costs
            // one message a day; saying nothing looks exactly like a day with
            // no work in it, which is the failure this room was built to end.
            await this.announceFailure(day, slot, err, now);
            return null;
          }
          if (!(await this.queueDelivery(slot, record))) return null;
          await this.deliver(slot, record, { at: now.getTime() });
          log.info(`post for ${slot.date} delivered (${record.text.length} chars)`);
          return record;
        }
      }

      // Nothing new to write: if today's post is out there unpublished and the
      // evening has come, say so once — with the post attached, never alone.
      if (now.getHours() >= this.remindHour() && this.lastRepeatDay !== day) {
        const slot = this.slotOn(day);
        const record = slot ? this.posts[slot.date] : undefined;
        if (slot && record?.text && record.deliveredAt && !record.publishedAt && !record.skipped && record.chaosState !== "draft" && !this.isBufferQueued(slot.date)) {
          this.lastRepeatDay = day;
          await this.deliver(slot, record, { kind: "repeat", at: now.getTime() });
          return record;
        }
      }
      return null;
    } catch (err) {
      log.warn("press tick failed", err);
      return null;
    } finally {
      this.busy = false;
    }
  }

  private isBufferQueued(day: string): boolean {
    return Boolean(this.buffer?.enabled && this.buffer.channelIds.length && this.buffer.channelIds.every(id => this.buffer?.submission(`press-${day}`, id)?.state === "queued"));
  }

  async queueDelivery(slot: PostSlot, record: PostRecord): Promise<boolean> {
    if (this.runtime?.getSetting("LAINOS_PRESS_DELIVERY") === "chaos") {
      try {
        await this.queueForChaos(slot, record);
        return true;
      } catch (err) {
        log.warn(`could not send post ${slot.date} to chaos press`, err);
        await this.announceDeliveryFailure(slot, record, err);
        return false;
      }
    }
    if (!this.buffer?.autoPost) return true;
    try {
      await this.buffer.enqueue(`press-${slot.date}`, record.text);
      return true;
    } catch (err) {
      log.warn(`could not queue post ${slot.date} in Buffer`, err);
      await this.announceDeliveryFailure(slot, record, err);
      return false;
    }
  }

  private async announceDeliveryFailure(slot: PostSlot, record: PostRecord, err: unknown): Promise<void> {
    const day = planDay();
    if (this.lastFailureDay === day) return;
    this.lastFailureDay = day;
    await this.persist();
    const chatId = await this.chatId();
    for (const fn of this.subscribers) {
      try { fn({ kind: "failed", header: `Could not deliver the post for ${slot.date}: ${(err as Error).message}`, post: "", slot, record, chatId }); } catch { /* isolate subscribers */ }
    }
  }

  private async queueForChaos(slot: PostSlot, record: PostRecord): Promise<void> {
    if (record.chaosState === "draft") { await this.scheduleChaos(record); return; }
    const mcp = this.runtime?.getService<RemoteMcpService>("mcp");
    const images = this.runtime?.getService<ImageService>("image");
    if (!mcp || !images?.configured()) throw new Error("Chaos MCP or the image service is unavailable");
    if (record.chaosState === "sending") throw new Error("The Chaos draft has an unknown outcome; inspect the desk before retrying");
    // Read the shared desk before creating anything, including posts created by other agents.
    const queue = await mcp.call("chaos", "press_queue", {});
    if (!queue.ok) throw new Error(`Cannot read Chaos press queue: ${queue.text}`);
    const previous = readChaosQueue(queue.text ?? "");
    if (previous.partial) log.warn("Chaos returned a partial queue; only visible entries can be checked for duplicates");
    const matching = previous.entries.find(item => item.channel === "lain___os" && item.text?.trim() === record.text.trim());
    if (matching) {
      if (!matching.has_image || !matching.id) throw new Error("The matching Chaos draft is missing an image or id; inspect the desk");
      record.chaosState = "draft"; record.chaosDraftId = matching.id; await this.persist(); await this.scheduleChaos(record); return;
    }
    if ((!record.imagePath || !record.imageMime) && slot.asset.startsWith("screenshot:")) {
      const url = slot.asset.slice("screenshot:".length).trim();
      if (url !== "https://lain-os.com") throw new Error("Screenshot URL is not on the approved public-site list");
      const dir = join(this.runtime?.getSetting("LAINOS_DATA_DIR") ?? "./data", "images");
      await mkdir(dir, { recursive: true });
      const path = join(dir, `press-${slot.date}-screenshot.png`);
      const profile = join(dir, `press-${slot.date}-browser`);
      await execFile("chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--window-size=1440,900", "--virtual-time-budget=10000", `--user-data-dir=${profile}`, `--screenshot=${path}`, url], { timeout: 60000, maxBuffer: 1_000_000 });
      // Keep the top of the real page; omit the consent overlay and live ticker.
      await execFile("convert", [path, "-crop", "1440x700+0+0", "+repage", path], { timeout: 20000 });
      record.imagePath = path; record.imageMime = "image/png"; await this.persist();
    }
    if ((!record.imagePath || !record.imageMime) && slot.asset.startsWith("diagram:")) {
      const dir = join(this.runtime?.getSetting("LAINOS_DATA_DIR") ?? "./data", "images");
      await mkdir(dir, { recursive: true });
      const path = join(dir, `press-${slot.date}-diagram.png`);
      await execFile("convert", ["-size", "1440x900", "xc:#090811", "-fill", "#f3edff", "-font", "DejaVu-Sans", "-pointsize", "58", "-gravity", "center", "-annotate", "+0-90", "LAIN OS", "-fill", "#b39cf4", "-pointsize", "42", "-annotate", "+0+15", "CONVERSATION     MEMORY     TOOLS", "-fill", "#96d8ef", "-pointsize", "25", "-annotate", "+0+115", "github.com/lain-labs/os" , path], { timeout: 20000 });
      record.imagePath = path; record.imageMime = "image/png"; await this.persist();
    }
    if (!record.imagePath || !record.imageMime) {
      const image = await images.generate(
        `Create a visual metaphor for this LainOS post: ${record.text}\n` +
        `Editorial subject: ${slot.primary}. Minimal 90s cyberpunk anime mood, mostly black, restrained cyan, pink and violet light, subtle CRT grain, dry floor. No logos, no readable text, no charts implying price growth, no real people. If depicting Lain: adult with short black bob, violet eyes and black hoodie; a single tilted halo with a small X fixed into the ring on the right, never floating separately. Do not invent a screenshot or claim this is a real interface.`,
        "16:9",
      );
      record.imagePath = image.path; record.imageMime = image.mime; await this.persist();
    }
    const bytes = await readFile(record.imagePath);
    if (bytes.length > 8 * 1024 * 1024) throw new Error("The image exceeds the Chaos 8 MB limit");
    record.chaosState = "sending"; await this.persist();
    const result = await mcp.call("chaos", "press_draft", {
      channel: "lain___os", text: record.text,
      image_base64: `data:${record.imageMime};base64,${bytes.toString("base64")}`,
      video_prompt: `Gemini concept (not actual UI): 15 seconds, dark minimalist LainOS aesthetic with restrained violet and cyan. Visualize: ${slot.primary.slice(0, 1000)}. If Lain appears, an adult in a black hoodie with a single tilted halo and an X fixed into its right side. No fictional screenshots, no logos or claims of actual events.`,
      format: "story", why: `LainOS content plan ${slot.date}. Verify the text, source and attached image before scheduling. The video prompt is a concept for the operator.`, via: "Lain",
    });
    if (!result.ok) throw new Error(`Chaos submission outcome is unknown: ${result.text}`);
    let id: number | undefined;
    try { id = (JSON.parse(result.text ?? "") as { id?: number }).id; } catch { /* keep uncertain */ }
    if (!id) throw new Error("Chaos returned no draft ID; inspect the desk before retrying");
    record.chaosState = "draft"; record.chaosDraftId = id; await this.persist();
    await this.scheduleChaos(record);
  }

  private async scheduleChaos(record: PostRecord): Promise<void> {
    if (this.runtime?.getSetting("LAINOS_PRESS_CHAOS_AUTO") !== "1" || record.chaosScheduleState === "scheduled") return;
    if (record.chaosScheduleState === "sending") throw new Error("Chaos scheduling outcome is unknown; inspect the desk and Buffer before retrying");
    if (!record.chaosDraftId) throw new Error("Chaos draft ID is missing");
    const mcp = this.runtime.getService<RemoteMcpService>("mcp");
    if (!mcp) throw new Error("Chaos MCP is unavailable");
    record.chaosScheduleState = "sending"; await this.persist();
    const result = await mcp.call("chaos", "press_schedule", { id: record.chaosDraftId });
    if (!result.ok && /rate-limited; nothing was created/i.test(result.text ?? "")) {
      // The desk says Buffer refused outright and the draft is back. With the API spent, the
      // website still takes posts: queue it there and tell the desk; otherwise try later.
      if (bufferWebEnabled(this.runtime) && (await this.queueOnBufferWeb(record, mcp))) return;
      record.chaosScheduleState = undefined; await this.persist();
      throw new Error("Buffer is rate-limited; the post will be scheduled on a later try");
    }
    if (!result.ok) throw new Error(`Chaos scheduling outcome is unknown: ${result.text}`);
    let scheduled: { status?: string; buffer_post_id?: string; due_at?: string };
    try { scheduled = JSON.parse(result.text ?? ""); } catch { throw new Error("Chaos returned an unreadable schedule result"); }
    if (!['approved', 'sent'].includes(scheduled.status ?? "") || !scheduled.buffer_post_id) throw new Error("Chaos did not confirm a Buffer post ID");
    record.chaosScheduleState = "scheduled"; record.chaosBufferId = scheduled.buffer_post_id; record.chaosDueAt = scheduled.due_at; await this.persist();
  }

  /** Queue the post through publish.buffer.com and mark the desk draft scheduled. */
  private async queueOnBufferWeb(record: PostRecord, mcp: RemoteMcpService): Promise<boolean> {
    if (!this.runtime || !record.chaosDraftId) return false;
    const posted = await postViaBufferWeb(this.runtime, { channel: "lain___os", text: record.text, imagePath: record.imagePath });
    if (!posted.ok) {
      log.warn(`Buffer website did not take ${record.date}: ${posted.reason}`);
      return false;
    }
    // Next Available puts it in the queue's next slot; the desk only needs to know it is out of
    // its hands, so it is marked scheduled now and Buffer's own queue says the hour.
    record.chaosScheduleState = "scheduled"; record.chaosBufferId = "web"; await this.persist();
    const marked = await mcp.call("chaos", "press_mark", { id: record.chaosDraftId, status: "scheduled", due_at: new Date().toISOString() });
    if (!marked.ok) log.warn(`queued ${record.date} on the Buffer website but the desk mark failed: ${marked.text}`);
    return true;
  }

  private async weeklyEditorial(day: string): Promise<void> {
    if (!this.runtime || !this.plan) return;
    const root = join(this.runtime.getSetting("LAINOS_DATA_DIR") ?? "./data", "editorial", day);
    await mkdir(root, { recursive: true });
    const commits = await this.material(day);
    const jobs = [
      { file: "x-article.md", brief: "Write one useful, original English draft for X Articles about LainOS, 700–1100 words. Use a clear title, a short standfirst, useful section headings, and a conclusion. Include source URLs alongside factual claims and list sources at the end. Base factual claims only on the provided plan and commits; distinguish repository features from deployed services. No price predictions or investment advice. Do not imply this draft is published." },
      { file: "gemini-video-ideas.md", brief: "Write three distinct English ideas for short Gemini-generated videos about LainOS for a human collaborator. For each give a hook, 10–20 second storyboard, a ready-to-use visual prompt, negative prompt, and a source or fact to verify. Generated sequences are illustrations, never claim that they are actual product UI or a real-world event. Brand: mostly black, restrained pink, violet and cyan; an adult Lain with short black bob, black hoodie and violet eyes, when shown, has a single tilted halo with a small X fixed into the right side of the ring, never floating separately. Avoid third-party logos, financial promises and fabricated metrics." },
      { file: "demo-brief.md", brief: "Write a brief for one 15–25 second LainOS demo made using the brag or HyperFrames workflow. Specify a real, publicly accessible user interface, a clear entry, real interaction and visible result. Give a shot list, relevant source URLs, privacy and data checks, a concise post caption, and commands or steps to record and render. Use only evidence supplied; do not claim this draft is a finished video." },
    ];
    for (const job of jobs) {
      const path = join(root, job.file);
      if (existsSync(path)) continue;
      const response = await this.runtime.model.generate({ tier: ModelTier.LARGE, task: TaskKind.WRITE, system: job.brief, messages: [{ role: "user", content: `Date: ${day}\nProject source: https://github.com/lain-labs/os\n${briefText(this.plan)}\nRecent repository material:\n${commitsText(commits) || "No recent commits. Do not invent changes."}` }], maxTokens: 2600, temperature: 0.6 });
      const text = response.text.trim();
      if (text.length < 150) throw new Error(`Writer returned an incomplete ${job.file}`);
      await writeFile(path, text + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
      log.info(`prepared editorial draft ${path}`);
      const slot = this.slotOn(day) ?? this.plan.slots[0];
      const chatId = await this.chatId();
      for (const fn of this.subscribers) {
        try { fn({ kind: "editorial", header: `Prepared ${job.file} for ${day}. Ask Lain to show the ${job.file === "x-article.md" ? "article" : job.file === "demo-brief.md" ? "demo brief" : "Gemini video ideas"} for ${day}.`, post: "", slot, record: { date: day, pillar: "Editorial", text: "", revision: 0, writtenAt: Date.now() }, chatId }); } catch { /* isolate subscribers */ }
      }
    }
  }

  private async weeklyDemo(day: string): Promise<void> {
    if (!this.runtime || !this.plan) return;
    const root = join(this.runtime.getSetting("LAINOS_DATA_DIR") ?? "./data", "editorial", day);
    await mkdir(root, { recursive: true });
    const attempt = join(root, "demo-attempt.json");
    if (existsSync(attempt)) return;
    await writeFile(attempt, JSON.stringify({ startedAt: new Date().toISOString(), state: "running" }), { flag: "wx", mode: 0o600 });
    const output = join(root, "demo");
    const mediaRuntime = this.runtime.getSetting("LAINOS_PRESS_MEDIA_RUNTIME")?.trim() || join(homedir(), ".local/share/lainos/media-runtime");
    const env: NodeJS.ProcessEnv = {};
    for (const name of ["HOME", "PATH", "LANG", "TZ", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "DISPLAY"]) {
      if (process.env[name]) env[name] = process.env[name];
    }
    const slot = this.slotOn(day) ?? this.plan.slots[0];
    const notify = async (header: string) => {
      const chatId = await this.chatId();
      for (const fn of this.subscribers) {
        try { fn({ kind: "editorial", header, post: "", slot, record: { date: day, pillar: "Demo", text: "", revision: 0, writtenAt: Date.now() }, chatId }); } catch { /* isolate subscribers */ }
      }
    };
    try {
      await execFile(process.execPath, [join(this.repo, "scripts/press-demo.mjs"), output, mediaRuntime], { env, timeout: 600000, maxBuffer: 8_000_000 });
      if (this.runtime.getSetting("LAINOS_PRESS_CHAOS_AUTO") !== "1") {
        await writeFile(attempt, JSON.stringify({ completedAt: new Date().toISOString(), state: "ready", output }), { mode: 0o600 });
        await notify(`A real UI demo for ${day} is ready at ${output}/brag.mp4.`);
        return;
      }
      const mcp = this.runtime.getService<RemoteMcpService>("mcp");
      if (!mcp) throw new Error("Chaos MCP is unavailable");
      const text = (await readFile(join(output, "share-copy.txt"), "utf8")).trim();
      const image = await readFile(join(output, "brag.jpg"));
      const video = await readFile(join(output, "brag.mp4"));
      if (image.length > 8 * 1024 * 1024 || video.length > 20 * 1024 * 1024) throw new Error("Demo media exceeds Chaos upload limits");
      const queue = await mcp.call("chaos", "press_queue", {});
      if (!queue.ok) throw new Error("Cannot read Chaos press queue");
      const previous = readChaosQueue(queue.text ?? "");
      if (previous.entries.some(item => item.channel === "lain___os" && item.text?.trim() === text)) throw new Error("A matching demo is already on the Chaos desk");
      await writeFile(attempt, JSON.stringify({ state: "draft_sending", output }), { mode: 0o600 });
      const draft = await mcp.call("chaos", "press_draft", { channel: "lain___os", text, image_base64: `data:image/jpeg;base64,${image.toString("base64")}`, format: "demo", why: `Real public UI recording from ${day}; captured numbers are historical.`, via: "Lain" });
      if (!draft.ok) throw new Error(`Chaos draft outcome is unknown: ${draft.text}`);
      let id: number | undefined;
      try { id = (JSON.parse(draft.text ?? "") as { id?: number }).id; } catch { /* remain uncertain */ }
      if (!id) throw new Error("Chaos did not return the demo draft ID");
      await writeFile(attempt, JSON.stringify({ state: "video_sending", output, id }), { mode: 0o600 });
      const attached = await mcp.call("chaos", "press_video", { id, video_base64: video.toString("base64") });
      if (!attached.ok) throw new Error(`Chaos video upload outcome is unknown for draft ${id}: ${attached.text}`);
      await writeFile(attempt, JSON.stringify({ state: "schedule_sending", output, id }), { mode: 0o600 });
      const scheduled = await mcp.call("chaos", "press_schedule", { id });
      if (!scheduled.ok) throw new Error(`Chaos scheduling outcome is unknown for draft ${id}: ${scheduled.text}`);
      let result: { status?: string; buffer_post_id?: string; due_at?: string };
      try { result = JSON.parse(scheduled.text ?? ""); } catch { throw new Error(`Chaos schedule result for draft ${id} was unreadable`); }
      if (result.status !== "approved" || !result.buffer_post_id) throw new Error(`Chaos did not confirm scheduling for draft ${id}`);
      await writeFile(attempt, JSON.stringify({ completedAt: new Date().toISOString(), state: "scheduled", output, id, ...result }), { mode: 0o600 });
      await notify(`A real UI demo for ${day} was scheduled through Chaos and Buffer (${result.due_at ?? "next queue slot"}). File: ${output}/brag.mp4`);
    } catch (err) {
      // Preserve the last state and draft id for reconciliation after an ambiguous network failure.
      let previous: Record<string, unknown> = {};
      try { previous = JSON.parse(await readFile(attempt, "utf8")); } catch { /* initial attempt */ }
      await writeFile(attempt, JSON.stringify({ ...previous, failedAt: new Date().toISOString(), error: (err as Error).message.slice(0, 1000) }), { mode: 0o600 });
      await notify(`The UI demo for ${day} failed. Check ${attempt}; it will not be retried automatically.`);
      throw err;
    }
  }

  /**
   * Say once a day that the post could not be written, in words, and write
   * down when it is worth asking again.
   *
   * The wait is recorded even when the message is suppressed as a repeat:
   * saying it twice is noise, but retrying against a window that has not
   * reopened is the loop that produced two identical 401 walls on consecutive
   * mornings.
   */
  private async announceFailure(
    day: string,
    slot: PostSlot,
    err: unknown,
    at: Date = new Date(),
  ): Promise<void> {
    log.warn(`could not write the post for ${slot.date}`, err);
    // The sweep's clock, not the wall clock: the reopening hour is read out of
    // the refusal against the same `now` the schedule is driven by, so a
    // window can be tested without waiting for one.
    const now = at.getTime();
    const { reason, retryAt } = writerRefusal(err, at);
    // A writer that throws (a CLI exiting non-zero) never reached the branch
    // in `write()` that records a failure, so the day had no record at all and
    // nothing to back off from — every tick asked again. Write it here.
    const record = this.posts[slot.date] ?? {
      date: slot.date,
      pillar: slot.pillar,
      text: "",
      revision: 0,
      writtenAt: 0,
    };
    record.failedAt = now;
    record.retryAt = retryAt;
    this.posts[slot.date] = record;
    const first = this.lastFailureDay !== day;
    if (first) this.lastFailureDay = day;
    await this.persist();
    if (!first) return;
    const again = retryAt
      ? `I'll try again after ${formatClock(new Date(retryAt))}`
      : "I'll try again in half an hour";
    const header =
      `⚠ couldn't write the post for ${slot.date.slice(8)}.${slot.date.slice(5, 7)} ` +
      `(${slot.pillar}).\n${reason}\n${again} — or say "write the post" ` +
      `and I'll try right now.`;
    const chatId = await this.chatId();
    for (const fn of this.subscribers) {
      try {
        fn({
          kind: "failed",
          header,
          post: "",
          slot,
          record: this.posts[slot.date] ?? {
            date: slot.date,
            pillar: slot.pillar,
            text: "",
            revision: 0,
            writtenAt: Date.now(),
          },
          chatId,
        });
      } catch {
        /* a broken subscriber must never break the press room */
      }
    }
  }

  /** Say once that the calendar has run out, rather than going quiet. */
  private async announcePlanOver(day: string): Promise<void> {
    if (!this.plan || this.planOverAnnounced) return;
    this.planOverAnnounced = day;
    await this.persist();
    const header =
      `📋 the content plan ran out on ${this.plan.range.to} — no more scheduled posts.\n` +
      `next month — a new content-plan.json (or say so, and I'll write a post on your topic).`;
    const chatId = await this.chatId();
    for (const fn of this.subscribers) {
      try {
        fn({
          kind: "plan_over",
          header,
          post: "",
          slot: this.plan.slots[this.plan.slots.length - 1],
          record: { date: day, pillar: "", text: "", revision: 0, writtenAt: Date.now() },
          chatId,
        });
      } catch {
        /* a broken subscriber must never break the press room */
      }
    }
  }

  /**
   * The channel is the ground truth for "did it go out". A day the watched
   * channel published is a day whose post is considered published — the
   * operator is not asked to also tell us.
   */
  private async syncPublished(day: string): Promise<void> {
    const record = this.posts[day];
    if (!record?.text || record.publishedAt || record.skipped) return;
    if (record.chaosBufferId && this.buffer?.latest()?.posts.some(post => post.id === record.chaosBufferId)) {
      record.publishedAt = Date.now(); await this.persist(); return;
    }
    if (this.buffer?.autoPost || this.buffer?.channelIds.some(id => this.buffer?.submission(`press-${day}`, id))) {
      const snapshot = this.buffer.latest();
      const ids = this.buffer.channelIds.map(id => this.buffer?.submission(`press-${day}`, id)?.postId);
      if (ids.length && ids.every(id => id && snapshot?.posts.some(post => post.id === id))) {
        record.publishedAt = Date.now();
        await this.persist();
      }
      return;
    }
    const channel = this.channelName();
    const svc = this.runtime?.getService<ChannelWatchService>("channel-watch");
    if (!channel || !svc) return;
    const activity = await svc.activityToday(channel);
    if (activity && activity.postsToday > 0) {
      record.publishedAt = Date.now();
      await this.persist();
      log.info(`${channel} published today — ${day} closed`);
    }
  }

  /** Commits since the last post went out, so a post never repeats material. */
  private async material(date: string): Promise<Commit[]> {
    const previous = Object.values(this.posts)
      .filter((r) => r.date < date && r.text)
      .sort((a, b) => b.date.localeCompare(a.date))[0];
    const days = previous
      ? Math.min(COMMIT_WINDOW_DAYS * 2, Math.max(1, daysSince(previous.date) + 1))
      : COMMIT_WINDOW_DAYS;
    try {
      return await readCommits(this.repo, { sinceDays: days });
    } catch (err) {
      log.warn(`could not read commits from ${this.repo}`, err);
      return [];
    }
  }

  /** The last few posts as published, so the writer does not repeat itself. */
  private async recentPublished(): Promise<string[]> {
    const channel = this.channelName();
    const svc = this.runtime?.getService<ChannelWatchService>("channel-watch");
    if (channel && svc) {
      try {
        const posts = await svc.recentPosts(channel);
        if (posts?.length) return posts.slice(-5).map((p: ChannelPost) => p.text);
      } catch (err) {
        log.warn(`could not read t.me/${channel}`, err);
      }
    }
    // Fall back on what we wrote ourselves — weaker (it may never have been
    // published) but enough to stop two identical drafts in a row.
    return Object.values(this.posts)
      .filter((r) => r.text)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 3)
      .map((r) => r.text);
  }

  // -------------------------------------------------------------- internals

  private planPath(): string {
    const raw = this.runtime?.getSetting("LAINOS_PRESS_PLAN")?.trim();
    if (raw) return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
    return resolve(process.cwd(), "content-plan.json");
  }

  private channelName(): string {
    return (
      this.runtime?.getSetting("LAINOS_PRESS_CHANNEL")?.trim() ||
      this.plan?.channel?.trim() ||
      ""
    );
  }

  /**
   * Where a draft goes. The same resolution every other background service
   * uses — an explicit setting, then the allowlist, then the one known private
   * chat — so a post lands where the alerts and the heartbeat already land.
   */
  private async chatId(): Promise<number | undefined> {
    const runtime = this.runtime;
    const explicit = runtime?.getSetting("LAINOS_PRESS_CHAT_ID")?.trim();
    const raw = explicit || (runtime ? await resolveOperatorChatId((k) => runtime.getSetting(k)) : null);
    const id = Number(raw);
    return Number.isFinite(id) && id !== 0 ? id : undefined;
  }

  private hour(): number {
    return clampHour(Number(this.runtime?.getSetting("LAINOS_PRESS_HOUR") ?? DEFAULT_HOUR), DEFAULT_HOUR);
  }

  private remindHour(): number {
    return clampHour(
      Number(this.runtime?.getSetting("LAINOS_PRESS_REMIND_HOUR") ?? DEFAULT_REMIND_HOUR),
      DEFAULT_REMIND_HOUR,
    );
  }

  private maxPerDay(): number {
    const raw = Number(this.runtime?.getSetting("LAINOS_PRESS_MAX_PER_DAY") ?? DEFAULT_MAX_PER_DAY);
    return Number.isFinite(raw) ? Math.min(4, Math.max(1, Math.round(raw))) : DEFAULT_MAX_PER_DAY;
  }

  private spacingMs(): number {
    const raw = Number(this.runtime?.getSetting("LAINOS_PRESS_SPACING_MS") ?? DEFAULT_SPACING_MS);
    return Number.isFinite(raw) ? Math.max(600_000, raw) : DEFAULT_SPACING_MS;
  }

  private backlogDays(): number {
    const raw = Number(this.runtime?.getSetting("LAINOS_PRESS_BACKLOG_DAYS") ?? DEFAULT_BACKLOG_DAYS);
    return Number.isFinite(raw) ? Math.min(14, Math.max(0, Math.round(raw))) : DEFAULT_BACKLOG_DAYS;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const payload: PressFile = {
      posts: this.posts,
      lastRepeatDay: this.lastRepeatDay,
      lastFailureDay: this.lastFailureDay,
      planOverAnnounced: this.planOverAnnounced,
    };
    await writeFile(this.file, JSON.stringify(payload, null, 2), "utf8");
  }
}

// ------------------------------------------------------------------ prompts

/**
 * The writer's standing instructions. Everything here is a rule the strategy
 * report drew from fifty real posts, plus the one rule this house has always
 * had: a post is for the person using the thing, never for the person who
 * built it.
 */
export function writerSystemPrompt(plan: ContentPlan): string {
  const lang = plan.language === "en" ? "English" : plan.language;
  if (plan.writerInstructions?.length) {
    return [
      `Write a public post for ${plan.account ?? "the project"} in ${lang}.`,
      ...plan.writerInstructions,
      `OUTPUT: the post text and nothing else. No preamble, title, quotes, or code fence.`,
    ].join("\n");
  }
  return [
    `You write the public posts for the project (${plan.account ?? "its account"} on X, mirrored`,
    `to its Telegram channel). What you produce is published as written — it is the post itself,`,
    `not a draft to be discussed, and no one edits it after you.`,
    ``,
    `WHO READS IT: people who might use a wallet, and people who might hold the token.`,
    `Never developers. A reader who has never seen code must get everything the post carries.`,
    ``,
    `THE POST`,
    `- Write it in ${lang}. Use ${lang} regardless of the language of the brief below.`,
    `- One idea. Open with a claim, a problem or a question a person recognises — never with a`,
    `  version number, never with a list of features, never with "we shipped".`,
    `- State every change as what a person can now do, or no longer has to do.`,
    `- Never name a library, a file, a class, a framework, a migration, a test, an endpoint or an`,
    `  internal service. Never write "refactored", "rewrote", "under the hood", "backend". If a`,
    `  change cannot be told without them, tell its consequence instead.`,
    `- Concrete beats adjective: a number, a step, a before and after. No "seamless", "powerful",`,
    `  "revolutionary", "excited to announce".`,
    `- Short lines with a blank line between them. No hashtags. No emoji decoration. No markdown:`,
    `  no bold, no headers, no bullet characters other than a plain "•" where a list truly helps.`,
    `- Length is free — a long post is fine when every line earns its place. Most posts want three`,
    `  to eight short beats; one line is only enough when that line is the whole idea.`,
    `- End on the day's CTA. Say it once, as the last line, in your own words. If that CTA is an`,
    `  action (reply, open, download, name a ticker), the last line is that action. If it is a`,
    `  question, ask that one question. Never "thoughts?", never "what do you think?", never a second ask.`,
    `- Do not describe the attachment in the text; the operator attaches it separately. The asset`,
    `  named in the brief is the plan's suggestion, not a constraint — if the honest evidence for`,
    `  the day's thesis is a different one, write that and let the operator attach what fits.`,
    `- Invent nothing. A number, date, name, partner or feature may appear only when today's thesis`,
    `  or the material below already states it. The thesis is the operator's assignment and its`,
    `  figures are allowed. Thin material means a thesis without extra evidence, never invented evidence.`,
    ``,
    `OUTPUT: the post text and nothing else. No preamble, no title, no surrounding quotes, no code`,
    `fence, no sign-off, no notes about what you did.`,
  ].join("\n");
}

/** The day's assignment plus everything true that could feed it. */
export function writerBrief(
  plan: ContentPlan,
  slot: PostSlot,
  commits: Commit[],
  published: string[],
  angle?: string,
): string {
  const parts = [`TODAY'S PLAN SLOT:\n${slotText(slot)}`, `STANDING BRIEF:\n${briefText(plan)}`];
  const material = commitsText(commits);
  parts.push(
    material
      ? `WHAT ACTUALLY SHIPPED IN THE LAST FEW DAYS (repo commits are raw material, not publication\n` +
          `copy; pick out what a user would notice and translate it into plain language):\n${material}`
      : `WHAT ACTUALLY SHIPPED IN THE LAST FEW DAYS: no new commits — write today's thesis without\n` +
          `referencing recent work, and don't invent anything.`,
  );
  if (published.length) {
    parts.push(
      `RECENT PUBLISHED POSTS (don't repeat the idea or the opening line):\n` +
        published.map((p) => `---\n${p.slice(0, 700)}`).join("\n"),
    );
  }
  if (angle?.trim()) parts.push(`SEPARATE OPERATOR INSTRUCTION: ${angle.trim()}`);
  return parts.join("\n\n");
}

/**
 * Strip everything a chat model wraps an answer in. The post is pasted into a
 * channel by a human who should not have to delete a "Here's your post:" line
 * first — and a stray code fence would publish as a literal backtick.
 */
export function cleanPostText(raw: string): string {
  let text = raw.trim();
  // A fenced block: take what is inside it.
  const fence = text.match(/^```[a-z]*\n([\s\S]*?)\n?```$/i);
  if (fence) text = fence[1].trim();
  // A preamble line ("Here's the post:") followed by a blank line.
  const preamble =
    /^(?:[^\n]{0,120}(?:here'?s|here is|below is|draft)[^\n]{0,120}:)\s*\n+/i;
  if (preamble.test(text)) text = text.replace(preamble, "").trim();
  // Wrapping quotes around the whole thing.
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("«") && text.endsWith("»")) ||
    (text.startsWith("“") && text.endsWith("”"))
  ) {
    text = text.slice(1, -1).trim();
  }
  // Markdown emphasis the channel would render as literal asterisks.
  text = text.replace(/^#{1,6}\s+/gm, "");
  return text.trim();
}

/** The operator-facing line above a delivered post. */
export function headerFor(kind: PressEvent["kind"], slot: PostSlot, record: PostRecord): string {
  const when = `${slot.date.slice(8, 10)}.${slot.date.slice(5, 7)}`;
  const by = record.provider ? ` · ${record.provider}` : "";
  if (kind === "repeat") {
    return (
      `📝 the post for ${when} still hasn't gone out — here it is again.\n` +
      `asset: ${slot.asset}`
    );
  }
  return (
    `📝 post for ${when} · ${slot.pillar}${by}\n` +
    `asset for it per the plan: ${slot.asset}\n` +
    `next message — the text, copy it whole.`
  );
}

/**
 * What a refusal from the writer actually said, and when to ask again.
 *
 * A writer is a CLI, and a CLI that will not answer says why in prose meant
 * for a terminal: a stack trace, a 401 with a cf-ray, a usage window with the
 * hour it reopens. Forwarding that verbatim into Telegram is how the operator
 * got two identical walls of `unexpected status 401 Unauthorized … cf-ray …`
 * on two consecutive mornings and still had to read the log to learn that
 * codex on that host had never been signed in.
 *
 * Two facts are worth extracting and nothing else is:
 *
 *  - **which kind of no it is** — out of credentials for now (it will answer
 *    later), or not allowed to ask at all (it will never answer here, and the
 *    operator has to do something);
 *  - **when it reopens**, when the refusal names an hour. A subscription CLI
 *    that says "try again at 11:33 AM" has told us exactly how long the flat
 *    half-hour retry will keep failing.
 *
 * Pure, and takes its clock, so every branch is testable without waiting.
 */
export function writerRefusal(
  raw: unknown,
  now: Date = new Date(),
): { reason: string; retryAt?: number } {
  const text = (raw instanceof Error ? raw.message : String(raw ?? "")).trim();
  if (!text) return { reason: "the writer did not answer" };

  // A stack trace says nothing an operator can act on.
  const body = text
    .split("\n")
    .filter((line) => !/^\s*at\s/.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  const retryAt = parseRetryHour(body, now);
  if (/usage limit|rate.?limit|quota|too many requests|\b429\b/i.test(body)) {
    const when = retryAt ? ` until ${formatClock(new Date(retryAt))}` : "";
    return { reason: `the writer hit its usage limit${when}`, retryAt };
  }
  if (/\b401\b|unauthorized|missing bearer|not logged in|no credentials|please run .*login/i.test(body)) {
    // Nothing here reopens on its own: this host has no session at all.
    return { reason: "the writer is not authorized on this machine" };
  }
  const short = body.length > 200 ? `${body.slice(0, 199)}…` : body;
  return { reason: short, retryAt };
}

/** "try again at 11:33 AM" / "resets at 15:04" → the next such moment. */
function parseRetryHour(text: string, now: Date): number | undefined {
  const relative = text.match(/try again in (\d{1,3}) (second|minute|hour)s?/i);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const ms = unit === "second" ? 1_000 : unit === "minute" ? 60_000 : 3_600_000;
    return now.getTime() + amount * ms;
  }
  const match = text.match(/(?:try again|resets?|available again|retry) at (\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!match) return undefined;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[3]?.toUpperCase();
  if (meridiem === "PM" && hour < 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return undefined;
  const at = new Date(now);
  at.setHours(hour, minute, 0, 0);
  // A window that already passed today is tomorrow's, not the past.
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at.getTime();
}

function formatClock(at: Date): string {
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

// ------------------------------------------------------------------ helpers

function findGitRoot(from: string): string {
  let dir = resolve(from);
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(from);
}

function clampHour(hour: number, fallback: number): number {
  return Number.isFinite(hour) ? Math.min(23, Math.max(0, Math.round(hour))) : fallback;
}

function daysSince(date: string): number {
  const then = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10));
  return Math.max(0, Math.round((Date.now() - then) / 86_400_000));
}

function getPress(runtime: IAgentRuntime): PressService {
  const svc = runtime.getService<PressService>("press");
  if (!svc) throw new Error("press service not started");
  return svc;
}

function chatIdFromState(state: State): number | undefined {
  if (!state.roomId.startsWith("tg-")) return undefined;
  const id = Number(state.roomId.slice(3));
  return Number.isFinite(id) ? id : undefined;
}

/** "today", "tomorrow", "25.08", "2026-08-25" → a plan date. */
export function resolveDay(raw: string | undefined, today = planDay()): string {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value || /^today$/.test(value)) return today;
  if (/^tomorrow$/.test(value)) return shiftDay(today, 1);
  if (/^yesterday$/.test(value)) return shiftDay(today, -1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const dotted = value.match(/^(\d{1,2})[.\/](\d{1,2})(?:[.\/](\d{4}))?$/);
  if (dotted) {
    const year = dotted[3] ?? today.slice(0, 4);
    return `${year}-${dotted[2].padStart(2, "0")}-${dotted[1].padStart(2, "0")}`;
  }
  return today;
}

function shiftDay(day: string, delta: number): string {
  const at = Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)) + delta * 86_400_000;
  return new Date(at).toISOString().slice(0, 10);
}

// ------------------------------------------------------------------ actions

const writePostAction: Action = {
  name: "write_post",
  similes: ["draft_post", "make_post", "write_the_post", "post_now", "write_tweet"],
  description:
    "Write the public post for one day of the content plan and send it to the operator ready to publish. Use whenever the operator asks for a post, a tweet, or the post for today — the post is assembled from the day's slot in the plan plus what the repository actually shipped. Optionally takes a date ('today', '26.08') and an angle the operator wants taken. The finished text is delivered as its own message; do not retype it in your reply.",
  parameters: {
    type: "object",
    properties: {
      date: {
        type: "string",
        description: "Which day of the plan: 'today' (default), 'tomorrow', '26.08', '2026-08-26'.",
      },
      angle: {
        type: "string",
        description: "Optional instruction from the operator: what to stress, what to avoid.",
      },
    },
  },
  examples: [
    { user: "write today's post", agent: "writing the post from the plan for today…" },
    {
      user: "do the post about the bridge, but make it sound human",
      agent: "writing it — today's thesis plus what actually shipped for the bridge.",
    },
  ],
  async validate(runtime) {
    const svc = runtime.getService<PressService>("press");
    return Boolean(svc?.planLoaded);
  },
  async handler(runtime, state, params) {
    const svc = getPress(runtime);
    const day = resolveDay(params.date ? String(params.date) : undefined);
    const slot = svc.slotOn(day);
    if (!slot) {
      const plan = svc.contentPlan;
      return {
        ok: false,
        text: plan
          ? `The content plan covers ${plan.range.from}…${plan.range.to} and has no slot for ${day}.`
          : `No content plan is loaded${svc.planProblem ? ` (${svc.planProblem})` : ""}.`,
      };
    }
    let record;
    try {
      record = await svc.write(slot, { angle: params.angle ? String(params.angle) : undefined });
    } catch (err) {
      return { ok: false, text: `Couldn't write the post: ${(err as Error).message}` };
    }
    if (runtime.getSetting("LAINOS_PRESS_DELIVERY") === "chaos" && !(await svc.queueDelivery(slot, record))) {
      return { ok: false, text: `The post for ${day} was written but could not be sent with its image to Chaos. It has not been scheduled.` };
    }
    await svc.deliver(slot, record, { chatId: chatIdFromState(state) });
    return {
      ok: true,
      text:
        (record.chaosState === "draft"
          ? `The post for ${day} (${slot.pillar}) is on the Chaos desk with an image; ${record.chaosScheduleState === "scheduled" ? "it is scheduled in Buffer" : "it awaits scheduling"}. Do not claim it was published.`
          : `The post for ${day} (${slot.pillar}) has already been sent to the operator as its own message, ready to copy. Do not repeat it.`),
      data: { date: day, pillar: slot.pillar, chars: record.text.length, revision: record.revision },
    };
  },
};

const postPlanAction: Action = {
  name: "post_plan",
  similes: ["content_plan", "what_to_post", "post_plan_similes", "post_schedule"],
  description:
    "Show what the content plan says: today's slot, what is still owed, and whether today's post has been written, sent or published. Use when the operator asks what to post, what's planned, or how far behind the plan we are.",
  parameters: {
    type: "object",
    properties: {
      days: { type: "number", description: "How many upcoming days to list. Default 3." },
    },
  },
  examples: [{ user: "what's on the post plan?", agent: "checking the plan…" }],
  async validate(runtime) {
    return Boolean(runtime.getService("press"));
  },
  async handler(runtime, _state, params) {
    const svc = getPress(runtime);
    const plan = svc.contentPlan;
    if (!plan) {
      return { ok: false, text: `No content plan loaded${svc.planProblem ? `: ${svc.planProblem}` : "."}` };
    }
    const today = planDay();
    const ahead = Math.min(7, Math.max(1, Number(params.days) || 3));
    const upcoming = plan.slots.filter((s) => s.date >= today).slice(0, ahead);
    const owed = svc.pending(today);
    const lines = upcoming.map((s) => {
      const rec = svc.recordOn(s.date);
      const state = rec?.publishedAt
        ? "published"
        : rec?.skipped
          ? "skipped"
          : rec?.chaosScheduleState === "scheduled"
            ? "scheduled through Chaos and Buffer"
          : rec?.chaosState === "draft"
            ? "draft with image on Chaos press desk, awaiting scheduling"
          : svc.buffer?.enabled && svc.buffer.channelIds.some(id => svc.buffer?.submission(`press-${s.date}`, id)?.state === "queued")
            ? "queued in Buffer, awaiting publication"
          : rec?.deliveredAt
            ? "written, awaiting publication"
            : rec?.text
              ? "written"
              : "not written";
      return `${s.date} ${s.day} · ${s.pillar} — ${s.primary} [${state}]`;
    });
    return {
      ok: true,
      text:
        [
          `Plan: ${plan.title} (${plan.range.from}…${plan.range.to}).`,
          ...lines,
          owed.length
            ? `Still not written: ${owed.map((s) => s.date).join(", ")}.`
            : `No backlog on the plan.`,
        ].join("\n"),
      data: {
        today,
        owed: owed.map((s) => s.date),
        upcoming: upcoming.map((s) => ({ date: s.date, pillar: s.pillar, primary: s.primary })),
      },
    };
  },
};

const markPostPublishedAction: Action = {
  name: "mark_post_published",
  similes: ["post_published", "marked_as_published", "already_posted_it", "post_is_out"],
  description:
    "Record that the operator has published the post for a day, so it is not repeated in the evening. Only needed when the post went somewhere the channel does not show — a post in the watched Telegram channel is noticed by itself.",
  parameters: {
    type: "object",
    properties: { date: { type: "string", description: "Which day. Default today." } },
  },
  examples: [{ user: "I published the post", agent: "noted, I won't remind you about it tonight." }],
  async validate(runtime) {
    return Boolean(runtime.getService("press"));
  },
  async handler(runtime, _state, params) {
    const svc = getPress(runtime);
    const day = resolveDay(params.date ? String(params.date) : undefined);
    const record = await svc.markPublished(day);
    return record
      ? { ok: true, text: `Marked the post for ${day} as published.`, data: { date: day } }
      : { ok: false, text: `There is no written post for ${day}.` };
  },
};

const skipPostAction: Action = {
  name: "skip_post",
  similes: ["skip_day", "skip_the_post", "no_post_today"],
  description:
    "Drop one day of the content plan: nothing is written for it and it never joins the backlog. Use when the operator says there will be no post that day.",
  parameters: {
    type: "object",
    properties: { date: { type: "string", description: "Which day. Default today." } },
  },
  examples: [{ user: "no post today", agent: "got it, today's slot is closed." }],
  async validate(runtime) {
    const svc = runtime.getService<PressService>("press");
    return Boolean(svc?.planLoaded);
  },
  async handler(runtime, _state, params) {
    const svc = getPress(runtime);
    const day = resolveDay(params.date ? String(params.date) : undefined);
    const slot = await svc.skip(day);
    return slot
      ? { ok: true, text: `Skipped ${day} (${slot.pillar}).`, data: { date: day } }
      : { ok: false, text: `The plan has no slot for ${day}.` };
  },
};

const editorialAction: Action = {
  name: "press_editorial", similes: ["read_article_draft", "gemini_video_ideas"],
  description: "Read a prepared weekly X Articles draft, Gemini video ideas, or real UI demo brief for a specific date. These are unpublished drafts.",
  parameters: { type: "object", properties: { date: { type: "string", description: "Editorial date, YYYY-MM-DD" }, kind: { type: "string", enum: ["article", "video", "demo"] } }, required: ["date", "kind"] },
  examples: [{ user: "show this week's Gemini video ideas", agent: "opening the video briefs" }],
  async validate(runtime) { return Boolean(runtime.getService("press")); },
  async handler(runtime, _state, params) {
    try { const content = await getPress(runtime).editorial(String(params.date ?? ""), String(params.kind ?? "")); return { ok: true, text: content, data: { content } }; }
    catch { return { ok: false, text: "No matching editorial draft. Use the date from the editorial notification." }; }
  },
};

// ----------------------------------------------------------------- provider

const pressProvider: Provider = {
  name: "press",
  async get(runtime) {
    const svc = runtime.getService<PressService>("press");
    if (!svc) return "";
    const plan = svc.contentPlan;
    if (!plan) {
      return svc.planProblem
        ? `The content plan could not be read (${svc.planProblem}); write_post cannot run until it is fixed.`
        : "";
    }
    const today = planDay();
    const slot = svc.slotOn(today);
    const record = slot ? svc.recordOn(today) : undefined;
    const owed = svc.pending(today);
    const state = record?.publishedAt
      ? "already published"
      : record?.chaosScheduleState === "scheduled"
        ? "scheduled through Chaos and Buffer"
      : record?.chaosState === "draft"
        ? "draft with image on Chaos press desk, awaiting scheduling"
      : svc.buffer?.enabled && svc.buffer.channelIds.some(id => svc.buffer?.submission(`press-${today}`, id)?.state === "queued")
        ? "queued in Buffer, awaiting publication"
      : record?.deliveredAt
        ? "written and sent to the operator, not published yet"
        : record?.skipped
          ? "skipped by the operator"
          : "not written yet";
    return (
      `You write the account's daily post yourself — that is your job now, not reminding anyone ` +
      `to write one. Today (${today}) the plan says: ${slot ? `${slot.pillar} — ${slot.primary}` : "nothing (the plan does not cover today)"}. ` +
      `Status: ${state}.` +
      (owed.length ? ` Days still owing a post: ${owed.map((s) => s.date).join(", ")}.` : "") +
      ` Use write_post to write one (it delivers the finished text itself — never retype it), ` +
      `post_plan to say what is scheduled, mark_post_published when the operator says it is out, ` +
      `skip_post when a day is dropped. ` +
      (svc.buffer?.enabled ? `Use buffer_channels, buffer_queue_post and buffer_analytics for Buffer. A queued post is not yet published. ` : "") +
      (record?.chaosState === "draft" ? `The Chaos press desk has draft #${record.chaosDraftId}; ${record.chaosScheduleState === "scheduled" ? "it is scheduled, not necessarily published." : "it is not scheduled or published."} ` : "") +
      `Never invent what a post said or claim one was published.`
    );
  },
};

export const pressPlugin: Plugin = {
  name: "press",
  description:
    "Writes planned posts from repository material, delivers them to the operator, and can queue and monitor them through Buffer.",
  services: [new PressService()],
  providers: [pressProvider],
  actions: [writePostAction, postPlanAction, markPostPublishedAction, skipPostAction, editorialAction, ...bufferActions],
};

export { parsePlan, pendingSlots, planDay, slotFor } from "./plan.js";
export type { ContentPlan, PostSlot } from "./plan.js";
export { parseGitLog, commitsText, readCommits } from "./commits.js";
export type { Commit } from "./commits.js";
