#!/usr/bin/env -S npx tsx
/**
 * Trend paper smoke test (offline — synthetic bars, stub endpoints).
 *
 * Pinned here:
 *   1. the arithmetic: EMA against hand-computed values, the median;
 *   2. the rule: two closes above the EMA with a volume spike enter, one close
 *      or a thin bar does not; the stop-loss sells everything and starts the
 *      cooldown, no entry inside it and one right after; +40 % sells half,
 *      once; two closes below the EMA sell the rest; 1 % on every fill; the
 *      liquidity filter turns away a position over 2 % of the pool;
 *   3. the scheduler: hourly triggers fire once per hour at their minute, and
 *      plugin jobs run from the routines tick;
 *   4. the books: a check books fills into state.json and trades.jsonl, a
 *      restart carries on from them, a torn journal is cut back, the daily
 *      report compares with holding;
 *   5. paper only: the mode cannot be configured; no module reachable from
 *      the plugin can sign, send, swap or reach a wallet (import graph and
 *      source scan, with the scanner itself shown to catch a bad import);
 *      every request a real check makes, against stub endpoints, is a read;
 *      the plugin touches nothing on the runtime but settings and the scheduler.
 *
 * Run: npm run trend-paper:smoke
 */
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG, MODE, resolveConfig, type AssetId } from "../src/plugins/trend-paper/config.js";
import { CYBER, LAIN, READ_METHODS, cyberFeed, lainFeed, rpc, type Feed, type Fetch, type Snapshot } from "../src/plugins/trend-paper/market.js";
import { backtest, ema, median, newBook, step, type Bar } from "../src/plugins/trend-paper/strategy.js";
import { TrendPaperService, type TrendPaperEvent } from "../src/plugins/trend-paper/index.js";
import { isDue, RoutineService, type Routine, type ScheduledJob } from "../src/plugins/skills/routines.js";
import type { IAgentRuntime } from "../src/types.js";

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

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 1);
const cfg = resolveConfig();

/** Bars from closes; volume 1 unless given, liquidity 100 unless given. */
function bars(closes: number[], vols: number[] = [], liq: number | null = 100): Bar[] {
  return closes.map((c, i) => ({ t: T0 + i * HOUR, o: c, h: c, l: c, c, v: vols[i] ?? 1, liq }));
}

/** Run the rule bar by bar from the first bar it can read; returns each bar's decision (or null). */
function replay(series: Bar[], book = newBook(1), c = cfg) {
  const emas = ema(series.map((b) => b.c), c.emaPeriod);
  const out = [];
  for (let i = 0; i < series.length; i++) out.push(step(book, series, emas, i, c));
  return { book, out, emas };
}

// ---------------------------------------------------------------- 1. arithmetic

{
  const e = ema([1, 2, 3, 4, 5, 6], 3);
  // seed = (1+2+3)/3 = 2; k = 0.5 → 3, 4, 5
  check("EMA: NaN before the period, SMA seed, then k = 2/(n+1)", Number.isNaN(e[1]!) && e[2] === 2 && e[3] === 3 && e[4] === 4 && e[5] === 5);
  const e20 = ema(Array.from({ length: 21 }, (_, i) => i + 1), 20);
  check("EMA20: seed is the mean of 20 closes, next is 21·2/21 + 10.5·19/21", e20[19] === 10.5 && close(e20[20]!, 21 * (2 / 21) + 10.5 * (19 / 21)));
  check("median: odd, even, unsorted", median([3, 1, 2]) === 2 && median([4, 1, 3, 2]) === 2.5);
}

// ---------------------------------------------------------------- 2. the rule

/** 30 flat bars at 1 (EMA = 1), volume 1 — then whatever the test appends. */
const FLAT = Array.from({ length: 30 }, () => 1);

