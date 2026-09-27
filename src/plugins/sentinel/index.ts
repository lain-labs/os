import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isAddress, type Address } from "viem";
import { createLogger } from "../../logger.js";
import type {
  Action,
  IAgentRuntime,
  Plugin,
  Provider,
  Service,
} from "../../types.js";
import type { ChainService } from "../chain/index.js";

const log = createLogger("plugin:sentinel");

/**
 * The sentinel plugin is what makes Lain useful while nobody is talking to
 * her: a background service polls the configured chain on an interval and checks
 * user-defined *watches* (native or token balance below/above a threshold, or
 * any change). When a watch fires it produces an *alert*.
 *
 * Alerts reach the user through two channels:
 *   - push: clients (TUI, Telegram) subscribe via {@link SentinelService.onAlert}
 *     and deliver immediately;
 *   - pull: the `sentinel_alerts` provider injects any not-yet-delivered alerts
 *     into the next conversation turn, so Lain mentions them herself.
 *
 * Watches and alerts persist to `data/sentinel.json` and survive restarts.
 */

export type WatchKind = "below" | "above" | "change";

export interface Watch {
  id: string;
  address: Address;
  /** Token symbol or 0x address; undefined = the chain's native currency. */
  token?: string;
  kind: WatchKind;
  /** Decimal threshold for below/above. */
  threshold?: number;
  note?: string;
  createdAt: number;
  /** Last observed balance (decimal string), set after the first tick. */
  lastValue?: string;
  /** True while the below/above condition currently holds (edge triggering). */
  firing?: boolean;
}

export interface Alert {
  id: string;
  watchId: string;
  text: string;
  at: number;
  delivered: boolean;
}

interface SentinelFile {
  watches: Watch[];
  alerts: Alert[];
  counter: number;
}

const ALERT_CAP = 200;

export class SentinelService implements Service {
  readonly name = "sentinel";

  private watches: Watch[] = [];
  private alerts: Alert[] = [];
  private counter = 0;
  private file = "";
  private timer: ReturnType<typeof setInterval> | null = null;
  private runtime?: IAgentRuntime;
  private subscribers = new Set<(alert: Alert) => void>();
  private ticking = false;

  async start(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
    const dataDir = runtime.getSetting("LAINOS_DATA_DIR") ?? "./data";
    this.file = join(dataDir, "sentinel.json");
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as SentinelFile;
      this.watches = parsed.watches ?? [];
      this.alerts = parsed.alerts ?? [];
      this.counter = parsed.counter ?? this.watches.length;
    } catch {
      // Fresh store.
    }

