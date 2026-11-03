import { formatEther, parseAbi, type Address } from "viem";
import type { ChainService } from "../chain/index.js";
import { ERC20_ABI, FACTORY_ABI, PAIR_ABI } from "../chain/abi.js";

/**
 * Round-trip arbitrage across the DEX's own pools: native → A → B → native.
 * Thin pools that nobody trades drift apart, so a cycle can return more native
 * than it took. Every pair the factory knows is read, every 3-cycle through
 * the wrapped native token is priced with the constant-product formula, and
 * each cycle's best input is found by golden-section search. Before a cycle is
 * sent, the router itself simulates it, so a fee-on-transfer token or a pool
 * that moved shows up as a refused simulation, not a lost swap.
 */

export interface Pool {
  pair: Address;
  token0: string;
  token1: string;
  reserve0: bigint;
  reserve1: bigint;
}

export interface Cycle {
  path: [Address, Address, Address, Address];
  label: string;
  amountIn: bigint;
  amountOut: bigint;
  profit: bigint;
}

const ROUTER = parseAbi([
  "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)",
]);
const WETH = parseAbi(["function withdraw(uint256 wad)"]);

const pairCache = new Map<string, { pairs: { pair: Address; token0: string; token1: string }[]; at: number }>();
const symbolCache = new Map<string, string>();

/** Every pair of the factory with its live reserves. The pair list is re-read every 6 hours. */
export async function loadPools(chain: ChainService): Promise<Pool[]> {
  const client = chain.publicClient;
  const factory = chain.dex.factory;
  let cached = pairCache.get(factory);
  if (!cached || Date.now() - cached.at > 6 * 3_600_000) {
    const length = Number(await client.readContract({ address: factory, abi: FACTORY_ABI, functionName: "allPairsLength" }));
    const pairs: { pair: Address; token0: string; token1: string }[] = [];
    for (let i = 0; i < length; i += 1) {
      try {
        const pair = (await client.readContract({ address: factory, abi: FACTORY_ABI, functionName: "allPairs", args: [BigInt(i)] })) as Address;
        const [token0, token1] = await Promise.all([
          client.readContract({ address: pair, abi: PAIR_ABI, functionName: "token0" }) as Promise<Address>,
          client.readContract({ address: pair, abi: PAIR_ABI, functionName: "token1" }) as Promise<Address>,
        ]);
        pairs.push({ pair, token0: token0.toLowerCase(), token1: token1.toLowerCase() });
      } catch {
        // An unreadable pair is left out.
      }
    }
    cached = { pairs, at: Date.now() };
    pairCache.set(factory, cached);
  }
  const pools: Pool[] = [];
  await Promise.all(
    cached.pairs.map(async (p) => {
      try {
        const [r0, r1] = (await client.readContract({ address: p.pair, abi: PAIR_ABI, functionName: "getReserves" })) as readonly [bigint, bigint, number];
        if (r0 > 0n && r1 > 0n) pools.push({ ...p, reserve0: r0, reserve1: r1 });
      } catch {
        // Skip.
      }
    }),
  );
  return pools;
}

export async function symbolOf(chain: ChainService, token: string): Promise<string> {
  if (token === chain.dex.wrappedNative.toLowerCase()) return chain.nativeSymbol;
  for (const [sym, addr] of Object.entries(chain.tokens)) if (addr.toLowerCase() === token) return sym;
  const hit = symbolCache.get(token);
  if (hit) return hit;
  const sym = (await chain.publicClient
    .readContract({ address: token as Address, abi: ERC20_ABI, functionName: "symbol" })
    .catch(() => token.slice(0, 8))) as string;
  symbolCache.set(token, sym);
  return sym;
}

function amountOut(x: bigint, rin: bigint, rout: bigint): bigint {
  if (x <= 0n) return 0n;
  const inFee = x * 997n;
  return (inFee * rout) / (rin * 1000n + inFee);
}

type Hop = { pool: Pool; from: string; to: string };

function through(hops: Hop[], x: bigint): bigint {
  let amt = x;
  for (const h of hops) {
    const fwd = h.pool.token0 === h.from;
    amt = amountOut(amt, fwd ? h.pool.reserve0 : h.pool.reserve1, fwd ? h.pool.reserve1 : h.pool.reserve0);
  }
  return amt;
}

