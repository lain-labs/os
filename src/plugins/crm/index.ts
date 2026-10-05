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
import type { ChainService } from "../chain/index.js";
import type { ChannelWatchService } from "../channel/index.js";
import type { ForgeService } from "../forge/index.js";
import type { GithubStreakService } from "../github/index.js";
import type { PressService } from "../press/index.js";
import type { ScoutService } from "../scout/index.js";
import type { SentinelService } from "../sentinel/index.js";

const log = createLogger("plugin:crm");

/**
 * Lain files what she did.
 *
 * Almost everything this agent does happens while nobody is talking to her —
 * the forge builds a holder's wish at four in the morning, the trader takes
 * profit on a position, a balance watch fires, a digest comes back — and all
 * of it landed in exactly one place: a Telegram message that scrolled away.
 * So the board that is supposed to answer "what is this project doing"
 * answered only for the work three people typed in by hand.
 *
 * This plugin is the other half of that sentence. Every task-shaped thing she
 * produces becomes one record, posted to a CRM over plain HTTP. Any operator
 * console is a fine reader (`POST /api/crm/tasks`, token in a header),
 * but nothing here knows that: a record is `{id, title, detail, status, at}`
 * and the endpoint is a setting, so pointing it at anything else that speaks
 * JSON is a change of two environment variables.
 *
 * Three things make it safe to leave running:
 *
 *   - **Off unless configured.** No `LAINOS_CRM_URL`, no traffic, no queue.
 *   - **The id is ours.** Every record carries a namespaced id the sender
 *     mints (`lainos:trade:0x…`), so a delivery retried after a timeout is
 *     the same record and not a second one. Nothing else can make this
 *     idempotent — the daemon cannot see whether the request it never got an
 *     answer to actually landed.
 *   - **A durable outbox.** Records survive in `data/crm.json` until the CRM
 *     acknowledges them, so an evening the site was down is not an evening
 *     missing from the board. It drains in order, oldest first.
 *
 * Two kinds of record, and no third: `open` for something a human still has
 * to do (a wish waiting to be reviewed and published, a watch that fired, a
 * post to publish), `done` for something already finished, which is a log
 * line under the board. A record that needs nobody and finished nothing is a
 * record that should not have been sent.
 *
 * What it reads: the event streams the other plugins already publish (forge,
 * sentinel, scout, github, channel, press), plus a sweep over two things that
 * are state rather than events — the wishboard and the trade journal, which
 * is how a trade Lain made herself is filed alongside one the trader loop
 * made. Switching the plugin on for the first time marks everything already
 * there as seen and files none of it: the board starts the day it is wired
 * up, not with a year of history nobody asked for.
 */

export type CrmStatus = "open" | "done";

export interface CrmRecord {
  /** Namespaced and sender-minted: `lainos:<kind>:<key>`. */
  id: string;
  title: string;
  detail?: string;
  /** `open` needs a person; `done` is a log line. */
  status: CrmStatus;
  priority?: "low" | "normal" | "high";
  /** Unix ms of when it happened, which is not when it is delivered. */
  at: number;
}

/** A record before it has an id: what the sweeps and the streams produce. */
interface CrmDraft {
  kind: string;
  key?: string;
  title: string;
  detail?: string;
  status?: CrmStatus;
  priority?: CrmRecord["priority"];
  at?: number;
}

interface CrmFile {
  /** Not yet acknowledged, oldest first. */
  pending: CrmRecord[];
  /** Ids already filed (or deliberately dropped), newest last. */
  seen: string[];
  counter: number;
}

const DEFAULT_INTERVAL_MS = 300_000;
/** A backlog past this is an outage, not a queue; the oldest are dropped. */
const PENDING_CAP = 200;
const SEEN_CAP = 1_000;
const TITLE_MAX = 200;
const DETAIL_MAX = 4_000;

export class CrmService implements Service {
  readonly name = "crm";

  private runtime?: IAgentRuntime;
  private url: string | null = null;
  private token: string | null = null;
  private file = "";
  private pending: CrmRecord[] = [];
  private seen = new Set<string>();
  private counter = 0;
  private dispatcher?: Dispatcher;
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> | null = null;
  private unsubscribe: (() => void)[] = [];
  private lastError: string | null = null;

