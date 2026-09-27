/**
 * Trading policy: the bounds Lain trades inside, and how they are read.
 *
 * Every knob has a compiled-in default and an env/setting override, and every
 * override is validated on the way in — a malformed `LAINOS_*` value throws
 * with the variable's own name rather than silently trading at zero.
 */
import type { IAgentRuntime } from "../../types.js";
import { parsePositiveNative } from "./math.js";

export const DEFAULT_SLIPPAGE_BPS = 100;
export const DEFAULT_DEADLINE_SECONDS = 300;
export const DEFAULT_SPECULATE_GAS_RESERVE = "0.02";
export const DEFAULT_SPECULATE_MAX_NATIVE = "0.05";
export const DEFAULT_SPECULATE_MIN_NATIVE = "0.001";
export const DEFAULT_SPECULATE_WALLET_FRACTION_BPS = 500;
export const DEFAULT_SPECULATE_POOL_FRACTION_BPS = 50;
export const DEFAULT_SPECULATE_MAX_IMPACT_BPS = 150;
export const DEFAULT_BASKET_MAX_TOKENS = 4;
export const DEFAULT_BASKET_MIN_TRADE = "0.01";
export const DEFAULT_BASKET_POOL_FRACTION_BPS = 150;
export const DEFAULT_BASKET_MAX_IMPACT_BPS = 500;
export const DEFAULT_BASKET_PAIR_SCAN = 500;
export const DEFAULT_LIQUIDITY_MAX_POOL_SHARE_BPS = 500;
export const DEFAULT_LIQUIDITY_CONFIRM_THRESHOLD_NATIVE = "0.25";
export const DEFAULT_LIQUIDITY_GAS_RESERVE_NATIVE = "0.02";

export interface SpeculateConfig {
  gasReserveWei: bigint;
  maxNativeWei: bigint;
  minNativeWei: bigint;
  walletFractionBps: number;
  poolFractionBps: number;
  maxImpactBps: number;
  slippageBps: number;
  deadlineSeconds: number;
}

export interface BasketConfig {
  gasReserveWei: bigint;
  minTradeWei: bigint;
  poolFractionBps: number;
  maxImpactBps: number;
  slippageBps: number;
  deadlineSeconds: number;
  maxTokens: number;
  maxPairScan: number;
}

export function parseConfigNative(raw: string | undefined, fallback: string, name: string): bigint {
  const parsed = parsePositiveNative(raw ?? fallback);
  if (parsed === null) throw new Error(`${name} must be a positive native-currency amount`);
  return parsed;
}

export function parseConfigBps(raw: string | undefined, fallback: number, name: string): number {
  const parsed = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10_000) {
    throw new Error(`${name} must be an integer from 0 to 10000`);
  }
  return parsed;
}

export function parseConfigInt(
  raw: string | undefined,
  fallback: number,
  name: string,
  min: number,
  max: number,
): number {
  const parsed = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

export function parseSlippageBps(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_SLIPPAGE_BPS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 5_000) return null;
  return n;
}

export function parseDeadlineSeconds(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_DEADLINE_SECONDS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 30 || n > 3_600) return null;
  return n;
}