/** Profitable native → A → B → native cycles, best first, each at its best input up to maxIn. */
export async function findCycles(chain: ChainService, pools: Pool[], maxIn: bigint, minProfit: bigint): Promise<Cycle[]> {
  const w = chain.dex.wrappedNative.toLowerCase();
  const byToken = new Map<string, Pool[]>();
  for (const p of pools) {
    for (const t of [p.token0, p.token1]) {
      const list = byToken.get(t) ?? [];
      list.push(p);
      byToken.set(t, list);
    }
  }
  const other = (p: Pool, t: string) => (p.token0 === t ? p.token1 : p.token0);
  const out: Cycle[] = [];
  for (const p1 of byToken.get(w) ?? []) {
    const a = other(p1, w);
    for (const p2 of byToken.get(a) ?? []) {
      if (p2 === p1) continue;
      const b = other(p2, a);
      if (b === w) continue;
      for (const p3 of byToken.get(b) ?? []) {
        if (p3 === p2 || other(p3, b) !== w) continue;
        const hops: Hop[] = [
          { pool: p1, from: w, to: a },
          { pool: p2, from: a, to: b },
          { pool: p3, from: b, to: w },
        ];
        const profit = (x: bigint) => through(hops, x) - x;
        // Golden-section search on the concave profit curve.
        let lo = maxIn / 10_000n;
        let hi = maxIn;
        if (profit(lo) <= 0n) continue;
        for (let i = 0; i < 60 && hi - lo > maxIn / 100_000n; i += 1) {
          const m1 = lo + ((hi - lo) * 382n) / 1000n;
          const m2 = lo + ((hi - lo) * 618n) / 1000n;
          if (profit(m1) < profit(m2)) lo = m1;
          else hi = m2;
        }
        const best = (lo + hi) / 2n;
        const gain = profit(best);
        if (gain < minProfit) continue;
        out.push({
          path: [w as Address, a as Address, b as Address, w as Address],
          label: `${await symbolOf(chain, w)}→${await symbolOf(chain, a)}→${await symbolOf(chain, b)}→${await symbolOf(chain, w)}`,
          amountIn: best,
          amountOut: best + gain,
          profit: gain,
        });
      }
    }
  }
  return out.sort((x, y) => (y.profit > x.profit ? 1 : y.profit < x.profit ? -1 : 0));
}

/** The router's own answer for a cycle at `amountIn`, or null when it would revert. */
export async function simulateCycle(chain: ChainService, cycle: Cycle, amountIn: bigint): Promise<bigint | null> {
  if (!chain.agentAddress) return null;
  try {
    const { result } = await chain.publicClient.simulateContract({
      account: chain.agentAddress,
      address: chain.dex.router,
      abi: ROUTER,
      functionName: "swapExactETHForTokens",
      args: [0n, cycle.path, chain.agentAddress, BigInt(Math.floor(Date.now() / 1000) + 300)],
      value: amountIn,
    });
    return result[result.length - 1] ?? null;
  } catch {
    return null;
  }
}

/** Send a cycle and unwrap what came back. Returns the native received. */
export async function executeCycle(chain: ChainService, cycle: Cycle, amountIn: bigint, minOut: bigint): Promise<{ hash: `0x${string}`; received: bigint; explorer?: string }> {
  const wallet = chain.walletClient;
  const me = chain.agentAddress;
  if (!wallet || !me) throw new Error("no signer configured");
  const w = chain.dex.wrappedNative;
  const before = (await chain.publicClient.readContract({ address: w, abi: ERC20_ABI, functionName: "balanceOf", args: [me] })) as bigint;
  const hash = await wallet.writeContract({
    account: wallet.account!,
    chain: chain.chain,
    address: chain.dex.router,
    abi: ROUTER,
    functionName: "swapExactETHForTokens",
    args: [minOut, cycle.path, me, BigInt(Math.floor(Date.now() / 1000) + 300)],
    value: amountIn,
  });
  const receipt = await chain.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`cycle reverted (${hash})`);
  const after = (await chain.publicClient.readContract({ address: w, abi: ERC20_ABI, functionName: "balanceOf", args: [me] })) as bigint;
  const received = after - before;
  if (received > 0n) {
    const unwrap = await wallet.writeContract({ account: wallet.account!, chain: chain.chain, address: w, abi: WETH, functionName: "withdraw", args: [received] });
    await chain.publicClient.waitForTransactionReceipt({ hash: unwrap });
  }
  return { hash, received, explorer: chain.explorerTxUrl(hash) };
}

export function fmtNative(wei: bigint): string {
  return String(Math.round(Number(formatEther(wei)) * 1e4) / 1e4);
}
