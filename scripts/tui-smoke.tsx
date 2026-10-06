#!/usr/bin/env -S npx tsx
/**
 * TUI smoke test: renders the ink App against fake stdio and drives the
 * keyboard — message round-trip, markdown-flat feed, /copy (OSC 52), /clear,
 * the arrow-key pickers, in-app scrolling layout, and the idle blink pause
 * that keeps terminal text selectable. Run: npm run tui:smoke
 */
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { render } from "ink";

// Dead RPC + fresh prefs dir so nothing but the blink timer repaints.
process.env.CHAIN_RPC_URL = "http://127.0.0.1:9";
process.env.LAINOS_DATA_DIR = mkdtempSync(join(tmpdir(), "lainos-tui-"));

import { App } from "../src/clients/tui/App.js";
import { AgentRuntime } from "../src/runtime.js";
import { FileMemoryStore } from "../src/memory/store.js";
import { SessionStore } from "../src/memory/sessions.js";
import { SwitchableModelProvider } from "../src/models/routing.js";
import { lain } from "../src/characters/lain.js";
import type { ModelRequest, ModelResponse } from "../src/types.js";

const REPLY = "the wired says: privet";

class FakeStdout extends EventEmitter {
  isTTY = true;
  columns = 100;
  rows = 40;
  writes: string[] = [];
  write(data: string): boolean {
    this.writes.push(String(data));
    return true;
  }
  off(ev: string, fn: (...a: unknown[]) => void) {
    return this.removeListener(ev, fn);
  }
}

class FakeStdin extends EventEmitter {
  isTTY = true;
  private chunks: string[] = [];
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  write(data: string) {
    this.chunks.push(data);
    this.emit("readable");
  }
  read(): string | null {
    return this.chunks.shift() ?? null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Without SGR/OSC, the raw chunks carry colour codes between word spans. */
const stripAnsi = (s: string) =>
  s
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[()][0-9A-Za-z]/g, "")
    .replace(/\x1b\]0;[^\x07]*\x07/g, "");

