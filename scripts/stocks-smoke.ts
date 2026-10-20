#!/usr/bin/env -S npx tsx
/**
 * Stock desk smoke test (offline — synthetic pool states, no RPC, no Yahoo).
 *
 * Pinned here:
 *   1. the in-tick swap math: an exact-in swap on virtual reserves, a round trip
 *      costing about two fees, and USD prices through a multi-hop route;
 *   2. the New York session clock: open on a weekday afternoon, closed on a
 *      Saturday with the next open on Monday at 09:30 New York time;
 *   3. price history rebuilt from swaps, sample by sample;
 *   4. the desk's accounting: a buy, a partial sell, cash and basis that add up;
 *   5. exits: a trend position leaves on its trailing stop, a basis position
 *      when the gap to Wall Street has closed, and a position opened by hand is
 *      never closed by the strategy;
 *   6. BTC (cbBTC, 8 decimals) in two pools: each fill takes the better one, and
 *      a v4 pool charges its protocol fee on top of the LP fee.
 *
 * Run: npm run stocks:smoke
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ASSETS,
  historyFromSwaps,
  POOLS,
  routeSwap,
  swapOut,
  usdPrices,
  usSession,
  v4SwapFee,
  type DeskSwap,
  type PoolState,
} from "../src/plugins/stocks/robinhood.js";
import { StockDeskService } from "../src/plugins/stocks/engine.js";

let checks = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  checks += 1;
  if (!ok) failed += 1;
  console.log(`${ok ? "✓" : "✗"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
};

const Q96 = 2n ** 96n;
/** A pool state at `price` token1 per token0 (whole units) with the given decimals. */
const at = (price: number, dec0: number, dec1: number, liquidity = 10n ** 24n, fee = 500): PoolState => {
  const raw = price * 10 ** (dec1 - dec0);
  return { sqrtPriceX96: BigInt(Math.round(Math.sqrt(raw) * 2 ** 48)) * 2n ** 48n, liquidity, fee };
};
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const CBBTC = "0xcec185eb182c47d1ba1efc84e6959e18cd620be4";
const dec = (token: string) => (token === USDG ? 6 : token === CBBTC ? 8 : 18);

// A market: USDG/WETH at 2400, SPY/WETH at 0.32 WETH, TSLA/SPY at 0.46 SPY, NVDA at $216, the rest at $100.
const states = new Map<string, PoolState>();
const setPrice = (key: string, quotePerBase: number) => {
  const p = POOLS[key]!;
  const asset = ASSETS.find((a) => a.route.at(-1) === key);
  const base = key === "USDG/WETH" ? "0x0bd7d308f8e1639fab988df18a8011f41eacad73" : asset!.token;
  // quotePerBase is "quote per base"; Uniswap wants token1 per token0.
  const price01 = base === p.token0 ? quotePerBase : 1 / quotePerBase;
  states.set(key, at(price01, dec(p.token0), dec(p.token1)));
};
setPrice("USDG/WETH", 2400);
setPrice("SPY/WETH", 0.32);
setPrice("TSLA/SPY", 0.46);
setPrice("NVDA/USDG", 216);
for (const key of ["GOOGL/USDG", "MSTR/USDG", "CRCL/USDG", "HIMS/USDG", "GLD/USDG", "SPCX/USDG"]) setPrice(key, 100);
// BTC at $81,700 in both its pools: the v4 one ten times deeper, the v3 one cheaper per trade.
const setBtc = (key: string, liquidity: bigint, fee: number) => {
  const p = POOLS[key]!;
  states.set(key, at(p.token0 === CBBTC ? 81_700 : 1 / 81_700, dec(p.token0), dec(p.token1), liquidity, fee));
};
setBtc("BTC/USDG 0.15%", 6n * 10n ** 11n, v4SwapFee(262 | (262 << 12), 1500));
setBtc("BTC/USDG 0.05%", 6n * 10n ** 10n, 500);

