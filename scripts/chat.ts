#!/usr/bin/env -S npx tsx
/** Launch the Lain agent in an interactive CLI REPL. */
import { runCli } from "../src/clients/cli.js";
import { createAgent } from "../src/index.js";
import { lain } from "../src/characters/lain.js";

async function main() {
  const agent = await createAgent({ character: lain });
  await runCli(agent);
  await agent.stop();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
