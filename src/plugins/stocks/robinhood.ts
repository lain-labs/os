/**
 * The Robinhood Chain stock market, as a paper desk reads it: the tokenized
 * stocks Robinhood issues on its chain ("Robinhood Tokens"), the Uniswap pools
 * they actually trade in, their Wall Street prices, and the clock of the US
 * session they shadow.
 *
 * Facts, checked 2026-10-16: pools found by liquidity on GeckoTerminal, every
 * price then recomputed from the pool's own state on chain and compared with
 * Wall Street (NVDA 215.82 on chain vs 215.53, TSLA via TSLA→SPY→WETH→USDG
 * 353.25 vs 353.26). Nothing here builds a transaction.
 *
 * Of the big coins only BTC trades for real here, as Coinbase's cbBTC (checked
 * 2026-10-17: $81,696–81,782 on chain vs $81,788 on Binance). The "SOL", "XRP",
 * "BNB", "TRX", "ZEC" and "LINK" tokens on the chain are look-alikes: unbacked,
 * priced nowhere near the coin, or sitting in seeded pools that never trade.
 *
 * A v4 swap pays the pool's LP fee plus the PoolManager's protocol fee on top
 * (cbBTC/USDG: 1500 + 262 → 1762 pips in its Swap events), so the desk charges both.
 *
 * Fill math is Uniswap's within the current tick: a v3/v4 pool at price √P
 * with liquidity L trades like a constant-product pool on virtual reserves
 * x = L/√P, y = L·√P. Exact while a trade stays inside the tick — true for
 * desk-sized orders in these pools; a fill that would cross ticks is a little
 * optimistic, and the board says fills are in-tick.
 */
