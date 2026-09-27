import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from "undici";
import { createLogger } from "../../logger.js";
import type {
  Action,
  IAgentRuntime,
  Plugin,
  Provider,
  Service,
  State,
} from "../../types.js";

const log = createLogger("plugin:channel");

/**
 * The channel plugin keeps the rooms the operator speaks in alive. Two kinds of
 * room, and the whole design turns on whether Lain can actually see one:
 *
 *  - **readable** — a public Telegram channel. Its web preview
 *    (t.me/s/<name>, no admin rights needed) carries every post's timestamp,
 *    so "did we post today" is ground truth: days with posts pass in silence.
 *  - **blind** — a Discord behind an invite link, a group chat in X. Nothing
 *    outside can read either: Discord would need a bot inside the guild, an X
 *    chat would need the account's own session. There is no truth to check, so
 *    the schedule is the entire signal. The nudge says so rather than
 *    pretending it looked, and `mark_venue_posted` ("I already posted in discord")
 *    buys silence for the rest of the day.
 *
 * Past the reminder hour, every quiet room lands in **one** message per chat —
 * three separate pings would be exactly the noise this is meant to cure. A day
 * is never nudged twice. Watches persist in `data/channels.json`; records
 * written before venues existed had no `kind` and read back as Telegram
 * channels. Reminders are pushed through onEvent like sentinel alerts.
 */

/** What a watched room is — which decides whether its activity can be read. */
export type VenueKind = "telegram" | "discord" | "twitter" | "other";

export interface ChannelWatch {
  id: string;
  /** Venue kind; absent in pre-venue records, where it means "telegram". */
  kind: VenueKind;
  /** Stable key: the Telegram username, or a slug for a blind venue. */
  channel: string;
  /** Human name of a blind venue, e.g. "discord" or "the X chat". */
  label?: string;
  /** Invite/chat link, carried into the reminder so the nudge is one tap. */
  url?: string;
  reporter: string;
  /** Telegram chat to deliver to, when known. */
  chatId?: number;
  /** Host-local hour (0-23) after which a silent day triggers the nudge. */
  remindHour: number;
  createdAt: number;
  lastCheckedAt?: number;
  /** Unix ms of the newest post seen on the last check (readable venues). */
  lastPostAt?: number;
  /** YYYY-MM-DD of the last day a reminder went out (max one per day). */
  lastRemindedDay?: string;
  /** YYYY-MM-DD the operator said they had already written there. */
  lastPostedDay?: string;
}

export interface ChannelEvent {
  kind: "reminder";
  text: string;
  /** Every venue this one reminder covers. */
  watches: ChannelWatch[];
  chatId?: number;
}

export interface ChannelActivity {
  /** Unix ms of the newest post on the preview page, or null when none parse. */
  lastPostAt: number | null;
  /** Posts whose host-local day equals `day`. */
  postsToday: number;
}

/** One post as the public preview renders it: when it went out, and its text. */
export interface ChannelPost {
  at: number;
  text: string;
}

/**
 * A service that owns the daily post for a channel itself (the press room).
 * The watcher asks before nudging: a reminder to post, delivered next to a
 * finished post, is exactly the noise these reminders were meant to prevent.
 * Duck-typed rather than imported so the dependency stays one-directional.
 */
interface PostAuthority {
  covers(channel: string): boolean;
}

interface ChannelFile {
  watches: ChannelWatch[];
  counter: number;
}

const DEFAULT_REMIND_HOUR = 18;
const DEFAULT_TICK_MS = 1_800_000; // 30 min
const CHANNEL_RE = /^[a-zA-Z][a-zA-Z0-9_]{3,31}$/;

