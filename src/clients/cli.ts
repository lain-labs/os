import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createLogger } from "../logger.js";
import { buildRecap } from "../memory/recap.js";
import { newRoomId } from "../memory/sessions.js";
import { answerStamp, SwitchableModelProvider } from "../models/routing.js";
import { TASKS, TASK_ORDER, isTaskKind } from "../models/tasks.js";
import type { IAgentRuntime } from "../types.js";

const log = createLogger("cli");

const HELP = [
  "/new            start a fresh session (aliases: /clear, /reset)",
  "/resume <id|n>  reopen an earlier session",
  "/sessions       list recent sessions, newest first",
  "/recap [id|n]   summarise a session (this one by default)",
  "/tasks [kind] [provider[:model]]  who answers which kind of work",
  "/exit           leave",
].join("\n");

const ago = (at: number): string => {
  const mins = Math.round((Date.now() - at) / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
};

/** Interactive REPL against a running agent. */
export async function runCli(runtime: IAgentRuntime, roomId?: string): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  const name = runtime.character.name;
  const sessions = runtime.sessions;
  const switchable =
    runtime.model instanceof SwitchableModelProvider ? runtime.model : undefined;
  log.info(`Talking to ${name}. /help for commands, /exit to quit.`);

  // Each run is its own session, like the TUI — /resume is how you go back.
  let room = roomId ?? newRoomId("cli");
  const say = (text: string) => stdout.write(`${text}\n`);

  for (;;) {
    const line = (await rl.question("\x1b[36myou>\x1b[0m ")).trim();
    if (!line) continue;
    const [cmd, ...rest] = line.split(/\s+/);

    if (line === "/exit" || line === "/quit") break;
    if (cmd === "/help") {
      say(HELP);
      continue;
    }
    if (cmd === "/new" || cmd === "/reset" || cmd === "/clear") {
      room = newRoomId("cli");
      say(`new session · room ${room} (the old one is saved — /resume brings it back)`);
      continue;
    }
    if (cmd === "/sessions") {
      const list = (await sessions?.list(10)) ?? [];
      say(
        list.length
          ? list
              .map(
                (s, i) =>
                  `${s.roomId === room ? "❯" : " "} ${String(i + 1).padStart(2)}  ${s.id}  ` +
                  `${s.client.padEnd(4)} ${ago(s.updatedAt).padEnd(9)} ${String(s.turns).padStart(3)} turns  ${s.title || "—"}`,
              )
              .join("\n")
          : "no sessions recorded yet.",
      );
      continue;
    }
    if (cmd === "/resume") {
      const record = rest[0] ? await sessions?.resolve(rest[0]) : undefined;
      if (!record) {
        say(rest[0] ? `no session "${rest[0]}" — /sessions lists them.` : "usage: /resume <id|n>");
        continue;
      }
      room = record.roomId;
      const mems = await runtime.memory.recent(record.roomId, 10);
      say(`resumed ${record.id} · ${record.turns} turns · last touched ${ago(record.updatedAt)}`);
      for (const m of mems.filter((x) => x.role !== "system")) {
        say(`  ${m.role === "agent" ? name : "you"}: ${m.content.slice(0, 160)}`);
      }
      continue;
    }
    if (cmd === "/recap") {
      const record = rest[0] ? await sessions?.resolve(rest[0]) : await sessions?.resolve(room);
      if (!record) {
        say("nothing said in this session yet.");
        continue;
      }
      const result = await buildRecap(runtime, record);
      if (result.summarised && result.model) {
        await sessions?.setRecap(record.id, { text: result.text, at: Date.now(), model: result.model });
      }
      say(result.text);
      continue;
    }
    if (cmd === "/tasks") {
      if (!switchable) {
        say("this run's model provider is fixed — nothing to route.");
        continue;
      }
      const row = (r: { emoji: string; task: string; provider: string; model: string; source: string; error?: string }) =>
        `  ${r.emoji} ${r.task.padEnd(10)} ${r.provider}${r.model ? ` · ${r.model}` : ""}  (${r.source})` +
        `${r.error ? `  ⚠ ${r.error}` : ""}`;
      const kind = rest[0]?.toLowerCase();
      if (!kind) {
        say(switchable.taskRoutes().map(row).join("\n"));
        continue;
      }
      if (!isTaskKind(kind)) {
        say(`unknown kind "${kind}" — one of: ${TASK_ORDER.join(", ")}`);
        continue;
      }
      if (!rest[1]) {
        say(`${row(switchable.taskRouteState(kind))}\n  ${TASKS[kind].desc}`);
        continue;
      }
      const clearing = ["default", "none", "base"].includes(rest[1].toLowerCase());
      const result = switchable.setTaskRoute(kind, clearing ? null : rest.slice(1).join(" "));
      say(typeof result === "string" ? result : row(result));
      continue;
    }

    try {
      const result = await runtime.handleMessage({ roomId: room, userId: "user", text: line });
      if (result.actions.length) {
        const summary = result.actions.map((a) => `${a.name}:${a.result.ok ? "ok" : "fail"}`).join(", ");
        log.debug(`actions -> ${summary}`);
      }
      // Provenance on every reply: what kind of work it was taken as, and who
      // actually answered — the two things a routed agent must never hide.
      const stamp = answerStamp(result);
      stdout.write(`\x1b[35m${name}>\x1b[0m ${result.text}\n`);
      if (stamp) stdout.write(`\x1b[2m       ${stamp}\x1b[0m\n`);
    } catch (err) {
      log.error("turn failed", err);
    }
  }
  rl.close();
}