export function speculateConfig(runtime: IAgentRuntime, maxNativeOverride?: unknown): SpeculateConfig {
  return {
    gasReserveWei: parseConfigNative(
      runtime.getSetting("LAINOS_SPECULATE_GAS_RESERVE_NATIVE"),
      DEFAULT_SPECULATE_GAS_RESERVE,
      "LAINOS_SPECULATE_GAS_RESERVE_NATIVE",
    ),
    maxNativeWei: parseConfigNative(
      typeof maxNativeOverride === "string" ? maxNativeOverride : runtime.getSetting("LAINOS_SPECULATE_MAX_NATIVE"),
      DEFAULT_SPECULATE_MAX_NATIVE,
      "LAINOS_SPECULATE_MAX_NATIVE",
    ),
    minNativeWei: parseConfigNative(
      runtime.getSetting("LAINOS_SPECULATE_MIN_NATIVE"),
      DEFAULT_SPECULATE_MIN_NATIVE,
      "LAINOS_SPECULATE_MIN_NATIVE",
    ),
    walletFractionBps: parseConfigBps(
      runtime.getSetting("LAINOS_SPECULATE_WALLET_FRACTION_BPS"),
      DEFAULT_SPECULATE_WALLET_FRACTION_BPS,
      "LAINOS_SPECULATE_WALLET_FRACTION_BPS",
    ),
    poolFractionBps: parseConfigBps(
      runtime.getSetting("LAINOS_SPECULATE_POOL_FRACTION_BPS"),
      DEFAULT_SPECULATE_POOL_FRACTION_BPS,
      "LAINOS_SPECULATE_POOL_FRACTION_BPS",
    ),
    maxImpactBps: parseConfigBps(
      runtime.getSetting("LAINOS_SPECULATE_MAX_IMPACT_BPS"),
      DEFAULT_SPECULATE_MAX_IMPACT_BPS,
      "LAINOS_SPECULATE_MAX_IMPACT_BPS",
    ),
    slippageBps: parseConfigBps(
      runtime.getSetting("LAINOS_SPECULATE_SLIPPAGE_BPS"),
      DEFAULT_SLIPPAGE_BPS,
      "LAINOS_SPECULATE_SLIPPAGE_BPS",
    ),
    deadlineSeconds: parseConfigInt(
      runtime.getSetting("LAINOS_SPECULATE_DEADLINE_SECONDS"),
      DEFAULT_DEADLINE_SECONDS,
      "LAINOS_SPECULATE_DEADLINE_SECONDS",
      30,
      3_600,
    ),
  };
}

export function basketConfig(runtime: IAgentRuntime, params: Record<string, unknown>): BasketConfig {
  const maxTokensRaw = params.maxTokens ?? runtime.getSetting("LAINOS_BASKET_MAX_TOKENS");
  const maxImpactRaw = params.maxImpactBps ?? runtime.getSetting("LAINOS_BASKET_MAX_IMPACT_BPS");
  return {
    gasReserveWei: parseConfigNative(
      runtime.getSetting("LAINOS_SPECULATE_GAS_RESERVE_NATIVE"),
      DEFAULT_SPECULATE_GAS_RESERVE,
      "LAINOS_SPECULATE_GAS_RESERVE_NATIVE",
    ),
    minTradeWei: parseConfigNative(
      runtime.getSetting("LAINOS_BASKET_MIN_TRADE_NATIVE"),
      DEFAULT_BASKET_MIN_TRADE,
      "LAINOS_BASKET_MIN_TRADE_NATIVE",
    ),
    poolFractionBps: parseConfigBps(
      runtime.getSetting("LAINOS_BASKET_POOL_FRACTION_BPS"),
      DEFAULT_BASKET_POOL_FRACTION_BPS,
      "LAINOS_BASKET_POOL_FRACTION_BPS",
    ),
    maxImpactBps: parseConfigBps(
      maxImpactRaw === undefined || maxImpactRaw === "" ? undefined : String(maxImpactRaw),
      DEFAULT_BASKET_MAX_IMPACT_BPS,
      "LAINOS_BASKET_MAX_IMPACT_BPS",
    ),
    slippageBps: parseConfigBps(
      runtime.getSetting("LAINOS_BASKET_SLIPPAGE_BPS"),
      DEFAULT_SLIPPAGE_BPS,
      "LAINOS_BASKET_SLIPPAGE_BPS",
    ),
    deadlineSeconds: parseConfigInt(
      runtime.getSetting("LAINOS_BASKET_DEADLINE_SECONDS"),
      DEFAULT_DEADLINE_SECONDS,
      "LAINOS_BASKET_DEADLINE_SECONDS",
      30,
      3_600,
    ),
    maxTokens: parseConfigInt(
      maxTokensRaw === undefined || maxTokensRaw === "" ? undefined : String(maxTokensRaw),
      DEFAULT_BASKET_MAX_TOKENS,
      "LAINOS_BASKET_MAX_TOKENS",
      1,
      10,
    ),
    maxPairScan: parseConfigInt(
      runtime.getSetting("LAINOS_BASKET_MAX_PAIR_SCAN"),
      DEFAULT_BASKET_PAIR_SCAN,
      "LAINOS_BASKET_MAX_PAIR_SCAN",
      1,
      5_000,
    ),
  };
}