  async start(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
    const dataDir = runtime.getSetting("LAINOS_DATA_DIR") ?? "./data";
    this.file = join(dataDir, "crm.json");

    const url = runtime.getSetting("LAINOS_CRM_URL")?.trim();
    const off = runtime.getSetting("LAINOS_CRM") === "0";
    if (!url || off) {
      log.info(off ? "crm ingest off (LAINOS_CRM=0)" : "crm ingest off (no LAINOS_CRM_URL)");
      return;
    }
    this.url = url;
    this.token = runtime.getSetting("LAINOS_CRM_TOKEN")?.trim() || null;
    if (!this.token) {
      // Said out loud rather than discovered later: the ingest answers a
      // tokenless call with a 404, which reads exactly like a wrong address.
      log.warn("LAINOS_CRM_TOKEN is unset — the ingest will refuse every record");
    }
    const proxy = runtime.getSetting("LAINOS_CRM_PROXY")?.trim();
    if (proxy) this.dispatcher = new ProxyAgent(proxy);

    let fresh = true;
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as CrmFile;
      this.pending = parsed.pending ?? [];
      this.seen = new Set(parsed.seen ?? []);
      this.counter = parsed.counter ?? 0;
      fresh = false;
    } catch {
      // Never wired up before.
    }

    // The first run adopts the past instead of filing it. Fifty old wishes
    // arriving as fifty open tasks is not a record of anything — it is the
    // board being made useless on the day it was connected.
    if (fresh) {
      // Never fatal: a plugin that reads the past wrongly must not be the
      // reason the agent fails to come up at all.
      let adopted: string[] = [];
      try {
        adopted = this.currentState().map((draft) => this.idOf(draft));
      } catch (err) {
        log.warn("could not read what already exists; nothing adopted", err);
      }
      for (const id of adopted) this.seen.add(id);
      await this.persist();
      log.info(`crm ingest wired to ${this.url}; ${adopted.length} existing item(s) adopted as seen`);
    } else {
      log.info(`crm ingest wired to ${this.url}; ${this.pending.length} record(s) waiting`);
    }

    this.subscribe(runtime);

