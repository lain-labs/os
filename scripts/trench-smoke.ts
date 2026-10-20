#!/usr/bin/env -S npx tsx
/**
 * Paper trenching smoke test (offline — no RPC, controlled curve states).
 *
 * Pinned here:
 *   1. the PONS curve math: a buy pays the 1 % fee and the creator tax, a sell
 *      back at the same state returns about 2 % less, and price is (P + Q) / T;
 *   2. every exit of an open position: half off at the take-profit, the rest on
 *      the trailing stop; the stop-loss; the time limit; graduation at the last
 *      mark; and an unreadable curve (an RPC hiccup) closes nothing;
 *   3. the fills land in the Robinhood paper account — cash and journal agree.
 *
 * Run: npm run trench:smoke
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaperDesk } from "../src/plugins/chain/paper.js";
import { buyOut, netIn, sellOut, spotPrice, withOwn, type CurveState } from "../src/plugins/trench/pons.js";
import { TrenchService } from "../src/plugins/trench/engine.js";

let checks = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  checks += 1;
  if (!ok) failed += 1;
  console.log(`${ok ? "✓" : "✗"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
};

const E = 10n ** 18n;
const state = (quote: bigint, tokens: bigint): CurveState => ({
  curve: "0xc0" as never,
  token: "0x70" as never,
  pairToken: "0x0000000000000000000000000000000000000000" as never,
  quote,
  tokens,
  phantom: (168n * E) / 100n,
  threshold: (42n * E) / 10n,
});

// 1. math
const s0 = state(E / 2n, 800_000_000n * E);
const spend = (2n * E) / 100n;
const got = buyOut(s0, spend, 0);
const back = sellOut(withOwn(s0, got, netIn(spend, 0)), got, 0);
const loss = Number(((spend - back) * 10_000n) / spend) / 100;
check("a round trip with no market move costs the two fees (~2%)", loss > 1.9 && loss < 2.1, `${loss}%`);
const naive = sellOut(s0, got, 0);
check("marking against the untouched curve would charge our impact twice", naive < back);
check("creator tax shrinks the fill", buyOut(s0, spend, 500) < got);
check("spot price is (P + Q) / T", spotPrice(s0) === ((s0.phantom + s0.quote) * E) / s0.tokens);

// 2. exits, against a stub chain whose only real part is the paper desk
const dataDir = mkdtempSync(join(tmpdir(), "lainos-trench-"));
const desk = new PaperDesk(join(dataDir, "paper"), E, false);
await desk.load();
const chain = {
  configured: true,
  chain: { id: 4663, name: "Robinhood Chain" },
  paper: desk,
  registerVenue: () => () => {},
};
const settings: Record<string, string> = { LAINOS_DATA_DIR: dataDir, LAINOS_TRENCH_INTERVAL_MS: "3600000" };
const runtime = {
  getSetting: (k: string) => settings[k],
  getService: (n: string) => (n === "chain" ? chain : undefined),
} as never;
const trench = new TrenchService();
await trench.start(runtime);
const t = trench as unknown as {
  enter: (c: unknown, s: CurveState, sym: string, rules: unknown, book: unknown) => Promise<void>;
  walk: (pos: unknown, s: CurveState | undefined, rules: unknown) => Promise<void>;
  completed: Set<string>;
};
const book = await desk.account(4663);
const rules = { ...trench.rules, takeProfitPct: 100, trailPct: 25, stopLossPct: 30, maxHoldMin: 45 };
const open = async (curve: string, token: string, s: CurveState) => {
  await t.enter({ curve, token, buys: 10, buyers: 8, inflow: E / 5n, ageMin: 3, taxBps: 0 }, { ...s, curve: curve as never }, token.toUpperCase(), rules, book);
  return trench.positions.find((p) => p.curve === curve)!;
};

// take-profit, then trail
const tp = await open("0xc1", "0xa1", s0);
check("an entry books into the paper account", book.cashWei === E - spend && book.holding("0xa1") > 0n);
const pumped = state(3n * E, 400_000_000n * E); // price ×4
await t.walk(tp, pumped, rules);
check("take-profit sells half and keeps trailing", tp.tpDone && BigInt(tp.qty) > 0n && trench.positions.includes(tp));
const higher = state((7n * E) / 2n, 380_000_000n * E);
await t.walk(tp, higher, rules);
check("a new high only raises the peak", trench.positions.includes(tp));
const faded = state(E, 400_000_000n * E); // well over 25% off the high
await t.walk(tp, faded, rules);
const tpClosed = trench.closed.find((c) => c.token === "0xa1");
check("the trailing stop closes the rest", !trench.positions.includes(tp) && tpClosed?.reason.startsWith("trailing") === true);
check("a 4× pump then a fade is still a win", (tpClosed?.pnlPct ?? 0) > 50, `${tpClosed?.pnlPct}%`);

// stop-loss
const sl = await open("0xc2", "0xa2", s0);
// the virtual reserve floors the price: only a curve drained back near empty is a −30% dump
await t.walk(sl, state(0n, 990_000_000n * E), rules);
const slClosed = trench.closed.find((c) => c.token === "0xa2");
check("the stop-loss closes a dump", slClosed?.reason.startsWith("stop-loss") === true && (slClosed?.pnlPct ?? 0) < -30);

// time exit
const slow = await open("0xc3", "0xa3", s0);
slow.openedAt = Date.now() - 50 * 60_000;
await t.walk(slow, s0, rules);
check("a flat position leaves at the time limit", trench.closed.find((c) => c.token === "0xa3")?.reason.startsWith("time exit") === true);

// an unreadable curve closes nothing; a graduated one closes at its last mark
const grad = await open("0xc4", "0xa4", s0);
await t.walk(grad, undefined, rules);
check("an RPC hiccup closes nothing", trench.positions.includes(grad));
const mark = BigInt(grad.markValue);
t.completed.add("0xc4");
await t.walk(grad, undefined, rules);
const gradClosed = trench.closed.find((c) => c.token === "0xa4");
check("graduation closes at the last curve mark", gradClosed?.reason.startsWith("graduated") === true && BigInt(gradClosed.proceeds) === mark);

// 3. the paper account agrees with the ledger
const proceeds = trench.closed.reduce((sum, c) => sum + BigInt(c.proceeds), 0n);
const spentAll = trench.closed.reduce((sum, c) => sum + BigInt(c.spent), 0n);
check("paper cash = start − spent + proceeds", book.cashWei === E - spentAll + proceeds, `${book.cashWei}`);
check("nothing left in the paper journal", book.journal.positions().length === 0);

await trench.stop();
console.log(`\ntrench smoke ${failed ? `FAILED (${failed}/${checks})` : `ok (${checks} checks)`}`);
process.exit(failed ? 1 : 0);