{
  const one = replay(bars([...FLAT, 1.1, 0.9], [...FLAT, 1, 3]));
  check("one close above the EMA is not a signal", one.out.every((d) => d === null) && one.book.qty === 0);

  const two = replay(bars([...FLAT, 1.1, 1.1], [...FLAT, 1, 1.5]));
  const buy = two.out.at(-1);
  check("two closes above the EMA with volume ≥ 1.5 × median enter", buy?.action === "buy" && two.book.qty > 0, JSON.stringify(buy));
  check("the entry is booked at the signal close", buy?.price === 1.1 && two.book.entryPx === 1.1);
  check("1% cost on the entry: tokens = cash × 0.99 / price", close(two.book.qty, (1 * 0.99) / 1.1) && close(buy!.fee, 0.01));
  check("the decision is stamped with the bar's close time", buy?.at === T0 + 32 * HOUR);

  const thin = replay(bars([...FLAT, 1.1, 1.1], [...FLAT, 1, 1.49]));
  check("volume under 1.5 × median: no entry", thin.out.every((d) => d === null));

  const quiet = replay(bars([...FLAT, 1.1, 1.1], Array.from({ length: 32 }, () => 0)));
  check("median 0 and no trade in the bar: no entry", quiet.out.every((d) => d === null));
  const spark = replay(bars([...FLAT, 1.1, 1.1], [...Array.from({ length: 31 }, () => 0), 0.01]));
  check("median 0 and any trade in the bar: entry", spark.out.at(-1)?.action === "buy");

  const lookback = replay(bars([...FLAT, 1.1, 1.1], [...FLAT.slice(0, 6), ...Array.from({ length: 24 }, () => 10), 1, 15]));
  check("the yardstick is the median of the 24 bars before the signal bar", lookback.out.at(-1)?.action === "buy" && close(lookback.out.at(-1)!.medianVolume, 10));
}

{
  // In at 1.1, then a close at 0.935 = 1.1 × 0.85: stop.
  const r = replay(bars([...FLAT, 1.1, 1.1, 0.935], [...FLAT, 1, 2, 1]));
  const stop = r.out.at(-1);
  check("stop-loss: close ≤ entry × 0.85 sells everything", stop?.action === "sell" && /stop-loss/.test(stop.reason) && r.book.qty === 0, JSON.stringify(stop));
  check("1% cost on the exit: proceeds = qty × price × 0.99", close(stop!.quote, ((0.99 / 1.1) * 0.935) * 0.99));
  check("a stop starts a 6-hour cooldown from the bar's close", r.book.cooldownUntil === stop!.at + 6 * HOUR);
  check("the losing round trip is counted, not won", r.book.roundTrips === 1 && r.book.wins === 0);

  const above = 0.935 * 1.5;
  // After the stop: signals at every bar; entries must wait until the close 6 h after the stop.
  const tail = Array.from({ length: 8 }, () => above);
  const after = replay(bars([...FLAT, 1.1, 1.1, 0.935, ...tail], [...FLAT, 1, 2, 1, ...tail.map(() => 5)]));
  const stopAt = after.out[32]!.at;
  const firstBuy = after.out.slice(33).find((d) => d?.action === "buy");
  check("no entry inside the cooldown", after.out.slice(33).every((d) => d === null || d.at >= stopAt + 6 * HOUR));
  check("an entry as soon as the cooldown is over", firstBuy?.at === stopAt + 6 * HOUR, JSON.stringify(firstBuy));

  const noStop = replay(bars([...FLAT, 1.1, 1.1, 0.95, 0.94], [...FLAT, 1, 2, 1, 1]));
  check("a trend exit (2 closes below the EMA) does not start a cooldown", noStop.out.at(-1)?.action === "sell" && /trend exit/.test(noStop.out.at(-1)!.reason) && noStop.book.cooldownUntil === 0);
}

