#!/usr/bin/env -S npx tsx
/**
 * Backtest smoke test (offline — synthetic candles, a seeded cache, no network).
 *
 * Pinned here:
 *   1. the rule language: indicators against hand-computed values, x[n],
 *      crosses, nothing that can see a later bar, and errors that say what to write;
 *   2. fills: a signal at a close trades at the next open, fees and slippage
 *      are charged, stops fill inside the bar (at the open when it gaps through),
 *      the stop wins a bar that touches both, trailing stops and time exits;
 *   3. the numbers: drawdown, CAGR, Sharpe, win rate, the held-out split;
 *   4. sweeps: one variant per combination, named, capped;
 *   5. a whole run read from the candle cache, ranked and reported;
 *   6. on-chain history against a local JSON-RPC stub: windows the endpoint
 *      refuses are split, swap prices decoded from sqrtPriceX96, bars built
 *      from swaps (a quiet day is a flat bar), the cache read back without a
 *      second download, and any pool's tokens read from the chain;
 *   7. live runs against a stand-in desk: a strategy in the market joins at
 *      once, one out of it waits, the exit rule sells at the next close, a
 *      stop sells between closes, a position closed by hand leaves the run
 *      out, and the runs survive a restart.
 *
 * Run: npm run backtest:smoke
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileRule, type Market } from "../src/plugins/backtest/rules.js";
import { bitstampPair, normalizePair, type Series } from "../src/plugins/backtest/candles.js";
import { buyAndHold, expandStrategies, measure, PRESETS, runBacktest, simulate, type StrategySpec } from "../src/plugins/backtest/engine.js";
import { parseBacktestArgs, report } from "../src/plugins/backtest/index.js";
import { DEX_MARKETS, dexMarketFromPool, loadDexSeries } from "../src/plugins/backtest/dex.js";
import { LiveStrategyService, type LiveDesk } from "../src/plugins/backtest/live.js";

let checks = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  checks += 1;
  if (!ok) failed += 1;
  console.log(`${ok ? "✓" : "✗"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
};
const close = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
const throws = (f: () => unknown, re: RegExp) => {
  try {
    f();
    return false;
  } catch (err) {
    return re.test((err as Error).message);
  }
};

const DAY = 86_400_000;
/** A daily series from closes; open = previous close unless given, high/low just around the bar. */
function series(closes: number[], opts: { opens?: number[]; highs?: number[]; lows?: number[]; t0?: number } = {}): Series {
  const n = closes.length;
  const t0 = opts.t0 ?? Date.UTC(2020, 0, 1);
  const open = Float64Array.from(closes, (c, i) => opts.opens?.[i] ?? (i ? closes[i - 1]! : c));
  return {
    pair: "TEST/USDT",
    interval: "1d",
    t: Float64Array.from({ length: n }, (_, i) => t0 + i * DAY),
    open,
    close: Float64Array.from(closes),
    high: Float64Array.from(closes, (c, i) => opts.highs?.[i] ?? Math.max(c, open[i]!)),
    low: Float64Array.from(closes, (c, i) => opts.lows?.[i] ?? Math.min(c, open[i]!)),
    volume: new Float64Array(n).fill(1),
    stretches: [],
    notes: [],
  };
}
const market = (s: Series): Market => s;
const evalOn = (s: Series, src: string) => compileRule(src).run(market(s), new Map());
/** Evaluate a numeric expression by comparing it with itself — the rule language only returns conditions. */
const ruleNum = (s: Series, src: string, i: number, value: number) => evalOn(s, `abs(${src} - ${value}) < 0.000001`)[i] === 1;

