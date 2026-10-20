import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, appendFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPaper } from "../skills/sma50_paper.mjs";

const STEP = 4 * 3_600_000;
const NOW = Date.parse("2026-10-19T08:00:30Z"); // 11:00 Moscow.
const CUTOFF = Math.floor(NOW / STEP) * STEP;
const root = await mkdtemp(join(tmpdir(), "lainos-sma50-"));
const dir = join(root, "sma50-paper-wish14");
const stored = [];
const routines = {
  active: true,
  async list() { return structuredClone(stored); },
  async add(r) { stored.push({ ...r, id: `r${stored.length + 1}` }); },
};
const runtime = {
  getSetting(key) { assert.equal(key, "LAINOS_DATA_DIR"); return root; },
  getService(name) { assert.equal(name, "routines"); return routines; },
};
const state = { roomId: "tg-42", message: { userId: "tester" } };
let requests = 0;
let cutoff = CUTOFF;
let sol = [90, 90];
let eth = [100, 100];
function candles(tail, end = cutoff) {
  return Array.from({ length: 60 }, (_, i) => {
    const start = end - (60 - i) * STEP;
    const price = i < 58 ? 100 : tail[i - 58];
    return [start, "100", "100", "100", String(price), "1", start + STEP - 1];
  });
}
const feed = async (input) => {
  requests++;
  const url = new URL(input);
  assert.equal(url.origin, "https://data-api.binance.vision");
  assert.equal(url.pathname, "/api/v3/klines");
  assert.equal(url.searchParams.get("interval"), "4h");
  assert.equal(url.searchParams.get("limit"), "61");
  assert.equal(url.searchParams.get("endTime"), String(cutoff - 1));
  const symbol = url.searchParams.get("symbol");
  assert.ok(["SOLUSDC", "ETHUSDC"].includes(symbol));
  const rows = candles(symbol === "SOLUSDC" ? sol : eth);
  // A deliberately extreme forming close must never enter the signal.
  rows.push([cutoff, "1", "1", "1", "99999999", "1", cutoff + STEP - 1]);
  return rows;
};
const run = (mode, now = NOW, fetchJson = feed) => runPaper(runtime, state, { mode }, { now, fetchJson });
const json = async (file) => JSON.parse(await readFile(join(dir, file), "utf8"));
const journal = async () => (await readFile(join(dir, "trades.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
const closeTo = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);

try {
  // A missing setup cannot silently seed a portfolio.
  assert.equal((await run("check")).ok, false);
  assert.equal(requests, 0);
  const first = await run("setup");
  assert.equal(first.ok, true, first.text);
  assert.equal(first.data.launched, true);
  assert.equal(stored.length, 7);
  assert.deepEqual(stored.map((r) => r.trigger.at), ["03:00", "07:00", "11:00", "15:00", "19:00", "23:00", "23:05"]);
  assert.ok(stored.every((r) => r.trigger.timeZone === "Europe/Moscow" && r.chatId === 42));
  const initial = await json("state.json");
  closeTo(initial.balances.SOL.usdc, 90 * 0.997);
  assert.equal(initial.balances.SOL.coin, 0);
  assert.deepEqual(initial.balances.ETH, { coin: 1, usdc: 0 });
  assert.equal(initial.tradeCount, 1);
  let trades = await journal();
  assert.equal(trades[0].action, "sell");
  assert.equal(trades[0].time, new Date(CUTOFF).toISOString());
  closeTo(trades[0].sma50, 99.6);
  assert.deepEqual(Object.keys(trades[0]), ["time", "asset", "action", "price", "sma50", "amount_in", "amount_out", "holding_after"]);
  assert.equal(trades[0].amount_in, 1);
  assert.deepEqual(trades[0].holding_after, { SOL: 0, USDC: 89.73 });

  // Hot reload and concurrent calls must not re-fetch or repeat a candle.
  const fresh = await import(`../skills/sma50_paper.mjs?restart=${Date.now()}`);
  const repeats = await Promise.all([run("check"), fresh.runPaper(runtime, state, { mode: "check" }, { now: NOW, fetchJson: feed })]);
  assert.ok(repeats.every((r) => r.ok && r.data.tradeCount === 1));
  assert.equal(requests, 2);
  assert.equal((await run("setup")).ok, true);
  assert.equal(stored.length, 7);
  assert.equal(requests, 2);

  // A canonical commit with missing exports models a crash between files.
  await rm(join(dir, "state.json"));
  await writeFile(join(dir, "trades.jsonl"), "");
  await appendFile(join(dir, "checks.jsonl"), '{"torn":');
  assert.equal((await run("check")).ok, true);
  assert.deepEqual(await json("state.json"), initial);
  assert.equal((await journal()).length, 1);
  assert.ok((await readFile(join(dir, "checks.jsonl"), "utf8")).endsWith("\n"));
  assert.equal(requests, 2);
  // A torn trade projection must be completed without appending a duplicate.
  const firstTradeLine = await readFile(join(dir, "trades.jsonl"), "utf8");
  await writeFile(join(dir, "trades.jsonl"), firstTradeLine.slice(0, 40));
  assert.equal((await run("status")).ok, true);
  assert.equal(await readFile(join(dir, "trades.jsonl"), "utf8"), firstTradeLine);

  cutoff += STEP;
  sol = [110, 110];
  eth = [90, 90];
  const second = await run("check", NOW + STEP);
  assert.equal(second.ok, true, second.text);
  closeTo(second.data.balances.SOL.coin, 89.73 / 110 * 0.997);
  assert.equal(second.data.balances.SOL.usdc, 0);
  closeTo(second.data.balances.ETH.usdc, 89.73);
  assert.equal(second.data.tradeCount, 3);
  trades = await journal();
  assert.equal(trades[1].action, "buy");
  closeTo(trades[1].amount_in, 89.73);
  closeTo(trades[1].amount_out, 89.73 / 110 * 0.997);

  // One close across the SMA, or equality, is a hold. No shared USDC funding.
  cutoff += STEP;
  sol = [90, 110];
  eth = [100, 100];
  const hold = await run("check", NOW + 2 * STEP);
  assert.equal(hold.ok, true, hold.text);
  assert.equal(hold.data.tradeCount, 3);
  assert.deepEqual(hold.data.balances, second.data.balances);
  const report = await run("report", NOW + 2 * STEP);
  assert.match(report.text, /hold benchmark 1 SOL/);
  assert.match(report.text, /hold benchmark 1 ETH/);
  assert.match(report.text, /Total trades: 3/);
  assert.equal((await run("report", NOW + 3 * STEP)).ok, false);

  // Fail closed on short, stale, gapped, duplicate, disordered or invalid data.
  cutoff += STEP;
  const before = await readFile(join(dir, "checks.jsonl"), "utf8");
  for (const mutate of [
    (rows) => rows.slice(1),
    () => candles([90, 90], cutoff - STEP),
    (rows) => rows.filter((_, i) => i !== 30),
    (rows) => [...rows, rows.at(-1)],
    (rows) => rows.toReversed(),
    (rows) => rows.map((r, i) => i === 59 ? [...r.slice(0, 4), "NaN", ...r.slice(5)] : r),
  ]) {
    const bad = await run("check", NOW + 3 * STEP, async () => mutate(candles([90, 90])));
    assert.equal(bad.ok, false, bad.text);
    assert.equal(await readFile(join(dir, "checks.jsonl"), "utf8"), before);
  }
  const partial = await run("check", NOW + 3 * STEP, async (url) => {
    if (url.includes("ETHUSDC")) throw new Error("feed unavailable");
    return candles([90, 90]);
  });
  assert.equal(partial.ok, false);
  assert.equal(await readFile(join(dir, "checks.jsonl"), "utf8"), before);
  assert.equal((await journal()).length, 3);

  // Each close is compared to the SMA as of that candle, without lookahead.
  const tricky = Array(60).fill(100);
  tricky[9] = 200;
  tricky[58] = 101;
  tricky[59] = 103;
  const ownSma = await run("check", NOW + 3 * STEP, async () => candles([100, 100]).map((r, i) => {
    r[4] = String(tricky[i]); return r;
  }));
  assert.equal(ownSma.ok, true, ownSma.text);
  // ETH holds USDC: its previous close 101 < its previous SMA 102.02,
  // even though it is above the current SMA 100.08. It must not buy.
  assert.equal(ownSma.data.balances.ETH.coin, 0);
  assert.equal(ownSma.data.tradeCount, 3);

  // A complete malformed log fails closed; never reset a portfolio.
  const goodLog = await readFile(join(dir, "checks.jsonl"), "utf8");
  await appendFile(join(dir, "checks.jsonl"), "bad complete record\n");
  assert.equal((await run("check", NOW + 4 * STEP)).ok, false);
  await writeFile(join(dir, "checks.jsonl"), goodLog);
  assert.equal((await runPaper(runtime, state, { mode: "check", price: 1 })).ok, false);

  // Setup stores schedules during an outage but never calls it a launch.
  const offline = await mkdtemp(join(tmpdir(), "lainos-sma50-offline-"));
  try {
    const r = await runPaper({ ...runtime, getSetting: () => offline }, state, { mode: "setup" },
      { now: NOW, fetchJson: async () => { throw new Error("offline"); } });
    assert.equal(r.ok, false);
    assert.equal(r.data.launched, false);
    assert.match(r.text, /Launch is not confirmed/);
  } finally { await rm(offline, { recursive: true, force: true }); }
  routines.active = false;
  const inactive = await run("setup", NOW + 3 * STEP);
  assert.equal(inactive.ok, true);
  assert.equal(inactive.data.launched, false);
  routines.active = true;

  // Two independent OS processes share the same kernel lock and commit log.
  cutoff += STEP;
  const childCode = `
    import {runPaper} from ${JSON.stringify(new URL("../skills/sma50_paper.mjs", import.meta.url).href)};
    const runtime={getSetting:()=>${JSON.stringify(root)},getService:()=>undefined};
    const r=await runPaper(runtime,{}, {mode:'check'}, {now:${NOW + 4 * STEP},fetchJson:async()=>${JSON.stringify(candles([90, 90]))}});
    if(!r.ok) throw new Error(r.text);
  `;
  const child = () => new Promise((done, fail) => {
    const p = spawn(process.execPath, ["--input-type=module", "-e", childCode], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (s) => { err += s; });
    p.once("error", fail);
    p.once("close", (code) => code === 0 ? done() : fail(new Error(err)));
  });
  await Promise.all([child(), child()]);
  const all = (await readFile(join(dir, "checks.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(all.filter((e) => e.state_after.lastCandleClose === cutoff).length, 1);
  const lastTrades = await journal();
  assert.equal(lastTrades.length, 4);
  assert.equal(new Set(lastTrades.map((t) => `${t.time}:${t.asset}`)).size, 4);
  // Killing a worker while it owns the lock releases the kernel lock without
  // a timeout, PID cleanup, or another trade/checkpoint for that candle.
  cutoff += STEP;
  const crashCode = `
    import {runPaper} from ${JSON.stringify(new URL("../skills/sma50_paper.mjs", import.meta.url).href)};
    import {writeFile} from 'node:fs/promises';
    const result=await runPaper({getSetting:()=>${JSON.stringify(root)},getService:()=>undefined},{},{mode:'check'},
      {now:${NOW + 5 * STEP},fetchJson:async()=>{await writeFile(${JSON.stringify(join(root, "holding"))},'holding');await new Promise(()=>{});}});
    if(!result.ok) throw new Error(result.text);
  `;
  await new Promise((done, fail) => {
    const p = spawn(process.execPath, ["--input-type=module", "-e", crashCode], { stdio: ["ignore", "ignore", "pipe"] });
    let locked = false;
    let errors = "";
    p.stderr.on("data", (s) => { errors += s; });
    const timer = setTimeout(() => { p.kill("SIGKILL"); fail(new Error(`Crash test did not acquire the lock: ${errors}`)); }, 5000);
    const poll = setInterval(async () => {
      if (await readFile(join(root, "holding"), "utf8").catch(() => null)) {
        locked = true;
        clearInterval(poll);
        p.kill("SIGKILL");
      }
    }, 20);
    p.once("error", fail);
    p.once("close", () => { clearTimeout(timer); clearInterval(poll); locked ? done() : fail(new Error(`Crash worker exited before acquiring the lock: ${errors}`)); });
  });
  await rm(join(root, "holding"));
  const afterCrash = await run("check", NOW + 5 * STEP);
  assert.equal(afterCrash.ok, true, afterCrash.text);
  assert.equal(afterCrash.data.tradeCount, 4);
  assert.deepEqual((await readdir(root)).sort(), ["sma50-paper-wish14"]);
  console.log("SMA50 paper smoke passed: isolation, fees, signals, closed bars, recovery, concurrent processes, setup and reports.");
} finally {
  await rm(root, { recursive: true, force: true });
}