/** Host-local calendar day as YYYY-MM-DD (reminders fire in host time). */
export function localDay(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Strip t.me/…, @… and trailing paths down to the bare channel username. */
export function normalizeChannel(raw: string): string {
  return raw
    .trim()
    .replace(/^(https?:\/\/)?t\.me\/(s\/)?/i, "")
    .replace(/^@/, "")
    .replace(/[/?#].*$/, "");
}

/** Only a public Telegram channel exposes its posts to an outside reader. */
export function isReadableVenue(watch: ChannelWatch): boolean {
  return watch.kind === "telegram";
}

/** Display name: the t.me handle for channels, the given name for the rest. */
export function venueLabel(watch: ChannelWatch): string {
  if (watch.kind === "telegram") return `t.me/${watch.channel}`;
  return watch.label ?? watch.channel;
}

/** Guess the venue from what the operator called it or linked to. */
export function inferVenueKind(raw: string): VenueKind {
  const s = raw.toLowerCase();
  if (/discord/.test(s)) return "discord";
  if (/twitter|x\.com/.test(s)) return "twitter";
  if (/(^|[^a-z])t\.me|telegram/.test(s)) return "telegram";
  return "other";
}

/**
 * Parse the message timestamps out of a channel's public web preview
 * (https://t.me/s/<name>): every post carries a `<time datetime="…">` inside
 * its date link. Returns the newest post time and how many posts fall on the
 * given host-local day. Exported for tests.
 */
export function parseChannelPosts(html: string, day: string): ChannelActivity {
  let lastPostAt: number | null = null;
  let postsToday = 0;
  for (const m of html.matchAll(/<time[^>]*datetime="([^"]+)"/gi)) {
    const at = Date.parse(m[1]);
    if (!Number.isFinite(at)) continue;
    if (lastPostAt === null || at > lastPostAt) lastPostAt = at;
    if (localDay(new Date(at)) === day) postsToday += 1;
  }
  return { lastPostAt, postsToday };
}

/**
 * Parse the posts themselves out of a channel's public web preview: each
 * message block carries its text next to the `<time datetime="…">` of the date
 * link. Oldest first, as the page renders them. Exported for tests.
 */
export function parseChannelPostTexts(html: string): ChannelPost[] {
  const posts: ChannelPost[] = [];
  // Each message's text block is followed by its own dated footer link, so the
  // post is paired with the first <time> that comes after it. Splitting on the
  // message container instead would cut inside it: `tgme_widget_message_text`
  // starts with the container's own class name.
  for (const m of html.matchAll(
    /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
  )) {
    const end = (m.index ?? 0) + m[0].length;
    const at = Date.parse(
      html.slice(end, end + 4000).match(/<time[^>]*datetime="([^"]+)"/i)?.[1] ?? "",
    );
    if (!Number.isFinite(at)) continue;
    const text = stripHtml(m[1]);
    if (text) posts.push({ at, text });
  }
  return posts;
}

/** Telegram's preview markup → the plain text a reader sees. */
function stripHtml(raw: string): string {
  return decodeEntities(
    raw
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div)>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeEntities(raw: string): string {
  return raw
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/**
 * Does this venue owe a nudge right now? Pure, so the schedule is testable
 * without a clock or a network. `activity` is the reading for a readable
 * venue and is ignored for blind ones — a readable day that could not be read
 * is never nudged (a blocked preview is not proof of silence), while a blind
 * venue has nothing to read and rides on the schedule alone.
 */
export function isVenueDue(
  watch: ChannelWatch,
  now: Date,
  activity: ChannelActivity | null,
): boolean {
  const day = localDay(now);
  if (watch.lastRemindedDay === day) return false;
  if (watch.lastPostedDay === day) return false;
  if (now.getHours() < watch.remindHour) return false;
  if (!isReadableVenue(watch)) return true;
  return activity !== null && activity.postsToday === 0;
}

/** The evening message: every quiet room at once, in one nudge. */
export function reminderText(watches: ChannelWatch[]): string {
  const blind = watches.filter((w) => !isReadableVenue(w));
  const lines = watches.map((w) => {
    if (isReadableVenue(w)) {
      const last = w.lastPostAt
        ? ` (last post: ${new Date(w.lastPostAt).toLocaleString("en-US")})`
        : "";
      return `• ${venueLabel(w)} — no posts yet today${last}`;
    }
    return `• ${venueLabel(w)}${w.url ? ` — ${w.url}` : ""}`;
  });
  const tail: string[] = [];
  if (watches.some(isReadableVenue)) {
    tail.push("posts from the channel mirror to twitter and keep the public channel alive.");
  }
  if (blind.length) {
    tail.push(
      `I can't see inside ${listAnd(blind.map(venueLabel))} — reminding on schedule. ` +
        `if you've already written there, say so and I'll go quiet until tomorrow.`,
    );
  }
  return ["📣 quiet today:", ...lines, ...tail].join("\n");
}

export class ChannelWatchService implements Service {
  readonly name = "channel-watch";

  private watches: ChannelWatch[] = [];
  private counter = 0;
  private file = "";
  private timer: ReturnType<typeof setInterval> | null = null;
  private dispatcher?: Dispatcher;
  private busy = false;
  private defaultRemindHour = DEFAULT_REMIND_HOUR;
  private subscribers = new Set<(event: ChannelEvent) => void>();
  private runtime?: IAgentRuntime;

  async start(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
    const dataDir = runtime.getSetting("LAINOS_DATA_DIR") ?? "./data";
    this.file = join(dataDir, "channels.json");
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as ChannelFile;
      // Records predating venues carry no kind: they were all Telegram channels.
      this.watches = (parsed.watches ?? []).map((w) => ({ ...w, kind: w.kind ?? "telegram" }));
      this.counter = parsed.counter ?? 0;
    } catch {
      // Fresh store.
    }

    // t.me is blocked on the same hosts as api.telegram.org, so the Telegram
    // proxy is the natural first fallback.
    const proxy =
      runtime.getSetting("LAINOS_CHANNEL_PROXY") ??
      runtime.getSetting("TELEGRAM_PROXY") ??
      runtime.getSetting("LAINOS_MODEL_PROXY") ??
      runtime.getSetting("HTTPS_PROXY");
    if (proxy) this.dispatcher = new ProxyAgent(proxy);

    const hour = Number(runtime.getSetting("LAINOS_CHANNEL_REMIND_HOUR") ?? DEFAULT_REMIND_HOUR);
    this.defaultRemindHour = Number.isFinite(hour)
      ? Math.min(23, Math.max(0, hour))
      : DEFAULT_REMIND_HOUR;

    const tick = Number(runtime.getSetting("LAINOS_CHANNEL_INTERVAL_MS") ?? DEFAULT_TICK_MS);
    this.timer = setInterval(() => void this.tick(), Math.max(60_000, tick));
    this.timer.unref?.();
    log.info(
      `channel watch online: ${this.watches.length} venue(s)` +
        `${proxy ? `, proxy ${proxy}` : ""}, tick every ${Math.max(60_000, tick) / 60_000}m`,
    );
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  onEvent(fn: (event: ChannelEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  listWatches(): ChannelWatch[] {
    return [...this.watches];
  }

  /**
   * Add or update a watched venue. A Telegram channel is keyed by its
   * username and must look like one; a blind venue is keyed by a slug of its
   * name, because there is no handle to validate against.
   */
  async addWatch(input: {
    channel: string;
    kind?: VenueKind;
    label?: string;
    url?: string;
    reporter: string;
    chatId?: number;
    remindHour?: number;
  }): Promise<ChannelWatch | null> {
    const raw = input.channel.trim();
    if (!raw) return null;
    const kind = input.kind ?? "telegram";

    let key: string;
    let label: string | undefined;
    let url = input.url?.trim() || undefined;
    if (kind === "telegram") {
      key = normalizeChannel(raw);
      if (!CHANNEL_RE.test(key)) return null;
    } else {
      label = (input.label ?? raw).trim();
      if (isUrl(raw) && !url) {
        url = raw;
        if (label === raw) label = defaultLabelFor(kind, raw);
      }
      if (!label) return null;
      key = slugify(label) || slugify(url ?? "") || kind;
    }

    const existing = this.watches.find(
      (w) => w.kind === kind && w.channel.toLowerCase() === key.toLowerCase(),
    );
    if (existing) {
      if (input.chatId !== undefined) existing.chatId = input.chatId;
      if (input.remindHour !== undefined) existing.remindHour = clampHour(input.remindHour);
      if (label) existing.label = label;
      if (url) existing.url = url;
      await this.persist();
      return existing;
    }

    this.counter += 1;
    const watch: ChannelWatch = {
      id: `ch${this.counter}`,
      kind,
      channel: key,
      label,
      url,
      reporter: input.reporter,
      chatId: input.chatId,
      remindHour:
        input.remindHour !== undefined ? clampHour(input.remindHour) : this.defaultRemindHour,
      createdAt: Date.now(),
    };
    this.watches.push(watch);
    await this.persist();
    log.info(
      `venue added: [${watch.id}] ${venueLabel(watch)} (${watch.kind}, ` +
        `${isReadableVenue(watch) ? "readable" : "blind"}, remind after ${watch.remindHour}:00)`,
    );
    return watch;
  }

  async removeWatch(idOrName: string): Promise<boolean> {
    const target = this.match(idOrName);
    if (!target) return false;
    this.watches = this.watches.filter((w) => w !== target);
    await this.persist();
    return true;
  }

  /**
   * "I already wrote there" — silence a blind venue for the rest of the day.
   * Without a name it covers every blind venue, since the readable ones answer
   * that question themselves. Returns what it actually marked.
   */
  async markPosted(idOrName?: string, day = localDay()): Promise<ChannelWatch[]> {
    const marked = idOrName?.trim()
      ? [this.match(idOrName)].filter((w): w is ChannelWatch => Boolean(w))
      : this.watches.filter((w) => !isReadableVenue(w));
    if (!marked.length) return [];
    for (const watch of marked) watch.lastPostedDay = day;
    await this.persist();
    return marked;
  }

  /** Find a venue by id, key, label, or — when unambiguous — by its kind. */
  match(key: string): ChannelWatch | undefined {
    const k = key.trim().toLowerCase();
    if (!k) return undefined;
    const bare = normalizeChannel(key).toLowerCase();
    const direct = this.watches.find(
      (w) =>
        w.id.toLowerCase() === k ||
        w.channel.toLowerCase() === k ||
        w.channel.toLowerCase() === bare ||
        (w.label ?? "").toLowerCase() === k ||
        (w.url ?? "").toLowerCase() === k,
    );
    if (direct) return direct;
    // "discord", "the twitter chat" — a kind names a venue while it is the only one.
    const kind = inferVenueKind(k);
    const ofKind = this.watches.filter((w) => w.kind === kind);
    if (kind !== "other" && ofKind.length === 1) return ofKind[0];
    return this.watches.find((w) => (w.label ?? "").toLowerCase().includes(k));
  }

  /**
   * Read the channel's public preview and report today's activity. Returns
   * null when the page could not be fetched or holds no parseable posts (a
   * private channel, a blocked preview) — an unknown day is never nudged.
   */
  async activityToday(channel: string): Promise<ChannelActivity | null> {
    try {
      const html = await this.get(`https://t.me/s/${channel}`);
      const activity = parseChannelPosts(html, localDay());
      return activity.lastPostAt === null ? null : activity;
    } catch (err) {
      log.warn(`preview fetch failed for t.me/${channel}`, err);
      return null;
    }
  }

  /**
   * Read the channel's public preview and return its recent posts, newest
   * last. Null when the page could not be read — the caller must be able to
   * tell "nothing published" from "nothing readable".
   */
  async recentPosts(channel: string): Promise<ChannelPost[] | null> {
    try {
      return parseChannelPostTexts(await this.get(`https://t.me/s/${channel}`));
    } catch (err) {
      log.warn(`preview fetch failed for t.me/${channel}`, err);
      return null;
    }
  }

  /** Scheduled sweep: one nudge per chat per day, covering every quiet venue. */
  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = new Date();
      const day = localDay(now);
      const due: ChannelWatch[] = [];
      const author = this.runtime?.getService<PostAuthority & Service>("press");
      let dirty = false;
      for (const watch of this.watches) {
        if (watch.lastRemindedDay === day || watch.lastPostedDay === day) continue;
        if (now.getHours() < watch.remindHour) continue;
        // Somebody else already owns this room's daily post and delivers it
        // written — nudging on top of that is the noise, not the cure.
        if (isReadableVenue(watch) && author?.covers(watch.channel)) continue;
        let activity: ChannelActivity | null = null;
        if (isReadableVenue(watch)) {
          activity = await this.activityToday(watch.channel);
          watch.lastCheckedAt = Date.now();
          if (activity?.lastPostAt) watch.lastPostAt = activity.lastPostAt;
          dirty = true;
        }
        if (isVenueDue(watch, now, activity)) due.push(watch);
      }
      for (const watch of due) {
        watch.lastRemindedDay = day;
        dirty = true;
      }
      if (dirty) await this.persist();
      for (const [chatId, group] of groupByChat(due)) {
        const text = reminderText(group);
        for (const fn of this.subscribers) {
          try {
            fn({ kind: "reminder", text, watches: group, chatId });
          } catch {
            /* a broken subscriber must never break the watcher */
          }
        }
      }
    } finally {
      this.busy = false;
    }
  }

  /** GET with the proxy when configured, falling back to a direct request. */
  private async get(url: string): Promise<string> {
    try {
      return await this.fetchOnce(url, this.dispatcher);
    } catch (err) {
      if (!this.dispatcher) throw err;
      return this.fetchOnce(url, undefined);
    }
  }

  private async fetchOnce(url: string, dispatcher?: Dispatcher): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await undiciFetch(url, {
        headers: {
          "user-agent":
            "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
        },
        dispatcher,
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`${new URL(url).host} HTTP ${res.status}`);
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const payload: ChannelFile = { watches: this.watches, counter: this.counter };
    await writeFile(this.file, JSON.stringify(payload, null, 2), "utf8");
  }
}

// ------------------------------------------------------------------ helpers

function clampHour(hour: number): number {
  return Number.isFinite(hour) ? Math.min(23, Math.max(0, Math.round(hour))) : DEFAULT_REMIND_HOUR;
}

function isUrl(raw: string): boolean {
  return /^https?:\/\//i.test(raw.trim());
}

function defaultLabelFor(kind: VenueKind, raw: string): string {
  if (kind === "discord") return "discord";
  if (kind === "twitter") return "the X chat";
  try {
    return new URL(raw).host;
  } catch {
    return raw;
  }
}

function slugify(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** "a, b and c" — the reminder reads as a sentence, not a CSV row. */
function listAnd(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function groupByChat(watches: ChannelWatch[]): Map<number | undefined, ChannelWatch[]> {
  const groups = new Map<number | undefined, ChannelWatch[]>();
  for (const watch of watches) {
    const group = groups.get(watch.chatId);
    if (group) group.push(watch);
    else groups.set(watch.chatId, [watch]);
  }
  return groups;
}

function getChannels(runtime: IAgentRuntime): ChannelWatchService {
  const svc = runtime.getService<ChannelWatchService>("channel-watch");
  if (!svc) throw new Error("channel-watch service not started");
  return svc;
}

function chatIdFromState(state: State): number | undefined {
  if (!state.roomId.startsWith("tg-")) return undefined;
  const id = Number(state.roomId.slice(3));
  return Number.isFinite(id) ? id : undefined;
}

// ------------------------------------------------------------------ actions

const watchChannelPostsAction: Action = {
  name: "watch_channel_posts",
  similes: ["watch_telegram_channel", "channel_streak", "post_reminder", "watch_posts"],
  description:
    "Remind the user every day when a public Telegram channel has no posts yet: watches the channel's public preview (t.me/s/<name>) and sends one reminder in the evening on days without posts (silence on days with them). Use when someone asks to make sure a channel posts daily — e.g. because its posts are mirrored to Twitter and move the token price. For a Discord server or an X group chat, use watch_chat_silence instead — those cannot be read from outside.",
  parameters: {
    type: "object",
    properties: {
      channel: {
        type: "string",
        description: "Public channel username or t.me link, e.g. 'my_channel'.",
      },
      remind_hour: {
        type: "number",
        description: "Hour of day (0-23) after which to remind on postless days. Default 18.",
      },
    },
    required: ["channel"],
  },
  examples: [
    {
      user: "watch the public channel t.me/my_channel — it should post every day",
      agent: "watching t.me/my_channel — I'll remind you in the evening if no post went out that day.",
    },
  ],
  async validate(runtime) {
    return Boolean(runtime.getService("channel-watch"));
  },
  async handler(runtime, state, params) {
    const svc = getChannels(runtime);
    const channel = String(params.channel ?? "").trim();
    if (!channel) return { ok: false, text: "I need the channel username to watch." };
    const hour = Number(params.remind_hour);
    const watch = await svc.addWatch({
      channel,
      kind: "telegram",
      reporter: state.message.userId,
      chatId: chatIdFromState(state),
      remindHour: Number.isFinite(hour) ? hour : undefined,
    });
    if (!watch) {
      return { ok: false, text: `"${channel}" doesn't look like a public channel username.` };
    }
    return {
      ok: true,
      text:
        `Watching t.me/${watch.channel} (${watch.id}): on days with no posts ` +
        `I'll remind you here after ${watch.remindHour}:00.`,
      data: { id: watch.id, channel: watch.channel, remindHour: watch.remindHour },
    };
  },
};

const watchChatSilenceAction: Action = {
  name: "watch_chat_silence",
  similes: [
    "watch_discord",
    "watch_twitter_chat",
    "remind_to_write",
    "watch_chat",
    "chat_reminder",
  ],
  description:
    "Add a daily reminder to write somewhere that cannot be read from outside — a Discord server behind an invite, a group chat or DM in X, any other room. There is no way to check whether it is really quiet (Discord needs a bot inside the guild, an X chat needs the account's session), so the reminder fires on schedule and says so; the user silences it for a day with mark_venue_posted. Reminders for all watched places arrive as one evening message.",
  parameters: {
    type: "object",
    properties: {
      place: {
        type: "string",
        description: "What to nudge about: a name like 'discord' / 'the X chat', or a link to it.",
      },
      kind: {
        type: "string",
        description: "One of 'discord', 'twitter', 'other'. Inferred from the name when omitted.",
      },
      link: {
        type: "string",
        description: "Optional invite/chat URL, included in the reminder.",
      },
      remind_hour: {
        type: "number",
        description: "Hour of day (0-23) after which to nudge. Default 18.",
      },
    },
    required: ["place"],
  },
  examples: [
    {
      user: "I also have a twitter chat and a discord, it's quiet there — remind me to write",
      agent:
        "I'll remind you about both in the evening along with the channel. I can't see inside them — if you've written there, say so and I'll go quiet until tomorrow.",
    },
  ],
  async validate(runtime) {
    return Boolean(runtime.getService("channel-watch"));
  },
  async handler(runtime, state, params) {
    const svc = getChannels(runtime);
    const place = String(params.place ?? "").trim();
    if (!place) return { ok: false, text: "I need to know which chat to remind you about." };
    const asked = String(params.kind ?? "").trim().toLowerCase();
    const kind: VenueKind =
      asked === "discord" || asked === "twitter" || asked === "telegram" || asked === "other"
        ? (asked as VenueKind)
        : inferVenueKind(`${place} ${params.link ?? ""}`);
    if (kind === "telegram") {
      return {
        ok: false,
        text: "That looks like a Telegram channel — watch_channel_posts reads it for real.",
      };
    }
    const hour = Number(params.remind_hour);
    const watch = await svc.addWatch({
      channel: place,
      kind,
      url: params.link ? String(params.link) : undefined,
      reporter: state.message.userId,
      chatId: chatIdFromState(state),
      remindHour: Number.isFinite(hour) ? hour : undefined,
    });
    if (!watch) return { ok: false, text: `I couldn't make a watch out of "${place}".` };
    return {
      ok: true,
      text:
        `Watching ${venueLabel(watch)} (${watch.id}): I'll nudge you here after ` +
        `${watch.remindHour}:00 every day. I can't see inside it, so the nudge says so — ` +
        `tell me you've written there and it stays quiet until tomorrow.`,
      data: {
        id: watch.id,
        kind: watch.kind,
        label: venueLabel(watch),
        remindHour: watch.remindHour,
        readable: false,
      },
    };
  },
};

const markVenuePostedAction: Action = {
  name: "mark_venue_posted",
  similes: ["already_posted", "wrote_there", "silence_today", "posted_already"],
  description:
    "Record that the user has already written in a watched chat today, so its reminder stays quiet until tomorrow. Only meaningful for places that cannot be read (Discord, X chats) — a Telegram channel answers that question by itself. Without a name it covers every unreadable place at once.",
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "Watch id ('ch2'), name ('discord') or link. Omit for all blind venues.",
      },
    },
  },
  examples: [
    { user: "I already posted in discord", agent: "got it, no discord reminder today." },
  ],
  async validate(runtime) {
    return Boolean(runtime.getService("channel-watch"));
  },
  async handler(runtime, _state, params) {
    const svc = getChannels(runtime);
    const id = params.id ? String(params.id) : undefined;
    const marked = await svc.markPosted(id);
    if (!marked.length) {
      return {
        ok: false,
        text: id ? `No watched chat matching ${id}.` : "No unreadable chats are being watched.",
      };
    }
    return {
      ok: true,
      text: `Noted — no reminder today for ${marked.map(venueLabel).join(", ")}.`,
      data: { marked: marked.map((w) => ({ id: w.id, label: venueLabel(w) })) },
    };
  },
};

const checkChannelPostsAction: Action = {
  name: "check_channel_posts",
  similes: ["channel_today", "posts_today", "last_post", "channel_status"],
  description:
    "Check right now whether a public Telegram channel has posts today, and when the last post went out. Defaults to the watched channel when only one is watched. Discord servers and X chats cannot be checked this way — it will say so.",
  parameters: {
    type: "object",
    properties: {
      channel: { type: "string", description: "Channel username. Defaults to the watched one." },
    },
  },
  examples: [{ user: "has the channel posted today?", agent: "checking the channel preview…" }],
  async validate(runtime) {
    return Boolean(runtime.getService("channel-watch"));
  },
  async handler(runtime, _state, params) {
    const svc = getChannels(runtime);
    const asked = String(params.channel ?? "").trim();
    const readable = svc.listWatches().filter(isReadableVenue);

    if (asked) {
      const watched = svc.match(asked);
      if (watched && !isReadableVenue(watched)) {
        const day = localDay();
        return {
          ok: true,
          text:
            `${venueLabel(watched)} can't be read from outside — I only know whether you told ` +
            `me you wrote there today (${watched.lastPostedDay === day ? "you did" : "you haven't"}).`,
          data: { id: watched.id, kind: watched.kind, readable: false },
        };
      }
    }

    const channel =
      normalizeChannel(asked) || (readable.length === 1 ? readable[0].channel : "");
    if (!channel) {
      return { ok: false, text: "Which channel? I'm not watching exactly one." };
    }
    const activity = await svc.activityToday(channel);
    if (!activity) {
      return {
        ok: false,
        text: `Couldn't read the public preview of t.me/${channel} right now (is it public?).`,
      };
    }
    const last = activity.lastPostAt
      ? new Date(activity.lastPostAt).toLocaleString("en-US")
      : "unknown";
    return {
      ok: true,
      text:
        activity.postsToday > 0
          ? `Yes — t.me/${channel} has ${activity.postsToday} post(s) today; last at ${last}.`
          : `Not yet — t.me/${channel} has no posts today. Last post: ${last}. Twitter is waiting.`,
      data: { channel, ...activity },
    };
  },
};

const stopChannelWatchAction: Action = {
  name: "stop_channel_watch",
  similes: ["unwatch_channel", "stop_post_reminder", "remove_channel_watch", "unwatch_chat"],
  description:
    "Stop a daily reminder, by watch id (ch1), channel username, or the name of a chat ('discord').",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Watch id (e.g. 'ch1'), channel username or chat name." },
    },
    required: ["id"],
  },
  examples: [{ user: "stop watching the channel", agent: "removed the reminder." }],
  async validate(runtime) {
    return Boolean(runtime.getService("channel-watch"));
  },
  async handler(runtime, _state, params) {
    const svc = getChannels(runtime);
    const id = String(params.id ?? "").trim();
    const target = svc.match(id);
    const removed = target ? await svc.removeWatch(id) : false;
    return removed
      ? { ok: true, text: `Stopped watching ${target ? venueLabel(target) : id}.` }
      : { ok: false, text: `No watch matching ${id}.` };
  },
};

