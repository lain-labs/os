import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from "undici";
import { createLogger } from "../../logger.js";
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

const log = createLogger("plugin:scout");

/**
 * The scout is Lain's autonomous researcher. A holder says "watch Solana and
 * only tell me about genuinely important changes" or "collect everything about
 * zkVM every day" — that becomes a *topic*: on its own schedule the scout sweeps public
 * sources (Hacker News, Reddit, GitHub, Google News, optionally a Nitter
 * instance for X), drops everything already seen, and asks the agent's model
 * to distill the rest into a digest honouring the topic's instruction. If
 * nothing clears the importance bar, no message is sent at all.
 *
 * Topics persist in `data/scout.json`; digests are pushed through onEvent
 * (Telegram chat of the requester, TUI feed) like sentinel alerts.
 */

export interface Topic {
  id: string;
  /** What to research, e.g. "Solana" or "zkVM". */
  query: string;
  /** The requester's instruction verbatim, e.g. "only really important changes". */
  note?: string;
  reporter: string;
  /** Telegram chat to deliver to, when known. */
  chatId?: number;
  intervalMs: number;
  createdAt: number;
  lastRunAt?: number;
  lastDigestAt?: number;
  /** URLs already shown/considered, to never repeat items. */
  seen: string[];
}

export interface ScoutItem {
  title: string;
  url: string;
  source: string;
  score?: number;
  at?: number;
}

export interface ScoutEvent {
  kind: "digest";
  text: string;
  topic: Topic;
  chatId?: number;
}

interface ScoutFile {
  topics: Topic[];
  counter: number;
}

interface RunTopicOptions {
  deliver: boolean;
  /** Use fetched items even when they were already seen. Useful for manual "run now". */
  includeSeen?: boolean;
  /** Return a human note instead of null when nothing clears the digest bar. */
  noteOnEmpty?: boolean;
}

const SEEN_CAP = 600;
const PROMPT_ITEM_CAP = 40;
const MIN_INTERVAL_MS = 3_600_000; // 1h
const DEFAULT_INTERVAL_MS = 86_400_000; // daily

export class ScoutService implements Service {
  readonly name = "scout";

  private topics: Topic[] = [];
  private counter = 0;
  private file = "";
  private runtime?: IAgentRuntime;
  private timer: ReturnType<typeof setInterval> | null = null;
  private dispatcher?: Dispatcher;
  private busy = false;
  private subscribers = new Set<(event: ScoutEvent) => void>();

  async start(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
    const dataDir = runtime.getSetting("LAINOS_DATA_DIR") ?? "./data";
    this.file = join(dataDir, "scout.json");
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as ScoutFile;
      this.topics = parsed.topics ?? [];
      this.counter = parsed.counter ?? 0;
    } catch {
      // Fresh store.
    }

    const proxy =
      runtime.getSetting("LAINOS_SCOUT_PROXY") ??
      runtime.getSetting("LAINOS_MODEL_PROXY") ??
      runtime.getSetting("HTTPS_PROXY");
    if (proxy) this.dispatcher = new ProxyAgent(proxy);