    const interval = Math.max(
      60_000,
      Number(runtime.getSetting("LAINOS_CRM_INTERVAL_MS") ?? DEFAULT_INTERVAL_MS),
    );
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref?.();
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
  }

  get enabled(): boolean {
    return this.url !== null;
  }

  status(): { enabled: boolean; url?: string; pending: number; lastError?: string } {
    return {
      enabled: this.enabled,
      url: this.url ?? undefined,
      pending: this.pending.length,
      lastError: this.lastError ?? undefined,
    };
  }

  /**
   * File one record. Returns false when the plugin is off or the record has
   * already been filed — both of which are ordinary, neither of which is an
   * error worth surfacing to whoever produced the event.
   */
  async record(input: CrmDraft): Promise<boolean> {
    if (!this.enabled) return false;

    const id = this.idOf(input);
    if (this.seen.has(id) || this.pending.some((r) => r.id === id)) return false;

    const title = oneLine(input.title).slice(0, TITLE_MAX);
    if (!title) return false;

    this.pending.push({
      id,
      title,
      detail: input.detail ? input.detail.slice(0, DETAIL_MAX) : undefined,
      status: input.status ?? "open",
      priority: input.priority,
      at: input.at ?? Date.now(),
    });
    if (this.pending.length > PENDING_CAP) {
      const dropped = this.pending.splice(0, this.pending.length - PENDING_CAP);
      for (const record of dropped) this.seen.add(record.id);
      log.warn(`crm outbox over ${PENDING_CAP}: dropped ${dropped.length} oldest record(s)`);
    }
    await this.persist();
    void this.flush();
    return true;
  }

  /** One sweep: pick up state changes, then drain the outbox. */
  async tick(): Promise<void> {
    if (!this.enabled) return;
    try {
      for (const draft of this.currentState()) {
        if (this.seen.has(this.idOf(draft))) continue;
        await this.record(draft);
      }
    } catch (err) {
      log.warn("crm sweep failed", err);
    }
    await this.flush();
  }

  /**
   * Deliver, oldest first, stopping at the first record that did not land.
   *
   * Order matters more than throughput here: the board reads as a story, and
   * a queue that skips its stuck head to deliver the tail tells it backwards.
   */
  async flush(): Promise<void> {
    if (!this.enabled || this.pending.length === 0) return;
    // One drain at a time, and a second caller waits for the first rather
    // than being told there is nothing to do: `await flush()` has to mean the
    // queue was actually worked, or every caller has to guess how long to
    // wait instead.
    this.flushing ??= this.drain().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async drain(): Promise<void> {
    while (this.pending.length > 0) {
      const record = this.pending[0];
      const outcome = await this.deliver(record);
      if (outcome === "retry") break;
      this.pending.shift();
      this.seen.add(record.id);
      if (outcome === "refused") {
        log.warn(`crm refused ${record.id}: ${this.lastError ?? "no reason given"}`);
      }
      await this.persist();
    }
  }

  /**
   * `ok` — accepted. `refused` — this server will never accept this record
   * (a malformed one), so retrying it forever would wedge the whole queue
   * behind it. `retry` — everything else: the site being down, the token
   * being unset (which answers 404), a network that blinked.
   */
  private async deliver(record: CrmRecord): Promise<"ok" | "refused" | "retry"> {
    try {
      const response = await undiciFetch(this.url as string, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(this.token ? { "X-Crm-Token": this.token } : {}),
        },
        body: JSON.stringify({
          id: record.id,
          title: record.title,
          detail: record.detail,
          status: record.status,
          priority: record.priority,
          at: new Date(record.at).toISOString(),
        }),
        dispatcher: this.dispatcher,
      });
      if (response.ok) {
        this.lastError = null;
        return "ok";
      }
      this.lastError = `HTTP ${response.status}`;
      // 404 is the ingest saying it has no token configured, which is a
      // state that gets fixed rather than a record that is wrong.
      if (response.status === 404 || response.status === 408 || response.status === 429) {
        return "retry";
      }
      return response.status >= 400 && response.status < 500 ? "refused" : "retry";
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return "retry";
    }
  }

  /**
   * The two things that are state rather than an event: wishes on the board
   * and trades in the journal. Both are read every sweep and filtered against
   * `seen`, which is also what makes them survive a daemon that was restarted
   * between the thing happening and the CRM being reachable.
   */
  private currentState(): (CrmDraft & { key: string })[] {
    const out: (CrmDraft & { key: string })[] = [];
    const runtime = this.runtime;
    if (!runtime) return out;

    const forge = runtime.getService<ForgeService>("forge");
    for (const wish of typeof forge?.listWishes === "function" ? forge.listWishes() : []) {
      if (wish.status === "rejected") continue;
      out.push({
        kind: "wish",
        key: wish.id,
        // Open, and it stays open after the forge builds it: nothing here
        // pushes, so a built wish is still waiting on a person to read the
        // commit and publish it.
        status: "open",
        title: `wish ${wish.id}: ${wish.title}`,
        detail: [wish.detail, `requested by: ${wish.reporter}`].filter(Boolean).join("\n\n"),
        at: wish.createdAt,
      });
    }

    const chain = runtime.getService<ChainService>("chain");
    const trades =
      typeof chain?.journal?.recentTrades === "function" ? chain.journal.recentTrades(50) : [];
    for (const trade of trades) {
      out.push({
        kind: "trade",
        key: trade.txHash,
        status: "done",
        title:
          `${trade.side === "buy" ? "bought" : "sold"} ${trade.symbol}` +
          (trade.reason ? ` — ${trade.reason}` : ""),
        detail: `tx ${trade.txHash}`,
        at: trade.ts,
      });
    }

    return out;
  }

  /**
   * Everything the other plugins already announce. Subscribing here rather
   * than in the daemon script is deliberate: these records must be filed on
   * every surface Lain runs on, and the daemon's wiring only exists when
   * Telegram came up.
   *
   * This service starts last (it is last in the character's plugin list), so
   * every service it reaches for is already running. Each stream is checked
   * for rather than assumed: a character may run with any subset of plugins,
   * and a missing one is a stream that has nothing to say, not a crash.
   */
  private subscribe(runtime: IAgentRuntime): void {
    const forge = runtime.getService<ForgeService>("forge");
    if (typeof forge?.onEvent === "function") {
      this.unsubscribe.push(
        forge.onEvent((ev) => {
          if (ev.kind !== "job_finished") return;
          void this.record({
            kind: "forge",
            key: ev.job.id,
            status: "done",
            title: ev.text,
            detail: ev.job.summary,
            at: ev.job.endedAt ?? Date.now(),
          });
        }),
      );
    }

    const sentinel = runtime.getService<SentinelService>("sentinel");
    if (typeof sentinel?.onAlert === "function") {
      this.unsubscribe.push(
        sentinel.onAlert((alert) => {
          // A brief is a report, filed like a digest.
          if (alert.kind === "brief") {
            void this.record({
              kind: "digest",
              key: alert.id,
              status: "done",
              title: "morning brief",
              detail: alert.text,
              at: alert.at,
            });
            return;
          }
          void this.record({
            kind: "alert",
            key: alert.id,
            // A watch fires because somebody asked to be told. Being told is
            // not the end of it.
            status: "open",
            priority: "high",
            title: alert.text,
            at: alert.at,
          });
        }),
      );
    }

    const scout = runtime.getService<ScoutService>("scout");
    if (typeof scout?.onEvent === "function") {
      this.unsubscribe.push(
        scout.onEvent((ev) => {
          void this.record({
            kind: "digest",
            key: `${ev.topic.id}:${Date.now()}`,
            status: "done",
            title: `digest on topic ${ev.topic.id}`,
            detail: ev.text,
          });
        }),
      );
    }

    const github = runtime.getService<GithubStreakService>("github-streak");
    if (typeof github?.onEvent === "function") {
      this.unsubscribe.push(
        github.onEvent((ev) => {
          void this.record({
            kind: "github",
            key: `${ev.watch.id}:${dayStamp()}`,
            status: "open",
            title: ev.text,
          });
        }),
      );
    }

    const channels = runtime.getService<ChannelWatchService>("channel-watch");
    if (typeof channels?.onEvent === "function") {
      this.unsubscribe.push(
        channels.onEvent((ev) => {
          void this.record({
            kind: "channel",
            key: `${ev.watches.map((w) => w.id).join("-")}:${dayStamp()}`,
            status: "open",
            title: ev.text,
          });
        }),
      );
    }

    const press = runtime.getService<PressService>("press");
    if (typeof press?.onEvent === "function") {
      this.unsubscribe.push(
        press.onEvent((ev) => {
          void this.record({
            kind: "press",
            key: `${ev.record.date}:${ev.kind}`,
            // Nothing on this host publishes: the post exists until a person
            // puts it somewhere.
            status: "open",
            title: ev.header,
            detail: ev.post || undefined,
          });
        }),
      );
    }
  }

  /** `lainos:<kind>:<key>`, which is also how the CRM tells our rows apart. */
  private idOf(draft: CrmDraft): string {
    return `lainos:${draft.kind}:${draft.key ?? String(Date.now())}`.slice(0, 120);
  }

  private async persist(): Promise<void> {
    // The seen set is what stops a restart from re-filing the wishboard, so
    // it is bounded rather than unbounded: the newest thousand ids cover far
    // more history than any sweep reads back.
    const seen = [...this.seen].slice(-SEEN_CAP);
    this.seen = new Set(seen);
    const data: CrmFile = { pending: this.pending, seen, counter: this.counter };
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(data, null, 2), "utf8");
  }

  /**
   * Next key for a record Lain files by hand.
   *
   * Stamped as well as counted: a counter that started over because the data
   * file was lost would mint an id the CRM already holds, and the note would
   * be answered as a duplicate and silently never appear.
   */
  nextNoteKey(): string {
    this.counter += 1;
    return `${Date.now()}-${this.counter}`;
  }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function dayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