import { decodeAbiParameters, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { fetch as undiciFetch, ProxyAgent } from "undici";

export const ROBINHOOD_CHAIN_ID = 4663;
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as Address;
export const STATE_VIEW = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b" as Address;
export const V4_POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951" as Address;
export const T_V3_SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
export const T_V4_SWAP = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";

const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const CBBTC = "0xcec185eb182c47d1ba1efc84e6959e18cd620be4";

/** One pool, as a desk reads it. */
export interface PoolSpec {
  key: string;
  kind: "v3" | "v4";
  /** v3: the pool contract; v4: the pool id. */
  id: string;
  /** The two tokens, sorted (token0 < token1 by address, as Uniswap orders them). */
  token0: string;
  token1: string;
}

/** A tradeable asset: its token, its decimals, and the route that buys it with USDG. */
export interface AssetSpec {
  symbol: string;
  name: string;
  token: string;
  decimals: number;
  /** Pool keys from USDG to the asset, in order. */
  route: string[];
  /** Other routes a fill may take; each trade takes whichever returns the most, as a router would. */
  alt?: string[][];
  /** Wall Street ticker; null when there is none to compare with (a private company, a coin). */
  ticker: string | null;
}

const pool = (key: string, kind: "v3" | "v4", id: string, a: string, b: string): PoolSpec => {
  const [token0, token1] = [a.toLowerCase(), b.toLowerCase()].sort();
  return { key, kind, id: id.toLowerCase(), token0: token0!, token1: token1! };
};

export const POOLS: Record<string, PoolSpec> = Object.fromEntries(
  [
    pool("USDG/WETH", "v3", "0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca", USDG, WETH),
    pool("SPY/WETH", "v3", "0xddcbba3666f578e3f09516f21ff85bfee859ab5e", "0x117cc2133c37b721f49de2a7a74833232b3b4c0c", WETH),
    pool("TSLA/SPY", "v4", "0x3ea70ce0b34473692549f97e630a1d82dc05cea94fa55f81b50f10c8c6d8186f", "0x322f0929c4625ed5bad873c95208d54e1c003b2d", "0x117cc2133c37b721f49de2a7a74833232b3b4c0c"),
    pool("NVDA/USDG", "v3", "0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3", "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec", USDG),
    pool("GOOGL/USDG", "v3", "0x34d0dc122cf9a8eb296fc5e0d3a233625d7d19b7", "0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3", USDG),
    pool("MSTR/USDG", "v4", "0x319bac87e616a89e241c10aeb8afd4892a852cdd8b373cd9765ecddc40b87cfe", "0xec262a75e413fafd0df80480274532c79d42da09", USDG),
    pool("CRCL/USDG", "v3", "0x654e4143e82a5824445ade0824351c2a9acd95a8", "0xdf0992e440dd0be65bd8439b609d6d4366bf1cb5", USDG),
    pool("HIMS/USDG", "v3", "0xc8c90d3a1c1a24967e773ac2ad0d456ba3e31f64", "0xccee82fe024c36fa15e1005ede3e9e4787e23d09", USDG),
    pool("GLD/USDG", "v3", "0xba2f1ed4ceb2169d538d1e614d847e83c5a55913", "0xc9a981fee1f9dec688bb123ccdecc63d0debfc4e", USDG),
    pool("SPCX/USDG", "v3", "0xc61284332117c3fb23a2a56cceffd07f7af60029", "0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea", USDG),
    // The deeper pool first: it is the one BTC's price is read from. The thin 0.05% one fills small orders cheaper.
    pool("BTC/USDG 0.15%", "v4", "0x94c62eebf6454231b2fcd0259ede448ae3c6ad8617718cd88dab20b30cfae48a", CBBTC, USDG),
    pool("BTC/USDG 0.05%", "v3", "0x9664d869540e9d0a76f12c6623946c6d5d201e09", CBBTC, USDG),
  ].map((p) => [p.key, p]),
);

export const ASSETS: AssetSpec[] = [
  { symbol: "NVDA", name: "NVIDIA", token: "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec", decimals: 18, route: ["NVDA/USDG"], ticker: "NVDA" },
  { symbol: "SPY", name: "S&P 500 ETF", token: "0x117cc2133c37b721f49de2a7a74833232b3b4c0c", decimals: 18, route: ["USDG/WETH", "SPY/WETH"], ticker: "SPY" },
  { symbol: "TSLA", name: "Tesla", token: "0x322f0929c4625ed5bad873c95208d54e1c003b2d", decimals: 18, route: ["USDG/WETH", "SPY/WETH", "TSLA/SPY"], ticker: "TSLA" },
  { symbol: "GOOGL", name: "Alphabet", token: "0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3", decimals: 18, route: ["GOOGL/USDG"], ticker: "GOOGL" },
  { symbol: "MSTR", name: "Strategy", token: "0xec262a75e413fafd0df80480274532c79d42da09", decimals: 18, route: ["MSTR/USDG"], ticker: "MSTR" },
  { symbol: "CRCL", name: "Circle", token: "0xdf0992e440dd0be65bd8439b609d6d4366bf1cb5", decimals: 18, route: ["CRCL/USDG"], ticker: "CRCL" },
  { symbol: "HIMS", name: "Hims & Hers", token: "0xccee82fe024c36fa15e1005ede3e9e4787e23d09", decimals: 18, route: ["HIMS/USDG"], ticker: "HIMS" },
  { symbol: "GLD", name: "SPDR Gold", token: "0xc9a981fee1f9dec688bb123ccdecc63d0debfc4e", decimals: 18, route: ["GLD/USDG"], ticker: "GLD" },
  { symbol: "SPCX", name: "SpaceX (private)", token: "0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea", decimals: 18, route: ["SPCX/USDG"], ticker: null },
  { symbol: "BTC", name: "Bitcoin (cbBTC)", token: CBBTC, decimals: 8, route: ["BTC/USDG 0.15%"], alt: [["BTC/USDG 0.05%"]], ticker: null },
  { symbol: "ETH", name: "Ether", token: WETH, decimals: 18, route: ["USDG/WETH"], ticker: null },
];

export const USDG_TOKEN = USDG;
export const USDG_DECIMALS = 6;

export interface PoolState {
  sqrtPriceX96: bigint;
  liquidity: bigint;
  /** Fee in pips (1e-6): 500 = 0.05 %. */
  fee: number;
}

const V3_ABI = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function liquidity() view returns (uint128)",
  "function fee() view returns (uint24)",
]);
const STATE_VIEW_ABI = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128)",
]);

/**
 * What a v4 swap really pays, in pips: the protocol fee (12 bits per direction
 * in slot0) taken first, the LP fee on the rest — Uniswap's ProtocolFeeLibrary.
 * The two directions can differ; the desk keeps one fee per pool and takes the dearer.
 */
export function v4SwapFee(protocolFee: number, lpFee: number): number {
  const protocol = Math.max(protocolFee & 0xfff, protocolFee >> 12);
  return protocol + lpFee - Math.floor((protocol * lpFee) / 1_000_000);
}

