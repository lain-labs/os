/**
 * The backtest plugin: strategies tested on years of history (engine.ts) —
 * on-chain, rebuilt from a Uniswap pool's swaps on Ethereum (dex.ts), or from
 * the exchanges (candles.ts) for the years before DEXes — and how Lain and the
 * operator reach it: the `backtest` tool, where Lain writes strategies in the
 * rule language and runs them together, and /backtest in the TUI.
 */
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { createLogger } from "../../logger.js";
import type { Action, IAgentRuntime, Plugin } from "../../types.js";
import { INTERVALS, isInterval, normalizePair, type Interval } from "./candles.js";
import { dexMarketFromPool, knownDexMarket, type DexMarket } from "./dex.js";
import { ruleHelp } from "./rules.js";
import {
  DEFAULT_COSTS,
  expandStrategies,
  MAX_VARIANTS,
  PRESETS,
  runBacktest,
  type BacktestResult,
  type StrategyInput,
  type StrategyResult,
} from "./engine.js";

export { runBacktest, expandStrategies, PRESETS } from "./engine.js";
export type { BacktestResult, StrategyInput, StrategySpec } from "./engine.js";

const log = createLogger("plugin:backtest");

const YEAR_MS = 365.25 * 86_400_000;
const DEFAULT_YEARS = 5;
const DEFAULT_HOLDOUT = 30;
/** Rows the ranking shows; the saved report keeps every variant. */
const SHOWN = 15;

export interface BacktestRequest {
  pair?: string;
  interval?: string;
  years?: number;
  /** YYYY-MM-DD; overrides years. */
  from?: string;
  to?: string;
  presets?: string[];
  strategies?: StrategyInput[];
  feePct?: number;
  slippagePct?: number;
  holdoutPct?: number;
  /** "dex": a Uniswap v3 pool's swaps on Ethereum (default for BTC and ETH); "cex": Binance, Bitstamp before it. */
  source?: "dex" | "cex";
  /** A Uniswap v3 pool on Ethereum to read the history from (implies dex). */
  pool?: string;
}

/** Runs share the candle cache on disk — one at a time, so two never fetch and write the same file at once. */
let queue: Promise<unknown> = Promise.resolve();

function serial<T>(fn: () => Promise<T>): Promise<T> {
  const job = queue.then(fn);
  queue = job.catch(() => undefined);
  return job;
}

