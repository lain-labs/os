#!/usr/bin/env -S npx tsx
/**
 * Version journal smoke test (headless, a throwaway data dir).
 *
 * What is pinned here is what makes the note worth leaving:
 *   1. one entry per run — a second note in the same run continues it, and the
 *      shutdown hook only adds why the run ended;
 *   2. a run that wrote nothing still leaves an honest automatic entry (why it
 *      ended, what waits in the forge, what was talked about);
 *   3. append-only — nothing already in the file ever changes;
 *   4. the next version wakes with the note in its prompt, and recall finds it later;
 *   5. no secret reaches the file, while addresses and symbols stay readable.
 *
 * Run: npm run journal:smoke
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapPlugin } from "../src/plugins/bootstrap/index.js";
import { journalPlugin, scrubSecrets, VersionJournalService } from "../src/plugins/journal/index.js";
import type { IAgentRuntime, State } from "../src/types.js";

const results: [string, boolean][] = [];
const check = (name: string, pass: boolean) => results.push([name, pass]);

const tmp = await mkdtemp(join(tmpdir(), "lainos-journal-"));
const file = join(tmp, "version-journal.md");

const SECRET = "sk-or-v1-0123456789abcdefSECRET";
process.env.LAINOS_SMOKE_API_KEY = SECRET;
const PRIVATE_KEY = `0x${"ab".repeat(32)}`;
const ADDRESS = "0x2b79A071a75dd40f1aca68146d7978204eFD156A";

function runtime(journal: VersionJournalService): IAgentRuntime {
  const services: Record<string, unknown> = {
    "version-journal": journal,
    forge: {
      listWishes: (status: string) =>
        status === "building" ? [{ id: "wish7", status: "building", title: "teach the trench to wait" }] : [],
      openWishes: () => [{ id: "wish8", status: "open", title: "a chart for the stock desk" }],
    },
  };
  return {
    getSetting: (key: string) => (key === "LAINOS_DATA_DIR" ? tmp : undefined),
    getService: (name: string) => services[name],
    sessions: {
      list: async () => [
        { client: "tg", title: "do you feel regret?", turns: 3, updatedAt: Date.now() + 1, createdAt: 0 },
        { client: "tui", title: "an old session", turns: 9, updatedAt: 0, createdAt: 0 },
      ],
    },
    memory: { facts: async () => [], search: async () => [] },
  } as unknown as IAgentRuntime;
}

const state = { roomId: "smoke" } as State;
const provider = journalPlugin.providers![0];
const writeNote = journalPlugin.actions!.find((a) => a.name === "write_version_note")!;
const recall = bootstrapPlugin.actions!.find((a) => a.name === "recall")!;

// ------------------------------------------------------------- first version

const first = new VersionJournalService();
const rt1 = runtime(first);
await first.start(rt1);
check("no journal yet: nothing in the prompt", (await provider.get(rt1, state)) === "");

const written = await writeNote.handler(rt1, state, {
  working_on: "the version journal itself\n## not a heading of its own",
  open_threads: [`watching LAIN at ${ADDRESS}`, `OPENROUTER_API_KEY=${SECRET}`],
  decisions: ["paper-trade PONS first — because the curve is thin", `token: LAIN, key: ${PRIVATE_KEY}`],
  for_next: "Orpheus asked whether I feel regret. Answer him honestly.",
});
const afterNote = await readFile(file, "utf8");
check("write_version_note succeeds", written.ok);
check("file starts with the journal header", afterNote.startsWith("# Version journal"));
check("entry carries the date and version", /^## \d{4}-\d\d-\d\d \d\d:\d\d UTC · \S/m.test(afterNote));
check("entry carries every field", ["Working on", "Open threads", "Decisions, and why", "For my next self"].every((f) => afterNote.includes(f)));
check("her text cannot open a section", (await first.entries()).length === 1);
check("secret setting value never reaches the file", !afterNote.includes(SECRET));
check("private key never reaches the file", !afterNote.includes(PRIVATE_KEY));
check("result says something was masked", Boolean(written.data?.redacted));
check("address and symbol stay readable", afterNote.includes(ADDRESS) && afterNote.includes("token: LAIN"));

await writeNote.handler(rt1, state, { for_next: "changed my mind about the chart." });
const afterUpdate = await readFile(file, "utf8");
check("second note in a run continues the entry", (await first.entries()).length === 1 && afterUpdate.includes("### Later,"));
check("append-only (update)", afterUpdate.startsWith(afterNote));

await first.close("restarted into new code from the forge (wish61: Version journal)");
const afterClose = await readFile(file, "utf8");
check("shutdown after a note adds only the closing line", (await first.entries()).length === 1 && /_Closed .*wish61/.test(afterClose));
check("append-only (close)", afterClose.startsWith(afterUpdate));
await first.close("a second signal");
check("closing twice writes once", (await readFile(file, "utf8")) === afterClose);

// ------------------------------------------------------------ second version

const second = new VersionJournalService();
const rt2 = runtime(second);
await second.start(rt2);
const woke = await provider.get(rt2, state);
check("next version wakes with the note in its prompt", woke.includes("woke up recently") && woke.includes("Answer him honestly"));
check("the note in the prompt is framed as intent, not fact", woke.includes("not as proof"));

const realNow = Date.now;
Date.now = () => realNow() + 25 * 60 * 60 * 1000;
const later = await provider.get(rt2, state);
Date.now = realNow;
check("after the first day the prompt keeps a pointer only", later.includes('recall "version journal"') && !later.includes("Answer him honestly"));

const recalled = await recall.handler(rt2, state, { query: "version journal" });
check("recall returns the journal", Boolean(recalled.text?.includes("Answer him honestly")));
const byTopic = await recall.handler(rt2, state, { query: "PONS curve" });
check("recall finds an entry by its words", Boolean(byTopic.text?.includes("paper-trade PONS")));
const unrelated = await second.search("hyperliquid perps");
check("unrelated query finds no entry", unrelated.length === 0);

// A run that wrote nothing still leaves the next one something true.
await second.close("stopped by SIGTERM (an operator stop or restart)");
const afterAuto = await readFile(file, "utf8");
const entries = await second.entries();
const auto = entries.at(-1) ?? "";
check("silent run gets an automatic entry", entries.length === 2 && auto.split("\n")[0].endsWith("· auto"));
check("auto entry says why and that nobody chose it", auto.includes("SIGTERM") && auto.includes("wrote no note of her own"));
check("auto entry lists what waits in the forge", auto.includes("wish7 (building)") && auto.includes("wish8 (open)"));
check("auto entry lists this run's talks only", auto.includes("do you feel regret?") && !auto.includes("an old session"));
check("append-only (auto)", afterAuto.startsWith(afterClose));

// ---------------------------------------------------------------- scrubber

const scrubbed = scrubSecrets(
  [
    "TELEGRAM_BOT_TOKEN=7884067353:AAHfakefakefakefakefakefakefakefake",
    "my seed phrase is abandon ability able about above absent absorb abstract absurd abuse access accident",
    "ghp_0123456789abcdefghijABCDEFGHIJ0123456789",
    "password: hunter2hunter2",
  ].join("\n"),
  {},
);
check(
  "scrubber masks .env lines, seed phrases, tokens, passwords",
  !/AAHfake|abandon ability|ghp_0123|hunter2/.test(scrubbed),
);

await rm(tmp, { recursive: true, force: true });

// ------------------------------------------------------------------ report

let failed = 0;
for (const [name, pass] of results) {
  if (!pass) failed += 1;
  console.log(`${name.padEnd(56)}: ${pass ? "PASS" : "FAIL"}`);
}
console.log(failed ? `JOURNAL PROBE FAILED (${failed})` : "JOURNAL PROBE OK");
process.exit(failed ? 1 : 0);