/** Every pool's live state in one Multicall3 round trip; unreadable pools are left out. */
export async function poolStates(client: PublicClient): Promise<Map<string, PoolState>> {
  const pools = Object.values(POOLS);
  const calls: unknown[] = pools.flatMap((p): unknown[] =>
    p.kind === "v3"
      ? [
          { address: p.id as Address, abi: V3_ABI, functionName: "slot0" },
          { address: p.id as Address, abi: V3_ABI, functionName: "liquidity" },
          { address: p.id as Address, abi: V3_ABI, functionName: "fee" },
        ]
      : [
          { address: STATE_VIEW, abi: STATE_VIEW_ABI, functionName: "getSlot0", args: [p.id as Hex] },
          { address: STATE_VIEW, abi: STATE_VIEW_ABI, functionName: "getLiquidity", args: [p.id as Hex] },
        ],
  );
  const res = (await client.multicall({ multicallAddress: MULTICALL3, allowFailure: true, contracts: calls as never })) as {
    status: "success" | "failure";
    result?: unknown;
  }[];
  const out = new Map<string, PoolState>();
  let i = 0;
  for (const p of pools) {
    const n = p.kind === "v3" ? 3 : 2;
    const r = res.slice(i, i + n);
    i += n;
    if (r.some((x) => x.status !== "success")) continue;
    const slot = r[0]!.result as readonly [bigint, number, ...unknown[]];
    out.set(p.key, {
      sqrtPriceX96: slot[0],
      liquidity: r[1]!.result as bigint,
      fee: p.kind === "v3" ? Number(r[2]!.result) : v4SwapFee(Number(slot[2]), Number(slot[3])),
    });
  }
  return out;
}

const Q96 = 2n ** 96n;

/** token1 per token0 in whole units, from √P. */
export function midPrice(state: PoolState, dec0: number, dec1: number): number {
  const sqrt = Number(state.sqrtPriceX96) / 2 ** 96;
  return sqrt * sqrt * 10 ** (dec0 - dec1);
}

/** Output of an exact-in swap inside the current tick (virtual reserves x = L/√P, y = L·√P). */
export function swapOut(state: PoolState, zeroForOne: boolean, amountIn: bigint): bigint {
  if (amountIn <= 0n || state.liquidity <= 0n || state.sqrtPriceX96 <= 0n) return 0n;
  const net = (amountIn * BigInt(1_000_000 - state.fee)) / 1_000_000n;
  const x = (state.liquidity * Q96) / state.sqrtPriceX96;
  const y = (state.liquidity * state.sqrtPriceX96) / Q96;
  return zeroForOne ? (y * net) / (x + net) : (x * net) / (y + net);
}

/** Token decimals the desk knows (USDG, WETH and every asset). */
export function decimalsOf(token: string): number {
  if (token === USDG) return USDG_DECIMALS;
  return ASSETS.find((a) => a.token === token)?.decimals ?? 18;
}

/**
 * Fill a trade: USDG in → asset out (buy), or asset in → USDG out (sell), along
 * whichever of the asset's routes returns the most; null when none can be read.
 */
export function routeSwap(asset: AssetSpec, states: Map<string, PoolState>, side: "buy" | "sell", amountIn: bigint): bigint | null {
  let best: bigint | null = null;
  for (const route of [asset.route, ...(asset.alt ?? [])]) {
    const out = walkRoute(asset, route, states, side, amountIn);
    if (out !== null && (best === null || out > best)) best = out;
  }
  return best;
}

/** One route, hop by hop through each pool's live state, every hop paying its own fee. */
function walkRoute(asset: AssetSpec, route: string[], states: Map<string, PoolState>, side: "buy" | "sell", amountIn: bigint): bigint | null {
  const hops = side === "buy" ? route : [...route].reverse();
  let token = side === "buy" ? USDG : asset.token;
  let amount = amountIn;
  for (const key of hops) {
    const p = POOLS[key]!;
    const st = states.get(key);
    if (!st) return null;
    const zeroForOne = token === p.token0;
    if (!zeroForOne && token !== p.token1) return null;
    amount = swapOut(st, zeroForOne, amount);
    token = zeroForOne ? p.token1 : p.token0;
  }
  return amount;
}

/** USD price of every token the pools can reach from USDG (USDG itself is $1). */
export function usdPrices(states: Map<string, PoolState>): Map<string, number> {
  const px = new Map<string, number>([[USDG, 1]]);
  // Each pool prices the token it adds from one it already knows; a few passes reach the whole graph.
  for (let pass = 0; pass < 4; pass++) {
    for (const p of Object.values(POOLS)) {
      const st = states.get(p.key);
      if (!st) continue;
      const m = midPrice(st, decimalsOf(p.token0), decimalsOf(p.token1)); // token1 per token0
      if (px.has(p.token1) && !px.has(p.token0)) px.set(p.token0, m * px.get(p.token1)!);
      else if (px.has(p.token0) && !px.has(p.token1) && m > 0) px.set(p.token1, px.get(p.token0)! / m);
    }
  }
  return px;
}

