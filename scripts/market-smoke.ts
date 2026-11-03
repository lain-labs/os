#!/usr/bin/env -S npx tsx
/**
 * Trends, signals and the buy guide, headless and offline.
 *
 * Pins what goes out under Lain's name:
 *   1. the three trend sources are read into one shape, numbers only where given;
 *   2. a signal with a price promise is dropped, and at most three survive;
 *   3. a signal says why, what would prove it wrong, the risks — and that it is not a trade;
 *   4. the buy guide names LAIN as her own token, carries the contract, and
 *      ranks pools by depth with the price impact a buy of that size pays.
 *
 * Run: npm run market:smoke
 */
import { formatSignal, parseAnalysis, parseCoinGecko, parseDexScreenerBoosts, parseGeckoTerminal, compact } from "../src/plugins/trends/index.js";
import { guideFor, impactPct, parsePools, poolsText } from "../src/plugins/guide/index.js";

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown): void => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

// 1. Sources.
const cg = parseCoinGecko({ coins: [{ item: { id: "virtual", name: "Virtuals", symbol: "virtual", data: { price: 1.2, price_change_percentage_24h: { usd: 12.5 }, total_volume: "$45,000,000" } } }] });
check("coingecko: symbol, change and volume", cg[0].symbol === "VIRTUAL" && cg[0].change24h === 12.5 && cg[0].volume24h === 45_000_000, cg);
const now = Date.parse("2026-11-03T12:00:00Z");
const gt = parseGeckoTerminal({ data: [{ attributes: { name: "AGENT / SOL", base_token_price_usd: "0.01", volume_usd: { h24: "250000" }, price_change_percentage: { h24: "-8" }, reserve_in_usd: "40000", pool_created_at: "2026-11-01T12:00:00Z" }, relationships: { network: { data: { id: "solana" } } } }] }, now);
check("geckoterminal: chain, liquidity and pool age", gt[0].chain === "solana" && gt[0].liquidityUsd === 40_000 && gt[0].ageDays === 2, gt);
const ds = parseDexScreenerBoosts([{ chainId: "base", tokenAddress: "0xabc", totalAmount: 500, description: "a meme" }]);
check("dexscreener boosts are marked as boosts", ds[0].boost === 500 && compact(ds).includes("boosted 500"), ds);

// 2. Analysis guard.
const analysis = parseAnalysis(JSON.stringify({
  brief: "AI agents lead.",
  signals: [
    { token: "AGENT", chain: "solana", thesis: "volume 6x its liquidity on a 2-day pool", invalidation: "volume falls below $50k", risks: "thin liquidity" },
    { token: "MOON", thesis: "will 100x by Friday", invalidation: "-", risks: "-" },
    { token: "A", thesis: "x", invalidation: "y", risks: "z" },
    { token: "B", thesis: "x", invalidation: "y", risks: "z" },
    { token: "C", thesis: "x", invalidation: "y", risks: "z" },
  ],
}));
check("a price promise is dropped and the rest capped at three", analysis.signals.length <= 3 && !analysis.signals.some((s) => s.token === "MOON"), analysis.signals);
check("garbage from the model is a brief, not a crash", parseAnalysis("no json here").signals.length === 0);

// 3. Signal text.
const text = formatSignal(analysis.signals[0], "2026-11-03T12:00:00.000Z");
check("a signal says why, when it is wrong, the risks, and that it is not a trade", /why:/.test(text) && /wrong if:/.test(text) && /risks:/.test(text) && /not a trade or advice/.test(text), text);

// 4. Buy guide.
const lain = guideFor("$lain");
check("LAIN is her own token and carries its contract", Boolean(lain?.title.includes("my own token") && lain.contract === "0x2b79A071a75dd40f1aca68146d7978204eFD156A"));
check("aliases resolve", guideFor("cyber.sol")?.contract === "E67WWiQY4s9SZbCyFVTh2CEjorEYbhuVJQUZb3Mbpump" && guideFor("solana")?.title === "SOL");
check("impact: $100 into $20k of liquidity ≈ 1%", impactPct(100, 20_000) === 0.99, impactPct(100, 20_000));
const pools = parsePools({ pairs: [
  { dexId: "raydium", chainId: "solana", baseToken: { symbol: "X" }, quoteToken: { symbol: "SOL" }, priceUsd: "1", liquidity: { usd: 5000 } },
  { dexId: "pumpswap", chainId: "solana", baseToken: { symbol: "X" }, quoteToken: { symbol: "SOL" }, priceUsd: "1", liquidity: { usd: 50_000 } },
  { dexId: "dead", chainId: "solana", liquidity: { usd: 0 } },
] });
check("pools ranked by depth, empty ones dropped", pools.length === 2 && pools[0].dex === "pumpswap", pools);
check("the deepest pool is called best", poolsText(pools, 100).startsWith("best: pumpswap"));

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nmarket smoke: all checks passed");