async function main() {
  const model = {
    name: "stub",
    modelFor: () => "stub-model",
    async generate(_req: ModelRequest): Promise<ModelResponse> {
      // A gateway answers: the id asked for, and the upstream that ran it.
      return { text: REPLY, toolCalls: [], model: "stub", provider: "gw", upstream: "groq" };
    },
  };
  // The daemon's chat model is switchable (/model claude|codex), so the probe
  // wraps the stub the same way — "anthropic" stands in for a route that has
  // neither a key nor a CLI on this machine.
  const switchable = new SwitchableModelProvider({
    initial: model as never,
    kind: "codex",
    envKind: "codex",
    assemble: (kind) =>
      kind === "anthropic"
        ? undefined
        : ({ ...model, name: kind, modelFor: () => `${kind}-model` } as never),
    persist: () => {},
  });
  const runtime = new AgentRuntime({
    character: lain,
    memory: new FileMemoryStore(mkdtempSync(join(tmpdir(), "lainos-tui-mem-"))),
    model: switchable as never,
    // Sessions are what /new, /resume and /sessions read; without a store the
    // commands answer "no index", which would pass for the wrong reason.
    sessions: new SessionStore(mkdtempSync(join(tmpdir(), "lainos-tui-ses-"))),
    settings: {},
  });
  runtime.use({
    name: "smoke-skills",
    description: "sidebar skill-count probe",
    actions: Array.from({ length: 24 }, (_, i) => ({
      name: `padded_out_probe_skill_${i}`,
      similes: [],
      description: "probe",
      examples: [],
      validate: async () => true,
      handler: async () => ({ ok: true }),
    })),
  });

  const stdout = new FakeStdout();
  const stdin = new FakeStdin();
  const app = render(<App runtime={runtime} />, {
    stdout: stdout as never,
    stdin: stdin as never,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  const anyWrite = (needle: string, from = 0) =>
    stdout.writes.slice(from).some((w) => w.includes(needle));
  const anyPlain = (needle: string, from = 0) =>
    stdout.writes.slice(from).some((w) => stripAnsi(w).includes(needle));
  const type = async (s: string) => {
    for (const ch of s) {
      stdin.write(ch);
      await sleep(15);
    }
  };

  await sleep(300);
  const results: [string, boolean][] = [];
  const resizeWipes: [number, number][] = [];

  // 0) the tab/window title is claimed via OSC 0
  results.push(["sets terminal title  ", anyWrite("\x1b]0;Lain OS")]);

  // 1) a normal message round-trip lands in the flat feed
  await type("hi\r");
  await sleep(700);
  results.push(["reply shows in feed  ", anyPlain(REPLY)]);
  // …with the whole provenance in the turn header: a model id alone cannot
  // say who ran it when the provider is a gateway serving an alias.
  results.push(["reply names model    ", anyPlain("· stub")]);
  results.push(["header names provider", anyPlain("· gw · stub ← groq")]);

  // The feed is drawn in the app's own frame now (not terminal scrollback), so
  // a blink repaint must keep the reply visible rather than drop it.
  await sleep(2000);
  results.push(["reply persists       ", anyPlain(REPLY)]);

  // 1.5) the composer edits like a readline prompt: ink's own key parsing
  // drops home/end/delete/ctrl+←→ entirely, so we parse the raw sequences.
  const beforeEdit = stdout.writes.length;
  await type("hello world");
  const press = async (seq: string) => {
    stdin.write(seq);
    await sleep(40);
  };
  await press("\x1b[H"); // home → start of line
  await type("X"); // "Xhello world"
  await press("\x1b[1;5C"); // ctrl+→ → past "hello"
  await press("\x1b[3~"); // delete → eats the space, "Xhelloworld"
  await press("\x1b[F"); // end
  await type("!");
  await sleep(120); // ink throttles renders — wait for the trailing frame
  results.push(["home/end/del/ctrl+→  ", anyPlain("Xhelloworld!", beforeEdit)]);
  await press("\x15"); // ctrl+u from the end wipes the line again
  await sleep(100);
  results.push(["line cleared         ", anyPlain("ask lain…", beforeEdit)]);

  // 1.6) the composer draws exactly what was typed. Spaces used to be eaten by
  // the wrapper (it rebuilt rows out of words), so the caret stood still until
  // the next letter arrived and a run of spaces collapsed into one.
  const beforeSpaces = stdout.writes.length;
  await type("a   b");
  await sleep(150);
  results.push(["spaces stay as typed ", anyPlain("a   b", beforeSpaces)]);
  await type(" ");
  await sleep(150);
  // The caret is a cell drawn *at* the cursor, so a trailing space means the
  // frame carries "a   b" followed by two cells before the frame's edge.
  const withTrailing = stripAnsi(stdout.writes.at(-1) ?? "");
  results.push(["trailing space shows ", withTrailing.includes("a   b  ")]);
  await press("\x15"); // ctrl+u — back to an empty composer
  await sleep(100);

  // 2) /copy emits OSC 52 with the reply, confirms in the feed
  const beforeCopy = stdout.writes.length;
  await type("/copy");
  await sleep(30);
  await type("\r"); // menu is narrowed to /copy; enter commits it
  await sleep(300);
  const osc = stdout.writes.find((w) => w.includes("\x1b]52;c;"));
  let oscOk = false;
  if (osc) {
    const b64 = osc.split("\x1b]52;c;")[1]?.split("\x07")[0] ?? "";
    oscOk = Buffer.from(b64, "base64").toString("utf8") === REPLY;
  }
  results.push(["/copy OSC52 payload  ", oscOk]);
  results.push(["/copy confirmation   ", anyPlain("copied lain's last reply", beforeCopy)]);

  // 2.5) sessions: the run is one, /sessions can see it, /new starts another
  // and /resume brings the first one back with its transcript intact.
  const beforeTasks = stdout.writes.length;
  await type("/tasks\r");
  await sleep(300);
  results.push(["/tasks prints the table", anyPlain("chat", beforeTasks) && anyPlain("(base)", beforeTasks)]);

  const beforeList = stdout.writes.length;
  await type("/sessions\r");
  await sleep(400);
  results.push(["/sessions sees this one", anyPlain("turns", beforeList) && anyPlain("❯", beforeList)]);

  await type("/new\r");
  await sleep(400);
  // Typing the command repaints the old feed on the way, so only the frame
  // that is actually on screen at the end says whether the session changed.
  const afterNew = stripAnsi(stdout.writes.at(-1) ?? "");
  results.push([
    "/new empties the feed  ",
    !afterNew.includes(REPLY) && afterNew.includes("welcome to the wired"),
  ]);

  const beforeResume = stdout.writes.length;
  await type("/resume 1\r");
  await sleep(600);
  results.push(["/resume brings it back ", anyPlain(REPLY, beforeResume)]);

  // 3) /clear resets the feed but keeps the banner + boot line. The screen is
  // rebuilt in the app's own frame, so check the LAST frame is clean.
  await type("/clear");
  await sleep(30);
  await type("\r");
  await sleep(300);
  const lastWrite = stdout.writes.at(-1) ?? "";
  results.push(["/clear shows boot    ", stripAnsi(lastWrite).includes("welcome to the wired")]);
  results.push(["/clear drops history ", !stripAnsi(lastWrite).includes(REPLY)]);

  // 4) picking a new /skin recolours the whole frame in place
  await type("/skin");
  await sleep(30);
  await type("\r"); // menu narrowed to /skin; enter opens the picker
  await sleep(200);
  stdin.write("\x1b[B"); // ↓ highlights "matrix" (preview recolors the frame)
  await sleep(150);
  const beforePick = stdout.writes.length;
  stdin.write("\r"); // pick it
  await sleep(300);
  const matrixPrimary = "38;2;57;255;20"; // THEMES.matrix.primary #39ff14
  results.push(["/skin applies theme  ", anyWrite(matrixPrimary, beforePick)]);
  results.push(["/skin reprints boot  ", anyPlain("welcome to the wired", beforePick)]);

  // 4.6) a picker is a mouse target too: clicking a row picks it. Arrow keys
  // alone are not an answer when the same list opens by clicking the sidebar.
  const rowOf = (needle: string): number =>
    stripAnsi(stdout.writes.at(-1) ?? "")
      .split("\n")
      .findIndex((l) => l.includes(needle));
  await type("/skin");
  await sleep(30);
  await type("\r");
  await sleep(250);
  const crimsonRow = rowOf("crimson");
  const beforeClick = stdout.writes.length;
  stdin.write(`\x1b[<0;6;${crimsonRow + 1}M`); // press on the row
  await sleep(60);
  stdin.write(`\x1b[<0;6;${crimsonRow + 1}m`); // release: picks it
  await sleep(300);
  const crimsonPrimary = "38;2;255;59;78"; // THEMES.crimson.primary #ff3b4e
  results.push(["click picks in picker", crimsonRow > 0 && anyWrite(crimsonPrimary, beforeClick)]);
  results.push(["picker closes on pick", !stripAnsi(stdout.writes.at(-1) ?? "").includes("↑↓ or click")]);

  // 4.65) dragging selects text and the release copies it. The terminal cannot
  // do this while the app reads the mouse, so the app has to.
  const beforeDrag = stdout.writes.length;
  stdin.write("\x1b[<0;1;1M"); // press, top-left
  await sleep(40);
  stdin.write("\x1b[<32;50;20M"); // drag (button held: 0 + motion bit)
  await sleep(40);
  stdin.write(`\x1b[<32;${stdout.columns};${stdout.rows - 1}M`);
  await sleep(40);
  stdin.write(`\x1b[<0;${stdout.columns};${stdout.rows - 1}m`); // release
  await sleep(300);
  const dragOsc = stdout.writes
    .slice(beforeDrag)
    .filter((w) => w.includes("\x1b]52;c;"))
    .at(-1);
  const dragged = dragOsc
    ? Buffer.from(dragOsc.split("\x1b]52;c;")[1]?.split("\x07")[0] ?? "", "base64").toString("utf8")
    : "";
  // (the feed was emptied by /clear above, so the boot line is what is on screen)
  results.push([
    "drag selects + copies",
    dragged.includes("welcome to the wired") && dragged.includes("\n"),
  ]);
  results.push(["drag says what it did", anyPlain("chars copied", beforeDrag)]);

  // 4.66) a drag held below the transcript scrolls it, and the copy takes what
  // scrolled past — not just the rows one screen shows.
  await type("/help\r");
  await sleep(300);
  for (let i = 0; i < 40; i++) stdin.write("\x1b[<64;5;5M"); // wheel up to the top
  await sleep(200);
  const beforeLong = stdout.writes.length;
  stdin.write("\x1b[<0;3;2M");
  await sleep(40);
  for (let i = 0; i < 60; i++) {
    stdin.write(`\x1b[<32;${10 + (i % 2)};${stdout.rows - 1}M`); // held on the composer
    await sleep(5);
  }
  await sleep(100);
  stdin.write(`\x1b[<0;10;${stdout.rows - 1}m`);
  await sleep(300);
  const longOsc = stdout.writes.slice(beforeLong).filter((w) => w.includes("\x1b]52;c;")).at(-1);
  const longCopy = longOsc
    ? Buffer.from(longOsc.split("\x1b]52;c;")[1]?.split("\x07")[0] ?? "", "base64").toString("utf8")
    : "";
  // (the transcript gets the window less the chrome: about rows - 7)
  results.push(["drag scrolls past edge", longCopy.split("\n").length > stdout.rows - 7]);
  await type("/clear\r"); // the rest expects the short boot feed
  await sleep(200);

  // 4.7) /model re-routes the replies in place, and a route that cannot be
  // built says so instead of silently dropping the chat on another model.
  const beforeModel = stdout.writes.length;
  await type("/model claude\r");
  await sleep(300);
  results.push(["/model switches      ", anyPlain("replies now go through claude", beforeModel)]);
  const beforeBadModel = stdout.writes.length;
  await type("/model claude-api\r");
  await sleep(300);
  results.push(["/model failure loud  ", anyPlain("unavailable", beforeBadModel)]);

  // 4.5) nothing ever draws wider than the terminal.
  const wideLine = stdout.writes
    .flatMap((w) => stripAnsi(w).split("\n"))
    .find((l) => [...l].length > stdout.columns);
  results.push(["fits terminal width  ", wideLine === undefined]);

  // 4.8) the composer holds more than one line, and the ways of saying so that
  // do not need a terminal protocol: alt+enter, ctrl+j, and a trailing "\".
  const beforeMulti = stdout.writes.length;
  await type("first");
  stdin.write("\x1b\r"); // alt+enter
  await sleep(60);
  await type("second");
  stdin.write("\n"); // ctrl+j
  await sleep(60);
  await type("third\\");
  stdin.write("\r"); // a trailing backslash breaks the line instead of sending
  await sleep(120);
  await type("fourth");
  await sleep(150);
  const multi = stripAnsi(stdout.writes.at(-1) ?? "");
  results.push([
    "composer holds lines ",
    ["first", "second", "third", "fourth"].every((l) => multi.includes(l)) && multi.includes("4 lines"),
  ]);

  // …and a paste keeps its line breaks instead of firing a message per line.
  const beforePaste = stdout.writes.length;
  stdin.write("\x15"); // ctrl+u — wipe the composer
  await sleep(60);
  stdin.write("\x1b[200~pasted one\npasted two\x1b[201~");
  await sleep(200);
  const pasted = stripAnsi(stdout.writes.at(-1) ?? "");
  results.push([
    "paste stays in composer",
    pasted.includes("pasted one") && pasted.includes("pasted two") && pasted.includes("2 lines"),
  ]);
  results.push(["paste sends nothing  ", !anyPlain("▸ you", beforePaste)]);
  stdin.write("\x15");
  await sleep(60);

  // 4.9) ctrl+y copies the last reply without a command…
  await type("say something\r"); // /clear left no reply to copy
  await sleep(700);
  const beforeYank = stdout.writes.length;
  stdin.write("\x19");
  await sleep(200);
  results.push(["ctrl+y copies reply  ", anyPlain("copied lain's last reply", beforeYank)]);

  // …and ctrl+s freezes the frame and hands the mouse back to the terminal, so
  // a selection can survive: nothing may be written while it holds.
  const beforeSelect = stdout.writes.length;
  stdin.write("\x13");
  await sleep(250);
  results.push(["ctrl+s says it froze ", anyPlain("selection", beforeSelect) && anyPlain("esc back", beforeSelect)]);
  results.push(["ctrl+s releases mouse", anyWrite("\x1b[?1000l", beforeSelect)]);
  const frozenAt = stdout.writes.length;
  await sleep(2500); // blink + chain poll would both have repainted by now
  results.push(["frozen frame is quiet", stdout.writes.length === frozenAt]);
  stdin.write("\x1b"); // esc leaves selection mode
  await sleep(200);
  results.push(["esc restores the app ", stdout.writes.length > frozenAt]);

  // 5) a width change drops the right sidebar (content goes full width)
  const beforeResize = stdout.writes.length;
  stdout.columns = 80;
  stdout.emit("resize");
  await sleep(600);
  results.push([
    "resize drops sidebar ",
    !anyPlain("╭─ session", beforeResize) && anyPlain("LAIN OS", beforeResize),
  ]);

  // 5.5) a slash menu taller than the window scrolls inside it instead of
  // pushing the frame past the last row (which made the terminal flicker)
  // (ink wipes the screen once when it repaints the old, taller frame into a
  // shorter window — that is the resize, not the menu, so those writes are
  // left out of the "never wipes" check below)
  const shrinkAt = stdout.writes.length;
  stdout.rows = 14;
  stdout.emit("resize");
  await sleep(300);
  const beforeMenu = stdout.writes.length;
  resizeWipes.push([shrinkAt, beforeMenu]);
  await type("/");
  await sleep(150);
  results.push(["short menu says more ", anyPlain("more", beforeMenu)]);
  for (let i = 0; i < 30; i++) {
    stdin.write("\x1b[B");
    await sleep(15);
  }
  await sleep(150);
  results.push(["menu scrolls to ↑ more", anyPlain("↑ ", beforeMenu)]);
  const menuTallest = Math.max(
    ...stdout.writes.slice(beforeMenu).map((w) => stripAnsi(w).split("\n").length),
  );
  results.push(["menu fits the window ", menuTallest <= stdout.rows]);
  results.push(["menu never wipes     ", !anyWrite("\x1b[2J", beforeMenu)]);
  stdin.write("\x15"); // ctrl+u closes the menu again
  await sleep(150);
  stdout.rows = 40;
  stdout.emit("resize");
  await sleep(300);

  // 6) blink repaints happen right after typing…
  const n1 = stdout.writes.length;
  await sleep(2500);
  const blinkFrames = stdout.writes.length - n1;
  results.push([`blinks while active  `, blinkFrames >= 2]);

  // …and stop once the keyboard has been idle >10s (selection survives)
  await sleep(9000);
  const n2 = stdout.writes.length;
  await sleep(3000);
  const idleFrames = stdout.writes.length - n2;
  results.push([`idle stops repaints  `, idleFrames === 0]);

  // 6.5) ctrl+c: once asks, twice leaves. Both encodings drive it — a terminal
  // speaking the kitty protocol (which this app asks for) never sends \x03.
  const beforeQuit = stdout.writes.length;
  stdin.write("\x03");
  await sleep(200);
  results.push(["ctrl+c asks first    ", anyPlain("again to leave the wired", beforeQuit)]);
  const beforeDisarm = stdout.writes.length;
  await type("x"); // any other key answers "no"
  await sleep(200);
  results.push(["another key disarms  ", !anyPlain("again to leave", beforeDisarm)]);
  let exited = false;
  void app.waitUntilExit().then(() => {
    exited = true;
  });
  stdin.write("\x03");
  await sleep(150);
  stdin.write("\x1b[99;5u"); // the kitty spelling of ctrl+c
  await sleep(400);
  results.push(["ctrl+c twice leaves  ", exited]);

  // 7) never clear the terminal. ink does exactly that — erasing the scrollback
  // with it — whenever a frame is as tall as the window, which is why the frame
  // stops one row short. A screen wiped several times a second cannot be read
  // back, scrolled back, or copied out of.
  results.push([
    "never wipes the screen",
    !stdout.writes.some(
      (w, i) => w.includes("\x1b[2J") && !resizeWipes.some(([a, b]) => i >= a && i < b),
    ),
  ]);
  // …and every frame stays inside the window, or ink wraps a line and clears.
  const tallest = Math.max(...stdout.writes.map((w) => stripAnsi(w).split("\n").length));
  results.push(["frame fits the window ", tallest <= stdout.rows]);

  app.unmount();
  let ok = true;
  for (const [name, pass] of results) {
    console.log(`${name}: ${pass ? "PASS" : "FAIL"}`);
    ok &&= pass;
  }
  console.log(ok ? "TUI PROBE OK" : "TUI PROBE FAILED");
  process.exit(ok ? 0 : 1);
}

void main();
