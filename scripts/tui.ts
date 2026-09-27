#!/usr/bin/env -S npx tsx
/** Launch the Lain agent inside the LainOS TUI. */
import React from "react";
import { render } from "ink";
import { createAgent } from "../src/index.js";
import { lain } from "../src/characters/lain.js";
import { setLogMuted } from "../src/logger.js";
import { App } from "../src/clients/tui/App.js";

async function main() {
  // The TUI owns the screen — keep stray console output from corrupting it.
  setLogMuted(true);
  const agent = await createAgent({ character: lain });

  // ctrl+c belongs to the app: one press asks, two leave. ink's own handler
  // would end the session on the first — and only ever sees the bare \x03 byte,
  // which a terminal speaking the kitty keyboard protocol never sends.
  const { waitUntilExit } = render(React.createElement(App, { runtime: agent }), {
    exitOnCtrlC: false,
  });
  await waitUntilExit();

  await agent.stop();
  process.exit(0);
}

main().catch((err) => {
  setLogMuted(false);
  console.error(err);
  process.exit(1);
});
