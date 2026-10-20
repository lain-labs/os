#!/usr/bin/env -S npx tsx
/**
 * Trend paper's backtest: the rule the paper desk runs (strategy.ts), over
 * each market's whole history — LAIN from its PONS launch, CYBER.sol from
 * its first pump.fun trade — with the numbers the daily report gives.
 *
 *   npm run trend-paper:backtest                     # caches under ./data/trend-paper/market
 *   npm run trend-paper:backtest -- --data /tmp/x    # elsewhere
 *   npm run trend-paper:backtest -- --trades         # every fill too
 *
 * Reads only: the same feeds the hourly check reads.
 */
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ASSETS, resolveConfig } from "../src/plugins/trend-paper/config.js";
import { FEEDS } from "../src/plugins/trend-paper/market.js";
import { backtest, fmt } from "../src/plugins/trend-paper/strategy.js";

const args = process.argv.slice(2);
const dataArg = args.indexOf("--data");
const data = resolve(dataArg >= 0 ? args[dataArg + 1]! : (process.env.LAINOS_DATA_DIR ?? "./data"));
const dir = join(data, "trend-paper");
const cfg = resolveConfig(JSON.parse(await readFile(join(dir, "config.json"), "utf8").catch(() => "{}")));
const day = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
const pct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;

for (const asset of ASSETS) {
  const feed = FEEDS[asset];
  const q = feed.quote;
  const snap = await feed.read({ fetch: (url, init) => fetch(url, init), dir: join(dir, "market"), now: Date.now, progress: (t) => console.error(`  … ${t}`) });
  const { summary: s, decisions } = backtest(snap.bars, cfg, cfg.capital[asset]);
  const rt = s.roundTrips;
  console.log(`\n${asset} — ${feed.label}`);
  console.log(`  history   ${day(snap.bars[0]!.t)} → ${day(s.end)} UTC, ${snap.bars.length} hourly bars; trading from ${day(s.start)} (EMA and volume warm-up)`);
  console.log(`  balance   ${fmt(s.capital)} → ${fmt(s.equity)} ${q} (${pct(s.equity / s.capital - 1)})${s.open ? " — still in at the end, marked at the last close" : ""}`);
  console.log(`  holding   ${fmt(s.capital)} → ${fmt(s.hold)} ${q} (${pct(s.hold / s.capital - 1)})`);
  console.log(`  trades    ${s.fills} fills, ${rt} closed round trips, profitable ${rt ? `${s.wins}/${rt} (${Math.round((100 * s.wins) / rt)}%)` : "n/a"}, ${s.skips} entries skipped by the liquidity filter`);
  console.log(`  drawdown  strategy ${(s.maxDrawdown * 100).toFixed(1)}% · holding ${(s.holdMaxDrawdown * 100).toFixed(1)}%`);
  console.log(`  pool now  ${fmt(snap.liquidity)} ${q} (2% = ${fmt(snap.liquidity * cfg.maxLiquidityShare)} ${q})`);
  for (const note of snap.notes) console.log(`  note      ${note}`);
  if (args.includes("--trades")) {
    for (const d of decisions) console.log(`    ${day(d.at)} ${d.action.padEnd(12)} ${fmt(d.price).padStart(12)} ${q}  ${d.reason}`);
  }
}