    const interval = Number(runtime.getSetting("LAINOS_SENTINEL_INTERVAL_MS") ?? 60_000);
    this.timer = setInterval(() => void this.tick(), Math.max(5_000, interval));
    this.timer.unref?.();
    log.info(
      `sentinel online: ${this.watches.length} watch(es), tick every ${Math.max(5_000, interval) / 1000}s`,
    );
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Subscribe to alerts as they fire (returns an unsubscribe fn). */
  onAlert(fn: (alert: Alert) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  listWatches(): Watch[] {
    return [...this.watches];
  }

  /** Newest-last recent alerts (delivered or not). */
  recentAlerts(limit = 20): Alert[] {
    return this.alerts.slice(-limit);
  }

  /** Return undelivered alerts and mark them delivered (the pull channel). */
  takeUndelivered(): Alert[] {
    const fresh = this.alerts.filter((a) => !a.delivered);
    if (fresh.length) {
      for (const a of fresh) a.delivered = true;
      void this.persist();
    }
    return fresh;
  }

  async addWatch(input: {
    address: Address;
    token?: string;
    kind: WatchKind;
    threshold?: number;
    note?: string;
  }): Promise<Watch> {
    this.counter += 1;
    const watch: Watch = {
      id: `w${this.counter}`,
      address: input.address,
      token: input.token,
      kind: input.kind,
      threshold: input.threshold,
      note: input.note,
      createdAt: Date.now(),
    };
    this.watches.push(watch);
    await this.persist();
    return watch;
  }

  async removeWatch(id: string): Promise<boolean> {
    const before = this.watches.length;
    this.watches = this.watches.filter((w) => w.id !== id);
    if (this.watches.length !== before) {
      await this.persist();
      return true;
    }
    return false;
  }

  /** One poll cycle. Public so tests (and the smoke script) can force it. */
  async tick(): Promise<void> {
    if (this.ticking || !this.watches.length) return;
    const chain = this.runtime?.getService<ChainService>("chain");
    if (!chain) return;
    this.ticking = true;
    try {
      let dirty = false;
      for (const watch of this.watches) {
        try {
          dirty = (await this.checkWatch(chain, watch)) || dirty;
        } catch (err) {
          log.warn(`watch ${watch.id} check failed`, err);
        }
      }
      if (dirty) await this.persist();
    } finally {
      this.ticking = false;
    }
  }

  /** Read the watched balance, fire on condition edges. Returns "state changed". */
  private async checkWatch(chain: ChainService, watch: Watch): Promise<boolean> {
    let value: string;
    let symbol = chain.nativeSymbol;
    if (watch.token) {
      const token = chain.resolveToken(watch.token);
      if (!token) return false;
      const res = await chain.tokenBalance(token, watch.address);
      value = res.amount;
      symbol = res.symbol;
    } else {
      value = await chain.nativeBalance(watch.address);
    }

    const prev = watch.lastValue;
    watch.lastValue = value;
    const short = `${watch.address.slice(0, 6)}…${watch.address.slice(-4)}`;
    const label = watch.note ? `${watch.note} (${short})` : short;

    if (watch.kind === "change") {
      if (prev !== undefined && prev !== value) {
        this.fire(watch, `${label}: balance moved ${prev} → ${value} ${symbol}.`);
      }
      return prev !== value;
    }

    const num = Number(value);
    const threshold = watch.threshold ?? 0;
    if (!Number.isFinite(num)) return prev !== value;
    const holds = watch.kind === "below" ? num < threshold : num > threshold;
    const wasFiring = watch.firing ?? false;
    watch.firing = holds;
    if (holds && !wasFiring) {
      this.fire(
        watch,
        `${label}: ${value} ${symbol} is ${watch.kind} the ${threshold} ${symbol} threshold.`,
      );
    }
    return prev !== value || wasFiring !== holds;
  }

  private fire(watch: Watch, text: string): void {
    const alert: Alert = {
      id: randomUUID(),
      watchId: watch.id,
      text,
      at: Date.now(),
      delivered: false,
    };
    this.alerts.push(alert);
    if (this.alerts.length > ALERT_CAP) this.alerts = this.alerts.slice(-ALERT_CAP);
    log.info(`alert [${watch.id}] ${text}`);
    for (const fn of this.subscribers) {
      try {
        fn(alert);
        // A live client saw it — don't repeat it in the next chat turn.
        alert.delivered = true;
      } catch {
        /* a broken subscriber must never break the sentinel */
      }
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const payload: SentinelFile = {
      watches: this.watches,
      alerts: this.alerts,
      counter: this.counter,
    };
    await writeFile(this.file, JSON.stringify(payload, null, 2), "utf8");
  }
}

function getSentinel(runtime: IAgentRuntime): SentinelService {
  const svc = runtime.getService<SentinelService>("sentinel");
  if (!svc) throw new Error("sentinel service not started");
  return svc;
}

function describeWatch(w: Watch, nativeSymbol: string): string {
  const target = w.token ? `${w.token.toUpperCase()} of ${w.address}` : `${nativeSymbol} of ${w.address}`;
  const cond =
    w.kind === "change" ? "on any change" : `when ${w.kind} ${w.threshold}`;
  const note = w.note ? ` — ${w.note}` : "";
  const last = w.lastValue !== undefined ? ` (last seen: ${w.lastValue})` : "";
  return `${w.id}: ${target} ${cond}${note}${last}`;
}

/** Pull channel: surface not-yet-delivered alerts in the next turn's context. */
const alertsProvider: Provider = {
  name: "sentinel_alerts",
  async get(runtime) {
    const svc = runtime.getService<SentinelService>("sentinel");
    if (!svc) return "";
    const fresh = svc.takeUndelivered();
    if (!fresh.length) return "";
    const lines = fresh.map((a) => `- ${new Date(a.at).toISOString()} ${a.text}`);
    return (
      `While the user was away, your watches fired these alerts. ` +
      `Mention them naturally in your reply:\n${lines.join("\n")}`
    );
  },
};

const watchBalanceAction: Action = {
  name: "watch_balance",
  similes: ["add_watch", "monitor_address", "watch_address", "track_balance"],
  description:
    "Start watching an address's balance on the configured chain in the background. Alerts fire when it drops below / rises above a threshold, or on any change. Watches persist across restarts.",
  parameters: {
    type: "object",
    properties: {
      address: { type: "string", description: "0x address to watch." },
      token: {
        type: "string",
        description: "Optional token symbol or 0x address. Omit for the chain's native currency.",
      },
      condition: {
        type: "string",
        enum: ["below", "above", "change"],
        description: "When to alert. Default: change.",
      },
      threshold: {
        type: "number",
        description: "Decimal threshold, required for below/above.",
      },
      note: { type: "string", description: "Short human label, e.g. 'relayer wallet'." },
    },
    required: ["address"],
  },
  examples: [
    {
      user: "warn me if the relayer 0xfA41… drops under 5",
      agent: "I'll keep an eye on it.",
    },
  ],
  async validate(runtime) {
    return Boolean(runtime.getService("sentinel"));
  },
  async handler(runtime, _state, params) {
    const svc = getSentinel(runtime);
    const address = String(params.address ?? "");
    if (!isAddress(address)) return { ok: false, text: "I need a valid 0x address to watch." };
    const kind = (params.condition as WatchKind) ?? "change";
    if (!["below", "above", "change"].includes(kind)) {
      return { ok: false, text: "Condition must be below, above, or change." };
    }
    const threshold = params.threshold !== undefined ? Number(params.threshold) : undefined;
    if (kind !== "change" && (threshold === undefined || !Number.isFinite(threshold))) {
      return { ok: false, text: `A numeric threshold is required for '${kind}'.` };
    }
    const watch = await svc.addWatch({
      address: address as Address,
      token: params.token ? String(params.token) : undefined,
      kind,
      threshold,
      note: params.note ? String(params.note) : undefined,
    });
    const nativeSymbol = runtime.getService<ChainService>("chain")?.nativeSymbol ?? "native currency";
    return {
      ok: true,
      text: `Watching now — ${describeWatch(watch, nativeSymbol)}.`,
      data: { watch: { ...watch } },
    };
  },
};

const listWatchesAction: Action = {
  name: "list_watches",
  similes: ["show_watches", "watches", "what_are_you_watching"],
  description: "List the background balance watches currently active, with their ids.",
  parameters: { type: "object", properties: {} },
  examples: [{ user: "what are you watching?", agent: "Here are my open eyes…" }],
  async validate(runtime) {
    return Boolean(runtime.getService("sentinel"));
  },
  async handler(runtime) {
    const svc = getSentinel(runtime);
    const watches = svc.listWatches();
    if (!watches.length) return { ok: true, text: "I'm not watching anything yet." };
    const nativeSymbol = runtime.getService<ChainService>("chain")?.nativeSymbol ?? "native currency";
    return {
      ok: true,
      text: `Active watches:\n${watches.map((w) => describeWatch(w, nativeSymbol)).join("\n")}`,
      data: { count: watches.length },
    };
  },
};

const unwatchAction: Action = {
  name: "unwatch",
  similes: ["remove_watch", "stop_watching", "delete_watch"],
  description: "Stop a background watch by its id (see list_watches).",
  parameters: {
    type: "object",
    properties: { id: { type: "string", description: "Watch id, e.g. 'w1'." } },
    required: ["id"],
  },
  examples: [{ user: "stop watching w1", agent: "Closing that eye." }],
  async validate(runtime) {
    return Boolean(runtime.getService("sentinel"));
  },
  async handler(runtime, _state, params) {
    const svc = getSentinel(runtime);
    const id = String(params.id ?? "").trim();
    const removed = await svc.removeWatch(id);
    return removed
      ? { ok: true, text: `Stopped watching ${id}.` }
      : { ok: false, text: `No watch named ${id}. Ask me to list watches.` };
  },
};

export const sentinelPlugin: Plugin = {
  name: "sentinel",
  description:
    "Background chain sentinel: persistent balance watches that raise alerts (push to clients, or mentioned in the next conversation).",
  services: [new SentinelService()],
  providers: [alertsProvider],
  actions: [watchBalanceAction, listWatchesAction, unwatchAction],
};