const logCrmTask: Action = {
  name: "log_crm_task",
  similes: ["record_task", "file_to_crm", "log_it_to_crm"],
  description:
    "File one record on the operators' CRM board. Use it for work you did or found that nobody else announces — a decision, a finding, something an operator has to pick up. Trades, forged wishes, fired watches and digests are filed automatically; do not repeat them here. Set done=true for something already finished (it becomes a log line) and leave it false for something a person still has to do.",
  examples: [
    {
      user: "log to crm that the gas station needs a refill",
      agent: "Logged it: gas station tank is below threshold, task is open.",
    },
  ],
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "One line. What happened or what has to be done." },
      detail: { type: "string", description: "Optional: the longer version." },
      done: { type: "boolean", description: "True when it is already finished." },
      priority: { type: "string", enum: ["low", "normal", "high"] },
    },
    required: ["title"],
  },
  async validate(runtime) {
    return runtime.getService<CrmService>("crm")?.enabled === true;
  },
  async handler(runtime, _state, params) {
    const crm = runtime.getService<CrmService>("crm");
    if (!crm?.enabled) return { ok: false, text: "CRM is not connected." };

    const title = String(params.title ?? "").trim();
    if (!title) return { ok: false, text: "The record needs a title." };

    const filed = await crm.record({
      kind: "note",
      key: crm.nextNoteKey(),
      title,
      detail: params.detail ? String(params.detail) : undefined,
      status: params.done === true ? "done" : "open",
      priority: params.priority as CrmRecord["priority"],
    });

    const state = crm.status();

    return {
      ok: filed,
      text: filed
        ? `logged to CRM${state.pending > 1 ? ` (${state.pending} queued)` : ""}.`
        : "that record already exists.",
      data: { pending: state.pending },
    };
  },
};

const crmProvider: Provider = {
  name: "crm",
  async get(runtime: IAgentRuntime, _state: State): Promise<string> {
    const crm = runtime.getService<CrmService>("crm");
    if (!crm?.enabled) return "";
    const state = crm.status();
    // Only worth prompt space when it is not working: a queue that drains is
    // not something Lain needs to think about.
    if (state.pending === 0) return "";
    return (
      `# CRM\n${state.pending} record(s) waiting to reach the board` +
      `${state.lastError ? ` (last error: ${state.lastError})` : ""}.`
    );
  },
};

export const crmPlugin: Plugin = {
  name: "crm",
  description:
    "Files every task-shaped thing Lain produces — forged wishes, trades, fired watches, digests, posts — onto the operators' CRM board, through a durable outbox.",
  actions: [logCrmTask],
  providers: [crmProvider],
  services: [new CrmService()],
};