// 1. the rule language
const ramp = series([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
check("sma(close, 3) on a ramp", ruleNum(ramp, "sma(close, 3)", 4, 4) && evalOn(ramp, "sma(close, 3) > 0")[1] === 0);
check("close[2] is two bars ago", ruleNum(ramp, "close[2]", 5, 4) && evalOn(ramp, "close[2] > 0")[1] === 0);
check("ema seeds on the sma, then smooths", ruleNum(ramp, "ema(close, 3)", 2, 2) && ruleNum(ramp, "ema(close, 3)", 3, 3));
check("highest/lowest include the bar", ruleNum(ramp, "highest(high, 3)", 5, 6) && ruleNum(ramp, "lowest(low, 3)", 5, 3));
check("roc is percent over n bars", ruleNum(ramp, "roc(close, 1)", 1, 100));
const flat = series(Array(40).fill(100));
check("rsi of a rising market is 100", evalOn(series(Array.from({ length: 40 }, (_, i) => 100 + i)), "rsi(close, 14) > 99.99")[39] === 1);
check("bollinger bands collapse on a flat market", ruleNum(flat, "bb_upper(close, 20, 2)", 30, 100) && ruleNum(flat, "bb_lower(close, 20, 2)", 30, 100));
const zig = series([5, 4, 3, 4, 5, 6, 5, 4]);
const up = evalOn(zig, "cross_above(close, 4.5)");
check("cross_above fires once, on the crossing bar", up[4] === 1 && [...up].filter((v) => v === 1).length === 1);
const before = evalOn(series([1, 2, 3, 4, 5, 6, 7, 8]), "close > sma(close, 3)");
const after = evalOn(series([1, 2, 3, 4, 5, 6, 1, 1]), "close > sma(close, 3)");
check("no rule sees a later bar", [0, 1, 2, 3, 4, 5].every((i) => before[i] === after[i]));
check("and/or/not combine conditions", evalOn(ramp, "close > 5 and not (close > 8) or close == 1")[0] === 1 && evalOn(ramp, "close > 5 and not (close > 8)")[7] === 1 && evalOn(ramp, "close > 5 and not (close > 8)")[8] === 0);
check("a number is not a rule", throws(() => compileRule("sma(close, 20)"), /must be a condition/));
check("an unknown function names the known ones", throws(() => compileRule("smaa(close, 3) > 1"), /unknown function "smaa".*sma/));
check("a period must be a whole number", throws(() => compileRule("sma(close, 2.5) > 1"), /whole number/));
check("periods are constants", throws(() => compileRule("sma(close, close) > 1"), /plain number/));
check("x[n] takes no negative n", throws(() => compileRule("close[-1] > 1"), /whole number of bars ago/));
check("warm-up adds up through nesting and x[n]", compileRule("sma(ema(close, 10), 5)[2] > 1").warmup === 3 * 10 + 5 + 2);

// 2. fills
const noCost = { feePct: 0, slippagePct: 0 };
const run = (s: Series, spec: Omit<StrategySpec, "name">, costs = noCost, start = 0) =>
  simulate(s, start, evalOn(s, spec.entry), spec.exit ? evalOn(s, spec.exit) : null, { name: "t", ...spec }, costs);

// in on bar 1's close (110), filled at bar 2's open (112); out on bar 4's close (100), filled at bar 5's open (101)
const steps = series([100, 110, 120, 130, 100, 100], { opens: [100, 100, 112, 121, 125, 101] });
const spec1 = { entry: "close > 105 and close < 115", exit: "close < 105" };
const r1 = run(steps, spec1);
const t1 = r1.trades[0]!;
check("a signal at the close fills at the next open", r1.trades.length === 1 && t1.entryAt === steps.t[2] && t1.entryPx === 112, JSON.stringify(r1.trades));
check("an exit signal sells at the next open", t1.exitAt === steps.t[5] && t1.exitPx === 101 && close(t1.retPct, (101 / 112 - 1) * 100));
check("equity follows the closes while in", close(r1.equity[3]!, 130 / 112));
const r2 = run(steps, spec1, { feePct: 1, slippagePct: 0 });
check("a fee is paid on the way in and out", close(r2.equity[3]!, (0.99 * 130) / 112) && close(r2.trades[0]!.retPct, (0.99 * 0.99 * 101 / 112 - 1) * 100));
const r2s = run(steps, spec1, { feePct: 0, slippagePct: 1 });
check("slippage worsens both market fills", close(r2s.trades[0]!.entryPx, 112 * 1.01) && close(r2s.trades[0]!.exitPx!, 101 * 0.99));

// gap through a stop: entry at 100, stop 10% → 90; next bar opens at 80 → fills at 80
const gap = series([100, 100, 95, 70, 70], { opens: [100, 100, 98, 80, 70], lows: [100, 100, 95, 70, 70] });
const r3 = run(gap, { entry: "close >= 100", stopLossPct: 10 });
check("a stop fills at the open when the bar gaps through it", r3.trades[0]!.exitPx === 80 && r3.trades[0]!.reason === "stop-loss", JSON.stringify(r3.trades[0]));
const touch = series([100, 100, 100, 100], { opens: [100, 100, 100, 100], highs: [100, 100, 130, 100], lows: [100, 100, 85, 100] });
const r4 = run(touch, { entry: "close >= 100 and close[1] < 1000", stopLossPct: 10, takeProfitPct: 20 });
check("a bar that touches both: the stop came first", r4.trades[0]!.reason === "stop-loss" && r4.trades[0]!.exitPx === 90, JSON.stringify(r4.trades[0]));
const tpBar = series([100, 100, 100, 100], { opens: [100, 100, 100, 100], highs: [100, 100, 125, 100], lows: [100, 100, 99, 100] });
const r5 = run(tpBar, { entry: "close >= 100 and close[1] < 1000", takeProfitPct: 20 }, { feePct: 0, slippagePct: 1 });
check("a take-profit fills at its price, no slippage", r5.trades[0]!.reason === "take-profit" && close(r5.trades[0]!.exitPx!, 101 * 1.2));
const trend = series([100, 100, 120, 140, 130, 125, 150], { lows: [100, 100, 120, 140, 128, 118, 150] });
const r6 = run(trend, { entry: "close >= 100 and close[1] < 101", trailPct: 10 });
check("a trailing stop follows the best close", r6.trades[0]!.reason === "trailing stop" && close(r6.trades[0]!.exitPx!, 126), JSON.stringify(r6.trades[0]));
const r7 = run(series([100, 100, 101, 102, 103, 104, 105]), { entry: "close >= 100 and close[1] < 101", maxBars: 2 });
check("a time exit sells after maxBars", r7.trades[0]!.bars === 3 && r7.trades[0]!.reason === "held 2 bars", JSON.stringify(r7.trades[0]));

// 3. the numbers
const dd = series([100, 100, 200, 100, 150]);
const bh = buyAndHold(dd, 0, noCost);
const m = measure(bh, dd, 0, 0, 5);
check("max drawdown of 200 → 100 is 50%", close(m.maxDdPct, 50));
check("total return of the window", close(m.totalPct, 50));
const doubling = series(Array.from({ length: 731 }, (_, i) => 100 * 2 ** (i / 365.25)));
const md = measure(buyAndHold(doubling, 0, noCost), doubling, 0, 0, 731);
check("CAGR of a series doubling every year is 100%", close(md.cagrPct!, 100, 0.01), `${md.cagrPct}`);
check("a steady rise has no drawdown", md.maxDdPct === 0);
const noisyUp = series(Array.from({ length: 400 }, (_, i) => 100 * 1.003 ** i * (i % 2 ? 1.004 : 1)));
const noisyDown = series(Array.from({ length: 400 }, (_, i) => 100 * 0.997 ** i * (i % 2 ? 1.004 : 1)));
const sUp = measure(buyAndHold(noisyUp, 0, noCost), noisyUp, 0, 0, 400).sharpe;
const sDown = measure(buyAndHold(noisyDown, 0, noCost), noisyDown, 0, 0, 400).sharpe;
check("Sharpe: high for a choppy rise, negative for a choppy fall", sUp > 3 && sDown < 0, `${sUp} / ${sDown}`);
const half = measure(buyAndHold(doubling, 0, noCost), doubling, 0, 365, 731);
check("a held-out window starts from the value before it", close(half.totalPct, 100 * (2 ** (366 / 365.25) - 1), 0.01), `${half.totalPct}`);

// 4. sweeps and presets
const swept = expandStrategies([], [{ name: "ema", entry: "ema(close, {fast}) > ema(close, {slow})", stopLossPct: "{sl}", params: { fast: [10, 20], slow: [50, 100, 200], sl: [5] } }]);
check("a sweep makes one variant per combination", swept.length === 6 && swept[0]!.name === "ema fast=10,slow=50,sl=5" && swept[0]!.entry === "ema(close, 10) > ema(close, 50)" && swept[0]!.stopLossPct === 5);
check("a slot with no values is an error", throws(() => expandStrategies([], [{ entry: "close > sma(close, {n})" }]), /\{n\} has no values/));
check("sweeps are capped", throws(() => expandStrategies([], [{ entry: "close > sma(close, {n})", params: { n: Array.from({ length: 300 }, (_, i) => i + 1) } }]), /more than 200/));
check("'all' is every preset", expandStrategies(["all"], []).length === Object.keys(PRESETS).length);
check("every preset compiles", Object.values(PRESETS).every((p) => compileRule(p.entry) && (!p.exit || compileRule(p.exit))));
check("pairs: a bare coin is against USDT", normalizePair("btc").binance === "BTCUSDT" && normalizePair("ETH/BTC").binance === "ETHBTC");
check("pairs: Bitstamp quotes dollars, not stablecoins", bitstampPair(normalizePair("BTCUSDT")) === "btcusd" && bitstampPair(normalizePair("XYZTRY")) === null);
const parsed = parseBacktestArgs(["eth", "3y", "4h", "donchian", "fee=0.075"]);
check("/backtest words", typeof parsed !== "string" && parsed.pair === "eth" && parsed.years === 3 && parsed.interval === "4h" && parsed.presets?.join() === "donchian" && parsed.feePct === 0.075);
check("/backtest refuses a word it does not know", typeof parseBacktestArgs(["btc", "eth"]) === "string");

// 5. a whole run from the cache: a market that trends up for a year and a half, then down
const dataDir = mkdtempSync(join(tmpdir(), "lainos-backtest-"));
mkdirSync(join(dataDir, "market", "binance"), { recursive: true });
const t0 = Date.UTC(2022, 0, 1);
const bars = Array.from({ length: 800 }, (_, i) => {
  const c = i < 550 ? 100 * 1.004 ** i : 100 * 1.004 ** 550 * 0.995 ** (i - 550);
  const wobble = 1 + 0.01 * Math.sin(i / 3);
  return [t0 + i * DAY, c * wobble * 0.998, c * wobble * 1.01, c * wobble * 0.99, c * wobble, 1];
});
writeFileSync(join(dataDir, "market", "binance", "XYZTRY-1d.json"), JSON.stringify({ listedAt: t0, bars }));
const res = await runBacktest({
  pair: "XYZTRY",
  interval: "1d",
  from: t0 + 300 * DAY,
  to: t0 + 799 * DAY,
  strategies: expandStrategies(["trend_200", "rsi_dip"], []),
  costs: { feePct: 0.1, slippagePct: 0.05 },
  holdoutPct: 30,
  dataDir,
});
check("the window starts where asked, warm-up read from before it", res.from === t0 + 300 * DAY && res.bars === 500 && !res.warmupShort);
check("the held-out part is the last 30%", res.holdoutFrom === t0 + (300 + 350) * DAY);
check("ranked by in-sample Sharpe", res.results[0]!.inSample.sharpe >= res.results[1]!.inSample.sharpe);
const trendRun = res.results.find((r) => r.spec.name === "trend_200")!;
check("the trend rule sidesteps the fall buy & hold rides", trendRun.full.maxDdPct < res.benchmark.full.maxDdPct, `${trendRun.full.maxDdPct} vs ${res.benchmark.full.maxDdPct}`);
const text = report(res, "/tmp/x.json");
check("the report has the benchmark, both strategies and years", /buy & hold/.test(text) && /trend_200/.test(text) && /rsi_dip/.test(text) && /2023/.test(text) && /held-out/.test(text));

// 6. on-chain history, against a stub of an Ethereum RPC
const FIRST = 12_369_621;
const HEAD = FIRST + 250_000 + 12;
const T0 = Date.UTC(2021, 4, 5) / 1000;
const hex = (n: bigint | number) => `0x${n.toString(16)}`;
const word = (v: bigint) => (v < 0n ? 2n ** 256n + v : v).toString(16).padStart(64, "0");
/** A WBTC/USDC swap at `usd` per bitcoin (WBTC is token0: 8 decimals, USDC 6). */
const swapLog = (block: number, usd: number, btc: number) => {
  const sqrt = BigInt(Math.round(Math.sqrt(usd / 100) * 2 ** 48)) * 2n ** 48n;
  return { blockNumber: hex(block), blockTimestamp: hex(T0 + (block - FIRST) * 12), data: `0x${word(BigInt(Math.round(btc * 1e8)))}${word(-BigInt(Math.round(btc * usd * 1e6)))}${word(sqrt)}${word(1n)}${word(0n)}` };
};
const swaps = [
  swapLog(FIRST + 100, 100, 1),
  swapLog(FIRST + 200, 110, 2),
  swapLog(FIRST + 300, 90, 1),
  swapLog(FIRST + 400, 105, 1),
  swapLog(FIRST + 2 * 7200 + 10, 120, 3),
  swapLog(FIRST + 200_000, 130, 1),
];
const abiStr = (txt: string) => `0x${word(32n)}${word(BigInt(txt.length))}${Buffer.from(txt).toString("hex").padEnd(64, "0")}`;
const LINK = "0x1111111111111111111111111111111111111111";
const USDC_ADDR = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
let getLogsCalls = 0;
let refused = 0;
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const { method, params } = JSON.parse(body) as { method: string; params: { fromBlock?: string; toBlock?: string; to?: string; data?: string }[] };
    let result: unknown;
    let error: { message: string } | undefined;
    if (method === "eth_blockNumber") result = hex(HEAD);
    else if (method === "eth_getLogs") {
      getLogsCalls += 1;
      const from = Number(params[0]!.fromBlock);
      const to = Number(params[0]!.toBlock);
      if (to - from + 1 > 60_000) {
        refused += 1;
        error = { message: "block range too large" };
      } else result = swaps.filter((l) => Number(l.blockNumber) >= from && Number(l.blockNumber) <= to);
    } else if (method === "eth_call") {
      const { to, data } = params[0]!;
      const calls: Record<string, string> = {
        "0x0dfe1681": `0x${word(BigInt(LINK))}`,
        "0xd21220a7": `0x${word(BigInt(USDC_ADDR))}`,
        "0xddca3f43": `0x${word(3000n)}`,
      };
      if (to === LINK) result = data === "0x95d89b41" ? abiStr("LINK") : `0x${word(18n)}`;
      else if (to === USDC_ADDR) result = data === "0x95d89b41" ? abiStr("USDC") : `0x${word(6n)}`;
      else result = calls[data!];
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(error ? { jsonrpc: "2.0", id: 1, error } : { jsonrpc: "2.0", id: 1, result }));
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const stub = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const dexDir = mkdtempSync(join(tmpdir(), "lainos-dex-"));
const day = 86_400_000;
const dex = await loadDexSeries({ market: DEX_MARKETS.BTC!, interval: "1d", from: T0 * 1000, to: T0 * 1000 + 3 * day, dataDir: dexDir, rpcUrls: [stub] });
const bar = (i: number) => [dex.open[i], dex.high[i], dex.low[i], dex.close[i]].map((v) => Math.round(v!)).join("/");
check("a window the endpoint refuses is split until it is served", refused > 0 && getLogsCalls > refused);
check("the price comes from sqrtPriceX96, decimals and all", bar(0) === "100/110/90/105", bar(0));
check("a bar's volume is the base traded in it", close(dex.volume[0]!, 5, 1e-6), `${dex.volume[0]}`);
check("a day nobody traded is a flat bar at the last price", bar(1) === "105/105/105/105" && dex.volume[1] === 0, bar(1));
check("the next bar opens where the last closed", bar(2) === "105/120/105/120", bar(2));
check("the report says it is on-chain", dex.stretches[0]!.source === "dex" && /WBTC\/USDC/.test(dex.stretches[0]!.pair));
const callsBefore = getLogsCalls;
const again = await loadDexSeries({ market: DEX_MARKETS.BTC!, interval: "1d", from: T0 * 1000, to: T0 * 1000 + 30 * day, dataDir: dexDir, rpcUrls: [stub] });
check("a second run reads the cache, not the chain", getLogsCalls === callsBefore && again.close.at(-1) === 130);
const early = await runBacktest({
  pair: "BTCUSDT",
  interval: "1d",
  from: T0 * 1000 - 365 * day,
  to: T0 * 1000 + 30 * day,
  strategies: expandStrategies(["ema_cross"], []),
  costs: noCost,
  holdoutPct: 0,
  dataDir: dexDir,
  dex: DEX_MARKETS.BTC!,
  rpcUrls: [stub],
});
check("asking before the pool existed says where its history starts", early.notes.some((n) => /history starts 2021-05-05, later than asked \(the pool's first swap\)/.test(n)), early.notes.join(" | "));
const link = await dexMarketFromPool("0x" + "a".repeat(40), { rpcUrls: [stub] });
check("any pool: tokens and fee read from the chain, priced in the dollar side", link.base.symbol === "LINK" && link.quote.symbol === "USDC" && link.baseIs0 && link.quote.decimals === 6 && /LINK\/USDC 0.3%/.test(link.label), JSON.stringify(link));
server.close();
const dexArgs = parseBacktestArgs(["0x" + "b".repeat(40), "2y", "dex"]);
check("/backtest takes a pool address and a source", typeof dexArgs !== "string" && dexArgs.pool === "0x" + "b".repeat(40) && dexArgs.source === "dex");

// 7. live runs, against a stand-in desk and bars that close on demand
const H = 3_600_000;
/** Hourly bars ending three hours ago, so the next one is due; push a close to make it arrive. */
const liveCloses = Array.from({ length: 120 }, (_, i) => 100 + i);
const hourT0 = Math.floor(Date.now() / H) * H - (liveCloses.length + 2) * H;
const liveSeries = (): Series => {
  const n = liveCloses.length;
  const c = Float64Array.from(liveCloses);
  return {
    pair: "WBTC/USDC",
    interval: "1h",
    t: Float64Array.from({ length: n }, (_, i) => hourT0 + i * H),
    open: Float64Array.from(c, (v, i) => (i ? c[i - 1]! : v)),
    high: Float64Array.from(c, (v) => v * 1.001),
    low: Float64Array.from(c, (v) => v * 0.999),
    close: c,
    volume: new Float64Array(n).fill(1),
    stretches: [],
    notes: [],
  };
};
class StandInDesk implements LiveDesk {
  px = 220;
  held = 0n;
  log: string[] = [];
  blocker() {
    return null;
  }
  async order(symbol: string, dollars: number, _by: string, why: string) {
    const qty = BigInt(Math.round((dollars / this.px) * 1e8));
    this.held += qty;
    this.log.push(`buy ${symbol} ${dollars} — ${why}`);
    return { line: "bought", qty, px: this.px };
  }
  async sellUnits(symbol: string, qty: bigint, _by: string, reason: string) {
    this.held -= qty;
    this.log.push(`sell ${symbol} — ${reason}`);
    return { line: "sold", proceeds: (Number(qty) / 1e8) * this.px };
  }
  async price() {
    return this.px;
  }
  async saleValue(_s: string, qty: bigint) {
    return (Number(qty) / 1e8) * this.px;
  }
  holding() {
    return this.held;
  }
}
const liveDir = mkdtempSync(join(tmpdir(), "lainos-live-"));
const liveRuntime = { getSetting: (k: string) => (k === "LAINOS_DATA_DIR" ? liveDir : undefined), getService: () => undefined } as unknown as Parameters<LiveStrategyService["start"]>[0];
const desk = new StandInDesk();
let loads = 0;
const live = new LiveStrategyService(async () => {
  loads += 1;
  return liveSeries();
}, desk);
await live.start(liveRuntime);
const trendSpec = { name: "trend_50", entry: "close > sma(close, 50)", exit: "close < sma(close, 50)" };
const joined = await live.begin({ spec: trendSpec, interval: "1h", usd: 5000 });
check("a strategy in the market at the last close joins at once, at the live price", /IN BTC/.test(joined) && desk.log.length === 1 && /buy BTC 5000/.test(desk.log[0]!), joined);
check("the run reports its rules, where its signal and fills come from", /close > sma\(close, 50\)/.test(joined) && /WBTC\/USDC/.test(joined) && /Robinhood Chain's live pools/.test(joined), joined);
await live.tick();
check("no new close, no new reading", desk.log.length === 1 && live.list()[0]!.qty !== "0");
liveCloses.push(150);
desk.px = 150;
await live.tick();
const s1 = live.list()[0]!;
check("the exit rule at the next close sells, and the run books the round trip", s1.qty === "0" && /exit rule/.test(desk.log[1] ?? "") && close(s1.cash, 5000 * (150 / 220), 1e-6), `${desk.log.join(" | ")} cash ${s1.cash}`);
check("the trade log has both sides, the sale with its return", s1.trades.length === 2 && s1.trades[1]!.side === "sell" && s1.trades[1]!.pnlPct! < -30);
liveCloses.splice(0, liveCloses.length, ...Array.from({ length: 120 }, (_, i) => 300 - i));
const waiting = await live.begin({ spec: trendSpec, interval: "1h", usd: 1000 });
check("a strategy out of the market waits for its entry", /OUT, in dollars/.test(waiting) && /waiting for close > sma/.test(waiting) && desk.log.length === 2, waiting);
liveCloses.splice(0, liveCloses.length, ...Array.from({ length: 120 }, (_, i) => 100 + i));
desk.px = 220;
const stopped = await live.begin({ spec: { ...trendSpec, name: "trend_stop", stopLossPct: 5 }, interval: "1h", usd: 1000 });
check("a third run joins the uptrend", /IN BTC/.test(stopped));
desk.px = 220 * 0.94;
await live.tick();
const s3 = live.list()[2]!;
check("a stop-loss sells between closes, on the live price", s3.qty === "0" && /stop-loss/.test(s3.last), s3.last);
const byHand = await live.begin({ spec: { ...trendSpec, name: "trend_hand" }, interval: "1h", usd: 1000 });
desk.held = 0n;
await live.tick();
check("a position closed on the desk by hand leaves the run out", /IN BTC/.test(byHand) && live.list()[3]!.qty === "0" && /outside the run/.test(live.list()[3]!.last));
const ended = await live.end("all");
check("stop ends every running run", (ended.match(/⏹/g) ?? []).length === 4 && live.list().every((r) => r.stoppedAt), ended);
check("a live run refuses a coin Robinhood Chain has no pool for", await live.begin({ spec: trendSpec, pair: "SOLUSDT" }).then(() => false, (e: Error) => /BTC and ETH/.test(e.message)));
await live.stop();
const reborn = new LiveStrategyService(async () => liveSeries(), desk);
await reborn.start(liveRuntime);
check("the runs survive a restart", reborn.list().length === 4 && reborn.list()[0]!.trades.length === 2);
await reborn.stop();
check("bars were read on start and on new closes only", loads >= 5);

console.log(`\nbacktest smoke ${failed ? `FAILED (${failed}/${checks})` : `ok (${checks} checks)`}`);
process.exit(failed ? 1 : 0);