/** One swap in one of the desk's pools, as the tape shows it. */
export interface DeskSwap {
  symbol: string;
  side: "buy" | "sell";
  /** Asset amount, whole units. */
  qty: number;
  /** Size in USD at the current prices. */
  usd: number;
  block: bigint;
  ts: number;
  /** The pool it happened in, and that pool's price right after it. */
  pool: string;
  sqrtPriceX96: bigint;
}

interface RawLog {
  address: string;
  topics: string[];
  data: Hex;
  blockNumber: Hex;
}

/** Which asset a pool's swaps are about: the one whose route ends in it (for TSLA/SPY that is TSLA). */
function poolAsset(p: PoolSpec): AssetSpec | undefined {
  return ASSETS.find((a) => [a.route, ...(a.alt ?? [])].some((r) => r.at(-1) === p.key));
}

/**
 * Swaps in the desk's pools over a block range: v3 pools by address, v4 by
 * pool id on the PoolManager. Sign conventions differ — v3 reports amounts
 * from the pool's side, v4 from the swapper's — and both are turned into
 * "someone bought / sold the asset".
 */
export async function deskSwaps(
  client: PublicClient,
  fromBlock: bigint,
  toBlock: bigint,
  clock: (block: bigint) => number,
  prices: Map<string, number>,
): Promise<DeskSwap[]> {
  const hex = (n: bigint) => `0x${n.toString(16)}`;
  const v3 = Object.values(POOLS).filter((p) => p.kind === "v3");
  const v4 = Object.values(POOLS).filter((p) => p.kind === "v4");
  const [l3, l4] = (await Promise.all([
    client.request({ method: "eth_getLogs", params: [{ address: v3.map((p) => p.id), fromBlock: hex(fromBlock), toBlock: hex(toBlock), topics: [T_V3_SWAP] }] } as never),
    client.request({ method: "eth_getLogs", params: [{ address: V4_POOL_MANAGER, fromBlock: hex(fromBlock), toBlock: hex(toBlock), topics: [T_V4_SWAP, v4.map((p) => p.id)] }] } as never),
  ])) as [RawLog[], RawLog[]];
  const out: DeskSwap[] = [];
  const take = (p: PoolSpec | undefined, a0: bigint, a1: bigint, sqrtPriceX96: bigint, swapperSide: boolean, log: RawLog) => {
    if (!p) return;
    const asset = poolAsset(p);
    if (!asset) return;
    const assetIs0 = asset.token === p.token0;
    // Positive = the swapper received it (v4); the pool received it (v3) — flip v3 to the swapper's view.
    const assetDelta = (assetIs0 ? a0 : a1) * (swapperSide ? 1n : -1n);
    if (assetDelta === 0n) return;
    const qty = Number(assetDelta < 0n ? -assetDelta : assetDelta) / 10 ** asset.decimals;
    const block = BigInt(log.blockNumber);
    out.push({ symbol: asset.symbol, side: assetDelta > 0n ? "buy" : "sell", qty, usd: qty * (prices.get(asset.token) ?? 0), block, ts: clock(block), pool: p.key, sqrtPriceX96 });
  };
  for (const log of l3) {
    const [a0, a1, sqrt] = decodeAbiParameters([{ type: "int256" }, { type: "int256" }, { type: "uint160" }], `0x${log.data.slice(2, 194)}` as Hex);
    take(v3.find((p) => p.id === log.address.toLowerCase()), a0, a1, sqrt, false, log);
  }
  for (const log of l4) {
    const [a0, a1, sqrt] = decodeAbiParameters([{ type: "int128" }, { type: "int128" }, { type: "uint160" }], `0x${log.data.slice(2, 194)}` as Hex);
    take(v4.find((p) => p.id === log.topics[1]?.toLowerCase()), a0, a1, sqrt, true, log);
  }
  return out.sort((a, b) => (a.block === b.block ? 0 : a.block < b.block ? -1 : 1));
}

/**
 * Price history rebuilt from swaps: every swap leaves its pool at a known
 * price, so stepping through them in order and sampling every `stepSec` gives
 * each asset's USD price over the window. A pool with no swap in the window
 * holds its current price throughout.
 */
