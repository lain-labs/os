#!/usr/bin/env -S npx tsx
/**
 * Sentinel activity + brief smoke test (headless, fake chain, fake model).
 *
 * Pinned here:
 *   1. a new watch starts at the head — no replay of a wallet's history;
 *   2. a self-initiated buy from zero is a new position; an airdrop is nothing;
 *   3. repeated buys of one token alert once as "building", not per buy;
 *   4. a cohort alerts when enough members buy the same token, once;
 *   5. a sell to zero is recorded as an exit;
 *   6. the brief marks moves in tokens the operator holds, stays silent on
 *      NOTHING, fires on schedule once a day and skips a badly late one;
 *   7. cursors and moves survive a restart.
 *
 * Run: npm run sentinel:smoke
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address } from "viem";
import { SentinelService, type Alert } from "../src/plugins/sentinel/index.js";
import type { ActivitySource, RawTransfer } from "../src/plugins/sentinel/activity.js";
import { briefMaterial } from "../src/plugins/sentinel/brief.js";
import type { IAgentRuntime } from "../src/types.js";

const results: [string, boolean][] = [];
const check = (name: string, pass: boolean) => results.push([name, pass]);

const tmp = await mkdtemp(join(tmpdir(), "lainos-sentinel-"));

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const W1 = addr(0xa1);
const W2 = addr(0xb2);
const W3 = addr(0xb3);
const W4 = addr(0xb4);
const STRANGER = addr(0xdead);
const POOL = addr(0x9001);
const TOKA = addr(0x7a);
const TOKB = addr(0x7b);
const TOKC = addr(0x7c);
const SYMBOLS: Record<string, string> = { [TOKA]: "TOKA", [TOKB]: "TOKB", [TOKC]: "TOKC" };

// ------------------------------------------------------------- fake chain

let head = 100n;
const transfers: RawTransfer[] = [];
const senders = new Map<string, Address>();
const balances = new Map<string, bigint>();
const balKey = (token: Address, wallet: Address) => `${token}:${wallet}`.toLowerCase();
let txn = 0;

/** `wallet` receives `value` of `token`; the tx is signed by `signer`. */
function receive(wallet: Address, token: Address, value: bigint, signer: Address = wallet): void {
  const tx = `0x${(++txn).toString(16).padStart(64, "0")}`;
  transfers.push({ token, from: POOL, to: wallet, value, tx, block: head });
  senders.set(tx, signer);
  balances.set(balKey(token, wallet), (balances.get(balKey(token, wallet)) ?? 0n) + value);
}

function send(wallet: Address, token: Address, value: bigint): void {
  const tx = `0x${(++txn).toString(16).padStart(64, "0")}`;
  transfers.push({ token, from: wallet, to: POOL, value, tx, block: head });
  senders.set(tx, wallet);
  balances.set(balKey(token, wallet), (balances.get(balKey(token, wallet)) ?? 0n) - value);
}

const source: ActivitySource = {
  head: async () => head,
  transfers: async (wallet, from, to) =>
    transfers.filter(
      (t) =>
        t.block >= from &&
        t.block <= to &&
        (t.to.toLowerCase() === wallet.toLowerCase() || t.from.toLowerCase() === wallet.toLowerCase()),
    ),
  txSender: async (hash) => senders.get(hash),
  balance: async (token, wallet) => ({
    raw: balances.get(balKey(token, wallet)) ?? 0n,
    decimals: 0,
    symbol: SYMBOLS[token] ?? "TOKEN",
  }),
  ignored: () => [],
};

// ------------------------------------------------------------- fake runtime

const modelReply = { text: "NOTHING" };
const prompts: string[] = [];

function runtime(): IAgentRuntime {
  const services: Record<string, unknown> = {
    chain: { configured: true, agentAddress: addr(0x5e1f), explorerTxUrl: () => undefined },
  };
  return {
    character: { name: "Lain" },
    getSetting: (key: string) => ({ LAINOS_DATA_DIR: tmp } as Record<string, string>)[key],
    getService: (name: string) => services[name],
    actions: [
      {
        name: "portfolio_pnl",
        handler: async () => ({
          ok: true,
          text: "Treasury: 1 ETH native + 0.5 ETH in 1 position.\nTOKA: 10 ≈ 0.5 ETH",
          data: { positions: [{ token: TOKA, symbol: "TOKA", valueNative: "0.5" }] },
        }),
      },
    ],
    model: {
      generate: async (req: { messages: { content: string }[] }) => {
        prompts.push(req.messages[0].content);
        return { text: modelReply.text };
      },
    },
  } as unknown as IAgentRuntime;
}

const svc = new SentinelService();
svc.activitySource = source;
await svc.start(runtime());
const alerts: Alert[] = [];
svc.onAlert((a) => alerts.push(a));

const HOUR = 3_600_000;
let now = Date.UTC(2026, 9, 5, 6, 0);
async function step(fn: () => void = () => {}): Promise<Alert[]> {
  head += 1n;
  now += 10 * 60_000;
  fn();
  const before = alerts.length;
  await svc.tick(now);
  return alerts.slice(before);
}