// 1. math
const px = usdPrices(states);
const close = (a: number, b: number, tol = 0.002) => Math.abs(a / b - 1) < tol;
check("ETH priced through USDG/WETH", close(px.get("0x0bd7d308f8e1639fab988df18a8011f41eacad73")!, 2400));
check("SPY priced through WETH", close(px.get(ASSETS.find((a) => a.symbol === "SPY")!.token)!, 768));
check("TSLA priced through SPY and WETH", close(px.get(ASSETS.find((a) => a.symbol === "TSLA")!.token)!, 0.46 * 768));
const nvda = ASSETS.find((a) => a.symbol === "NVDA")!;
const thousand = 1000n * 10n ** 6n;
const got = routeSwap(nvda, states, "buy", thousand)!;
check("$1000 buys about 1000/216 NVDA less the fee", close(Number(got) / 1e18, (1000 / 216) * 0.9995, 0.001), `${Number(got) / 1e18}`);
const back = routeSwap(nvda, states, "sell", got)!;
const loss = (1 - Number(back) / Number(thousand)) * 100;
check("a round trip costs about two fees (0.05% each)", loss > 0.09 && loss < 0.12, `${loss.toFixed(4)}%`);
const tsla = ASSETS.find((a) => a.symbol === "TSLA")!;
const tslaLoss = (1 - Number(routeSwap(tsla, states, "sell", routeSwap(tsla, states, "buy", thousand)!)!) / Number(thousand)) * 100;
check("a three-hop round trip pays every hop's fee both ways", tslaLoss > loss * 2, `${tslaLoss.toFixed(4)}%`);
check("no liquidity, no fill", swapOut({ sqrtPriceX96: Q96, liquidity: 0n, fee: 500 }, true, 1000n) === 0n);

// 6. BTC
const btc = ASSETS.find((a) => a.symbol === "BTC")!;
check("BTC priced through its pool, 8 decimals and all", close(px.get(btc.token)!, 81_700), `${px.get(btc.token)}`);
const viaPool = (key: string, dollars: number) => swapOut(states.get(key)!, POOLS[key]!.token0 === USDG, BigInt(dollars * 1e6));
check("a small BTC order fills in the thin 0.05% pool", routeSwap(btc, states, "buy", 100n * 10n ** 6n) === viaPool("BTC/USDG 0.05%", 100) && viaPool("BTC/USDG 0.05%", 100) > viaPool("BTC/USDG 0.15%", 100));
check("a big BTC order fills in the deep pool", routeSwap(btc, states, "buy", 20_000n * 10n ** 6n) === viaPool("BTC/USDG 0.15%", 20_000) && viaPool("BTC/USDG 0.15%", 20_000) > viaPool("BTC/USDG 0.05%", 20_000));
check("a v4 swap pays the protocol fee on top of the LP fee (1500 + 262 → 1762)", v4SwapFee(262 | (262 << 12), 1500) === 1762 && v4SwapFee(0, 3000) === 3000);

// 2. the session clock
const friday = Date.parse("2026-10-16T17:34:00Z"); // 13:34 in New York (EDT)
const saturday = Date.parse("2026-10-17T15:00:00Z");
check("Friday 13:34 New York is open", usSession(friday).session === "open");
const sat = usSession(saturday);
check("Saturday is closed", sat.session === "closed");
check("the next open is Monday 09:30 New York (13:30 UTC)", new Date(sat.nextOpenMs).toISOString().startsWith("2026-10-19T13:30"), new Date(sat.nextOpenMs).toISOString());
check("Friday 19:00 New York is after-hours", usSession(Date.parse("2026-10-16T23:00:00Z")).session === "post");

// 3. history from swaps
const nvdaPool = POOLS["NVDA/USDG"]!;
const at216 = states.get("NVDA/USDG")!;
const at220 = at(nvdaPool.token0 === nvda.token ? 220 : 1 / 220, dec(nvdaPool.token0), dec(nvdaPool.token1));
const swaps: DeskSwap[] = [
  { symbol: "NVDA", side: "buy", qty: 1, usd: 216, block: 1n, ts: 100, pool: "NVDA/USDG", sqrtPriceX96: at216.sqrtPriceX96 },
  { symbol: "NVDA", side: "buy", qty: 1, usd: 220, block: 2n, ts: 130, pool: "NVDA/USDG", sqrtPriceX96: at220.sqrtPriceX96 },
];
const hist = historyFromSwaps(swaps, states, 100, 160, 10).get("NVDA")!;
check("history steps when a swap moves the pool", hist.length === 7 && close(hist[0]!, 216) && close(hist[2]!, 216) && close(hist[3]!, 220) && close(hist.at(-1)!, 220), hist.map((x) => x.toFixed(1)).join(","));

