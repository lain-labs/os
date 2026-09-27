/**
 * Pure arithmetic and input parsing — no chain, no runtime, no I/O.
 * Everything here is a function of its arguments, which is what makes the
 * trading paths testable without an RPC.
 */
import { parseEther, parseUnits } from "viem";

export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Uniswap V2 getAmountOut with the standard 0.3% fee. */
export function getAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const amountInWithFee = amountIn * 997n;
  return (amountInWithFee * reserveOut) / (reserveIn * 1000n + amountInWithFee);
}

export function priceImpactBps(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  amountOut: bigint,
): number {
  const noImpactOut = (amountIn * reserveOut) / reserveIn;
  if (noImpactOut <= 0n || amountOut >= noImpactOut) return 0;
  return Number(((noImpactOut - amountOut) * 10_000n) / noImpactOut);
}

export function minOutForSlippage(amountOut: bigint, slippageBps: number): bigint {
  return (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

export function parsePositiveUnits(raw: string, decimals: number): bigint | null {
  if (!/^\d+(\.\d+)?$/.test(raw) || Number(raw) <= 0) return null;
  try {
    return parseUnits(raw, decimals);
  } catch {
    return null;
  }
}

/** Parses a positive decimal amount of the chain's 18-decimal native currency. */
export function parsePositiveNative(raw: string): bigint | null {
  if (!/^\d+(\.\d+)?$/.test(raw) || Number(raw) <= 0) return null;
  try {
    return parseEther(raw);
  } catch {
    return null;
  }
}

export function optimalLiquidityAmounts(
  amountADesired: bigint,
  amountBDesired: bigint,
  reserveA: bigint,
  reserveB: bigint,
): [bigint, bigint] {
  const amountBOptimal = quoteReserveAmount(amountADesired, reserveA, reserveB);
  if (amountBOptimal <= amountBDesired) return [amountADesired, amountBOptimal];
  const amountAOptimal = quoteReserveAmount(amountBDesired, reserveB, reserveA);
  return [amountAOptimal, amountBDesired];
}

export function quoteReserveAmount(amountA: bigint, reserveA: bigint, reserveB: bigint): bigint {
  if (amountA <= 0n || reserveA <= 0n || reserveB <= 0n) return 0n;
  return (amountA * reserveB) / reserveA;
}

export function minBigint(...values: bigint[]): bigint {
  return values.reduce((min, v) => (v < min ? v : min));
}

export function maxBigint(...values: bigint[]): bigint {
  return values.reduce((max, v) => (v > max ? v : max));
}
