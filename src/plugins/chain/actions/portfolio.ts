/**
 * What the treasury is worth, against what it cost.
 *
 * Live value is a sell-side quote on the configured DEX, so a position with no
 * pool is listed at zero rather than dropped. Basis comes from the journal
 * first and from an explorer reconstruction second — and which one answered
 * is reported per position, because a reconstructed basis only sees DEX buys.
 */
import { formatEther, formatUnits, isAddress, type Address } from "viem";
import type { Action } from "../../../types.js";
import type { Position } from "../journal.js";
import { getService } from "../service.js";
import { sameAddress } from "../math.js";
import { reconstructDexBuyBasis } from "../explorer.js";

export const portfolioPnlAction: Action = {
  name: "portfolio_pnl",
  similes: ["pnl", "positions", "profit_report", "treasury_report", "cost_basis"],
  description:
    "Report the agent's treasury: native currency, every token position with its live sell-side value on the configured DEX, the journal's cost basis, and unrealised PnL. Use before selling 'profitable positions' or when asked how trading is going.",
  parameters: {
    type: "object",
    properties: {},
  },
  examples: [
    { user: "how's trading? what's up?", agent: "Computing the portfolio against cost basis…" },
  ],
  async validate() {
    return true;
  },
  async handler(runtime) {
    const svc = getService(runtime);
    const sym = svc.nativeSymbol;
    if (!svc.agentAddress) return { ok: false, text: "I have no wallet yet (create_wallet makes one)." };
    const address = svc.agentAddress;
    const native = await svc.publicClient.getBalance({ address });
    const reconstructed = await reconstructDexBuyBasis(address, svc.explorerApiUrl, svc.dex.router).catch(() => ({
      positions: new Map<string, Position>(),
      feesWei: 0n,
    }));

    // Positions = union of journaled tokens and the known-token registry.
    const tokens = new Map<string, Address>();
    for (const addr of Object.values(svc.tokens)) tokens.set(addr.toLowerCase(), addr);
    for (const pos of svc.journal.positions()) {
      if (isAddress(pos.token)) tokens.set(pos.token.toLowerCase(), pos.token as Address);
    }
    for (const pos of reconstructed.positions.values()) {
      if (isAddress(pos.token)) tokens.set(pos.token.toLowerCase(), pos.token as Address);
    }

    const lines: string[] = [];
    const positions: Record<string, unknown>[] = [];
    let totalValueWei = 0n;
    let totalBasisWei = 0n;
    let unknownBasis = 0;
    for (const token of tokens.values()) {
      if (sameAddress(token, svc.dex.wrappedNative)) continue;
      try {
        const { raw, decimals, symbol } = await svc.rawTokenBalance(token, address);
        if (raw <= 0n) continue;
        let valueWei = 0n;
        let quoteNote = "no live pool";
        try {
          const quote = await svc.quoteNativeSell(token, raw);
          valueWei = quote.amountOut;
          quoteNote = "";
        } catch {
          // Unquotable dust stays listed with zero live value.
        }
        const journalPos = svc.journal.positionOf(token);
        const reconstructedPos = reconstructed.positions.get(token.toLowerCase());
        const pos = journalPos ?? reconstructedPos;
        const basisSource = journalPos ? "journal" : reconstructedPos ? "onchain" : null;
        let basisWei: bigint | null = null;
        if (pos) {
          const posQty = BigInt(pos.qtyWei);
          const covered = raw < posQty ? raw : posQty;
          basisWei = posQty > 0n ? (BigInt(pos.costWei) * covered) / posQty : 0n;
        }
        totalValueWei += valueWei;
        if (basisWei !== null) totalBasisWei += basisWei;
        else unknownBasis += 1;

        const pnlText =
          basisWei !== null && basisWei > 0n
            ? `${valueWei >= basisWei ? "+" : ""}${Number(((valueWei - basisWei) * 10_000n) / basisWei) / 100}%`
            : "no recorded basis";
        lines.push(
          `${symbol}: ${formatUnits(raw, decimals)} ≈ ${formatEther(valueWei)} ${sym}` +
            (quoteNote ? ` (${quoteNote})` : basisWei !== null ? ` (basis ${formatEther(basisWei)}, ${pnlText})` : ` (${pnlText})`),
        );
        positions.push({
          token,
          symbol,
          amount: formatUnits(raw, decimals),
          valueNative: formatEther(valueWei),
          basisNative: basisWei !== null ? formatEther(basisWei) : null,
          unrealizedNative: basisWei !== null ? formatEther(valueWei - basisWei) : null,
          unrealizedPct:
            basisWei !== null && basisWei > 0n
              ? `${valueWei >= basisWei ? "+" : ""}${Number(((valueWei - basisWei) * 10_000n) / basisWei) / 100}%`
              : null,
          basisSource,
        });
      } catch {
        // Unreadable token contracts are skipped, not fatal.
      }
    }

    const unrealizedWei = totalBasisWei > 0n ? totalValueWei - totalBasisWei : null;
    const afterGasWei = unrealizedWei !== null ? unrealizedWei - reconstructed.feesWei : null;
    const totalPnl =
      unrealizedWei !== null
        ? `${unrealizedWei >= 0n ? "+" : ""}${formatEther(unrealizedWei)} ${sym} unrealised`
        : "no basis recorded yet";
    const header =
      `Treasury: ${formatEther(native)} ${sym} native + ${formatEther(totalValueWei)} ${sym} in ${positions.length} position(s) (${totalPnl}` +
      (unknownBasis ? `, ${unknownBasis} position(s) without basis` : "") +
      (afterGasWei !== null && reconstructed.feesWei > 0n ? `, ${afterGasWei >= 0n ? "+" : ""}${formatEther(afterGasWei)} after reconstructed gas` : "") +
      `).`;
    return {
      ok: true,
      text: positions.length ? `${header}\n${lines.join("\n")}` : header,
      data: {
        address,
        nativeBalance: formatEther(native),
        positions,
        totalValueNative: formatEther(totalValueWei),
        totalBasisNative: formatEther(totalBasisWei),
        unrealizedNative: unrealizedWei !== null ? formatEther(unrealizedWei) : null,
        unrealizedPct:
          unrealizedWei !== null && totalBasisWei > 0n
            ? `${unrealizedWei >= 0n ? "+" : ""}${Number((unrealizedWei * 10_000n) / totalBasisWei) / 100}%`
            : null,
        reconstructedGasFeesNative: formatEther(reconstructed.feesWei),
        unrealizedAfterGasNative: afterGasWei !== null ? formatEther(afterGasWei) : null,
        positionsWithoutBasis: unknownBasis,
        recentTrades: svc.journal.recentTrades(5),
      },
    };
  },
};