export function historyFromSwaps(
  swaps: DeskSwap[],
  current: Map<string, PoolState>,
  fromTs: number,
  toTs: number,
  stepSec: number,
): Map<string, number[]> {
  const sqrt = new Map<string, bigint>();
  // Start each pool at its first price in the window (or now, if it never traded).
  for (const [key, st] of current) sqrt.set(key, st.sqrtPriceX96);
  const seen = new Set<string>();
  for (const s of swaps) {
    if (!seen.has(s.pool)) {
      seen.add(s.pool);
      sqrt.set(s.pool, s.sqrtPriceX96);
    }
  }
  const out = new Map<string, number[]>(ASSETS.map((a) => [a.symbol, []]));
  let i = 0;
  for (let t = fromTs; t <= toTs; t += stepSec) {
    while (i < swaps.length && swaps[i]!.ts <= t) {
      sqrt.set(swaps[i]!.pool, swaps[i]!.sqrtPriceX96);
      i++;
    }
    const states = new Map<string, PoolState>([...sqrt].map(([k, v]) => [k, { sqrtPriceX96: v, liquidity: 1n, fee: 0 }]));
    const px = usdPrices(states);
    for (const a of ASSETS) {
      const p = px.get(a.token);
      if (p) out.get(a.symbol)!.push(p);
    }
  }
  return out;
}

/** A Wall Street price: the last minute bar (pre/post-market included) and the regular close before it. */
export interface StreetQuote {
  price: number;
  /** Unix seconds of that bar. */
  at: number;
  prevClose: number | null;
}

/** Last prices for tickers from Yahoo's chart API (one request each, in parallel). */
export async function streetQuotes(tickers: string[], proxy?: string): Promise<Map<string, StreetQuote>> {
  const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
  const out = new Map<string, StreetQuote>();
  await Promise.all(
    tickers.map(async (t) => {
      try {
        const res = await undiciFetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?range=1d&interval=1m&includePrePost=true`,
          { headers: { "user-agent": "Mozilla/5.0" }, ...(dispatcher ? { dispatcher } : {}) },
        );
        if (!res.ok) return;
        const body = (await res.json()) as {
          chart: { result?: { meta: { regularMarketPrice?: number; regularMarketTime?: number; chartPreviousClose?: number }; timestamp?: number[]; indicators: { quote: { close: (number | null)[] }[] } }[] };
        };
        const r = body.chart.result?.[0];
        if (!r) return;
        const closes = r.indicators.quote[0]?.close ?? [];
        const stamps = r.timestamp ?? [];
        let price = r.meta.regularMarketPrice ?? 0;
        let at = r.meta.regularMarketTime ?? 0;
        for (let i = closes.length - 1; i >= 0; i--) {
          const c = closes[i];
          if (c !== null && c !== undefined && stamps[i]) {
            if (stamps[i]! >= at) {
              price = c;
              at = stamps[i]!;
            }
            break;
          }
        }
        if (price > 0) out.set(t, { price, at, prevClose: r.meta.chartPreviousClose ?? null });
      } catch {
        // A ticker Yahoo will not answer just shows no Wall Street price this minute.
      }
    }),
  );
  return out;
}

export type Session = "pre" | "open" | "post" | "closed";

/**
 * The US equity session in New York time (pre 04:00, regular 09:30–16:00,
 * post until 20:00, weekdays). Exchange holidays are not known here — on one
 * the board says "open" while Wall Street's price simply does not move.
 */
export function usSession(nowMs: number): { session: Session; nextOpenMs: number } {
  const ny = (ms: number) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(ms));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return { day: get("weekday"), min: Number(get("hour")) * 60 + Number(get("minute")) };
  };
  const weekday = (d: string) => d !== "Sat" && d !== "Sun";
  const { day, min } = ny(nowMs);
  const session: Session = !weekday(day)
    ? "closed"
    : min >= 570 && min < 960
      ? "open"
      : min >= 240 && min < 570
        ? "pre"
        : min >= 960 && min < 1200
          ? "post"
          : "closed";
  // The next 09:30 New York on a weekday: walk forward a quarter hour at a time, then by the minute.
  let t = nowMs - (nowMs % 60_000) + 60_000;
  for (let i = 0; i < 4 * 24 * 5; i++) {
    const s = ny(t + 15 * 60_000);
    if (weekday(s.day) && s.min >= 570 && s.min < 585) break;
    t += 15 * 60_000;
  }
  for (let i = 0; i < 40; i++) {
    const s = ny(t);
    if (weekday(s.day) && s.min === 570) break;
    t += 60_000;
  }
  return { session, nextOpenMs: session === "open" ? nowMs : t };
}
