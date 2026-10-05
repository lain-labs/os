#!/usr/bin/env -S npx tsx
/** Launch the Lain agent inside the LainOS TUI. */
import React from "react";
import { render } from "ink";
import { createAgent } from "../src/index.js";
import { lain } from "../src/characters/lain.js";
import { setLogMuted } from "../src/logger.js";
import { ensureLogin } from "../src/setup/login-gate.js";
import { setTextPictographWidth } from "../src/clients/tui/markdown.js";
import { App } from "../src/clients/tui/App.js";

async function main() {
  // Required before the TUI takes over the screen, so the prompt (and any
  // opened browser) behaves like a normal terminal interaction.
  await ensureLogin();

  // The TUI owns the screen — keep stray console output from corrupting it.
  setLogMuted(true);
  // Node writes to a terminal synchronously, so a terminal that stops reading
  // (a phone with the ssh client in the background) blocked the event loop on
  // a full pty — and every turn, tool and watch with it. Queue instead; the
  // app stops drawing while the queue is backed up (useOutputFlowing).
  setStdoutBlocking(false);
  // ⚠ ⚙ ✔ are one cell in most terminals and two in some; ask this one.
  const pictograph = await measureTextPictograph();
  if (pictograph) setTextPictographWidth(pictograph);
  const agent = await createAgent({ character: lain });

  // ctrl+c belongs to the app: one press asks, two leave. ink's own handler
  // would end the session on the first — and only ever sees the bare \x03 byte,
  // which a terminal speaking the kitty keyboard protocol never sends.
  const { waitUntilExit } = render(React.createElement(App, { runtime: agent }), {
    exitOnCtrlC: false,
  });
  await waitUntilExit();

  await agent.stop();
  await drainStdout();
  process.exit(0);
}

/**
 * How many cells this terminal gives a text-style pictograph: print ⚠ at the
 * start of the line and ask where the cursor went (CSI 6n). LAINOS_TUI_EMOJI_WIDTH
 * overrides; no answer within the timeout (not a terminal, or one that does
 * not report) keeps the default.
 */
async function measureTextPictograph(): Promise<1 | 2 | null> {
  const env = process.env.LAINOS_TUI_EMOJI_WIDTH;
  if (env === "1" || env === "2") return Number(env) as 1 | 2;
  const { stdin, stdout } = process;
  if (!stdin.isTTY || !stdout.isTTY) return null;
  return new Promise((resolve) => {
    let buf = "";
    const finish = (width: 1 | 2 | null) => {
      clearTimeout(timer);
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\r\x1b[2K");
      resolve(width);
    };
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("latin1");
      const m = /\x1b\[\d+;(\d+)R/.exec(buf);
      if (m) finish(Number(m[1]) - 1 >= 2 ? 2 : 1);
    };
    const timer = setTimeout(() => finish(null), 700);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    stdout.write("\r\u26a0\x1b[6n");
  });
}

type BlockingHandle = { setBlocking?: (on: boolean) => void };

function setStdoutBlocking(on: boolean): void {
  if (!process.stdout.isTTY) return;
  (process.stdout as unknown as { _handle?: BlockingHandle })._handle?.setBlocking?.(on);
}

/** Let the last queued writes (terminal modes being restored) reach the terminal. */
async function drainStdout(): Promise<void> {
  if (process.stdout.writableLength > 0) {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 1000);
      process.stdout.once("drain", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
  setStdoutBlocking(true);
}

main().catch((err) => {
  setLogMuted(false);
  console.error(err);
  process.exit(1);
});
