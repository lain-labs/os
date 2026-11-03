#!/usr/bin/env -S npx tsx
/**
 * Paper desk smoke test (offline — stand-in GeckoTerminal/Kraken, a clock that
 * moves on demand, no network).
 *
 * Pinned here:
 *   1. bars: an hour nobody traded is a flat bar, every bar opens at the last
 *      close, an hour is written only once settled and never again, history is
 *      paged back past a short page, and a liquid pool that goes silent waits
 *      instead of being filled flat;
 *   2. the desk opens every market with the preset its backtest ranks first;
 *   3. its fills are the backtest engine's fills over the same bars, each one
 *      announced once — a restart announces nothing again;
 *   4. a signal on the last closed bar fills at once, at that bar's close;
 *   5. a strategy change sells at the last close and carries the dollars over;
 *   6. the report and Lain's line say what the books say;
 *   7. existing CYBER.sol sleeves are retired and their value transferred;
 *   8. nothing in the desk can reach a wallet, a signer or an order.
 *
 * Run: npm run desk:smoke
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileStrategies, simulate } from "../src/plugins/backtest/engine.js";
import { PaperDeskService, type DeskEvent } from "../src/plugins/desk/index.js";
import { handover, newState, replaySleeve, saveState, type Sleeve } from "../src/plugins/desk/book.js";
import { HOUR, loadBars, MARKET_IDS, MARKETS, SETTLE_MS, toSeries, type MarketEnv } from "../src/plugins/desk/markets.js";

let checks = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  checks += 1;
  if (!ok) failed += 1;
  console.log(`${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : `\n    ${detail.slice(0, 400)}`}`);
};

// Stand-in market APIs: hourly [sec, o, h, l, c, v] for each pool or spot pair.
const T0 = Date.UTC(2026, 6, 1);
let clock = T0 + 400 * HOUR + 15 * 60_000;
const quiet = new Set<number>();
const pools = new Map<string, (t: number) => number | null>();
for (const id of MARKET_IDS) {
  const k = MARKET_IDS.indexOf(id);
  pools.set(MARKETS[id].pool, (t) => {
    const h = (t - T0) / HOUR;
    // The LAIN pool skips every fifth hour; Kraken's XMR spot pair does not.
    if (id === "LAIN" && h % 5 === 4) return null;
    if (quiet.has(t)) return null;
    return 100 * (k + 1) * (1 + 0.2 * Math.sin(h / (9 + k)) + 0.0004 * h);
  });
}
let requests = 0;
const fakeFetch: MarketEnv["fetch"] = async (url) => {
  requests += 1;
  const u = new URL(url);
  const kraken = u.hostname === "api.kraken.com";
  const pool = kraken ? u.searchParams.get("pair")! : u.pathname.split("/pools/")[1]!.split("/")[0]!;
  const price = pools.get(pool)!;
  const before = u.searchParams.get("before_timestamp");
  const end = before ? Number(before) * 1000 - HOUR : Math.floor(clock / HOUR) * HOUR;
  const list: number[][] = [];
  // Kraken returns at most 720 hours and the current, unfinished hour.
  // GeckoTerminal is paged here in windows of 300 hours.
  const limit = kraken ? 720 : 300;
  for (let t = end; t >= T0 && t > end - limit * HOUR; t -= HOUR) {
    const c = price(t);
    if (c !== null) list.push([t / 1000, c * 0.999, c * 1.01, c * 0.99, c, 1000]);
  }
  if (kraken) {
    return new Response(JSON.stringify({
      error: [],
      result: { XXMRZUSD: list.reverse().map(([t, o, h, l, c, v]) => [t, String(o), String(h), String(l), String(c), String(c), String((v ?? 0) / (c ?? 1)), 10]), last: end / 1000 },
    }), { status: 200 });
  }
  return new Response(JSON.stringify({ data: { attributes: { ohlcv_list: list } } }), { status: 200 });
};
const env = (dir: string): MarketEnv => ({ fetch: fakeFetch, dir, now: () => clock, sleep: async () => {} });

// 1. bars
const barDir = mkdtempSync(join(tmpdir(), "lainos-desk-bars-"));
const lain = await loadBars(MARKETS.LAIN, env(barDir));
const lastClosed = Math.floor((clock - SETTLE_MS) / HOUR) * HOUR - HOUR;
const gapless = lain.every((b, i) => i === 0 || b[0] - lain[i - 1]![0] === HOUR);
check("history is paged back past a short page", lain[0]![0] === T0 && requests >= 2, `${new Date(lain[0]![0]).toISOString()} after ${requests} requests`);
check("one bar an hour, up to the last settled hour", gapless && lain.at(-1)![0] === lastClosed);
const flat = lain.find((b) => ((b[0] - T0) / HOUR) % 5 === 4)!;
check("an hour nobody traded is flat at the last close, with no volume", flat[1] === flat[4] && flat[2] === flat[4] && flat[5] === 0);
check("every bar opens where the last one closed", lain.every((b, i) => i === 0 || b[1] === lain[i - 1]![4]));
const before = requests;
const again = await loadBars(MARKETS.LAIN, env(barDir));
check("a settled cache is read without a request", requests === before && again.length === lain.length);
clock += HOUR;
const first = lain.at(-1)!.slice();
const more = await loadBars(MARKETS.LAIN, env(barDir));
check("the next hour adds one bar and rewrites none", more.length === lain.length + 1 && JSON.stringify(more[lain.length - 1]) === JSON.stringify(first));
const live = toSeries(MARKETS.LAIN, more, true);
check("the live bar stands at the last close", live.t.length === more.length + 1 && live.open[live.t.length - 1] === more.at(-1)![4] && live.high[live.t.length - 1] === more.at(-1)![4]);
// ETH goes silent for three hours: the indexer is behind, so nothing past its last bar is written.
const ethDir = mkdtempSync(join(tmpdir(), "lainos-desk-eth-"));
const eth0 = await loadBars(MARKETS.ETH, env(ethDir));
for (let t = eth0.at(-1)![0] + HOUR; t < eth0.at(-1)![0] + 5 * HOUR; t += HOUR) quiet.add(t);
clock += 3 * HOUR;
const eth1 = await loadBars(MARKETS.ETH, env(ethDir));
check("a liquid pool gone silent waits for its indexer", eth1.length === eth0.length);
quiet.clear();
clock -= 3 * HOUR;

const xmrDir = mkdtempSync(join(tmpdir(), "lainos-desk-xmr-"));
const xmr = await loadBars(MARKETS.XMR, env(xmrDir));
check("Monero uses Kraken spot XMR/USD, not a wrapped token", xmr.length >= 60 && toSeries(MARKETS.XMR, xmr).stretches[0]?.source === "kraken");
check("Kraken's unfinished hour is excluded", xmr.at(-1)![0] === Math.floor((clock - SETTLE_MS) / HOUR) * HOUR - HOUR);
const beforeXmrCache = requests;
await loadBars(MARKETS.XMR, env(xmrDir));
check("settled XMR history is cached", requests === beforeXmrCache);
clock += 800 * HOUR;
const gapRejected = await loadBars(MARKETS.XMR, env(xmrDir)).then(() => false, (e: Error) => /720-bar window/.test(e.message));
check("a >30-day Kraken gap is refused, never invented as flat bars", gapRejected);
clock -= 800 * HOUR;

// 2–3. the desk opens, fills are the engine's, announced once
const deskDir = mkdtempSync(join(tmpdir(), "lainos-desk-"));
const events: DeskEvent[] = [];
const desk = new PaperDeskService({ fetch: fakeFetch, now: () => clock, sleep: async () => {} });
await desk.open(deskDir);
desk.onEvent((e) => events.push(e));
await desk.check();
const state = () => JSON.parse(readFileSync(join(deskDir, "state.json"), "utf8"));
const opened = events.find((e) => e.kind === "opened");
check("the desk opens every market with a backtested preset", Boolean(opened) && MARKET_IDS.every((id) => state().sleeves[id]?.segments.length === 1), opened?.text);
check("the opening says what each strategy did in its backtest", MARKET_IDS.every((id) => opened!.text.includes(`${id} — `)) && /vs holding/.test(opened!.text));
check("$20 a market, nothing traded yet", MARKET_IDS.every((id) => state().sleeves[id].budgetUsd === 20) && !events.some((e) => e.kind === "fill"));
for (let h = 0; h < 72; h++) {
  clock += HOUR;
  await desk.check();
}
const fills = events.filter((e) => e.kind === "fill");
check("three days of hours bring fills", fills.length > 0, `${fills.length} fills`);
check("each fill announced once", new Set(state().announced).size === state().announced.length && fills.length === state().announced.length);
// The same fills, straight from the engine over the same bars.
const id = MARKET_IDS.find((m) => fills.some((f) => f.market === m))!;
const seg = state().sleeves[id].segments[0];
const bars = JSON.parse(readFileSync(join(deskDir, "market", `${id.toLowerCase()}.json`), "utf8")).bars;
const s = toSeries(MARKETS[id], bars, true);
const c = compileStrategies([seg.spec]).compiled[0]!;
const engine = simulate(s, s.t.findIndex((t) => t >= seg.from), c.entry.run(s, new Map()), c.exit?.run(s, new Map()) ?? null, seg.spec, MARKETS[id].costs);
const engineFills = engine.trades.flatMap((t) => [t.entryAt, ...(t.exitAt === null ? [] : [t.exitAt])]).length;
check("a market's fills are the backtest engine's over the same bars", fills.filter((f) => f.market === id).length === engineFills, `${id}: desk ${fills.filter((f) => f.market === id).length}, engine ${engineFills}`);
const restarted = new PaperDeskService({ fetch: fakeFetch, now: () => clock, sleep: async () => {} });
await restarted.open(deskDir);
const after: DeskEvent[] = [];
restarted.onEvent((e) => after.push(e));
await restarted.check();
check("a restart announces nothing again", !after.some((e) => e.kind === "fill" || e.kind === "opened"), after.map((e) => e.text).join(" | "));

// 4. a signal on the last closed bar fills now, at its close
const buy = fills.find((f) => /BUY/.test(f.text));
const lastBuy = engine.trades.at(-1)!;
const buyBar = s.t.indexOf(lastBuy.entryAt);
check("an entry fills at the open after its signal — the signal bar's close", buyBar > 0 && Math.abs(lastBuy.entryPx / (s.close[buyBar - 1]! * (1 + MARKETS[id].costs.slippagePct / 100)) - 1) < 1e-9 && Boolean(buy));

// 5. a strategy change
const valueBefore = restarted.statusText();
const switched = await restarted.setStrategy("ETH", { name: "always_in", entry: "close > 0" }, "smoke");
const eth = state().sleeves.ETH;
check("a change starts the new strategy on the next hour", eth.segments.length === 2 && eth.segments[1].from === eth.segments[0].until + HOUR);
check("it carries the dollars over, less the cost of selling a position", eth.segments[1].startUsd <= eth.segments[0].endUsd + 1e-9 && /now trades always_in/.test(switched), switched);
clock += HOUR;
const swEvents: DeskEvent[] = [];
restarted.onEvent((e) => swEvents.push(e));
await restarted.check();
check("the new strategy trades from there", swEvents.some((e) => e.kind === "fill" && e.market === "ETH" && /BUY ETH/.test(e.text)), swEvents.map((e) => e.text).join(" | "));
check("status shows the strategy and why", /always_in/.test(restarted.statusText()) && /why this strategy: smoke/.test(restarted.statusText()) && valueBefore.length > 0);

// 6. report and Lain's line
const report = await restarted.report();
check("the report: balance, result vs holding, biggest mistake, every market", /Balance: \$\d+\.\d\d \(fake\)/.test(report) && /holding all five instead/.test(report) && /Biggest mistake: /.test(report) && MARKET_IDS.every((m) => report.includes(`${m}: `)), report);
check("the report says it is paper", /no orders sent/.test(report));
const line = restarted.summaryLine();
check("Lain's line names the desk and sends her to paper_desk", /paper desk/.test(line) && /paper_desk/.test(line) && /\$\d+\.\d\d/.test(line), line);

// 7. old CYBER.sol state transfers its marked value to XMR, without new dollars.
const legacyDir = mkdtempSync(join(tmpdir(), "lainos-desk-legacy-"));
mkdirSync(join(legacyDir, "market"), { recursive: true });
writeFileSync(join(legacyDir, "market", "cyber.json"), JSON.stringify({ bars: more }));
const old = newState(clock);
old.sleeves.CYBER = {
  market: "CYBER",
  budgetUsd: 20,
  startPx: more[0]![4],
  segments: [{ spec: { name: "hold", entry: "close > 0" }, from: more[1]![0], startUsd: 20, why: "legacy" }],
  error: "",
};
const prior = replaySleeve(old.sleeves.CYBER as unknown as Sleeve, toSeries(MARKETS.XMR, more, true), { feePct: 0.3, slippagePct: 0.25 });
const proceeds = handover(prior, { feePct: 0.3, slippagePct: 0.25 }).endUsd;
await saveState(legacyDir, old);
const migrated = new PaperDeskService({ fetch: fakeFetch, now: () => clock, sleep: async () => {} });
await migrated.open(legacyDir);
await migrated.check();
const migratedState = JSON.parse(readFileSync(join(legacyDir, "state.json"), "utf8"));
check("CYBER is retired, and XMR starts with its marked proceeds", !migratedState.sleeves.CYBER && !!migratedState.retired?.CYBER && Math.abs(migratedState.sleeves.XMR.segments[0].startUsd - proceeds) < 1e-8);
await migrated.check();
check("migrating twice never creates more virtual dollars", !migratedState.sleeves.CYBER && migratedState.sleeves.XMR.segments[0].startUsd === JSON.parse(readFileSync(join(legacyDir, "state.json"), "utf8")).sleeves.XMR.segments[0].startUsd);

// 8. no order path
const src = readdirSync(join(import.meta.dirname, "../src/plugins/desk")).map((f) => readFileSync(join(import.meta.dirname, "../src/plugins/desk", f), "utf8")).join("\n");
const imports = [...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1]!);
check("the desk imports no chain, wallet or signer", imports.every((m) => !/chain|wallet|metamask|viem|trader|stocks|signer/.test(m)), imports.join(", "));

if (process.env.DESK_SMOKE_SHOW) console.log(["", fills[0]?.text, fills.find((f) => /SELL/.test(f.text))?.text, switched, report, line, restarted.statusText()].join("\n\n"));
console.log(`\ndesk smoke ${failed ? `FAILED (${failed}/${checks})` : `ok (${checks} checks)`}`);
process.exit(failed ? 1 : 0);
