#!/usr/bin/env -S npx tsx
/**
 * Security smoke test (headless, no model, no chain).
 *
 * Pinned here:
 *   1. a tool whose validate() refuses is not run, even when the model calls
 *      it by name or by simile without having been offered it;
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime, FileMemoryStore, type ModelProvider, type ModelRequest } from "../src/index.js";
import { lain } from "../src/characters/lain.js";
import type { Action } from "../src/types.js";

const results: [string, boolean][] = [];
const check = (name: string, pass: boolean) => results.push([name, pass]);
const tmp = await mkdtemp(join(tmpdir(), "lainos-security-"));

/** A model that calls the given tools once, then answers. */
function callingModel(calls: { name: string; input?: Record<string, unknown> }[]): ModelProvider {
  return {
    name: "call-stub",
    modelFor: () => "call-stub",
    async generate(request: ModelRequest) {
      const last = request.messages.at(-1)?.content ?? "";
      if (last.startsWith("Tool results")) return { text: "done", toolCalls: [], model: "call-stub" };
      return {
        text: "",
        toolCalls: calls.map((c) => ({ name: c.name, input: c.input ?? {} })),
        model: "call-stub",
      };
    },
  };
}

function runtimeWith(dir: string, model: ModelProvider, actions: Action[]): AgentRuntime {
  const runtime = new AgentRuntime({
    character: lain,
    memory: new FileMemoryStore(dir),
    model,
    settings: { LAINOS_DATA_DIR: dir, LAINOS_MODEL_TRANSCRIPTS: "0" },
  });
  runtime.use({ name: "probe", description: "security probes", actions });
  return runtime;
}

/** An action that records whether its handler ran. */
function probe(name: string, allowed: () => boolean, similes: string[] = []): Action & { ran: number } {
  const action = {
    ran: 0,
    name,
    similes,
    description: "stub",
    examples: [],
    async validate() {
      return allowed();
    },
    async handler() {
      action.ran += 1;
      return { ok: true, text: `${name} ran` };
    },
  };
  return action;
}

// ------------------------------------------------- 1. validate() is enforced

{
  const locked = probe("locked_probe", () => false, ["locked_alias"]);
  const open = probe("open_probe", () => true);
  const rt = runtimeWith(
    join(tmp, "validate"),
    callingModel([{ name: "locked_probe" }, { name: "locked_alias", input: { again: 1 } }, { name: "open_probe" }]),
    [locked, open],
  );
  const result = await rt.handleMessage({ roomId: "sec", userId: "user", text: "go" });
  check("a tool that fails validate() never runs", locked.ran === 0);
  check("…not even through a simile", result.actions.filter((a) => a.name === "locked_probe").every((a) => !a.result.ok));
  check("a tool that passes validate() still runs", open.ran === 1);
}

await rm(tmp, { recursive: true, force: true });

let failed = 0;
for (const [name, pass] of results) {
  console.log(`${pass ? "✓" : "✗"} ${name}`);
  if (!pass) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
