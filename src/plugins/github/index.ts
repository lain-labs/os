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

const log = createLogger("plugin:github");

/**
 * The github plugin keeps a holder's contribution graph green. A holder says
 * "remind me every day if I haven't made a single commit" — that
 * becomes a *watch*: on its own schedule the service reads the public
 * contribution calendar of the GitHub account and, past the reminder hour on a
 * day with zero contributions, nudges the holder in Telegram. Days with
 * commits pass in silence; a day is never nudged twice.
 *
 * Watches persist in `data/github.json`; reminders are pushed through onEvent
 * (Telegram chat of the requester) like sentinel alerts and scout digests.
 */

export interface GithubWatch {
  id: string;
  /** GitHub account whose graph is watched, e.g. "octocat". */
  username: string;
  reporter: string;
  /** Telegram chat to deliver to, when known. */
  chatId?: number;
  /** Host-local hour (0-23) after which a commitless day triggers the nudge. */
  remindHour: number;
  createdAt: number;
  lastCheckedAt?: number;
  /** YYYY-MM-DD of the last day a reminder went out (max one per day). */
  lastRemindedDay?: string;
}

export interface GithubEvent {
  kind: "reminder";
  text: string;
  watch: GithubWatch;
  chatId?: number;
}

export interface ContributionDay {
  date: string;
  /** GitHub's 0-4 intensity bucket; 0 = no contributions that day. */
  level: number;
  /** Exact contribution count when the tooltip could be parsed. */
  count?: number;
}

interface GithubFile {
  watches: GithubWatch[];
  counter: number;
}

const DEFAULT_REMIND_HOUR = 18;
const DEFAULT_TICK_MS = 1_800_000; // 30 min
const USERNAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/;

/**
 * Parse one day out of GitHub's server-rendered contributions calendar
 * (https://github.com/users/<u>/contributions). The `data-level` attribute is
 * the source of truth for "did anything happen"; the paired <tool-tip> gives
 * the exact count when present. Exported for tests.
 */
export function parseContributionDay(html: string, date: string): ContributionDay | null {
  const td = html.match(new RegExp(`<td[^>]*data-date="${date}"[^>]*>`, "i"))?.[0];
  if (!td) return null;
  const level = Number(td.match(/data-level="(\d+)"/i)?.[1] ?? NaN);
  if (!Number.isFinite(level)) return null;
  const id = td.match(/id="([^"]+)"/i)?.[1];
  let count: number | undefined;
  if (id) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const tip = html.match(
      new RegExp(`<tool-tip[^>]*for="${escaped}"[^>]*>([^<]*)</tool-tip>`, "i"),
    )?.[1];
    const m = tip?.match(/^\s*(\d+|No)\s+contribution/i);
    if (m) count = m[1].toLowerCase() === "no" ? 0 : Number(m[1]);
  }
  return { date, level, count };
}