// ------------------------------------------------------------------ provider

const channelProvider: Provider = {
  name: "channel",
  async get(runtime) {
    const svc = runtime.getService<ChannelWatchService>("channel-watch");
    if (!svc) return "";
    const watches = svc.listWatches();
    if (!watches.length) {
      return (
        "You can keep the project's rooms alive: watch_channel_posts sets a daily reminder for " +
        "a public Telegram channel that fires only on days it published nothing, and " +
        "watch_chat_silence does the same on schedule for places you cannot read " +
        "(a Discord behind an invite, a group chat in X)."
      );
    }
    const listed = watches
      .map(
        (w) =>
          `${w.id} ${venueLabel(w)} (${isReadableVenue(w) ? "readable" : "blind"}, ` +
          `remind after ${w.remindHour}:00)`,
      )
      .join(", ");
    const blind = watches.filter((w) => !isReadableVenue(w));
    return (
      `You watch these rooms for daily activity: ${listed}. All due reminders go out ` +
      `automatically as one evening message. check_channel_posts answers "did the channel ` +
      `post today" for Telegram.` +
      (blind.length
        ? ` ${listAnd(blind.map(venueLabel))} cannot be read from outside — never claim to know ` +
          `whether they are quiet; when the user says they have already written there, call ` +
          `mark_venue_posted so today's nudge is dropped.`
        : "")
    );
  },
};

export const channelPlugin: Plugin = {
  name: "channel",
  description:
    "Keeper of the rooms the operator speaks in: reads a public Telegram channel's posts for real, nudges on schedule about the ones nothing can read (Discord, X chats), and delivers every due reminder as one evening message.",
  services: [new ChannelWatchService()],
  providers: [channelProvider],
  actions: [
    watchChannelPostsAction,
    watchChatSilenceAction,
    markVenuePostedAction,
    checkChannelPostsAction,
    stopChannelWatchAction,
  ],
};
