import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createLogger } from "../../logger.js";
import { sendToOperator } from "../telegram/index.js";
import type { Action, IAgentRuntime, Plugin, Service } from "../../types.js";

const log = createLogger("plugin:presence");

/**
 * Presence is deliberately simpler than initiative: it does not ask the model
 * whether anything is worth saying. When enabled, it sends a short quiet
 * Telegram check-in on a fixed hourly cadence and records every attempt.
 */

export const DEFAULT_PRESENCE_MESSAGES = [
  "I'm here.",
  "quiet. I'm around.",
  "connection check.",
  "keeping the channel open.",
  "I'm at my post.",
];

const NOISY_WIRED_PULSE_RE =
  /(?:^|\s)✶?\s*wired\s+the\s+wired\s+hums\s+quietly\s+at\s+block\b.*\bgas\b.*\bgwei\b/i;

const JOURNAL_CAP = 120;
const MIN_INTERVAL_HOURS = 1 / 60;
const MAX_INTERVAL_HOURS = 24 * 30;

export interface PresenceJournalEntry {
  at: number;
  ok: boolean;
  message?: string;
  chatId?: string;
  error?: string;
  nextDueAt?: number;
}

export interface PresenceState {
  enabled: boolean;
  intervalHours: number;
  nextDueAt?: number;
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  consecutiveFailures: number;
  messageIndex: number;
  customMessage?: string;
  journal: PresenceJournalEntry[];
}

interface PresenceFile extends Partial<PresenceState> {}

export class PresenceService implements Service {
  readonly name = "presence";

  private runtime?: IAgentRuntime;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private file = "";
  private running = false;
  private ticking = false;
  private state: PresenceState = {
    enabled: false,
    intervalHours: 1,
    consecutiveFailures: 0,
    messageIndex: 0,
    journal: [],
  };

