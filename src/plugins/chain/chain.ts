import { defineChain, isAddress, type Address, type Chain } from "viem";

/**
 * LainOS is chain-agnostic: every EVM chain, token registry and DEX address
 * is read from the environment at boot. There are no baked-in defaults that
 * point at any particular network — an operator must configure their own.
 */

export interface ChainDexConfig {
  factory: Address;
  router: Address;
  wrappedNative: Address;
}

export interface ChainConfig {
  chain: Chain;
  nativeSymbol: string;
  explorerUrl?: string;
}

export function loadChainConfig(getSetting: (key: string) => string | undefined): ChainConfig {
  const rpcUrl = getSetting("CHAIN_RPC_URL");
  if (!rpcUrl) {
    throw new Error("CHAIN_RPC_URL is required (the EVM RPC endpoint to connect to).");
  }
  const chainIdRaw = getSetting("CHAIN_ID");
  const chainId = Number(chainIdRaw);
  if (!chainIdRaw || !Number.isInteger(chainId) || chainId <= 0) {
    throw new Error("CHAIN_ID is required and must be a positive integer.");
  }
  const name = getSetting("CHAIN_NAME") || "EVM chain";
  const nativeSymbol = getSetting("CHAIN_NATIVE_SYMBOL") || "ETH";
  const nativeDecimalsRaw = getSetting("CHAIN_NATIVE_DECIMALS");
  const nativeDecimals = nativeDecimalsRaw ? Number(nativeDecimalsRaw) : 18;
  if (!Number.isInteger(nativeDecimals) || nativeDecimals < 0 || nativeDecimals > 36) {
    throw new Error("CHAIN_NATIVE_DECIMALS must be an integer from 0 to 36.");
  }
  const explorerUrl = getSetting("CHAIN_EXPLORER_URL")?.trim() || undefined;
  const explorerName = getSetting("CHAIN_EXPLORER_NAME") || "Explorer";

  const chain = defineChain({
    id: chainId,
    name,
    nativeCurrency: { name: nativeSymbol, symbol: nativeSymbol, decimals: nativeDecimals },
    rpcUrls: { default: { http: [rpcUrl] } },
    ...(explorerUrl
      ? { blockExplorers: { default: { name: explorerName, url: explorerUrl } } }
      : {}),
  });

  return { chain, nativeSymbol, explorerUrl };
}

/** `CHAIN_TOKENS=SYMBOL:0xaddr,SYMBOL2:0xaddr2` — empty by default. */
export function loadChainTokens(getSetting: (key: string) => string | undefined): Record<string, Address> {
  const raw = getSetting("CHAIN_TOKENS");
  const out: Record<string, Address> = {};
  if (!raw) return out;
  for (const entry of raw.split(",")) {
    const [symbolRaw, addressRaw] = entry.split(":").map((part) => part?.trim());
    if (!symbolRaw || !addressRaw || !isAddress(addressRaw)) continue;
    out[symbolRaw.toUpperCase()] = addressRaw as Address;
  }
  return out;
}

/** A UniswapV2-compatible DEX (factory + router + wrapped-native), if configured. */
export function loadDexConfig(getSetting: (key: string) => string | undefined): ChainDexConfig | undefined {
  const factory = getSetting("CHAIN_DEX_FACTORY")?.trim();
  const router = getSetting("CHAIN_DEX_ROUTER")?.trim();
  const wrappedNative = getSetting("CHAIN_DEX_WRAPPED_NATIVE")?.trim();
  if (!factory && !router && !wrappedNative) return undefined;
  if (!factory || !router || !wrappedNative) {
    throw new Error(
      "CHAIN_DEX_FACTORY, CHAIN_DEX_ROUTER and CHAIN_DEX_WRAPPED_NATIVE must all be set together to enable DEX features.",
    );
  }
  if (!isAddress(factory) || !isAddress(router) || !isAddress(wrappedNative)) {
    throw new Error("CHAIN_DEX_FACTORY, CHAIN_DEX_ROUTER and CHAIN_DEX_WRAPPED_NATIVE must be valid 0x addresses.");
  }
  return { factory: factory as Address, router: router as Address, wrappedNative: wrappedNative as Address };
}

/** The address a factory returns for "no such pair". */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