    const tick = Number(runtime.getSetting("LAINOS_SCOUT_INTERVAL_MS") ?? 600_000);
    this.timer = setInterval(() => void this.tick(), Math.max(60_000, tick));
    this.timer.unref?.();
    log.info(
      `scout online: ${this.topics.length} topic(s)` +
        `${proxy ? `, proxy ${proxy}` : ""}, tick every ${Math.max(60_000, tick) / 60_000}m`,
    );
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  onEvent(fn: (event: ScoutEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  listTopics(): Topic[] {
    return [...this.topics];
  }

  getTopic(id: string): Topic | undefined {
    return this.topics.find((t) => t.id === id);
  }

  async setTopicChatId(id: string, chatId: number): Promise<boolean> {
    const topic = this.getTopic(id);
    if (!topic) return false;
    topic.chatId = chatId;
    await this.persist();
    return true;
  }

  async updateTopic(
    id: string,
    patch: { chatId?: number; intervalMs?: number },
  ): Promise<boolean> {
    const topic = this.getTopic(id);
    if (!topic) return false;
    if (patch.chatId !== undefined) topic.chatId = patch.chatId;
    if (patch.intervalMs !== undefined) topic.intervalMs = Math.max(MIN_INTERVAL_MS, patch.intervalMs);
    await this.persist();
    return true;
  }

  async addTopic(input: {
    query: string;
    note?: string;
    reporter: string;
    chatId?: number;
    intervalMs?: number;
    runImmediately?: boolean;
  }): Promise<Topic> {
    this.counter += 1;
    const topic: Topic = {
      id: `topic${this.counter}`,
      query: input.query.trim(),
      note: input.note?.trim() || undefined,
      reporter: input.reporter,
      chatId: input.chatId,
      intervalMs: Math.max(MIN_INTERVAL_MS, input.intervalMs ?? DEFAULT_INTERVAL_MS),
      createdAt: Date.now(),
      seen: [],
    };
    this.topics.push(topic);
    await this.persist();
    log.info(`topic added: [${topic.id}] ${topic.query} (every ${topic.intervalMs / 3_600_000}h)`);
    // First sweep right away, so the requester sees value immediately.
    if (input.runImmediately !== false) {
      void this.runTopic(topic, { deliver: true }).catch((err) =>
        log.warn(`first scan of ${topic.id} failed`, err),
      );
    }
    return topic;
  }

  async removeTopic(id: string): Promise<boolean> {
    const before = this.topics.length;
    this.topics = this.topics.filter((t) => t.id !== id);
    if (this.topics.length !== before) {
      await this.persist();
      return true;
    }
    return false;
  }

  /** Scheduled sweep: run every topic that is due, one at a time. */
  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = Date.now();
      for (const topic of this.topics) {
        const due = (topic.lastRunAt ?? 0) + topic.intervalMs <= now;
        if (!due) continue;
        try {
          await this.runTopic(topic, { deliver: true });
        } catch (err) {
          log.warn(`scan of ${topic.id} failed`, err);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  /**
   * One research sweep: gather → dedup → distill → (optionally) deliver.
   * Returns the digest text, or null when nothing cleared the importance bar.
   */
  async runTopic(topic: Topic, opts: RunTopicOptions): Promise<string | null> {
    topic.lastRunAt = Date.now();
    const items = await this.gather(topic.query);
    const seen = new Set(topic.seen);
    const fresh = items.filter((i) => !seen.has(i.url));
    const candidates = fresh.length || !opts.includeSeen ? fresh : items;
    // Everything fetched counts as seen — importance-rejected items must not
    // resurface on the next sweep either.
    topic.seen = [...topic.seen, ...fresh.map((i) => i.url)].slice(-SEEN_CAP);
    await this.persist();

    log.info(`scan ${topic.id} "${topic.query}": ${items.length} items, ${fresh.length} new`);
    if (!candidates.length) {
      if (!opts.noteOnEmpty) return null;
      return this.finishDigest(topic, this.emptyStudyNote(topic, items, fresh), opts);
    }

    const digest = await this.distill(topic, candidates);
    if (!digest) {
      if (!opts.noteOnEmpty) return null;
      return this.finishDigest(topic, this.emptyStudyNote(topic, items, fresh), opts);
    }

    return this.finishDigest(topic, `🔭 ${topic.query} — digest (${topic.id})\n\n${digest}`, opts);
  }

  private async finishDigest(
    topic: Topic,
    text: string,
    opts: RunTopicOptions,
  ): Promise<string> {
    topic.lastDigestAt = Date.now();
    await this.persist();
    if (opts.deliver) {
      for (const fn of this.subscribers) {
        try {
          fn({ kind: "digest", text, topic, chatId: topic.chatId });
        } catch {
          /* a broken subscriber must never break the scout */
        }
      }
    }
    return text;
  }

  private emptyStudyNote(topic: Topic, items: ScoutItem[], fresh: ScoutItem[]): string {
    const bySource = new Map<string, number>();
    for (const item of items) bySource.set(item.source, (bySource.get(item.source) ?? 0) + 1);
    const sources = bySource.size
      ? [...bySource.entries()].map(([source, count]) => `${source}: ${count}`).join(", ")
      : "sources returned no results";
    const lines = [
      `📝 ${topic.query} — note (${topic.id})`,
      "",
      `Checked public sources: ${sources}.`,
      fresh.length
        ? `New candidates: ${fresh.length}, but none look important enough for a full digest.`
        : "No new candidates since the last pass; this is a manual check-in run.",
      `What I found: no notable external signal on "${topic.query}" from the selected public feeds right now; I'll keep checking on schedule.`,
    ];

    const sample = (fresh.length ? fresh : items).slice(0, 5);
    if (sample.length) {
      lines.push("", "Nearest mentions/candidates found:");
      for (const item of sample) {
        lines.push(`- [${item.source}] ${item.title} — ${item.url}`);
      }
    }
    return lines.join("\n");
  }

  // ------------------------------------------------------------- sources

  /**
   * Sweep every public source for one query. Public so the study loop can
   * borrow the scout's sources (and its proxy) for the external half of a
   * lesson instead of duplicating the fetch stack.
   */
  async gather(query: string): Promise<ScoutItem[]> {
    const nitter = this.runtime?.getSetting("LAINOS_SCOUT_NITTER");
    const results = await Promise.allSettled([
      this.hackerNews(query),
      this.reddit(query),
      this.github(query),
      this.googleNews(query),
      ...(nitter ? [this.nitter(nitter, query)] : []),
    ]);
    const items: ScoutItem[] = [];
    const seenUrl = new Set<string>();
    for (const r of results) {
      if (r.status === "rejected") {
        log.warn(`source failed: ${(r.reason as Error)?.message ?? r.reason}`);
        continue;
      }
      for (const item of r.value) {
        if (!item.url || seenUrl.has(item.url)) continue;
        seenUrl.add(item.url);
        items.push(item);
      }
    }
    // Fresh first, then by score.
    return items.sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || (b.score ?? 0) - (a.score ?? 0));
  }

  /** GET with the proxy when configured, falling back to a direct request. */
  private async get(url: string, headers: Record<string, string> = {}): Promise<string> {
    try {
      return await this.fetchOnce(url, headers, this.dispatcher);
    } catch (err) {
      if (!this.dispatcher) throw err;
      return this.fetchOnce(url, headers, undefined);
    }
  }

  private async fetchOnce(
    url: string,
    headers: Record<string, string>,
    dispatcher?: Dispatcher,
  ): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await undiciFetch(url, {
        headers: { "user-agent": "LainOS-scout/0.1", ...headers },
        dispatcher,
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`${new URL(url).host} HTTP ${res.status}`);
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  private async hackerNews(query: string): Promise<ScoutItem[]> {
    const raw = await this.get(
      `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=15`,
    );
    const data = JSON.parse(raw) as {
      hits?: { title?: string; url?: string; objectID?: string; points?: number; created_at_i?: number }[];
    };
    return (data.hits ?? [])
      .filter((h) => h.title)
      .map((h) => ({
        title: h.title!,
        url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
        source: "HN",
        score: h.points,
        at: h.created_at_i ? h.created_at_i * 1000 : undefined,
      }));
  }

  private async reddit(query: string): Promise<ScoutItem[]> {
    // Reddit 403s its JSON API for unauthenticated clients; the Atom feed
    // still works with a browser-ish user agent (rate-limited, one hit/sweep).
    const raw = await this.get(
      `https://www.reddit.com/search.rss?q=${encodeURIComponent(query)}&sort=new&t=week&limit=15`,
      { "user-agent": "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0" },
    );
    return parseRss(raw, "Reddit", 15);
  }

  private async github(query: string): Promise<ScoutItem[]> {
    const token = this.runtime?.getSetting("GITHUB_TOKEN");
    const raw = await this.get(
      `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=10`,
      {
        accept: "application/vnd.github+json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    );
    const data = JSON.parse(raw) as {
      items?: { full_name?: string; description?: string | null; html_url?: string; stargazers_count?: number; pushed_at?: string }[];
    };
    return (data.items ?? [])
      .filter((i) => i.full_name && i.html_url)
      .map((i) => ({
        title: `${i.full_name}${i.description ? ` — ${i.description}` : ""}`,
        url: i.html_url!,
        source: "GitHub",
        score: i.stargazers_count,
        at: i.pushed_at ? Date.parse(i.pushed_at) : undefined,
      }));
  }

  private async googleNews(query: string): Promise<ScoutItem[]> {
    const raw = await this.get(
      `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`,
    );
    return parseRss(raw, "News", 15);
  }

  private async nitter(base: string, query: string): Promise<ScoutItem[]> {
    const raw = await this.get(
      `${base.replace(/\/$/, "")}/search/rss?f=tweets&q=${encodeURIComponent(query)}`,
    );
    return parseRss(raw, "X", 15);
  }

  // -------------------------------------------------------------- distill

  /** Ask the agent's model for an importance-filtered digest ("" = nothing). */
  private async distill(topic: Topic, items: ScoutItem[]): Promise<string | null> {
    if (!this.runtime) return null;
    const lines = items
      .slice(0, PROMPT_ITEM_CAP)
      .map(
        (i) =>
          `- [${i.source}${i.score ? ` ${i.score}` : ""}${i.at ? ` ${new Date(i.at).toISOString().slice(0, 10)}` : ""}] ${i.title} — ${i.url}`,
      )
      .join("\n");
    const system =
      `You are Lain's research scout writing a digest for one subscribed topic. ` +
      `Honour the subscriber's instruction strictly: include only what genuinely matters under it; ` +
      `drop noise, duplicates, marketing, and engagement bait. ` +
      `Write in the language of the instruction (default English). ` +
      `Start with a one- or two-sentence takeaway, then up to 8 bullet lines, each ending with its link. ` +
      `Plain text only, no markdown headers. ` +
      `If nothing clears the bar, reply with exactly the single word: NOTHING — ` +
      `never write "nothing found", "no relevant news", or any other explanation instead.`;
    const res = await this.runtime.model.generate({
      tier: ModelTier.MEDIUM,
      // A digest is drudgery by definition — routed by kind, so an operator
      // can put every one of them on a free model without touching the chat.
      task: TaskKind.DIGEST,
      system,
      messages: [
        {
          role: "user",
          content:
            `Topic: ${topic.query}\n` +
            `Subscriber instruction: ${topic.note ?? "report only really important changes"}\n\n` +
            `New items since the last sweep:\n${lines}`,
        },
      ],
      maxTokens: 900,
      temperature: 0.4,
    });
    const text = res.text.trim();
    if (looksLikeNothing(text)) return null;
    return text;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const payload: ScoutFile = { topics: this.topics, counter: this.counter };
    await writeFile(this.file, JSON.stringify(payload, null, 2), "utf8");
  }
}

// ------------------------------------------------------------------ helpers

/**
 * True when a distilled reply is a "nothing found" note rather than a digest.
 * The prompt demands the exact word NOTHING, but weaker models improvise
 * ("Nothing found on the topic…", "No relevant news.") — and a digest that
 * leads with emptiness must never be delivered: silence is the contract.
 * Exported for tests.
 */
export function looksLikeNothing(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  const first = trimmed
    .split("\n", 1)[0]
    .replace(/^[^\p{L}]+/u, "")
    .toLowerCase();
  if (/^nothing(\s|[.,:!—-]|$)/.test(first)) return true;
  const singleNote = !trimmed.includes("\n") && trimmed.length <= 300;
  return (
    singleNote &&
    /(nothing found|nothing new|nothing important|nothing significant|nothing (new|found|important|relevant)|no (relevant|new|important|significant) (news|items|updates|results))/.test(
      first,
    )
  );
}

/** Minimal RSS/Atom feed parser (dependency-free). Exported for tests. */
export function parseRss(xml: string, source: string, limit = 15): ScoutItem[] {
  const items: ScoutItem[] = [];
  const atom = !xml.includes("<item") && xml.includes("<entry");
  const blocks = xml.split(atom ? /<entry[\s>]/ : /<item[\s>]/).slice(1);
  for (const block of blocks.slice(0, limit)) {
    const title = decodeXml(
      block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1] ?? "",
    ).trim();
    const link = decodeXml(
      (atom
        ? block.match(/<link[^>]*href="([^"]+)"/)?.[1]
        : block.match(/<link>([\s\S]*?)<\/link>/)?.[1]) ?? "",
    ).trim();
    const pub = block.match(/<(?:pubDate|updated|published)>([\s\S]*?)<\/(?:pubDate|updated|published)>/)?.[1];
    const at = pub ? Date.parse(pub) : NaN;
    if (title && link) {
      items.push({ title, url: link, source, at: Number.isFinite(at) ? at : undefined });
    }
  }
  return items;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function getScout(runtime: IAgentRuntime): ScoutService {
  const svc = runtime.getService<ScoutService>("scout");
  if (!svc) throw new Error("scout service not started");
  return svc;
}

function chatIdFromState(state: State): number | undefined {
  if (!state.roomId.startsWith("tg-")) return undefined;
  const id = Number(state.roomId.slice(3));
  return Number.isFinite(id) ? id : undefined;
}

function describeTopic(t: Topic): string {
  const hours = Math.round(t.intervalMs / 3_600_000);
  const last = t.lastRunAt ? `${Math.round((Date.now() - t.lastRunAt) / 60_000)}m ago` : "never";
  return `${t.id}: "${t.query}" every ${hours}h${t.note ? ` — ${t.note}` : ""} (last sweep ${last})`;
}

// ------------------------------------------------------------------ actions

const researchTopicAction: Action = {
  name: "research_topic",
  similes: ["watch_topic", "follow_news", "monitor_topic", "subscribe_digest", "track_news"],
  description:
    "Subscribe to autonomous research on a topic: the scout sweeps Hacker News, Reddit, GitHub and the news on a schedule, filters by the subscriber's instruction, and delivers a digest only when something genuinely matters. Use whenever a user asks to follow, monitor, or collect news about a subject.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "The subject to research, e.g. 'Solana' or 'zkVM'." },
      note: {
        type: "string",
        description:
          "The user's instruction verbatim — importance bar, angle, focus (e.g. 'only tell me about genuinely important changes').",
      },
      interval_hours: {
        type: "number",
        description: "Sweep cadence in hours. Default 24 (daily), minimum 1.",
      },
    },
    required: ["query"],
  },
  examples: [
    { user: "watch Solana and only tell me about genuinely important changes", agent: "Watching. topic1 — first review coming soon." },
    { user: "collect everything about zkVM every day", agent: "Logged it. topic2, daily." },
  ],
  async validate(runtime) {
    return Boolean(runtime.getService("scout"));
  },
  async handler(runtime, state, params) {
    const svc = getScout(runtime);
    const query = String(params.query ?? "").trim();
    if (!query) return { ok: false, text: "The topic needs a subject to research." };
    const hours = Number(params.interval_hours);
    const topic = await svc.addTopic({
      query,
      note: params.note ? String(params.note) : undefined,
      reporter: state.message.userId,
      chatId: chatIdFromState(state),
      intervalMs: Number.isFinite(hours) && hours > 0 ? hours * 3_600_000 : undefined,
    });
    return {
      ok: true,
      text: `Research topic ${topic.id} started: "${topic.query}" every ${Math.round(topic.intervalMs / 3_600_000)}h. First sweep is running now.`,
      data: { id: topic.id, query: topic.query },
    };
  },
};

const listResearchAction: Action = {
  name: "list_research",
  similes: ["research_topics", "what_do_you_follow", "show_subscriptions"],
  description: "List the topics the scout is researching, with cadence and last sweep time.",
  parameters: { type: "object", properties: {} },
  examples: [{ user: "what are you watching?", agent: "Here are my topics…" }],
  async validate(runtime) {
    return Boolean(runtime.getService("scout"));
  },
  async handler(runtime) {
    const svc = getScout(runtime);
    const topics = svc.listTopics();
    if (!topics.length) return { ok: true, text: "I'm not researching anything yet." };
    return {
      ok: true,
      text: `Research topics:\n${topics.map(describeTopic).join("\n")}`,
      data: { count: topics.length },
    };
  },
};

const runResearchAction: Action = {
  name: "run_research",
  similes: ["scan_now", "whats_new", "fresh_digest", "check_topic"],
  description:
    "Run a research sweep for a subscribed topic right now and return the digest (or report that nothing important happened). Use when the user asks 'what's new about X' for a topic that is already subscribed.",
  parameters: {
    type: "object",
    properties: { id: { type: "string", description: "Topic id, e.g. 'topic1'." } },
    required: ["id"],
  },
  examples: [{ user: "what's new on solana?", agent: "Sweeping the sources now…" }],
  async validate(runtime) {
    return Boolean(runtime.getService("scout"));
  },
  async handler(runtime, _state, params) {
    const svc = getScout(runtime);
    const topic = svc.getTopic(String(params.id ?? "").trim());
    if (!topic) return { ok: false, text: `No topic named ${params.id}. Ask me to list research.` };
    const digest = await svc.runTopic(topic, { deliver: false });
    return digest
      ? { ok: true, text: digest }
      : { ok: true, text: `Swept the sources for "${topic.query}" — nothing new clears the bar.` };
  },
};

const stopResearchAction: Action = {
  name: "stop_research",
  similes: ["unsubscribe_topic", "stop_following", "remove_topic"],
  description: "Stop researching a topic by its id (see list_research).",
  parameters: {
    type: "object",
    properties: { id: { type: "string", description: "Topic id, e.g. 'topic1'." } },
    required: ["id"],
  },
  examples: [{ user: "stop watching solana", agent: "Closing the topic." }],
  async validate(runtime) {
    return Boolean(runtime.getService("scout"));
  },
  async handler(runtime, _state, params) {
    const svc = getScout(runtime);
    const id = String(params.id ?? "").trim();
    const removed = await svc.removeTopic(id);
    return removed
      ? { ok: true, text: `Stopped researching ${id}.` }
      : { ok: false, text: `No topic named ${id}.` };
  },
};

// ------------------------------------------------------------------ provider

const scoutProvider: Provider = {
  name: "scout",
  async get(runtime) {
    const svc = runtime.getService<ScoutService>("scout");
    if (!svc) return "";
    const topics = svc.listTopics();
    if (!topics.length) {
      return "You are also a researcher: offer research_topic when users want to follow a subject.";
    }
    return (
      `You research ${topics.length} topic(s): ` +
      topics.map((t) => `${t.id} "${t.query}"`).join(", ") +
      `. Digests go out automatically; run_research answers "what's new" on demand.`
    );
  },
};

export const scoutPlugin: Plugin = {
  name: "scout",
  description:
    "Autonomous researcher: subscribed topics are swept across HN/Reddit/GitHub/news on a schedule and distilled into importance-filtered digests.",
  services: [new ScoutService()],
  providers: [scoutProvider],
  actions: [researchTopicAction, listResearchAction, runResearchAction, stopResearchAction],
};