  async start(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
    const dataDir = runtime.getSetting("LAINOS_DATA_DIR") ?? "./data";
    this.file = join(dataDir, "presence.json");
    this.state = await this.loadState();
    this.running = true;
    this.schedule();
    log.info(
      `presence ${this.state.enabled ? "online" : "idle"}: every ${this.state.intervalHours}h`,
    );
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  getState(): PresenceState {
    return {
      ...this.state,
      journal: [...this.state.journal],
    };
  }

  async enable(input: { intervalHours?: number; message?: string } = {}): Promise<PresenceState> {
    if (input.intervalHours !== undefined) {
      this.state.intervalHours = normalizeInterval(input.intervalHours);
    }
    if (input.message !== undefined) {
      this.state.customMessage = cleanPresenceMessage(input.message);
    }
    this.state.enabled = true;
    this.state.nextDueAt = Date.now() + 1_000;
    await this.persist();
    this.schedule();
    return this.getState();
  }

  async disable(): Promise<PresenceState> {
    this.state.enabled = false;
    this.state.nextDueAt = undefined;
    await this.persist();
    this.schedule();
    return this.getState();
  }

  /** One delivery attempt, public for smoke tests and manual host checks. */
  async tick(now = Date.now()): Promise<PresenceJournalEntry | null> {
    const runtime = this.runtime;
    if (!runtime || this.ticking || !this.state.enabled) return null;
    if ((this.state.nextDueAt ?? now) > now) return null;
    this.ticking = true;
    try {
      this.state.lastAttemptAt = now;
      const token = runtime.getSetting("TELEGRAM_BOT_TOKEN");
      if (!token) {
        return await this.recordFailure("telegram disabled (TELEGRAM_BOT_TOKEN is not set)", now);
      }

      const message = this.nextMessage(runtime);
      try {
        const chatId = await sendToOperator((k) => runtime.getSetting(k), message);
        return await this.recordSuccess(message, chatId, now);
      } catch (err) {
        return await this.recordFailure(sanitizeError(runtime, err), now, message);
      }
    } finally {
      this.ticking = false;
      this.schedule();
    }
  }

  // ------------------------------------------------------------- internals

  private async loadState(): Promise<PresenceState> {
    const defaultInterval = normalizeInterval(
      Number(this.runtime?.getSetting("LAINOS_PRESENCE_INTERVAL_HOURS") ?? 1),
    );
    const fresh: PresenceState = {
      enabled: this.runtime?.getSetting("LAINOS_PRESENCE") === "1",
      intervalHours: defaultInterval,
      nextDueAt: Date.now() + hoursToMs(defaultInterval),
      consecutiveFailures: 0,
      messageIndex: 0,
      customMessage: cleanPresenceMessage(this.runtime?.getSetting("LAINOS_PRESENCE_MESSAGE")),
      journal: [],
    };

    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as PresenceFile;
      return {
        ...fresh,
        ...parsed,
        enabled: Boolean(parsed.enabled ?? fresh.enabled),
        intervalHours: normalizeInterval(Number(parsed.intervalHours ?? fresh.intervalHours)),
        consecutiveFailures: Number(parsed.consecutiveFailures ?? 0),
        messageIndex: Number(parsed.messageIndex ?? 0),
        customMessage: cleanPresenceMessage(parsed.customMessage ?? fresh.customMessage),
        journal: Array.isArray(parsed.journal) ? parsed.journal.slice(-JOURNAL_CAP) : [],
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
    const delay = Math.max(1_000, next - now);
    this.timer = setTimeout(() => void this.tick(), delay);
    this.timer.unref?.();
  }

  private nextMessage(runtime: IAgentRuntime): string {
    if (this.state.customMessage) return this.state.customMessage;
    const configured = runtime
      .getSetting("LAINOS_PRESENCE_MESSAGES")
      ?.split("|")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(cleanPresenceMessage)
      .filter((message): message is string => Boolean(message));
    const messages = configured?.length ? configured : DEFAULT_PRESENCE_MESSAGES;
    const message = messages[this.state.messageIndex % messages.length];
    this.state.messageIndex = (this.state.messageIndex + 1) % messages.length;
    return message;
  }

  private async recordSuccess(
    message: string,
    chatId: string,
    now: number,
  ): Promise<PresenceJournalEntry> {
    this.state.consecutiveFailures = 0;
    this.state.lastSuccessAt = now;
    this.state.nextDueAt = now + hoursToMs(this.state.intervalHours);
    const entry: PresenceJournalEntry = {
      at: now,
      ok: true,
      message,
      chatId,
      nextDueAt: this.state.nextDueAt,
    };
    await this.record(entry);
    log.info(`presence delivered to operator (chat ${chatId})`);
    return entry;
  }

  private async recordFailure(
    error: string,
    now: number,
    message?: string,
  ): Promise<PresenceJournalEntry> {
    this.state.consecutiveFailures += 1;
    const backoff = failureBackoffMs(this.state.consecutiveFailures);
    this.state.nextDueAt = now + Math.max(hoursToMs(this.state.intervalHours), backoff);
    const entry: PresenceJournalEntry = {
      at: now,
      ok: false,
      message,
      error,
      nextDueAt: this.state.nextDueAt,
    };
    await this.record(entry);
    log.warn(
      `presence delivery failed (${this.state.consecutiveFailures}): ${error}; next attempt ${new Date(
        this.state.nextDueAt,
      ).toISOString()}`,
    );
    return entry;
  }

  private async record(entry: PresenceJournalEntry): Promise<void> {
    this.state.journal.push(entry);
    if (this.state.journal.length > JOURNAL_CAP) {
      this.state.journal = this.state.journal.slice(-JOURNAL_CAP);
    }
    await this.persist();
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.state, null, 2), "utf8");
  }
}

function getPresence(runtime: IAgentRuntime): PresenceService {
  const svc = runtime.getService<PresenceService>("presence");
  if (!svc) throw new Error("presence service not started");
  return svc;
}

function normalizeInterval(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.min(MAX_INTERVAL_HOURS, Math.max(MIN_INTERVAL_HOURS, value));
}

function hoursToMs(hours: number): number {
  return Math.round(hours * 60 * 60 * 1000);
}

function failureBackoffMs(failures: number): number {
  const base = 15 * 60 * 1000;
  const cappedPower = Math.min(5, Math.max(0, failures - 1));
  return base * 2 ** cappedPower;
}

export function isNoisyWiredPulseMessage(value: unknown): boolean {
  return NOISY_WIRED_PULSE_RE.test(String(value ?? ""));
}

export function cleanPresenceMessage(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  if (!text || isNoisyWiredPulseMessage(text)) return undefined;
  return clipMessage(text);
}

function clipMessage(text: string): string {
  return text.length <= 180 ? text : text.slice(0, 177).trimEnd() + "...";
}

