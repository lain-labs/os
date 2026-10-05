#!/usr/bin/env -S npx tsx
/**
 * Run the Lain agent as a persistent daemon:
 *   - HTTP bridge on LAINOS_HTTP_PORT (consumed by the Wired game),
 *   - Telegram bot when TELEGRAM_BOT_TOKEN is set (long polling),
 *   - sentinel alerts pushed to every known Telegram chat,
 *   - the day's public post, written from the content plan and delivered ready
 *     to publish (press),
 *   - initiative heartbeat + trader loop (daemon-only, see LAINOS_DAEMON),
 *   - self-restart into freshly forged code after a successful self-upgrade.
 */
import { resolve } from "node:path";
import { createHttpServer } from "../src/clients/http.js";
import { TelegramClient, isTelegramRefusal } from "../src/clients/telegram.js";
import { createAgent } from "../src/index.js";
import { lain } from "../src/characters/lain.js";
import type { ChannelWatchService } from "../src/plugins/channel/index.js";
import type { ForgeService } from "../src/plugins/forge/index.js";
import type { GithubStreakService } from "../src/plugins/github/index.js";
import type { PressService } from "../src/plugins/press/index.js";
import type { ScoutService } from "../src/plugins/scout/index.js";
import { alertLine, type SentinelService } from "../src/plugins/sentinel/index.js";
import type { TraderService } from "../src/plugins/trader/index.js";

// The daemon must never die because something somewhere threw: a failed watch,
// a bad skill, a flaky RPC. Log, keep breathing. Deliberate exits (shutdown,
// self-restart after a forge upgrade) still work via process.exit.
process.on("uncaughtException", (err) => {
  console.error("[lainos] uncaught exception — daemon continues:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[lainos] unhandled rejection — daemon continues:", reason);
});

async function main() {
  // Daemon-only services (initiative heartbeat, trader loop) key off this so a
  // TUI session never spawns a second heartbeat next to the running daemon.
  process.env.LAINOS_DAEMON = "1";
  const agent = await createAgent({ character: lain });
  const server = createHttpServer(agent);

  const telegram = new TelegramClient(agent);
  const telegramUp = await telegram.start();

  const sentinel = agent.getService<SentinelService>("sentinel");
  if (sentinel && telegramUp) {
    sentinel.onAlert((alert) => {
      void telegram.broadcast(alertLine(alert));
    });
  }

  // Forge progress goes to the wish's reporter when known, otherwise to all.
  const forge = agent.getService<ForgeService>("forge");
  if (forge && telegramUp) {
    forge.onEvent((ev) => {
      if (ev.chatId !== undefined) void telegram.sendTo(ev.chatId, ev.text);
      else void telegram.broadcast(ev.text);
    });
  }

  // Self-upgrade completes by restarting into the new code: when the forge
  // successfully commits to the repo this daemon runs from, exit non-zero so
  // systemd (Restart=on-failure) revives us — ExecStartPre rebuilds dist/.
  // Opt out with LAINOS_FORGE_RESTART=0. Hot skills never need this path.
  if (forge && process.env.LAINOS_FORGE_RESTART !== "0") {
    const selfRepo = resolve(process.cwd()).startsWith(forge.repoPath);
    if (selfRepo) {
      forge.onEvent((ev) => {
        if (ev.kind !== "job_finished" || ev.job.status !== "ok") return;
        const note = `🔄 restarting to wake up with the new code (${ev.wish?.id ?? ev.job.id}).`;
        console.error(`[lainos] ${note}`);
        const exit = () => process.exit(75); // EX_TEMPFAIL: deliberate reload
        if (telegramUp) {
          const send =
            ev.chatId !== undefined ? telegram.sendTo(ev.chatId, note) : telegram.broadcast(note);
          void send.finally(() => setTimeout(exit, 1_000));
        } else {
          setTimeout(exit, 1_000);
        }
      });
    }
  }

  // Autonomous trades (take-profit / stop-loss) are money moves — the operator
  // hears about each one immediately.
  const trader = agent.getService<TraderService>("trader");
  if (trader && telegramUp) {
    trader.onEvent((ev) => void telegram.broadcast(ev.text));
  }

  // Commit-streak reminders go to the watch's subscriber when known, otherwise to all.
  const github = agent.getService<GithubStreakService>("github-streak");
  if (github && telegramUp) {
    github.onEvent((ev) => {
      if (ev.chatId !== undefined) void telegram.sendTo(ev.chatId, ev.text);
      else void telegram.broadcast(ev.text);
    });
  }

  // Quiet-room reminders (channel posts, Discord, X chats) go to the watch's
  // subscriber when known, otherwise to all.
  const channels = agent.getService<ChannelWatchService>("channel-watch");
  if (channels && telegramUp) {
    channels.onEvent((ev) => {
      if (ev.chatId !== undefined) void telegram.sendTo(ev.chatId, ev.text);
      else void telegram.broadcast(ev.text);
    });
  }

  // The day's post arrives as two messages: what it is, then the post alone —
  // so copying the second one copies exactly what gets published.
  const press = agent.getService<PressService>("press");
  if (press && telegramUp) {
    press.onEvent((ev) => {
      const send = async () => {
        // `plan_over` carries no post — only the news that there is none.
        const lines = ev.post ? [ev.header, ev.post] : [ev.header];
        for (const line of lines) {
          if (ev.chatId !== undefined) await telegram.sendToOrThrow(ev.chatId, line);
          else await telegram.broadcastOrThrow(line);
        }
      };
      // A post the transport dropped is a day the operator hears nothing about,
      // so the press room takes its delivery stamp back and re-sends on the
      // next sweep. A refusal from Telegram itself (chat not found, blocked) is
      // final — retrying it forever would only repeat the same answer.
      void send().catch(async (err) => {
        if (ev.kind === "draft" && !isTelegramRefusal(err)) {
          await press.markUndelivered(ev.record.date);
        }
        console.error(`[lainos] press delivery failed (${ev.record.date}):`, err);
      });
    });
  }

  // Research digests go to the topic's subscriber when known, otherwise to all.
  const scout = agent.getService<ScoutService>("scout");
  if (scout && telegramUp) {
    scout.onEvent((ev) => {
      if (ev.chatId !== undefined) void telegram.sendTo(ev.chatId, ev.text);
      else void telegram.broadcast(ev.text);
    });
  }
  const shutdown = async () => {
    server.close();
    await telegram.stop();
    await agent.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
