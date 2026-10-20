/**
 * PONS v2 on Robinhood Chain: the launchpad where the chain's memecoins are
 * born. A token launches onto its own bonding curve (paired with ETH), trades
 * there until the curve has taken in its graduation threshold, then moves to a
 * Uniswap v4 pool.
 *
 * Everything here is a read or arithmetic — no transaction is ever built. The
 * addresses, event layouts and curve economics are facts verified on chain
 * (2026-09/10); the curve formulas reproduce real CurveBuy/CurveSell fills.
 *
 *   buy:  fee = 1 % of spend, tax = creator tax of spend, net = spend − fee − tax,
 *         tokensOut = net · T / (P + Q + net)
 *   sell: gross = tokensIn · (P + Q) / (T + tokensIn), out = gross − 1 % − tax
 *
 * where Q is the curve's real quote reserve (`trackedQuote`), T the tokens still
 * on it (`trackedTokens`) and P its virtual quote (`phantomQuote`).
 */
import { decodeAbiParameters, parseAbi, type Address, type Hex, type PublicClient } from "viem";

export const PONS_CHAIN_ID = 4663;
export const PONS_V2_FACTORY = "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e" as Address;
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as Address;
export const NATIVE_PAIR = "0x0000000000000000000000000000000000000000";
export const EXPLORER = "https://robinhoodchain.blockscout.com";

export const T_TOKEN_LAUNCHED = "0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607";
export const T_CURVE_BUY = "0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455";
export const T_CURVE_SELL = "0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df";
export const T_CURVE_COMPLETED = "0xf8d37a90738ae063b8b8058b66f5880cf3cf7ab0c5d4fa78219696591dfbfb67";

/** The curve's swap fee, on quote in (buys) and on gross quote out (sells). */
export const CURVE_FEE_BPS = 100n;
/** Creator tax assumed until a curve's own events show its rate. */
export const DEFAULT_TAX_BPS = 100;

const CURVE_ABI = parseAbi([
  "function token() view returns (address)",
  "function pairToken() view returns (address)",
  "function trackedQuote() view returns (uint256)",
  "function trackedTokens() view returns (uint256)",
  "function phantomQuote() view returns (uint256)",
  "function graduationThreshold() view returns (uint256)",
]);
const ERC20_META_ABI = parseAbi(["function symbol() view returns (string)"]);

export interface CurveState {
  curve: Address;
  token: Address;
  pairToken: Address;
  /** Real quote reserve, wei. */
  quote: bigint;
  /** Tokens still on the curve, raw. */
  tokens: bigint;
  /** Virtual quote reserve, wei. */
  phantom: bigint;
  threshold: bigint;
}

/** One curve-side trade, as its log tells it. */
export interface CurveTrade {
  curve: string;
  side: "buy" | "sell";
  /** The receiving wallet — on this chain `buyer` is often a router, the recipient rarely is. */
  wallet: string;
  /** Quote in (buy) or out (sell), wei. */
  quote: bigint;
  tokens: bigint;
  /** Creator tax rate this fill paid, bps. */
  taxBps: number;
  block: bigint;
  /** Unix seconds. */
  ts: number;
}

export interface Launch {
  token: string;
  curve: string;
  deployer: string;
  pairToken: string;
  block: bigint;
  ts: number;
}

interface RawLog {
  address: string;
  topics: string[];
  data: Hex;
  blockNumber: Hex;
  blockTimestamp?: Hex;
}

const hex = (n: bigint) => `0x${n.toString(16)}`;

/** Unix seconds of a block. */
export type BlockClock = (block: bigint) => number;

/**
 * A log's time: its `blockTimestamp` when the RPC fills it in — Robinhood's
 * public endpoint sends "0x0" — otherwise the clock's estimate.
 */
function logTime(log: RawLog, clock: BlockClock): number {
  const stamped = log.blockTimestamp ? Number(BigInt(log.blockTimestamp)) : 0;
  return stamped > 0 ? stamped : clock(BigInt(log.blockNumber));
}

/**
 * A clock anchored on the head block: its timestamp, minus the measured block
 * interval per block back (Robinhood Chain runs ~0.1 s blocks, but measure it).
 */
export async function blockClock(client: PublicClient, head: bigint, sample = 3_000n): Promise<BlockClock> {
  return clockFrom(await measureBlocks(client, head, sample));
}

