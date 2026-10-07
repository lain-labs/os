/**
 * What the chain itself says about each asset: its spot price in the native
 * coin on the chain's DEX (the wrapped-native pair's reserves), the depth of
 * that pool, and — through the USDC pair — the same in dollars. For a coin of
 * the chain's own community this is the only price there is; for a wrapped
 * fund or coin it shows whether the on-chain market follows the real one.
 */
import { type Address, type PublicClient } from "viem";
import { FACTORY_ABI, PAIR_ABI } from "../chain/abi.js";
import type { NetworkProfile } from "../chain/networks.js";
import type { Asset } from "./assets.js";

export interface PoolPrice {
  /** Native coin per one token. */
  native: number;
  /** Native coin on the token's side of the pool — its depth. */
  depthNative: number;
  usd?: number;
}

const ZERO = "0x0000000000000000000000000000000000000000";

type Res = { status: "success" | "failure"; result?: unknown };
type Call = { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] };

/**
 * Many reads, failures kept per call: one Multicall3 call where the chain has
 * the contract, otherwise plain calls twenty at a time (Cyberia has none).
 */
async function readMany(client: PublicClient, calls: Call[]): Promise<Res[]> {
  if (client.chain?.contracts?.multicall3) {
    return (await client.multicall({ allowFailure: true, contracts: calls as never })) as Res[];
  }
  const out: Res[] = [];
  for (let i = 0; i < calls.length; i += 20) {
    out.push(
      ...(await Promise.all(
        calls.slice(i, i + 20).map((c) =>
          client
            .readContract(c as never)
            .then((result): Res => ({ status: "success", result }))
            .catch((): Res => ({ status: "failure" })),
        ),
      )),
    );
  }
  return out;
}

export async function dexPrices(
  client: PublicClient,
  profile: NetworkProfile,
  assets: Asset[],
): Promise<{ prices: Map<string, PoolPrice>; nativeUsd?: number; note?: string }> {
  const prices = new Map<string, PoolPrice>();
  const factory = profile.dexFactory as Address | undefined;
  const wrapped = profile.dexWrappedNative as Address | undefined;
  if (!factory || !wrapped) return { prices, note: `no DEX configured for ${profile.title}` };
  const nativeDecimals = profile.nativeDecimals ?? 18;
  const tokens = assets.filter((a) => a.address.toLowerCase() !== wrapped.toLowerCase());

  const pairs = await readMany(
    client,
    tokens.map((a) => ({ address: factory, abi: FACTORY_ABI, functionName: "getPair", args: [wrapped, a.address as Address] })),
  );
  const live = tokens
    .map((a, i) => ({ asset: a, pair: pairs[i]?.status === "success" ? (pairs[i].result as unknown as string) : ZERO }))
    .filter((x) => x.pair && x.pair !== ZERO);

  const reads = await readMany(
    client,
    live.flatMap((x) => [
      { address: x.pair as Address, abi: PAIR_ABI, functionName: "getReserves" },
      { address: x.pair as Address, abi: PAIR_ABI, functionName: "token0" },
    ]),
  );
  live.forEach((x, i) => {
    const reserves = reads[i * 2];
    const token0 = reads[i * 2 + 1];
    if (reserves?.status !== "success" || token0?.status !== "success") return;
    const [r0, r1] = reserves.result as unknown as [bigint, bigint];
    const nativeIs0 = String(token0.result).toLowerCase() === wrapped.toLowerCase();
    const rn = Number(nativeIs0 ? r0 : r1) / 10 ** nativeDecimals;
    const rt = Number(nativeIs0 ? r1 : r0) / 10 ** x.asset.decimals;
    if (rn <= 0 || rt <= 0) return;
    prices.set(x.asset.symbol.toUpperCase(), { native: rn / rt, depthNative: rn });
  });

  // Dollars through the deepest stablecoin pool the chain has.
  const stable = ["USDC", "USDT"].map((s) => prices.get(s)).find(Boolean);
  const nativeUsd = stable ? 1 / stable.native : undefined;
  if (nativeUsd) for (const p of prices.values()) p.usd = p.native * nativeUsd;
  return { prices, nativeUsd };
}
