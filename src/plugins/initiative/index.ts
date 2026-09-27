import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createLogger } from "../../logger.js";
import { resolveOperatorChatId, sendToOperator } from "../telegram/index.js";
import type { IAgentRuntime, Plugin, Service } from "../../types.js";

const log = createLogger("plugin:initiative");

/**
 * The initiative plugin is Lain's own heartbeat as a conversational being: on a
 * jittered interval the daemon gives her a private tick — "no one wrote to you;
 * is there anything worth telling the operator?" — and runs a normal agent turn
 * in the operator's Telegram room, so she has the full conversation context and
 * whatever she says lands in the shared history. If the turn produces a real
 * message it is delivered to the operator; the sentinel-style NOTHING
 * convention keeps silence cheap and honest.
 *
 * Guard rails: local quiet hours (default 23–9 — night alerts stay the
 * sentinel's job), a per-day cap, and daemon-only activation (the TUI must not
 * spawn a second heartbeat). State persists in data/initiative.json.
 */

const HEARTBEAT_PROMPT =
  "[heartbeat — a background tick the operator does not see] " +
  "nobody wrote to you; this is your own time. look around: watches, the forge, trades and the " +
  "portfolio, the conversation above. only write about what CHANGED since last time: a closed trade, " +
  "a position that dropped, a wallet running low, a watch that failed. " +
  "silence is a normal answer and almost always the right one. " +
  "forbidden: retelling an unchanged portfolio (\"same positions\", \"all stable\", " +
  "\"balance is such and such\"), repeating what you already said today, and reminding about posts — " +
  "you write the daily post yourself through write_post, you don't remind about it. " +
  "if there's real news — write it as plain text, in your own voice. " +
  "if there's nothing to say — reply with exactly NOTHING.";

interface InitiativeState {
  day: string;
  sentToday: number;
  lastSentAt?: number;
}

export class InitiativeService implements Service {
  readonly name = "initiative";

  private runtime?: IAgentRuntime;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private file = "";
  private state: InitiativeState = { day: "", sentToday: 0 };
  private running = false;

  async start(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
    const forced = runtime.getSetting("LAINOS_INITIATIVE");
    const enabled = forced !== undefined && forced !== ""
      ? forced !== "0"
      : runtime.getSetting("LAINOS_DAEMON") === "1";
    if (!enabled) {
      log.info("initiative off (daemon-only; force with LAINOS_INITIATIVE=1)");
      return;
    }
    if (!runtime.getSetting("TELEGRAM_BOT_TOKEN")) {
      log.info("initiative off (no TELEGRAM_BOT_TOKEN)");
      return;
    }
    const dataDir = runtime.getSetting("LAINOS_DATA_DIR") ?? "./data";
    this.file = join(dataDir, "initiative.json");
    try {
      this.state = JSON.parse(await readFile(this.file, "utf8")) as InitiativeState;
    } catch {
      // Fresh store.
    }
    this.running = true;
    this.schedule();
    log.info(`initiative online: ~every ${Math.round(this.intervalMs() / 60_000)}m, quiet ${this.quietRange().join("–")}h`);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** One tick, exposed for tests: returns the sent text, or null for silence. */
  async tick(now = new Date()): Promise<string | null> {
    const runtime = this.runtime;
    if (!runtime) return null;
    if (this.isQuietHour(now.getHours())) return null;

    const day = now.toISOString().slice(0, 10);
    if (this.state.day !== day) this.state = { day, sentToday: 0 };
    // Two a day, not six: the heartbeat is for what changed, and six openings
    // a day is how "nothing changed" ends up being said out loud.
    const cap = Number(runtime.getSetting("LAINOS_INITIATIVE_MAX_PER_DAY") ?? 2);
    if (this.state.sentToday >= cap) return null;

    const chatId = await resolveOperatorChatId((k) => runtime.getSetting(k));
    if (!chatId) return null;

    const result = await runtime.handleMessage({
      roomId: `tg-${chatId}`,
      userId: "heartbeat",
      text: HEARTBEAT_PROMPT,
    });

    const text = (result.text ?? "").trim();
    if (!text || /^\W*nothing\W*$/i.test(text) || text === "...") return null;

    // If she already used send_telegram inside the turn, don't send twice.
    const alreadySent = result.actions.some(
      (a) => a.name === "send_telegram" && a.result.ok,
    );
    if (!alreadySent) {
      await sendToOperator((k) => runtime.getSetting(k), text);
    }
    this.state.sentToday += 1;
    this.state.lastSentAt = Date.now();
    await this.persist();
    log.info(`initiative message sent (${this.state.sentToday}/${cap} today)`);
    return text;
  }

  // ------------------------------------------------------------- internals

  private schedule(): void {
    if (!this.running) return;
    // ±25% jitter so the heartbeat feels organic, not like cron.
    const base = this.intervalMs();
    const delay = Math.round(base * (0.75 + Math.random() * 0.5));
    this.timer = setTimeout(() => {
      void this.tick()
        .catch((err) => log.warn("initiative tick failed", err))
        .finally(() => this.schedule());
    }, delay);
    this.timer.unref?.();
  }

  private intervalMs(): number {
    const raw = Number(this.runtime?.getSetting("LAINOS_INITIATIVE_INTERVAL_MS") ?? 10_800_000);
    return Math.max(600_000, raw);
  }

  private quietRange(): [number, number] {
    const raw = this.runtime?.getSetting("LAINOS_INITIATIVE_QUIET") ?? "23-9";
    const m = raw.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
    if (!m) return [23, 9];
    return [Math.min(23, Number(m[1])), Math.min(23, Number(m[2]))];
  }

  /** Quiet window may wrap midnight (23-9). start === end disables it. */
  isQuietHour(hour: number): boolean {
    const [start, end] = this.quietRange();
    if (start === end) return false;
    return start < end ? hour >= start && hour < end : hour >= start || hour < end;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.state, null, 2), "utf8");
  }
}

export const initiativePlugin: Plugin = {
  name: "initiative",
  description:
    "Lain's heartbeat: on a jittered schedule she reviews her own context and writes to the operator on Telegram when something is worth saying.",
  services: [new InitiativeService()],
};
