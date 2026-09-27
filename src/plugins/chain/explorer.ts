/**
 * Blockscout-compatible explorer API, read-only. The journal is the primary
 * record of what a position cost; this reconstructs a basis for trades made
 * before the journal existed (or from another host) by replaying the
 * address's own DEX buys. Entirely optional — degrades to "no reconstructed
 * basis" when no explorer API is configured.
 */
import { isAddress, type Address } from "viem";
import type { Position } from "./journal.js";
import { sameAddress } from "./math.js";

export interface ReconstructedBasis {
  positions: Map<string, Position>;
  feesWei: bigint;
}

interface ExplorerTransaction {
  hash: string;
  from?: { hash?: string };
  to?: { hash?: string };
  value?: string;
  fee?: { value?: string } | string;
  method?: string | null;
  status?: string;
}

interface ExplorerTokenTransfer {
  transaction_hash?: string;
  to?: { hash?: string };
  token?: { address_hash?: string; symbol?: string };
  total?: { value?: string };
}

async function explorerItems<T>(base: string, path: string): Promise<T[]> {
  const out: T[] = [];
  let params: Record<string, string> | null = {};

  while (params) {
    const url = new URL(`${base}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`explorer ${path} failed: HTTP ${res.status}`);
    const body = (await res.json()) as {
      items?: T[];
      next_page_params?: Record<string, unknown> | null;
    };
    out.push(...(body.items ?? []));
    params = body.next_page_params
      ? Object.fromEntries(Object.entries(body.next_page_params).map(([key, value]) => [key, String(value)]))
      : null;
  }

  return out;
}

function mergeReconstructedPosition(positions: Map<string, Position>, input: Position): void {
  const key = input.token.toLowerCase();
  const prev = positions.get(key);
  if (!prev) {
    positions.set(key, input);
    return;
  }
  positions.set(key, {
    ...prev,
    qtyWei: (BigInt(prev.qtyWei) + BigInt(input.qtyWei)).toString(),
    costWei: (BigInt(prev.costWei) + BigInt(input.costWei)).toString(),
  });
}

/**
 * @param explorerApiUrl Base URL of a Blockscout-compatible API (e.g.
 *   `https://explorer.example.com/api/v2`). When absent, returns an empty
 *   reconstruction rather than failing — the journal remains the source of
 *   truth for basis.
 * @param dexRouter The DEX router address whose buys are being replayed.
 */
export async function reconstructDexBuyBasis(
  address: Address,
  explorerApiUrl: string | undefined,
  dexRouter: Address,
): Promise<ReconstructedBasis> {
  if (!explorerApiUrl) return { positions: new Map(), feesWei: 0n };

  const [transactions, transfers] = await Promise.all([
    explorerItems<ExplorerTransaction>(explorerApiUrl, `/addresses/${address}/transactions`),
    explorerItems<ExplorerTokenTransfer>(explorerApiUrl, `/addresses/${address}/token-transfers`),
  ]);
  const txByHash = new Map(transactions.map((tx) => [tx.hash.toLowerCase(), tx]));
  const positions = new Map<string, Position>();
  let feesWei = 0n;

  for (const transfer of transfers) {
    const hash = transfer.transaction_hash?.toLowerCase();
    const token = transfer.token?.address_hash;
    const qtyWei = transfer.total?.value;
    if (!hash || !token || !isAddress(token) || !qtyWei) continue;
    if (!sameAddress(transfer.to?.hash ?? "", address)) continue;

    const tx = txByHash.get(hash);
    if (!tx || tx.status !== "ok") continue;
    if (!sameAddress(tx.from?.hash ?? "", address)) continue;
    if (!sameAddress(tx.to?.hash ?? "", dexRouter)) continue;
    if ((tx.method ?? "").toLowerCase() !== "0x7ff36ab5") continue; // swapExactETHForTokens

    const costWei = BigInt(tx.value ?? "0");
    if (costWei <= 0n) continue;
    const feeWei = typeof tx.fee === "string" ? tx.fee : tx.fee?.value;
    feesWei += BigInt(feeWei ?? "0");
    mergeReconstructedPosition(positions, {
      token,
      symbol: transfer.token?.symbol ?? "TOKEN",
      qtyWei,
      costWei: costWei.toString(),
    });
  }

  return { positions, feesWei };
}