{
  // In at 1.1; 1.54 = 1.1 × 1.4 sells half, a higher close sells nothing more; two closes below the EMA sell the rest.
  const r = replay(bars([...FLAT, 1.1, 1.1, 1.54, 1.7, 0.95, 0.94], [...FLAT, 1, 2, 1, 1, 1, 1]));
  const part = r.out[32];
  const qty = 0.99 / 1.1;
  check("+40% from the entry sells 50%", part?.action === "sell_partial" && close(part.tokens, qty / 2), JSON.stringify(part));
  check("the partial exit happens once", r.out[33] === null);
  const exit = r.out.at(-1);
  check("the rest sells on two closes below the EMA", exit?.action === "sell" && close(exit.tokens, qty / 2) && r.book.qty === 0);
  check("a round trip with a partial exit is profitable on its total proceeds", r.book.roundTrips === 1 && r.book.wins === 1);
  const flat = replay(bars([...FLAT, 1.1, 1.1], [...FLAT, 1, 2]));
  check("a round trip at the entry price loses exactly the two costs", flat.book.qty > 0 && close(flat.book.qty * 1.1 * 0.99, 0.99 * 0.99));
}

{
  const big = replay(bars([...FLAT, 1.1, 1.1], [...FLAT, 1, 2], 49.99));
  const skip = big.out.at(-1);
  check("liquidity filter: 1 > 2% of 49.99 → skipped, cash kept", skip?.action === "skip" && /2% of the pool/.test(skip.reason) && big.book.cash === 1 && big.book.qty === 0);
  const edge = replay(bars([...FLAT, 1.1, 1.1], [...FLAT, 1, 2], 50));
  check("liquidity filter: exactly 2% is allowed", edge.out.at(-1)?.action === "buy");
  const unknown = replay(bars([...FLAT, 1.1, 1.1], [...FLAT, 1, 2], null));
  check("an unknown pool is never entered", unknown.out.at(-1)?.action === "skip");
  const s = bars([...FLAT, 1.1, 1.1], [...FLAT, 1, 2], 1000);
  const live = step(newBook(1), s, ema(s.map((b) => b.c), 20), 31, cfg, 10);
  check("the live pool overrides the bar's liquidity", live?.action === "skip" && live.liquidity === 10);
}

{
  const s = bars([...FLAT, 1.1, 1.1, 1.6, 1.7, 1.12, 1.11], [...FLAT, 1, 2, 1, 1, 1, 1]);
  const { summary } = backtest(s, cfg, 1);
  const holdEnd = ((1 * 0.99) / s[cfg.volumeLookback]!.c) * 1.11;
  check("backtest: hold buys at the first decision bar, paying the cost once", close(summary.hold, holdEnd));
  check("backtest: counts fills, round trips and wins", summary.fills === 3 && summary.roundTrips === 1 && summary.wins === 1 && !summary.open, JSON.stringify(summary));
}

// ---------------------------------------------------------------- 3. scheduler

{
  const at = (h: number, m: number, s = 0) => Date.UTC(2026, 9, 20, h, m, s);
  const routine = (lastRunAt: number) => ({ trigger: { kind: "hourly", minute: 2 }, lastRunAt }) as Routine;
  check("hourly :02 is not due at :01", !isDue(routine(at(11, 2)), at(12, 1)));
  check("hourly :02 is due at :02", isDue(routine(at(11, 2)), at(12, 2)));
  check("hourly :02 runs once per hour", !isDue(routine(at(12, 2, 10)), at(12, 59)));
  check("hourly :02 catches up a slot slept through", isDue(routine(at(9, 2)), at(12, 30)));

  const rs = new RoutineService();
  const ran: number[] = [];
  let clock = at(12, 2);
  rs.schedule({ name: "t", trigger: { kind: "hourly", minute: 2 }, run: async () => void ran.push(clock) });
  await rs.tick(clock);
  clock = at(12, 30);
  await rs.tick(clock);
  clock = at(13, 2, 5);
  await rs.tick(clock);
  check("plugin jobs run from the routines tick at their slots only", ran.length === 2 && ran[1] === at(13, 2, 5), JSON.stringify(ran));
  check("an hourly minute out of range is refused", throws(() => rs.schedule({ name: "bad", trigger: { kind: "hourly", minute: 60 }, run: async () => {} }), /0–59/));
}

// ---------------------------------------------------------------- 4. the books

const dir = mkdtempSync(join(tmpdir(), "lainos-trend-paper-"));