/** Where the chain's clock stands: a head block, its time, and seconds per block. */
export interface BlockAnchor {
  block: bigint;
  ts: number;
  spb: number;
}

/** Two block headers `sample` apart: the head's timestamp and the measured block interval. */
export async function measureBlocks(client: PublicClient, head: bigint, sample = 3_000n): Promise<BlockAnchor> {
  const [top, past] = await Promise.all([
    client.getBlock({ blockNumber: head }),
    client.getBlock({ blockNumber: head > sample ? head - sample : 0n }),
  ]);
  const span = Number(top.number - past.number);
  return {
    block: head,
    ts: Number(top.timestamp),
    spb: span > 0 ? Number(top.timestamp - past.timestamp) / span : 0.1,
  };
}

/** A clock that extrapolates from an anchor, before or after it. */
export function clockFrom(anchor: BlockAnchor): BlockClock {
  return (block) => Math.round(anchor.ts + Number(block - anchor.block) * anchor.spb);
}
const topicAddress = (t: string) => `0x${t.slice(-40)}`.toLowerCase();

/** eth_getLogs with a raw topic filter (viem's getLogs wants an event ABI). */
async function rawLogs(client: PublicClient, filter: Record<string, unknown>): Promise<RawLog[]> {
  return (await client.request({ method: "eth_getLogs", params: [filter] } as never)) as RawLog[];
}

/** Every curve buy, sell and graduation in a block range (keep ranges ≤ 30k blocks, ≤ 10k logs). */
export async function curveActivity(
  client: PublicClient,
  fromBlock: bigint,
  toBlock: bigint,
  clock: BlockClock,
): Promise<{ trades: CurveTrade[]; completed: string[] }> {
  const logs = await rawLogs(client, {
    fromBlock: hex(fromBlock),
    toBlock: hex(toBlock),
    topics: [[T_CURVE_BUY, T_CURVE_SELL, T_CURVE_COMPLETED]],
  });
  const trades: CurveTrade[] = [];
  const completed: string[] = [];
  for (const log of logs) {
    const curve = log.address.toLowerCase();
    if (log.topics[0] === T_CURVE_COMPLETED) {
      completed.push(curve);
      continue;
    }
    const buy = log.topics[0] === T_CURVE_BUY;
    if (log.topics.length < 3) continue;
    // CurveBuy(buyer, recipient, quoteIn, tokensOut, fee, tax) /
    // CurveSell(seller, recipient, tokensIn, quoteOut, fee, tax)
    const [a, b, fee, tax] = decodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      log.data,
    );
    const quote = buy ? a : b;
    const tokens = buy ? b : a;
    const taxBase = buy ? quote : quote + fee + tax;
    trades.push({
      curve,
      side: buy ? "buy" : "sell",
      wallet: topicAddress(log.topics[2]!),
      quote,
      tokens,
      taxBps: taxBase > 0n ? Number((tax * 10_000n) / taxBase) : DEFAULT_TAX_BPS,
      block: BigInt(log.blockNumber),
      ts: logTime(log, clock),
    });
  }
  return { trades, completed };
}

/** Tokens launched by the PONS v2 factory in a block range. */
export async function launches(client: PublicClient, fromBlock: bigint, toBlock: bigint, clock: BlockClock): Promise<Launch[]> {
  const logs = await rawLogs(client, {
    address: PONS_V2_FACTORY,
    fromBlock: hex(fromBlock),
    toBlock: hex(toBlock),
    topics: [T_TOKEN_LAUNCHED],
  });
  return logs
    .filter((log) => log.topics.length >= 4)
    .map((log) => {
      // TokenLaunched(token, curve, deployer; pairToken, launchConfig, threshold)
      const [pairToken] = decodeAbiParameters([{ type: "address" }], `0x${log.data.slice(2, 66)}` as Hex);
      return {
        token: topicAddress(log.topics[1]!),
        curve: topicAddress(log.topics[2]!),
        deployer: topicAddress(log.topics[3]!),
        pairToken: pairToken.toLowerCase(),
        block: BigInt(log.blockNumber),
        ts: logTime(log, clock),
      };
    });
}