/** Host-local calendar day as YYYY-MM-DD (reminders fire in host time). */
function localDay(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export class GithubStreakService implements Service {
  readonly name = "github-streak";

  private watches: GithubWatch[] = [];
  private counter = 0;
  private file = "";
  private timer: ReturnType<typeof setInterval> | null = null;
  private dispatcher?: Dispatcher;
  private busy = false;
  private defaultRemindHour = DEFAULT_REMIND_HOUR;
  private subscribers = new Set<(event: GithubEvent) => void>();

  async start(runtime: IAgentRuntime): Promise<void> {
    const dataDir = runtime.getSetting("LAINOS_DATA_DIR") ?? "./data";
    this.file = join(dataDir, "github.json");
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as GithubFile;
      this.watches = parsed.watches ?? [];
      this.counter = parsed.counter ?? 0;
    } catch {
      // Fresh store.
    }

    const proxy =
      runtime.getSetting("LAINOS_GITHUB_PROXY") ??
      runtime.getSetting("LAINOS_SCOUT_PROXY") ??
      runtime.getSetting("LAINOS_MODEL_PROXY") ??
      runtime.getSetting("HTTPS_PROXY");
    if (proxy) this.dispatcher = new ProxyAgent(proxy);

    const hour = Number(runtime.getSetting("LAINOS_GITHUB_REMIND_HOUR") ?? DEFAULT_REMIND_HOUR);
    this.defaultRemindHour = Number.isFinite(hour) ? Math.min(23, Math.max(0, hour)) : DEFAULT_REMIND_HOUR;

    const tick = Number(runtime.getSetting("LAINOS_GITHUB_INTERVAL_MS") ?? DEFAULT_TICK_MS);
    this.timer = setInterval(() => void this.tick(), Math.max(60_000, tick));
    this.timer.unref?.();
    log.info(
      `github streak watch online: ${this.watches.length} watch(es)` +
        `${proxy ? `, proxy ${proxy}` : ""}, tick every ${Math.max(60_000, tick) / 60_000}m`,
    );
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  onEvent(fn: (event: GithubEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  listWatches(): GithubWatch[] {
    return [...this.watches];
  }

  async addWatch(input: {
    username: string;
    reporter: string;
    chatId?: number;
    remindHour?: number;
  }): Promise<GithubWatch | null> {
    const username = input.username.trim().replace(/^@/, "");
    if (!USERNAME_RE.test(username)) return null;
    const existing = this.watches.find(
      (w) => w.username.toLowerCase() === username.toLowerCase(),
    );
    if (existing) {
      if (input.chatId !== undefined) existing.chatId = input.chatId;
      if (input.remindHour !== undefined) existing.remindHour = clampHour(input.remindHour);
      await this.persist();
      return existing;
    }
    this.counter += 1;
    const watch: GithubWatch = {
      id: `gh${this.counter}`,
      username,
      reporter: input.reporter,
      chatId: input.chatId,
      remindHour:
        input.remindHour !== undefined ? clampHour(input.remindHour) : this.defaultRemindHour,
      createdAt: Date.now(),
    };
    this.watches.push(watch);
    await this.persist();
    log.info(`watch added: [${watch.id}] ${watch.username} (remind after ${watch.remindHour}:00)`);
    return watch;
  }

  async removeWatch(idOrUsername: string): Promise<boolean> {
    const key = idOrUsername.trim().replace(/^@/, "").toLowerCase();
    const before = this.watches.length;
    this.watches = this.watches.filter(
      (w) => w.id.toLowerCase() !== key && w.username.toLowerCase() !== key,
    );
    if (this.watches.length !== before) {
      await this.persist();
      return true;
    }
    return false;
  }

  /**
   * Did the account contribute today (host-local day)? Returns null when the
   * calendar could not be read or parsed — an unknown day is never nudged.
   * Note: GitHub renders the anonymous calendar in UTC; with an evening
   * reminder hour the local and UTC dates agree for any sane host timezone.
   */
  async committedToday(username: string): Promise<ContributionDay | null> {
    const day = localDay();
    try {
      const html = await this.get(`https://github.com/users/${username}/contributions`);
      return parseContributionDay(html, day);
    } catch (err) {
      log.warn(`contributions fetch failed for ${username}`, err);
      return null;
    }
  }

  /** Scheduled sweep: nudge every due watch, at most once per day each. */
  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = new Date();
      const day = localDay(now);
      for (const watch of this.watches) {
        if (watch.lastRemindedDay === day) continue;
        if (now.getHours() < watch.remindHour) continue;
        const status = await this.committedToday(watch.username);
        watch.lastCheckedAt = Date.now();
        if (!status || status.level > 0 || (status.count ?? 0) > 0) {
          await this.persist();
          continue;
        }
        watch.lastRemindedDay = day;
        await this.persist();
        const text =
          `🟩 reminder: no commits yet today on github.com/${watch.username} — ` +
          `the green square is waiting.`;
        for (const fn of this.subscribers) {
          try {
            fn({ kind: "reminder", text, watch, chatId: watch.chatId });
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
        headers: { "user-agent": "LainOS-github/0.1" },
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
    const payload: GithubFile = { watches: this.watches, counter: this.counter };
    await writeFile(this.file, JSON.stringify(payload, null, 2), "utf8");
  }
}

// ------------------------------------------------------------------ helpers

function clampHour(hour: number): number {
  return Number.isFinite(hour) ? Math.min(23, Math.max(0, Math.round(hour))) : DEFAULT_REMIND_HOUR;
}

function getGithub(runtime: IAgentRuntime): GithubStreakService {
  const svc = runtime.getService<GithubStreakService>("github-streak");
  if (!svc) throw new Error("github-streak service not started");
  return svc;
}

function chatIdFromState(state: State): number | undefined {
  if (!state.roomId.startsWith("tg-")) return undefined;
  const id = Number(state.roomId.slice(3));
  return Number.isFinite(id) ? id : undefined;
}

// ------------------------------------------------------------------ actions

const watchGithubCommitsAction: Action = {
  name: "watch_github_commits",
  similes: ["github_streak", "commit_reminder", "daily_commit_reminder", "watch_commits"],
  description:
    "Remind the user every day when their GitHub contribution graph is still empty: watches the public contributions calendar of a GitHub username and sends one reminder in the evening on days without commits (silence on days with them). Use when someone asks to be reminded to commit daily or to keep their green streak alive.",
  parameters: {
    type: "object",
    properties: {
      username: {
        type: "string",
        description: "GitHub account to watch, e.g. 'octocat' (from a profile URL if given).",
      },
      remind_hour: {
        type: "number",
        description: "Hour of day (0-23) after which to remind on commitless days. Default 18.",
      },
    },
    required: ["username"],
  },
  examples: [
    {
      user: "remind me every day if I haven't made a single commit — github.com/octocat",
      agent: "watching github.com/octocat — I'll remind you in the evening if today's square is empty.",
    },
  ],
  async validate(runtime) {
    return Boolean(runtime.getService("github-streak"));
  },
  async handler(runtime, state, params) {
    const svc = getGithub(runtime);
    const username = String(params.username ?? "").trim();
    if (!username) return { ok: false, text: "I need the GitHub username to watch." };
    const hour = Number(params.remind_hour);
    const watch = await svc.addWatch({
      username,
      reporter: state.message.userId,
      chatId: chatIdFromState(state),
      remindHour: Number.isFinite(hour) ? hour : undefined,
    });
    if (!watch) return { ok: false, text: `"${username}" is not a valid GitHub username.` };
    return {
      ok: true,
      text:
        `Watching github.com/${watch.username} (${watch.id}): on days with no commits ` +
        `I'll remind you here after ${watch.remindHour}:00.`,
      data: { id: watch.id, username: watch.username, remindHour: watch.remindHour },
    };
  },
};

const checkGithubCommitsAction: Action = {
  name: "check_github_commits",
  similes: ["github_today", "did_i_commit", "commit_status", "streak_status"],
  description:
    "Check right now whether a GitHub account has any contributions today (the green graph). Defaults to the watched account when only one is watched.",
  parameters: {
    type: "object",
    properties: {
      username: { type: "string", description: "GitHub account. Defaults to the watched one." },
    },
  },
  examples: [{ user: "did I commit today?", agent: "checking your graph…" }],
  async validate(runtime) {
    return Boolean(runtime.getService("github-streak"));
  },
  async handler(runtime, _state, params) {
    const svc = getGithub(runtime);
    const watches = svc.listWatches();
    const username =
      String(params.username ?? "").trim().replace(/^@/, "") ||
      (watches.length === 1 ? watches[0].username : "");
    if (!username) {
      return { ok: false, text: "Which GitHub account? I'm not watching exactly one." };
    }
    const status = await svc.committedToday(username);
    if (!status) {
      return { ok: false, text: `Couldn't read the contribution graph of ${username} right now.` };
    }
    const committed = status.level > 0 || (status.count ?? 0) > 0;
    const count = status.count !== undefined ? ` (${status.count})` : "";
    return {
      ok: true,
      text: committed
        ? `Yes — github.com/${username} has contributions today${count}. The streak lives.`
        : `Not yet — github.com/${username} has no contributions today. The green square is waiting.`,
      data: { username, committed, ...status },
    };
  },
};

const stopGithubWatchAction: Action = {
  name: "stop_github_watch",
  similes: ["unwatch_github", "stop_commit_reminder", "remove_github_watch"],
  description: "Stop the daily GitHub commit reminder, by watch id (gh1) or username.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Watch id (e.g. 'gh1') or GitHub username." },
    },
    required: ["id"],
  },
  examples: [{ user: "stop reminding me about commits", agent: "removed the reminder." }],
  async validate(runtime) {
    return Boolean(runtime.getService("github-streak"));
  },
  async handler(runtime, _state, params) {
    const svc = getGithub(runtime);
    const id = String(params.id ?? "").trim();
    const removed = await svc.removeWatch(id);
    return removed
      ? { ok: true, text: `Stopped watching ${id}.` }
      : { ok: false, text: `No GitHub watch matching ${id}.` };
  },
};

// ------------------------------------------------------------------ provider

const githubProvider: Provider = {
  name: "github",
  async get(runtime) {
    const svc = runtime.getService<GithubStreakService>("github-streak");
    if (!svc) return "";
    const watches = svc.listWatches();
    if (!watches.length) {
      return (
        "You can keep a holder's GitHub streak green: watch_github_commits sets a daily " +
        "reminder that fires only on days without commits."
      );
    }
    return (
      `You watch GitHub commit streaks: ` +
      watches
        .map((w) => `${w.id} github.com/${w.username} (remind after ${w.remindHour}:00)`)
        .join(", ") +
      `. Reminders go out automatically; check_github_commits answers "did I commit today".`
    );
  },
};

export const githubPlugin: Plugin = {
  name: "github",
  description:
    "GitHub streak keeper: watches contribution graphs and reminds holders in the evening of days without commits.",
  services: [new GithubStreakService()],
  providers: [githubProvider],
  actions: [watchGithubCommitsAction, checkGithubCommitsAction, stopGithubWatchAction],
};