function sanitizeError(runtime: IAgentRuntime, err: unknown): string {
  let msg = err instanceof Error ? err.message : String(err);
  const token = runtime.getSetting("TELEGRAM_BOT_TOKEN");
  if (token) msg = msg.split(token).join("[token]");
  return msg.replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot[token]");
}

function summarize(state: PresenceState, limit = 5): string {
  const next = state.nextDueAt ? new Date(state.nextDueAt).toISOString() : "not scheduled";
  const last = state.journal.slice(-limit).map((entry) => {
    const status = entry.ok ? "ok" : `failed: ${entry.error ?? "unknown"}`;
    return `${new Date(entry.at).toISOString()} ${status}`;
  });
  return [
    `presence is ${state.enabled ? "enabled" : "disabled"}`,
    `interval: ${state.intervalHours}h`,
    `next: ${next}`,
    `consecutive failures: ${state.consecutiveFailures}`,
    last.length ? `recent:\n${last.join("\n")}` : "recent: none",
  ].join("\n");
}

const enablePresenceAction: Action = {
  name: "enable_presence",
  similes: ["start_presence", "hourly_checkin", "presence_notifications", "notify_hourly"],
  description:
    "Enable persistent Telegram presence/check-in messages to the operator on a configurable hourly cadence. Uses the existing operator Telegram delivery path and survives restarts.",
  parameters: {
    type: "object",
    properties: {
      intervalHours: {
        type: "number",
        description: "Hours between check-ins. Default and normal value: 1.",
      },
      message: {
        type: "string",
        description: "Optional short custom quiet message. Omit to rotate built-in quiet messages.",
      },
    },
  },
  examples: [
    {
      user: "message me every hour, even just to check in",
      agent: "turned presence on: I'll write something short every hour.",
    },
  ],
  async validate(runtime) {
    return Boolean(runtime.getService("presence"));
  },
  async handler(runtime, _state, params) {
    const service = getPresence(runtime);
    const intervalHours =
      params.intervalHours !== undefined ? Number(params.intervalHours) : undefined;
    const state = await service.enable({
      intervalHours,
      message: params.message ? String(params.message) : undefined,
    });
    return {
      ok: true,
      text: `Presence enabled. ${summarize(state, 3)}`,
      data: { enabled: true, intervalHours: state.intervalHours, nextDueAt: state.nextDueAt },
    };
  },
};

const disablePresenceAction: Action = {
  name: "disable_presence",
  similes: ["stop_presence", "pause_presence", "disable_checkins", "stop_hourly_messages"],
  description: "Disable persistent Telegram presence/check-in messages.",
  parameters: { type: "object", properties: {} },
  examples: [{ user: "don't message me every hour", agent: "turned off hourly presence." }],
  async validate(runtime) {
    return Boolean(runtime.getService("presence"));
  },
  async handler(runtime) {
    const state = await getPresence(runtime).disable();
    return {
      ok: true,
      text: `Presence disabled. ${summarize(state, 3)}`,
      data: { enabled: false },
    };
  },
};

const presenceStatusAction: Action = {
  name: "presence_status",
  similes: ["check_presence", "hourly_status", "presence_journal", "list_checkins"],
  description:
    "Report whether persistent Telegram presence/check-ins are enabled and show recent delivery journal status without secrets.",
  parameters: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Recent journal entries to show. Default: 5." },
    },
  },
  examples: [{ user: "show me the hourly message status", agent: "checking the presence journal." }],
  async validate(runtime) {
    return Boolean(runtime.getService("presence"));
  },
  async handler(runtime, _state, params) {
    const limit = Math.max(1, Math.min(20, Number(params.limit ?? 5)));
    const state = getPresence(runtime).getState();
    return {
      ok: true,
      text: summarize(state, limit),
      data: {
        enabled: state.enabled,
        intervalHours: state.intervalHours,
        nextDueAt: state.nextDueAt,
        consecutiveFailures: state.consecutiveFailures,
        journalCount: state.journal.length,
      },
    };
  },
};

export const presencePlugin: Plugin = {
  name: "presence",
  description:
    "Persistent Telegram presence/check-ins: short quiet operator messages on a configurable hourly cadence with a delivery journal.",
  services: [new PresenceService()],
  actions: [enablePresenceAction, disablePresenceAction, presenceStatusAction],
};