// 1. baseline
receive(W1, TOKB, 5n); // history before the watch: must never be reported
await svc.addWatch({ address: W1, kind: "position", note: "fund", minBuys: 3, windowMs: 24 * HOUR });
await svc.addWatch({
  address: W2,
  kind: "cohort",
  members: [W2, W3, W4],
  minWallets: 3,
  windowMs: 24 * HOUR,
  note: "the funds",
});
check("first tick only sets cursors", (await step()).length === 0);

// 2. new position vs airdrop
let fired = await step(() => receive(W1, TOKA, 10n));
check("buy from zero → new position alert", fired.length === 1 && /fund .*opened a new position: 10 TOKA/.test(fired[0].text));
check("airdrop is ignored", (await step(() => receive(W1, TOKC, 1_000n, STRANGER))).length === 0);

// 3. accumulation
check("second buy alone is quiet", (await step(() => receive(W1, TOKA, 5n))).length === 0);
fired = await step(() => receive(W1, TOKA, 5n));
check("third buy in window → building alert", fired.length === 1 && /keeps building TOKA: 3 buys in 24h, now holds 20/.test(fired[0].text));
check("fourth buy does not repeat it", (await step(() => receive(W1, TOKA, 5n))).length === 0);

// 4. convergence
check("one cohort buyer: quiet", (await step(() => receive(W2, TOKC, 1n))).length === 0);
check("two cohort buyers: quiet", (await step(() => receive(W3, TOKC, 1n))).length === 0);
fired = await step(() => receive(W4, TOKC, 1n));
check("three cohort buyers → convergence alert", fired.length === 1 && /3 of 3 wallets in the funds bought TOKC/.test(fired[0].text));
check("a repeat buy does not refire", (await step(() => receive(W2, TOKC, 1n))).length === 0);

// 5. exit
await step(() => send(W1, TOKA, 25n));
const exit = svc.recentMoves(24 * HOUR, now).find((m) => m.side === "sell");
check("sell to zero is recorded as an exit", exit?.fresh === true && exit.symbol === "TOKA");

// 6. brief
const material = briefMaterial({
  portfolioText: "TOKA: 10",
  positions: [{ token: TOKA, symbol: "TOKA", valueNative: 0.5 }],
  previous: { at: 0, positions: [{ token: TOKA, symbol: "TOKA", valueNative: 0.25 }] },
  moves: svc.recentMoves(24 * HOUR, now),
  alerts: [],
  labelFor: (w) => svc.labelFor(w),
});
check("brief marks moves in held tokens", /sold out of TOKA .*\[OPERATOR HOLDS THIS\]/.test(material ?? ""));
check("brief calls out a sharp position move", /TOKA: \+100\.0% in value since the last brief/.test(material ?? ""));
check(
  "empty day has no material",
  briefMaterial({ positions: [], moves: [], alerts: [], labelFor: String }) === null,
);
check("NOTHING from the model is silence", (await svc.composeBrief(now)) === null);

await svc.setBrief({ at: "08:00", note: "only what matters" });
const briefTick = (d: Date) => (svc as unknown as { briefTick(d: Date): Promise<void> }).briefTick(d);
modelReply.text = "fund dumped all its TOKA — you still hold 10.";
const morning = (h: number, m: number, day = 6) => new Date(2026, 9, day, h, m);
let before = alerts.length;
await briefTick(morning(7, 59));
check("not before its time", alerts.length === before);
await briefTick(morning(8, 1));
const brief = alerts.slice(before);
check("fires at its time as a brief", brief.length === 1 && brief[0].kind === "brief" && /dumped/.test(brief[0].text));
check("the operator's note reaches the model", prompts.at(-1)?.startsWith("The operator asked for: only what matters") === true);
before = alerts.length;
await briefTick(morning(9, 0));
check("once a day", alerts.length === before);
await briefTick(morning(13, 0, 7));
check("a brief 5h late waits for tomorrow", alerts.length === before && svc.briefSchedule()?.lastDay === "2026-10-07");
check("the brief keeps a snapshot for tomorrow", svc.briefSchedule()?.snapshot?.positions[0]?.symbol === "TOKA");

// 7. restart
await svc.stop();
const again = new SentinelService();
again.activitySource = source;
await again.start(runtime());
check("moves survive a restart", again.recentMoves(24 * HOUR, now).length === svc.recentMoves(24 * HOUR, now).length);
const quiet: Alert[] = [];
again.onAlert((a) => quiet.push(a));
head += 1n;
await again.tick(now + 60_000);
check("cursors survive a restart (no rescan, no repeats)", quiet.length === 0);
await again.stop();

await rm(tmp, { recursive: true, force: true });

let failed = 0;
for (const [name, pass] of results) {
  console.log(`${pass ? "✓" : "✗"} ${name}`);
  if (!pass) failed += 1;
}
if (failed) {
  console.error(`${failed} sentinel check(s) failed`);
  process.exit(1);
}
console.log(`sentinel smoke ok (${results.length} checks)`);