/** Where the history is cached, and how it is reached. */
function marketSettings(runtime: IAgentRuntime): { dataDir: string; proxy: string | undefined; rpcUrls: string[] } {
  return {
    dataDir: runtime.getSetting("LAINOS_DATA_DIR") ?? "./data",
    // Bitstamp is unreachable from some networks without one; the daemon's proxy lives in LAINOS_MODEL_PROXY.
    proxy: runtime.getSetting("LAINOS_BACKTEST_PROXY") || runtime.getSetting("HTTPS_PROXY") || runtime.getSetting("LAINOS_MODEL_PROXY") || undefined,
    rpcUrls: (runtime.getSetting("LAINOS_BACKTEST_ETH_RPC") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  };
}

const DOLLARS = new Set(["USDT", "USDC", "FDUSD"]);

/** Where a run's history comes from: a pool on Ethereum, or the exchanges. */
async function historySource(req: BacktestRequest, proxy: string | undefined, rpcUrls: string[]): Promise<DexMarket | null> {
  if (req.pool) return dexMarketFromPool(req.pool, { proxy, rpcUrls });
  if (req.source === "cex") return null;
  const p = normalizePair(req.pair || "BTCUSDT");
  const known = DOLLARS.has(p.quote) ? knownDexMarket(p.base) : undefined;
  if (!known && req.source === "dex") {
    throw new Error(`no known on-chain market for ${p.base}/${p.quote} — give a Uniswap v3 pool address on Ethereum (pool), or use source "cex"`);
  }
  return known ?? null;
}

/** Run a backtest and return the report as text (the full result is saved as JSON beside it). */
export async function backtest(runtime: IAgentRuntime, req: BacktestRequest, onProgress?: (text: string) => void): Promise<string> {
  const interval = (req.interval ?? "1d").toLowerCase();
  if (!isInterval(interval)) throw new Error(`interval must be one of ${Object.keys(INTERVALS).join(", ")}`);
  const day = (s: string, what: string) => {
    const t = Date.parse(`${s}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(t)) throw new Error(`${what} must be a date like 2019-01-31`);
    return t;
  };
  const to = req.to ? day(req.to, "to") + 86_400_000 - 1 : Date.now();
  const years = req.years ?? DEFAULT_YEARS;
  if (!req.from && !(years > 0 && years <= 15)) throw new Error("years must be between 0 and 15");
  const from = req.from ? day(req.from, "from") : to - years * YEAR_MS;
  if (from >= to) throw new Error("the window ends before it starts");
  const presets = req.presets?.length || req.strategies?.length ? (req.presets ?? []) : ["all"];
  const strategies = expandStrategies(presets, req.strategies ?? []);
  const costs = { feePct: req.feePct ?? DEFAULT_COSTS.feePct, slippagePct: req.slippagePct ?? DEFAULT_COSTS.slippagePct };
  if (!(costs.feePct >= 0 && costs.feePct < 5 && costs.slippagePct >= 0 && costs.slippagePct < 5)) throw new Error("fee and slippage are percents under 5");
  const { dataDir, proxy, rpcUrls } = marketSettings(runtime);

  return serial(async () => {
    const dex = await historySource(req, proxy, rpcUrls);
    const result = await runBacktest({
      pair: req.pair || "BTCUSDT",
      interval: interval as Interval,
      from,
      to,
      strategies,
      costs,
      holdoutPct: req.holdoutPct ?? DEFAULT_HOLDOUT,
      dataDir,
      proxy,
      ...(dex ? { dex, rpcUrls } : {}),
      onProgress: (text) => {
        log.info(text);
        onProgress?.(text);
      },
    });
    const saved = await save(result, dataDir);
    log.info(`backtest ${result.pair} ${result.interval}: ${result.results.length} strateg${result.results.length === 1 ? "y" : "ies"}, ${result.bars} bars`);
    return report(result, saved);
  });
}

// ------------------------------------------------------------------ report

const date = (t: number) => new Date(t).toISOString().slice(0, 10);
const SOURCE_NAMES = { binance: "Binance ", bitstamp: "Bitstamp ", dex: "on-chain, every swap of ", kraken: "Kraken spot " } as const;
const signed = (v: number, digits = 1) => `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
/** Totals run to thousands of percent over a decade; past ×10 a multiple reads better. */
const total = (pct: number) => (pct >= 900 ? `×${(1 + pct / 100).toFixed(pct >= 9_900 ? 0 : 1)}` : signed(pct, 0));
const cut = (s: string, n: number) => ([...s].length > n ? `${[...s].slice(0, n - 1).join("")}…` : s.padEnd(n));

/** The account curve in a dozen characters, on a log scale so a decade of bitcoin still has a shape. */
function spark(equity: Float64Array, width = 12): string {
  const pts = Array.from({ length: width }, (_, i) => Math.log(equity[Math.round((i * (equity.length - 1)) / (width - 1))]!));
  const lo = Math.min(...pts);
  const hi = Math.max(...pts);
  return pts.map((v) => "▁▂▃▄▅▆▇█"[hi - lo < 1e-9 ? 3 : Math.round(((v - lo) / (hi - lo)) * 7)]).join("");
}

function row(r: StrategyResult, label: string): string {
  const f = r.full;
  return (
    `${cut(label, 24)} ${(f.cagrPct === null ? "—" : signed(f.cagrPct)).padStart(7)} ${total(f.totalPct).padStart(7)} ${signed(-f.maxDdPct, 0).padStart(6)}` +
    ` ${f.sharpe.toFixed(2).padStart(6)} ${String(r.spec.entry ? f.trades : "—").padStart(6)} ${(f.winPct === null ? "—" : `${f.winPct.toFixed(0)}%`).padStart(4)}` +
    ` ${`${f.exposurePct.toFixed(0)}%`.padStart(4)} │ ${(r.outSample ? signed(r.outSample.totalPct, 0) : "—").padStart(7)}  ${spark(r.run.equity)}`
  );
}

export function report(res: BacktestResult, saved: string | null): string {
  const years = (res.to - res.from) / YEAR_MS;
  const lines: string[] = [];
  lines.push(`📊 backtest · ${res.pair} ${res.interval} · ${date(res.from)} → ${date(res.to)} · ${years.toFixed(1)} years, ${res.bars} bars`);
  lines.push(
    `history: ${res.stretches.map((s) => `${SOURCE_NAMES[s.source]}${s.pair} ${date(s.from)} → ${date(s.to)}`).join(", then ")}`,
  );
  lines.push(`fills at the next bar's open · fee ${res.costs.feePct}% + slippage ${res.costs.slippagePct}% per fill · long only, the whole account`);
  lines.push(
    res.holdoutFrom !== null
      ? `ranked on ${date(res.from)} → ${date(res.holdoutFrom)}; "held-out" is ${date(res.holdoutFrom)} → ${date(res.to)} (last ${res.holdoutPct}%), never used to rank`
      : "ranked on the whole window (no holdout)",
  );
  lines.push("");
  lines.push(`${"strategy".padEnd(24)} ${"CAGR".padStart(7)} ${"total".padStart(7)} ${"maxDD".padStart(6)} ${"Sharpe".padStart(6)} ${"trades".padStart(6)} ${"win".padStart(4)} ${"in".padStart(4)} │ ${"held-out".padStart(7)}  curve`);
  lines.push(row(res.benchmark, "buy & hold"));
  lines.push("─".repeat(24 + 54));
  res.results.slice(0, SHOWN).forEach((r, i) => lines.push(row(r, `${i + 1}. ${r.spec.name}`)));
  if (res.results.length > SHOWN) lines.push(`… ${res.results.length - SHOWN} more variant(s) in the saved report`);

  // Year by year: the benchmark and the top three, side by side.
  const cols = [res.benchmark, ...res.results.slice(0, 3)];
  const names = ["buy & hold", ...res.results.slice(0, 3).map((r, i) => `${i + 1}. ${r.spec.name}`)];
  lines.push("");
  lines.push(`${"by year".padEnd(12)}${names.map((n) => cut(n, 15).padStart(16)).join("")}`);
  const firstYear = new Date(res.from).getUTCFullYear();
  const lastYear = new Date(res.to).getUTCFullYear();
  for (let y = firstYear; y <= lastYear; y++) {
    const partial = (y === firstYear && new Date(res.from).getUTCMonth() > 0) || (y === lastYear && new Date(res.to).getUTCMonth() < 11);
    const cells = cols.map((c) => {
      const v = c.yearly.find((x) => x.year === y);
      return (v ? signed(v.pct, 0) : "—").padStart(16);
    });
    lines.push(`${`${y}${partial ? " (part)" : ""}`.padEnd(12)}${cells.join("")}`);
  }

  const best = res.results[0];
  if (best?.outSample && res.benchmark.outSample) {
    const b = best.outSample;
    lines.push("");
    lines.push(
      `top pick on the held-out years: ${signed(b.totalPct, 0)} (max DD ${b.maxDdPct.toFixed(0)}%, Sharpe ${b.sharpe.toFixed(2)}) vs buy & hold ${signed(res.benchmark.outSample.totalPct, 0)}` +
        ` (max DD ${res.benchmark.outSample.maxDdPct.toFixed(0)}%, Sharpe ${res.benchmark.outSample.sharpe.toFixed(2)})`,
    );
  }
  lines.push("");
  lines.push(`periods count ${res.interval} bars · stops and take-profits fill inside the bar, stop first when both are touched`);
  for (const n of res.notes) lines.push(`note: ${n}`);
  if (res.warmupShort) lines.push("note: the history did not reach far enough back to warm every indicator up — the slowest rules sat out the first bars");
  if (saved) lines.push(`every trade and the curves: ${saved}`);
  return lines.join("\n");
}

async function save(res: BacktestResult, dataDir: string): Promise<string | null> {
  const dir = join(dataDir, "backtests");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const file = join(dir, `${stamp}-${res.pair.replace("/", "")}-${res.interval}.json`);
  const curve = (e: Float64Array) => Array.from({ length: Math.min(300, e.length) }, (_, i) => +e[Math.round((i * (e.length - 1)) / Math.max(1, Math.min(300, e.length) - 1))]!.toFixed(6));
  const plain = (r: StrategyResult) => ({ spec: r.spec, full: r.full, inSample: r.inSample, outSample: r.outSample, yearly: r.yearly, curve: curve(r.run.equity), trades: r.run.trades });
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(
      file,
      JSON.stringify(
        { ...res, from: date(res.from), to: date(res.to), holdoutFrom: res.holdoutFrom && date(res.holdoutFrom), benchmark: plain(res.benchmark), results: res.results.map(plain) },
        null,
        1,
      ),
      "utf8",
    );
    return file;
  } catch (err) {
    log.warn("could not save the backtest report", err);
    return null;
  }
}

// ----------------------------------------------------------------- /backtest

export function presetList(): string {
  return Object.entries(PRESETS)
    .map(([name, p]) => {
      const extras = [p.stopLossPct && `stop ${p.stopLossPct}%`, p.takeProfitPct && `take ${p.takeProfitPct}%`, p.trailPct && `trail ${p.trailPct}%`].filter(Boolean);
      return `  ${name.padEnd(15)} ${p.about}\n  ${"".padEnd(15)} in: ${p.entry}${p.exit ? ` · out: ${p.exit}` : ""}${extras.length ? ` · ${extras.join(", ")}` : ""}`;
    })
    .join("\n");
}

const USAGE =
  "usage: /backtest [pair|0xpool] [5y|YYYY-MM-DD [YYYY-MM-DD]] [interval] [dex|cex] [preset…] [fee=0.1] [slip=0.05] [holdout=30]\n" +
  `  e.g. /backtest btc 5y · /backtest eth 3y 4h donchian ema_cross · /backtest btc 10y cex · /backtest 0x…pool 2y\n` +
  "  history: dex — every swap of a Uniswap v3 pool on Ethereum (BTC, ETH, or any pool by address; from 2021-05),\n" +
  "           cex — Binance, Bitstamp before it (any Binance pair; BTC back to 2016 and earlier)\n" +
  `  intervals: ${Object.keys(INTERVALS).join(" ")} · default: BTC, 5 years, 1d, on-chain, every preset\n` +
  "  your own rules: ask Lain — \"generate five bitcoin strategies and test them on ten years\"\n" +
  "  /backtest presets — what each preset does\n" +
  "  on paper from now on: ask Lain to give a strategy to a market of her paper desk";

/** /backtest's words → a request; shared shape with the tool. */
export function parseBacktestArgs(args: string[]): BacktestRequest | string {
  const req: BacktestRequest = { presets: [] };
  const dates: string[] = [];
  for (const raw of args.map((a) => a.trim()).filter(Boolean)) {
    const a = raw.toLowerCase();
    let m: RegExpExecArray | null;
    if ((m = /^(\d+(?:\.\d+)?)y$/.exec(a))) req.years = Number(m[1]);
    else if (isInterval(a)) req.interval = a;
    else if (/^\d{4}-\d{2}-\d{2}$/.test(a)) dates.push(a);
    else if ((m = /^fee=([\d.]+)%?$/.exec(a))) req.feePct = Number(m[1]);
    else if ((m = /^slip(?:page)?=([\d.]+)%?$/.exec(a))) req.slippagePct = Number(m[1]);
    else if ((m = /^holdout=(\d+)%?$/.exec(a))) req.holdoutPct = Number(m[1]);
    else if (a === "all" || PRESETS[a]) req.presets!.push(a);
    else if (a === "dex" || a === "cex") req.source = a;
    else if (/^0x[0-9a-f]{40}$/.test(a)) req.pool = a;
    else if (!req.pair && /^[a-z0-9/_-]{2,20}$/.test(a)) req.pair = raw;
    else return `don't know "${raw}"\n${USAGE}`;
  }
  if (dates.length > 2) return `at most two dates — from and to\n${USAGE}`;
  if (dates[0]) req.from = dates[0];
  if (dates[1]) req.to = dates[1];
  if (!req.presets!.length) req.presets = ["all"];
  return req;
}

/** /backtest in the TUI. */
export async function backtestCommand(runtime: IAgentRuntime, args: string[], onProgress?: (text: string) => void): Promise<string> {
  const first = args[0]?.toLowerCase();
  if (first === "help") return `${USAGE}\n\nrule functions: ${ruleHelp()}`;
  if (first === "presets" || first === "rules") return `presets (periods count bars):\n${presetList()}\n\nrule functions: ${ruleHelp()}`;
  const req = parseBacktestArgs(args);
  if (typeof req === "string") return req;
  return backtest(runtime, req, onProgress);
}

// --------------------------------------------------------------------- tool

const backtestAction: Action = {
  name: "backtest",
  similes: ["backtest_strategy", "test_strategy", "strategy_backtest", "historical_test", "simulate_strategy"],
  description:
    "Test trading strategies on years of history and compare them with buy & hold. History (source): " +
    "'dex' — on-chain, rebuilt from every swap of a Uniswap v3 pool on Ethereum: the default for BTC (WBTC/USDC) and ETH (WETH/USDC), " +
    "or any pool by address (pool); it starts at Uniswap v3's launch, 2021-05, so it covers about five years. " +
    "'cex' — Binance spot candles with Bitstamp before Binance listed the pair: any Binance pair, and the only way to ten years of bitcoin. " +
    "The first run of a pool downloads its swaps (a minute or two), later runs read the cache. Long only, the whole account in or out; a rule is read at a bar's close and fills at the next open, " +
    "fees and slippage on every fill, stops and take-profits inside the bar. Strategies are ranked on the first part of the window and " +
    `the last holdoutPct (default ${DEFAULT_HOLDOUT}) is reported as "held-out", never used to rank — say which strategies held up there, ` +
    "and say it plainly when none beat buy & hold. When asked to generate strategies, write several different ones (trend, breakout, " +
    "mean reversion, momentum, filters) and run them together in ONE call; a parameter sweep is params: {fast: [10, 20], slow: [50, 100]} " +
    `with {fast} and {slow} in the rules (at most ${MAX_VARIANTS} variants). Rules: conditions over series open high low close volume; ` +
    "x[n] = n bars ago; + - * /; > < >= <= == !=; and or not. Periods count bars of the interval. Functions: " +
    `${ruleHelp()}. Presets: ${Object.entries(PRESETS).map(([k, p]) => `${k} (${p.about})`).join("; ")}. ` +
    `Defaults: BTCUSDT, ${DEFAULT_YEARS} years, 1d, every preset when no strategy is given. ` +
    "15m/30m over many years means a slow first download; prefer 1h and up for multi-year runs. " +
    "To trade a tested strategy on paper from now on, give it to one market of your paper desk with paper_desk_strategy.",
  parameters: {
    type: "object",
    properties: {
      pair: { type: "string", description: "Binance pair, e.g. BTCUSDT, ETHUSDT, ETHBTC; a bare coin means against USDT." },
      interval: { type: "string", enum: Object.keys(INTERVALS) },
      years: { type: "number", description: `Years back from now (default ${DEFAULT_YEARS}, up to 15).` },
      from: { type: "string", description: "Start date YYYY-MM-DD (overrides years)." },
      to: { type: "string", description: "End date YYYY-MM-DD (default today)." },
      presets: { type: "array", items: { type: "string" }, description: `Preset names, or "all": ${Object.keys(PRESETS).join(", ")}.` },
      strategies: {
        type: "array",
        description: "Strategies of your own.",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            entry: { type: "string", description: "Condition to buy, e.g. ema(close, {fast}) > ema(close, {slow})." },
            exit: { type: "string", description: "Condition to sell (optional when stops or a trail close it)." },
            stopLossPct: { type: "number" },
            takeProfitPct: { type: "number" },
            trailPct: { type: "number", description: "Sell this far below the best close since entry, percent." },
            maxBars: { type: "number", description: "Sell after this many bars in the market." },
            params: { type: "object", description: "Sweep: {name: [values]} for {name} slots in the rules; one variant per combination." },
          },
          required: ["entry"],
        },
      },
      feePct: { type: "number", description: `Per fill, percent (default ${DEFAULT_COSTS.feePct}).` },
      slippagePct: { type: "number", description: `Per market fill, percent (default ${DEFAULT_COSTS.slippagePct}).` },
      holdoutPct: { type: "number", description: `Last part of the window held out from ranking, percent (default ${DEFAULT_HOLDOUT}, 0 = none).` },
      source: { type: "string", enum: ["dex", "cex"], description: "dex: on-chain Uniswap v3 swaps on Ethereum (default for BTC, ETH); cex: Binance + Bitstamp (ten years; any Binance pair)." },
      pool: { type: "string", description: "A Uniswap v3 pool address on Ethereum to test on (implies dex)." },
    },
  },
  examples: [
    { user: "test a few bitcoin strategies on the last ten years", agent: "Writing five different ones and running them together on ten years of daily bars…" },
    { user: "does the golden cross beat holding ETH?", agent: "Running golden_cross on ETH/USDT against buy & hold…" },
  ],
  async validate() {
    return true;
  },
  async handler(runtime, _state, params) {
    try {
      const text = await backtest(runtime, {
        pair: typeof params.pair === "string" ? params.pair : undefined,
        interval: typeof params.interval === "string" ? params.interval : undefined,
        years: typeof params.years === "number" ? params.years : undefined,
        from: typeof params.from === "string" && params.from ? params.from : undefined,
        to: typeof params.to === "string" && params.to ? params.to : undefined,
        presets: Array.isArray(params.presets) ? params.presets.map(String) : undefined,
        strategies: Array.isArray(params.strategies) ? (params.strategies as StrategyInput[]) : undefined,
        feePct: typeof params.feePct === "number" ? params.feePct : undefined,
        slippagePct: typeof params.slippagePct === "number" ? params.slippagePct : undefined,
        holdoutPct: typeof params.holdoutPct === "number" ? params.holdoutPct : undefined,
        source: params.source === "dex" || params.source === "cex" ? params.source : undefined,
        pool: typeof params.pool === "string" && params.pool ? params.pool : undefined,
      });
      return { ok: true, text };
    } catch (err) {
      return { ok: false, text: `backtest: ${(err as Error).message}` };
    }
  },
};

export const backtestPlugin: Plugin = {
  name: "backtest",
  description:
    "Strategy backtests on years of history — on-chain Uniswap swaps on Ethereum, or Binance and Bitstamp — ranked with a held-out tail.",
  actions: [backtestAction],
};