/** A feed that serves whatever bars the test holds for it. */
function fakeFeed(asset: AssetId, quote: "ETH" | "SOL", get: () => Snapshot): Feed {
  return { asset, quote, pool: "test", label: asset, read: async () => get() };
}

{
  const snaps: Record<AssetId, Snapshot> = {
    LAIN: { bars: bars([...FLAT, 1.1]), liquidity: 100, notes: [] },
    CYBER: { bars: bars(FLAT), liquidity: 100, notes: [] },
  };
  let now = T0 + 31 * HOUR + 2 * 60_000;
  const deps = { now: () => now, feeds: { LAIN: fakeFeed("LAIN", "ETH", () => snaps.LAIN), CYBER: fakeFeed("CYBER", "SOL", () => snaps.CYBER) } };
  const svc = new TrendPaperService(deps);
  await svc.open(dir);
  const events: TrendPaperEvent[] = [];
  svc.onEvent((e) => events.push(e));

  await svc.check();
  const state1 = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  check("a first check opens both books at their capital", state1.assets.LAIN.book.cash === 0.1 && state1.assets.CYBER.book.cash === 1 && state1.mode === "paper");
  check("the first check sends the first daily report", events.filter((e) => e.kind === "report").length === 1 && state1.lastReportAt !== null);

  // An hour later LAIN's second close above the EMA arrives with volume: a buy.
  snaps.LAIN = { bars: bars([...FLAT, 1.1, 1.1], [...FLAT, 1, 2]), liquidity: 100, notes: [] };
  snaps.CYBER = { bars: bars([...FLAT, 1]), liquidity: 100, notes: [] };
  now += HOUR;
  await svc.check();
  const journal = readFileSync(join(dir, "trades.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const line = journal[0];
  check("the fill is journaled with time, asset, action, price, EMA, volume, reason, balance",
    journal.length === 1 && line.asset === "LAIN" && line.action === "buy" && line.price === 1.1 && Number.isFinite(line.ema) && line.volume === 2 &&
      /closes above EMA20/.test(line.reason) && line.balance_after.ETH === 0 && close(line.balance_after.LAIN, (0.1 * 0.99) / 1.1) && line.time === new Date(T0 + 32 * HOUR).toISOString(),
    JSON.stringify(line));
  const trade = events.find((e) => e.kind === "trade");
  check("the fill becomes one event: what, why, balance", !!trade && /LAIN BUY/.test(trade.text) && /why:/.test(trade.text) && /balance:/.test(trade.text) && /paper only/.test(trade.text));

  // The same hour again (a second tick, a restart) books nothing twice.
  await svc.check();
  check("a bar already read is never read again", readFileSync(join(dir, "trades.jsonl"), "utf8").trim().split("\n").length === 1);

  // A check that died between the journal and the state leaves a line the state does not count.
  appendFileSync(join(dir, "trades.jsonl"), `{"torn":true}\n{"half`);
  const restarted = new TrendPaperService(deps);
  await restarted.open(dir);
  await restarted.check();
  const after = readFileSync(join(dir, "trades.jsonl"), "utf8");
  check("a restart cuts the journal back to what the state committed", !after.includes("torn") && after.trim().split("\n").length === 1);
  const state2 = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  check("balances survive a restart", close(state2.assets.LAIN.book.qty, (0.1 * 0.99) / 1.1) && state2.assets.LAIN.book.cash === 0);

  const report = await restarted.report();
  check("the daily report: balance vs holding, trades, win rate, drawdown",
    /LAIN \(ETH\)/.test(report) && /CYBER \(SOL\)/.test(report) && /vs just holding/.test(report) && /1 fills, 0 closed/.test(report) && /max drawdown/.test(report), report);
}

// ---------------------------------------------------------------- 5. paper only

check("the mode is a constant: paper", MODE === "paper" && !("mode" in DEFAULT_CONFIG));
check("a config naming a mode is refused", throws(() => resolveConfig({ mode: "live" }), /mode is fixed to paper/) && throws(() => resolveConfig({ live: true }), /fixed to paper/));
check("unknown config keys are refused", throws(() => resolveConfig({ walletAddress: "0x1" }), /unknown key/));
check("strategy parameters are configurable", resolveConfig({ emaPeriod: 30, capital: { LAIN: 0.2 } }).emaPeriod === 30 && resolveConfig({ capital: { LAIN: 0.2 } }).capital.LAIN === 0.2);

{
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const pluginDir = join(root, "src/plugins/trend-paper");
  /** Modules outside the plugin it may load: they must reach nothing either. */
  const ALLOWED_LOCAL = new Set([join(root, "src/logger.ts")]);
  const ALLOWED_BUILTINS = new Set(["node:fs/promises", "node:path"]);
  const FORBIDDEN = [
    /eth_send(Raw)?Transaction/, /sendTransaction/, /sendRawTransaction/, /signTransaction/, /signMessage/, /signTypedData/, /\beth_sign\b/,
    /writeContract/, /createWalletClient/, /privateKeyToAccount/, /mnemonicToAccount/, /hdKeyToAccount/, /PRIVATE_KEY|_PK\b/,
    /swap_execute|swapExecute|SwapExecute/, /sellUnits|\.order\(/, /metamask|agent.?wallet/i, /child_process|\bspawn\(|\bexecFile?\(/,
    /\.actions\b/, /getService(<[^>]*>)?\(\s*["'`](?!routines["'`])/,
  ];
  const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const specifiers = (src: string) => {
    const out: string[] = [];
    const code = stripComments(src);
    for (const re of [/^\s*import\s+(?!type\b)[^"';]*?from\s+["']([^"']+)["']/gm, /^\s*export\s+(?!type\b)[^"';]*?from\s+["']([^"']+)["']/gm, /^\s*import\s+["']([^"']+)["']/gm, /\bimport\(\s*["']([^"']+)["']\s*\)/g, /\brequire\(\s*["']([^"']+)["']\s*\)/g]) {
      for (const m of code.matchAll(re)) out.push(m[1]!);
    }
    return out;
  };
  /** Every problem in the graph reachable from `entry`, as text. */
  const audit = (entry: string, inside: string, extra: Set<string> = new Set()): string[] => {
    const problems: string[] = [];
    const seen = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      if (!existsSync(file)) return void problems.push(`${relative(root, file)}: missing`);
      const src = readFileSync(file, "utf8");
      const code = stripComments(src);
      for (const re of FORBIDDEN) if (re.test(code)) problems.push(`${relative(root, file)}: ${re}`);
      for (const spec of specifiers(src)) {
        if (!spec.startsWith(".")) {
          if (!ALLOWED_BUILTINS.has(spec)) problems.push(`${relative(root, file)} imports ${spec}`);
          continue;
        }
        const target = resolve(dirname(file), spec.replace(/\.js$/, ".ts"));
        if (!target.startsWith(inside + "/") && !ALLOWED_LOCAL.has(target) && !extra.has(target)) problems.push(`${relative(root, file)} reaches ${relative(root, target)}`);
        else walk(target);
      }
    };
    walk(entry);
    return problems;
  };

  const problems = audit(join(pluginDir, "index.ts"), pluginDir);
  check("no path to real execution is reachable from the plugin (imports + source scan)", problems.length === 0, problems.join("; "));
  check("the logger it shares imports nothing", specifiers(readFileSync(join(root, "src/logger.ts"), "utf8")).length === 0);

  // The scanner must catch what it is there to catch.
  const bad = mkdtempSync(join(tmpdir(), "lainos-trend-paper-audit-"));
  writeFileSync(join(bad, "index.ts"), `import { ChainService } from "./${relative(bad, join(root, "src/plugins/chain/service.js"))}";\nimport "./b.js";\n`);
  writeFileSync(join(bad, "b.ts"), `import { createWalletClient } from "viem";\nexport const x = (runtime: any) => runtime.getService("chain");\n`);
  const caught = audit(join(bad, "index.ts"), bad);
  check("the audit catches a wallet import, a signer, a foreign service and an outside module",
    caught.some((p) => /reaches src\/plugins\/chain\/service\.ts/.test(p)) && caught.some((p) => /imports viem/.test(p)) && caught.some((p) => /createWalletClient/.test(p)) && caught.some((p) => /getService/.test(p)),
    caught.join("; "));
}

check("rpc() refuses any method that is not a read, before any request", await (async () => {
  let called = false;
  const env = { fetch: (async () => ((called = true), new Response("{}"))) as unknown as Fetch, dir, now: Date.now };
  for (const method of ["eth_sendRawTransaction", "eth_sendTransaction", "eth_sign", "sendTransaction"]) {
    try {
      await rpc(env, LAIN.rpc, [{ method, params: [] }]);
      return false;
    } catch (err) {
      if (!/not a read/.test((err as Error).message)) return false;
    }
  }
  return !called;
})());

{
  // A real check through the real feeds, against stub endpoints that log every request.
  const now = Date.UTC(2026, 9, 20, 12, 2);
  const launchTs = Math.floor((now - 40 * HOUR) / 1000);
  const perBlock = (30 * 3600) / (LAIN.graduationBlock - LAIN.launchBlock);
  const blockTs = (b: number) => Math.round(launchTs + (b - LAIN.launchBlock) * perBlock);
  let head = LAIN.graduationBlock + 30_000;
  const w = (v: bigint) => (v < 0n ? 2n ** 256n + v : v).toString(16).padStart(64, "0");
  const WAD = 10n ** 18n;
  const sqrtAt = (ethPerToken: number) => BigInt(Math.round(Math.sqrt(1 / ethPerToken) * 2 ** 48)) * 2n ** 48n;
  const curveLog = { blockNumber: `0x${LAIN.launchBlock.toString(16)}`, logIndex: "0x0", topics: ["0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455"], data: `0x${w(WAD / 10n)}${w(54_586_381_541_924_596_000_000_000n)}${w(WAD / 1000n)}${w(WAD / 500n)}` };
  const swap = (block: number, px: number, eth: bigint) => ({ blockNumber: `0x${block.toString(16)}`, logIndex: "0x1", topics: [], data: `0x${w(-eth)}${w(10n ** 24n)}${w(sqrtAt(px))}${w(29_277_002_188_455_996_281_347n)}${w(0n)}${w(0n)}` });
  const swaps = [swap(LAIN.graduationBlock + 10, 2e-8, WAD / 4n), swap(LAIN.graduationBlock + 20_000, 1.6e-8, WAD / 10n)];

  const requests: { host: string; method: string }[] = [];
  const gtRows = (before: number) => Array.from({ length: 30 }, (_, i) => Math.floor(now / HOUR) * 3600 - i * 3600)
    .filter((t) => t < before)
    .map((t, i) => [t, 1.5e-7 + i * 1e-10, 1.6e-7, 1.4e-7, 1.5e-7, i % 3 ? 0.2 : 0]);
  const stub: Fetch = async (url, init) => {
    const u = new URL(url);
    if (u.host === "api.geckoterminal.com") {
      requests.push({ host: u.host, method: init?.method ?? "GET" });
      const pool = u.pathname.split("/")[6];
      const before = Number(u.searchParams.get("before_timestamp"));
      return Response.json({ data: { attributes: { ohlcv_list: pool === CYBER.ammPool ? gtRows(before) : [] } } });
    }
    const body = JSON.parse(init?.body ?? "{}");
    const calls = Array.isArray(body) ? body : [body];
    const replies = calls.map((c: { id: number; method: string; params: any[] }) => {
      requests.push({ host: u.host, method: c.method });
      const result = (() => {
        switch (c.method) {
          case "eth_blockNumber": return `0x${head.toString(16)}`;
          case "eth_getBlockByNumber": return { timestamp: `0x${blockTs(Number(BigInt(c.params[0]))).toString(16)}` };
          case "eth_getLogs": {
            const [from, to] = [Number(BigInt(c.params[0].fromBlock)), Number(BigInt(c.params[0].toBlock))];
            const pool = c.params[0].address === LAIN.curve ? [curveLog] : swaps;
            return pool.filter((l) => Number(BigInt(l.blockNumber)) >= from && Number(BigInt(l.blockNumber)) <= to);
          }
          case "eth_call": return c.params[0].data.startsWith("0xc815641c") ? `0x${w(sqrtAt(1.6e-8))}${w(0n)}${w(0n)}${w(0n)}` : `0x${w(29_277_002_188_455_996_281_347n)}`;
          case "getTokenAccountsByOwner": return { value: [{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: c.params[1].mint === CYBER.wsol ? 57.6 : 369e6 } } } } } }] };
          default: return undefined;
        }
      })();
      return result === undefined ? { id: c.id, error: { code: -32601, message: "method not allowed" } } : { id: c.id, result };
    });
    return Response.json(Array.isArray(body) ? replies : replies[0]);
  };

  const live = mkdtempSync(join(tmpdir(), "lainos-trend-paper-live-"));
  let clock = now;
  const svc = new TrendPaperService({ fetch: stub, now: () => clock, sleep: async () => {} });
  const scheduled: ScheduledJob[] = [];
  const touched: string[] = [];
  const runtime = new Proxy({}, {
    get(_t, prop) {
      if (prop === "getSetting") return (key: string) => (key === "LAINOS_DATA_DIR" ? live : undefined);
      if (prop === "getService") {
        return (name: string) => {
          if (name !== "routines") throw new Error(`asked for service ${name}`);
          return { active: true, schedule: (job: ScheduledJob) => (scheduled.push(job), () => {}) };
        };
      }
      touched.push(String(prop));
      throw new Error(`touched runtime.${String(prop)}`);
    },
  }) as IAgentRuntime;
  await svc.start(runtime);
  check("start asks the runtime for settings and the scheduler only", touched.length === 0, touched.join(", "));
  check("it schedules the check hourly at :02 and the report daily at 09:00 Moscow",
    scheduled.length === 2 && JSON.stringify(scheduled[0]!.trigger) === JSON.stringify({ kind: "hourly", minute: 2 }) &&
      JSON.stringify(scheduled[1]!.trigger) === JSON.stringify({ kind: "daily", at: "09:00", timeZone: "Europe/Moscow" }));

  await scheduled[0]!.run();
  clock += HOUR;
  head += 36_000;
  await scheduled[0]!.run();
  const state = JSON.parse(readFileSync(join(live, "trend-paper/state.json"), "utf8"));
  check("a real check reads both markets through the real feeds", !!state.assets.LAIN && !!state.assets.CYBER && !state.assets.LAIN.error && !state.assets.CYBER.error, JSON.stringify(state.assets));
  check("LAIN's live pool is read from StateView: 2 × L / √P ETH", close(state.assets.LAIN.liquidity, 2 * 29_277_002_188_455_996_281_347 / Math.sqrt(1 / 1.6e-8) / 1e18, 1e-6));
  check("CYBER's live pool is twice its SOL reserve", close(state.assets.CYBER.liquidity, 115.2));
  const methods = new Set(requests.map((r) => r.method));
  const hosts = new Set(requests.map((r) => r.host));
  check("every request a check makes is a read", [...methods].every((m) => READ_METHODS.has(m) || m === "GET"), [...methods].join(", "));
  check("and goes only to the chain RPCs and GeckoTerminal",
    [...hosts].every((h) => ["rpc.mainnet.chain.robinhood.com", "api.mainnet-beta.solana.com", "api.geckoterminal.com"].includes(h)), [...hosts].join(", "));
  check("the feeds' bars are hourly, closed and without holes",
    [lainFeed, cyberFeed].length === 2 && (await lainFeed.read({ fetch: stub, dir: join(live, "trend-paper/market"), now: () => clock })).bars.every((b, i, a) => b.t + HOUR <= clock && (i === 0 || b.t - a[i - 1]!.t === HOUR)));
}

console.log(`\n${checks - failed}/${checks} checks passed`);
if (failed) process.exit(1);