/** Live state of several curves in one Multicall3 round trip; unreadable curves are left out. */
export async function curveStates(client: PublicClient, curves: string[]): Promise<Map<string, CurveState>> {
  const out = new Map<string, CurveState>();
  if (!curves.length) return out;
  const fns = ["token", "pairToken", "trackedQuote", "trackedTokens", "phantomQuote", "graduationThreshold"] as const;
  const res = await client.multicall({
    multicallAddress: MULTICALL3,
    allowFailure: true,
    contracts: curves.flatMap((curve) =>
      fns.map((functionName) => ({ address: curve as Address, abi: CURVE_ABI, functionName }) as const),
    ),
  });
  curves.forEach((curve, i) => {
    const r = res.slice(i * fns.length, (i + 1) * fns.length);
    if (r.some((x) => x.status !== "success")) return;
    const [token, pairToken, quote, tokens, phantom, threshold] = r.map((x) => x.result) as [
      Address, Address, bigint, bigint, bigint, bigint,
    ];
    out.set(curve.toLowerCase(), { curve: curve as Address, token, pairToken, quote, tokens, phantom, threshold });
  });
  return out;
}

/** Which token each curve sells, one round trip; unreadable curves are left out. */
export async function curveTokens(client: PublicClient, curves: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!curves.length) return out;
  const res = await client.multicall({
    multicallAddress: MULTICALL3,
    allowFailure: true,
    contracts: curves.map((curve) => ({ address: curve as Address, abi: CURVE_ABI, functionName: "token" }) as const),
  });
  curves.forEach((curve, i) => {
    const r = res[i];
    if (r?.status === "success") out.set(curve.toLowerCase(), String(r.result).toLowerCase());
  });
  return out;
}

/** Token symbols, one round trip; "?" where a token will not say. */
export async function symbols(client: PublicClient, tokens: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!tokens.length) return out;
  const res = await client.multicall({
    multicallAddress: MULTICALL3,
    allowFailure: true,
    contracts: tokens.map((token) => ({ address: token as Address, abi: ERC20_META_ABI, functionName: "symbol" }) as const),
  });
  tokens.forEach((token, i) => {
    const r = res[i];
    out.set(token.toLowerCase(), r?.status === "success" ? String(r.result).slice(0, 24) : "?");
  });
  return out;
}

/** Tokens a buy of `spend` wei gets, after the 1 % fee and the creator tax. */
export function buyOut(state: CurveState, spend: bigint, taxBps: number): bigint {
  const fee = (spend * CURVE_FEE_BPS) / 10_000n;
  const tax = (spend * BigInt(taxBps)) / 10_000n;
  const net = spend - fee - tax;
  if (net <= 0n) return 0n;
  const denom = state.phantom + state.quote + net;
  return denom > 0n ? (net * state.tokens) / denom : 0n;
}

/** Wei a sell of `tokensIn` returns, after the 1 % fee and the creator tax. */
export function sellOut(state: CurveState, tokensIn: bigint, taxBps: number): bigint {
  if (tokensIn <= 0n) return 0n;
  const gross = (tokensIn * (state.phantom + state.quote)) / (state.tokens + tokensIn);
  const fee = (gross * CURVE_FEE_BPS) / 10_000n;
  const tax = (gross * BigInt(taxBps)) / 10_000n;
  return gross - fee - tax;
}

/**
 * The curve as if our paper buy were in it. A paper fill never moves the real
 * reserves, so marking a position against them would charge its own entry
 * impact a second time on the way out; adding back the quote it put in and
 * the tokens it took makes a round trip with no market move cost the fees
 * only — what it would cost on chain.
 */
export function withOwn(state: CurveState, qty: bigint, netIn: bigint): CurveState {
  if (qty <= 0n || qty >= state.tokens) return state;
  return { ...state, quote: state.quote + netIn, tokens: state.tokens - qty };
}

/** What a buy of `spend` actually put into the curve, after its fee and tax. */
export function netIn(spend: bigint, taxBps: number): bigint {
  return spend - (spend * CURVE_FEE_BPS) / 10_000n - (spend * BigInt(taxBps)) / 10_000n;
}

/** Spot price, wei per whole token (1e18 raw units). */
export function spotPrice(state: CurveState): bigint {
  return state.tokens > 0n ? ((state.phantom + state.quote) * 10n ** 18n) / state.tokens : 0n;
}

/** How far along to graduation, 0–1. */
export function progress(state: CurveState): number {
  return state.threshold > 0n ? Math.min(1, Number((state.quote * 10_000n) / state.threshold) / 10_000) : 0;
}

export function explorerToken(token: string): string {
  return `${EXPLORER}/token/${token}`;
}
