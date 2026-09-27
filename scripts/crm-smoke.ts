#!/usr/bin/env -S npx tsx
/**
 * CRM outbox smoke test (headless, one throwaway HTTP server on loopback).
 *
 * What is pinned here is everything that decides whether the board can be
 * trusted:
 *   1. off unless configured — no URL, no queue, no traffic;
 *   2. the first run adopts the past instead of filing a year of it;
 *   3. an id is minted once, so a repeat of the same event files nothing;
 *   4. a delivery that failed is kept and lands on the next sweep;
 *   5. a record this server will never accept is dropped rather than left to
 *      wedge everything behind it;
 *   6. the outbox is on disk, so a restart mid-outage loses nothing.
 *
 * Run: npm run crm:smoke
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { CrmService } from "../src/plugins/crm/index.js";
import type { IAgentRuntime } from "../src/types.js";

const results: [string, boolean][] = [];
const check = (name: string, pass: boolean) => results.push([name, pass]);

const tmp = await mkdtemp(join(tmpdir(), "lainos-crm-"));

// ------------------------------------------------------------- fake world

const wishes = [
  { id: "w1", title: "old wish", reporter: "tg:someone", status: "open", createdAt: 1 },
];
const trades = [
  { ts: 2, side: "sell", token: "0x", symbol: "MINE", qtyWei: "1", nativeWei: "1", txHash: "0xold" },
];

/** The forge's subscriber, held in an object so TS does not narrow it away. */
const forgeStream: { fn: ((event: unknown) => void) | null } = { fn: null };

function runtime(settings: Record<string, string | undefined>): IAgentRuntime {
  const services: Record<string, unknown> = {
    forge: {
      listWishes: () => wishes,
      onEvent: (fn: (event: unknown) => void) => {
        forgeStream.fn = fn;
        return () => {
          forgeStream.fn = null;
        };
      },
    },
    chain: { journal: { recentTrades: () => trades } },
  };
  return {
    getSetting: (key: string) => settings[key],
    getService: (name: string) => services[name],
  } as unknown as IAgentRuntime;
}

// --------------------------------------------------------------- receiver

let status = 200;
const filed: Record<string, unknown>[] = [];
let unauthorized = 0;

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    if (req.headers["x-crm-token"] !== "secret") {
      unauthorized += 1;
      res.writeHead(404).end("{}");
      return;
    }
    if (status === 200) filed.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(status, { "content-type": "application/json" }).end("{}");
  });
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/crm/tasks`;

// ------------------------------------------------------------------- off

const off = new CrmService();
await off.start(runtime({ LAINOS_DATA_DIR: join(tmp, "off") }));
check("no url means off            ", off.enabled === false);
check(
  "and off files nothing        ",
  (await off.record({ kind: "note", key: "1", title: "x" })) === false,
);
await off.stop();

// ------------------------------------------------------- first run adopts

const dataDir = join(tmp, "on");
const settings = {
  LAINOS_DATA_DIR: dataDir,
  LAINOS_CRM_URL: url,
  LAINOS_CRM_TOKEN: "secret",
  LAINOS_CRM_INTERVAL_MS: "60000",
};
const crm = new CrmService();
await crm.start(runtime(settings));
await crm.tick();
check("wired up when url is set    ", crm.enabled === true);
check("first run files no history  ", filed.length === 0);

// --------------------------------------------------------- one real record

await crm.record({ kind: "alert", key: "a7", title: "ETH below 5", priority: "high" });
await crm.flush();
check("a record lands              ", filed.length === 1);
check("the id is namespaced        ", filed[0]?.id === "lainos:alert:a7");
check("open unless said otherwise  ", filed[0]?.status === "open");
check("and carries when it happened", typeof filed[0]?.at === "string");

// the same event twice is one record
await crm.record({ kind: "alert", key: "a7", title: "ETH below 5" });
await crm.flush();
check("the same event files once   ", filed.length === 1);

// a new wish appears on the board between sweeps
wishes.push({ id: "w2", title: "new wish", reporter: "tg:alice", status: "open", createdAt: 3 });
await crm.tick();
check("a new wish is swept up      ", filed.some((r) => r.id === "lainos:wish:w2"));
check("an old one still is not     ", !filed.some((r) => r.id === "lainos:wish:w1"));

// a finished forge job arrives as a stream event, already done
forgeStream.fn?.({
  kind: "job_finished",
  text: "filed wish w2",
  job: { id: "j9", status: "ok", endedAt: 4, summary: "ok" },
});
await crm.flush();
const job = filed.find((r) => r.id === "lainos:forge:j9");
check("a finished job is a log line", job?.status === "done");

// ------------------------------------------------------------- an outage

status = 500;
await crm.record({ kind: "note", key: "n1", title: "during the outage" });
await crm.flush();
check("a failed delivery is kept   ", crm.status().pending === 1);

// ...and a restart in the middle of it loses nothing
await crm.stop();
const stored = JSON.parse(await readFile(join(dataDir, "crm.json"), "utf8"));
check("the outbox is on disk       ", stored.pending?.[0]?.id === "lainos:note:n1");

const restarted = new CrmService();
await restarted.start(runtime(settings));
status = 200;
await restarted.flush();
check("and lands after the outage  ", filed.some((r) => r.id === "lainos:note:n1"));
check("with the queue drained      ", restarted.status().pending === 0);

// --------------------------------------------- a record it will not accept

status = 422;
await restarted.record({ kind: "note", key: "bad", title: "unreadable" });
await restarted.flush();
check("a refused record is dropped ", restarted.status().pending === 0);

status = 200;
await restarted.record({ kind: "note", key: "n2", title: "next one" });
await restarted.flush();
check("so the queue is not wedged  ", filed.some((r) => r.id === "lainos:note:n2"));

// ------------------------------------------------------------ wrong token

const wrong = new CrmService();
await wrong.start(runtime({ ...settings, LAINOS_DATA_DIR: join(tmp, "wrong"), LAINOS_CRM_TOKEN: "nope" }));
await wrong.record({ kind: "note", key: "z", title: "won't go through" });
await wrong.flush();
check("a 404 is retried, not lost  ", wrong.status().pending === 1 && unauthorized > 0);
await wrong.stop();

await restarted.stop();
server.close();
await rm(tmp, { recursive: true, force: true });

// ------------------------------------------------------------------ report

let failed = 0;
for (const [name, pass] of results) {
  if (!pass) failed += 1;
  console.log(`${name.padEnd(30)}: ${pass ? "PASS" : "FAIL"}`);
}
console.log(failed ? `CRM PROBE FAILED (${failed})` : "CRM PROBE OK");
process.exit(failed ? 1 : 0);