// 4–5. the desk, against a stub chain: states are injected, nothing is read
const dataDir = mkdtempSync(join(tmpdir(), "lainos-stocks-"));
const chain = { configured: true, chain: { id: 4663, name: "Robinhood Chain" }, publicClient: undefined };
const runtime = {
  getSetting: (k: string) => ({ LAINOS_DATA_DIR: dataDir, LAINOS_STOCKS_INTERVAL_MS: "3600000" })[k],
  getService: (n: string) => (n === "chain" ? chain : undefined),
} as never;
const desk = new StockDeskService();
await desk.start(runtime);
const d = desk as unknown as {
  states: Map<string, PoolState>;
  prices: Map<string, number>;
  lastTickAt: number;
  walk: (rules: unknown) => Promise<void>;
  quotes: { symbol: string; premiumPct: number | null }[];
  street: Map<string, { price: number; at: number; prevClose: number | null }>;
};
const inject = () => {
  d.states = new Map(states);
  d.prices = usdPrices(states);
  d.lastTickAt = Date.now();
};
inject();
await desk.buy("NVDA", 1000, "operator");
check("a buy spends the cash", desk.cash === 9_000n * 10n ** 6n);
await desk.sell("NVDA", "$400", "operator");
const pos = desk.positions.find((p) => p.symbol === "NVDA")!;
check("a partial sell leaves the rest with its share of the basis", pos && Math.abs(Number(pos.cost) / 1e6 - 600) < 1, pos ? `${Number(pos.cost) / 1e6}` : "gone");
// "$400" sells as many tokens as $400 of proceeds takes — the fee shows in the quantity, not the cash.
check("a dollar-sized sell brings back those dollars", close(Number(desk.cash) / 1e6, 9_400, 0.0005), `${Number(desk.cash) / 1e6}`);

// a trend position rides up, then gives back more than the trail
await desk.buy("SPCX", 1000, "auto", "trend: test", "trend");
setPrice("SPCX/USDG", 103);
inject();
await d.walk(desk.rules);
check("a trend position marks its new high", desk.positions.some((p) => p.symbol === "SPCX"));
setPrice("SPCX/USDG", 102.2);
inject();
await d.walk(desk.rules);
const spcx = desk.closed.find((c) => c.symbol === "SPCX");
check("the trailing stop takes it out off the high, in profit", spcx?.reason.startsWith("trailing stop") === true && (spcx?.pnlPct ?? 0) > 0, spcx?.reason);

// a basis position leaves once the token is back at Wall Street's price
await desk.buy("GOOGL", 1000, "auto", "basis: test", "basis");
d.street.set("GOOGL", { price: 100, at: Date.now() / 1000, prevClose: null });
d.quotes = [{ symbol: "GOOGL", premiumPct: 0.01 }];
await d.walk(desk.rules);
check("a basis position exits when the gap has closed", desk.closed.some((c) => c.symbol === "GOOGL" && c.reason.startsWith("gap closed")));

// the operator's NVDA, down hard, is still the operator's to close
setPrice("NVDA/USDG", 190);
inject();
await d.walk(desk.rules);
check("a position opened by hand is never closed by the strategy", desk.positions.some((p) => p.symbol === "NVDA"));

await desk.buy("btc", 1000, "operator");
const btcPos = desk.positions.find((p) => p.symbol === "BTC");
check("the desk buys BTC in satoshis", btcPos !== undefined && close(Number(btcPos.qty) / 1e8, (1000 / 81_700) * 0.9995, 0.001), btcPos?.qty);

await desk.stop();
console.log(`\nstocks smoke ${failed ? `FAILED (${failed}/${checks})` : `ok (${checks} checks)`}`);
process.exit(failed ? 1 : 0);
