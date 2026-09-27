/**
 * Lain trading on her own initiative — one token, or a basket across several.
 *
 * Everything here answers the same question the operator cannot answer live:
 * how much of the treasury may this be? The size comes from `config.ts` caps
 * (gas reserve, wallet fraction, pool fraction, price impact), and a trade that
 * cannot fit inside them is declined in words rather than shrunk silently.
 */
import { formatEther, formatUnits, type Address } from "viem";
import type { Action } from "../../../types.js";
import { ROUTER_ABI } from "../abi.js";
import { getService, type ChainService, type NativeBuyQuote } from "../service.js";
import { quoteData } from "./trade.js";
import {
  getAmountOut,
  minBigint,
  minOutForSlippage,
  parsePositiveNative,
  priceImpactBps,
  sameAddress,
} from "../math.js";
import {
  basketConfig,
  speculateConfig,
  type BasketConfig,
  type SpeculateConfig,
} from "../config.js";

interface BasketCandidate {
  symbol: string;
  token: Address;
  probe: NativeBuyQuote;
}

export const speculateTokenAction: Action = {
  name: "speculate_token",
  similes: ["autonomous_buy", "agent_buy", "ape_token", "take_position", "buy_without_amount"],
  description:
    "Autonomously take a small speculative position in a token on the configured DEX when the user asks to buy without specifying an amount or explicitly wants the agent to decide. Chooses spend from wallet balance, gas reserve, max-risk cap and pool-liquidity cap, then executes with slippage protection.",
  parameters: {
    type: "object",
    properties: {
      token: { type: "string", description: "Token symbol or 0x address." },
      thesis: {
        type: "string",
        description: "Optional short reason the agent is taking the risk.",
      },
      maxNative: {
        type: "string",
        description: "Optional one-trade cap in native currency. Defaults to LAINOS_SPECULATE_MAX_NATIVE or 0.05.",
      },
    },
    required: ["token"],
  },
  examples: [
    { user: "buy LAIN", agent: "Sizing the position against my own risk limit…" },
  ],
  async validate() {
    return true;
  },
  async handler(runtime, _state, params) {
    const svc = getService(runtime);
    const sym = svc.nativeSymbol;
    if (!svc.walletClient || !svc.agentAddress) {
      return { ok: false, text: "No signer configured; I can think and quote, but I cannot take positions." };
    }
    const token = svc.resolveToken(String(params.token ?? ""));
    if (!token) return { ok: false, text: `Unknown token. Known: ${Object.keys(svc.tokens).join(", ") || "(none configured)"}.` };

    try {
      const cfg = speculateConfig(runtime, params.maxNative);
      const balance = await svc.publicClient.getBalance({ address: svc.agentAddress });
      const walletSpend = chooseSpeculativeSpend(balance, cfg, sym);
      if (typeof walletSpend === "string") return { ok: false, text: walletSpend };

      let spend = walletSpend;
      let quote = await svc.quoteNativeBuy(token, spend);
      const poolCap = (quote.reserveNative * BigInt(cfg.poolFractionBps)) / 10_000n;
      const cappedSpend = minBigint(spend, poolCap);
      if (cappedSpend < cfg.minNativeWei) {
        return {
          ok: false,
          text:
            `Pool-aware position size would be ${formatEther(cappedSpend)} ${sym}, below my ` +
            `${formatEther(cfg.minNativeWei)} ${sym} minimum. Pair ${quote.pair}.`,
          data: {
            policy: speculatePolicyData(cfg, balance),
            ...quoteData(quote, minOutForSlippage(quote.amountOut, cfg.slippageBps), cfg.slippageBps, svc.dex.router),
          },
        };
      }
      if (cappedSpend !== spend) {
        spend = cappedSpend;
        quote = await svc.quoteNativeBuy(token, spend);
      }
      if (quote.priceImpactBps > cfg.maxImpactBps) {
        return {
          ok: false,
          text:
            `I won't take this position: estimated impact is ${quote.priceImpactBps / 100}%, ` +
            `above my ${cfg.maxImpactBps / 100}% limit. Pool ${quote.pair}.`,
          data: quoteData(quote, minOutForSlippage(quote.amountOut, cfg.slippageBps), cfg.slippageBps, svc.dex.router),
        };
      }

      const minOut = minOutForSlippage(quote.amountOut, cfg.slippageBps);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + cfg.deadlineSeconds);
      const hash = await svc.walletClient.writeContract({
        account: svc.walletClient.account!,
        chain: svc.chain,
        address: svc.dex.router,
        abi: ROUTER_ABI,
        functionName: "swapExactETHForTokens",
        args: [minOut, quote.path, svc.agentAddress, deadline],
        value: spend,
      });
      const receipt = await svc.publicClient.waitForTransactionReceipt({ hash });
      const explorer = svc.explorerTxUrl(hash);
      const thesis = String(params.thesis ?? "").trim();
      if (receipt.status !== "success") {
        return { ok: false, text: `Speculative buy reverted: ${hash}`, data: { hash, explorer, status: receipt.status } };
      }
      await svc.journal.recordBuy({
        token,
        symbol: quote.symbol,
        qtyWei: quote.amountOut,
        nativeWei: spend,
        txHash: hash,
        reason: thesis || "speculate_token",
      });
      return {
        ok: true,
        text:
          `I took the risk: bought ${quote.symbol} for ${formatEther(spend)} ${sym}. ` +
          `Expected ~${formatUnits(quote.amountOut, quote.decimals)} ${quote.symbol}, ` +
          `minOut ${formatUnits(minOut, quote.decimals)}, impact ~${quote.priceImpactBps / 100}%. ` +
          `${thesis ? `Thesis: ${thesis}. ` : ""}Tx: ${hash}`,
        data: {
          hash,
          explorer,
          status: receipt.status,
          policy: speculatePolicyData(cfg, balance),
          ...quoteData(quote, minOut, cfg.slippageBps, svc.dex.router),
        },
      };
    } catch (err) {
      return { ok: false, text: `Speculative buy failed: ${(err as Error).message}.` };
    }
  },
};

export const speculateBasketAction: Action = {
  name: "speculate_basket",
  similes: ["buy_basket", "autonomous_basket", "buy_several_tokens", "spend_budget", "portfolio_buy"],
  description:
    "Autonomously spend a user-approved native-currency budget across several tokens on the configured DEX. Use this when the user says to buy several tokens, spend a total budget, or choose tokens at the agent's discretion. By default the action scans all live wrapped-native pairs on the DEX factory, splits the budget, skips unsafe pools, and executes multiple swaps with slippage protection.",
  parameters: {
    type: "object",
    properties: {
      budgetNative: { type: "string", description: "Total native-currency budget to spend, e.g. '0.90'." },
      tokens: {
        type: "string",
        description: "Optional comma-separated preferred symbols. Empty = agent's speculative universe.",
      },
      maxTokens: {
        type: "number",
        description: "Maximum number of tokens to buy. Default 4.",
      },
      thesis: {
        type: "string",
        description: "Optional short reason for the basket.",
      },
      maxImpactBps: {
        type: "number",
        description: "Optional max estimated price impact per swap, in bps. Default 500 = 5%.",
      },
    },
    required: ["budgetNative"],
  },
  examples: [
    { user: "spend 0.90, buy a few tokens at your own discretion", agent: "Building a basket against live liquidity…" },
  ],
  async validate() {
    return true;
  },
  async handler(runtime, _state, params) {
    const svc = getService(runtime);
    const sym = svc.nativeSymbol;
    if (!svc.walletClient || !svc.agentAddress) {
      return { ok: false, text: "No signer configured; I can only quote a basket, not buy it." };
    }
    const budgetNative = String(params.budgetNative ?? "");
    const budgetWei = parsePositiveNative(budgetNative);
    if (budgetWei === null) return { ok: false, text: "budgetNative must be a positive amount." };

    try {
      const cfg = basketConfig(runtime, params);
      const balance = await svc.publicClient.getBalance({ address: svc.agentAddress });
      if (balance <= cfg.gasReserveWei) {
        return { ok: false, text: `I only have ${formatEther(balance)} ${sym}; gas reserve is ${formatEther(cfg.gasReserveWei)}.` };
      }
      const spendable = balance - cfg.gasReserveWei;
      if (budgetWei > spendable) {
        return {
          ok: false,
          text:
            `Budget ${budgetNative} ${sym} exceeds spendable balance ${formatEther(spendable)} ${sym} ` +
            `after ${formatEther(cfg.gasReserveWei)} ${sym} gas reserve.`,
          data: { balanceNative: formatEther(balance), spendableNative: formatEther(spendable) },
        };
      }

      const tokenUniverse = params.tokens ?? runtime.getSetting("LAINOS_BASKET_TOKENS");
      const candidates = await basketCandidates(svc, tokenUniverse, budgetWei, cfg);
      if (!candidates.length) return { ok: false, text: "No basket candidates had a live usable pool." };

      const plan = planBasketBuys(candidates, budgetWei, cfg);
      if (!plan.length) {
        return {
          ok: false,
          text: "No planned basket trade cleared the minimum size, pool fraction and impact limits.",
          data: { candidates: candidates.map((c) => c.symbol), policy: basketPolicyData(cfg, balance, budgetWei) },
        };
      }

      const buys: Record<string, unknown>[] = [];
      const skipped: string[] = [];
      let spent = 0n;
      for (const item of plan) {
        try {
          const quote = await svc.quoteNativeBuy(item.token, item.spendWei);
          if (quote.priceImpactBps > cfg.maxImpactBps) {
            skipped.push(`${item.symbol}: impact ${quote.priceImpactBps / 100}%`);
            continue;
          }
          const minOut = minOutForSlippage(quote.amountOut, cfg.slippageBps);
          const deadline = BigInt(Math.floor(Date.now() / 1000) + cfg.deadlineSeconds);
          const hash = await svc.walletClient.writeContract({
            account: svc.walletClient.account!,
            chain: svc.chain,
            address: svc.dex.router,
            abi: ROUTER_ABI,
            functionName: "swapExactETHForTokens",
            args: [minOut, quote.path, svc.agentAddress, deadline],
            value: item.spendWei,
          });
          const receipt = await svc.publicClient.waitForTransactionReceipt({ hash });
          if (receipt.status !== "success") {
            skipped.push(`${item.symbol}: reverted ${hash}`);
            continue;
          }
          await svc.journal.recordBuy({
            token: item.token,
            symbol: quote.symbol,
            qtyWei: quote.amountOut,
            nativeWei: item.spendWei,
            txHash: hash,
            reason: String(params.thesis ?? "speculate_basket"),
          });
          spent += item.spendWei;
          buys.push({
            hash,
            explorer: svc.explorerTxUrl(hash),
            status: receipt.status,
            ...quoteData(quote, minOut, cfg.slippageBps, svc.dex.router),
          });
        } catch (err) {
          skipped.push(`${item.symbol}: ${(err as Error).message}`);
        }
      }

      if (!buys.length) {
        return {
          ok: false,
          text: `Basket execution found candidates but no swap succeeded. Skipped: ${skipped.join("; ")}`,
          data: { skipped, policy: basketPolicyData(cfg, balance, budgetWei) },
        };
      }

      const thesis = String(params.thesis ?? "").trim();
      const lines = buys.map((b) => {
        const symbol = String(b.symbol);
        return `${symbol}: ${b.amountInNative} ${sym} -> ~${b.amountOut} ${symbol} (${b.explorer ?? "no explorer configured"})`;
      });
      return {
        ok: true,
        text:
          `Basket bought ${buys.length} token(s), spent ${formatEther(spent)} of ${budgetNative} ${sym}. ` +
          `${thesis ? `Thesis: ${thesis}. ` : ""}` +
          lines.join(" | ") +
          (skipped.length ? ` | skipped: ${skipped.join("; ")}` : ""),
        data: {
          spentNative: formatEther(spent),
          budgetNative,
          buys,
          skipped,
          policy: basketPolicyData(cfg, balance, budgetWei),
        },
      };
    } catch (err) {
      return { ok: false, text: `Basket buy failed: ${(err as Error).message}.` };
    }
  },
};


async function basketCandidates(
  svc: ChainService,
  rawTokens: unknown,
  budgetWei: bigint,
  cfg: BasketConfig,
): Promise<BasketCandidate[]> {
  const probeWei = minBigint(cfg.minTradeWei, budgetWei);
  const candidates: BasketCandidate[] = [];
  const explicitSymbols = basketSymbols(rawTokens, cfg.maxTokens * 3);
  const tokens = explicitSymbols.length
    ? explicitSymbols
        .map((symbol) => ({ symbol, token: svc.resolveToken(symbol) }))
        .filter((entry): entry is { symbol: string; token: Address } => Boolean(entry.token))
    : (await svc.nativePairTokens(cfg.maxPairScan)).map((token) => ({ symbol: token, token }));

  for (const { symbol, token } of tokens) {
    if (sameAddress(token, svc.dex.wrappedNative)) continue;
    try {
      const probe = await svc.quoteNativeBuy(token, probeWei);
      const poolCap = (probe.reserveNative * BigInt(cfg.poolFractionBps)) / 10_000n;
      if (poolCap < cfg.minTradeWei) continue;
      candidates.push({ symbol: probe.symbol || symbol.toUpperCase(), token, probe });
    } catch {
      // Missing/dust pools are normal in a broad speculative universe.
    }
  }
  return candidates
    .sort((a, b) => (a.probe.reserveNative === b.probe.reserveNative ? 0 : a.probe.reserveNative < b.probe.reserveNative ? 1 : -1))
    .slice(0, cfg.maxTokens);
}

function basketSymbols(rawTokens: unknown, cap: number): string[] {
  const raw =
    Array.isArray(rawTokens)
      ? rawTokens.join(",")
      : String(rawTokens ?? "");
  const seen = new Set<string>();
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim().toUpperCase())
    .filter((s) => {
      if (!s || seen.has(s)) return false;
      seen.add(s);
      return true;
    })
    .slice(0, Math.max(1, cap));
}

function planBasketBuys(
  candidates: BasketCandidate[],
  budgetWei: bigint,
  cfg: BasketConfig,
): Array<{ symbol: string; token: Address; spendWei: bigint }> {
  let remaining = budgetWei;
  const plan: Array<{ symbol: string; token: Address; spendWei: bigint }> = [];
  const slots = candidates.length;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    const remainingSlots = BigInt(slots - i);
    const target = remaining / remainingSlots;
    const poolCap = (candidate.probe.reserveNative * BigInt(cfg.poolFractionBps)) / 10_000n;
    const spend = minBigint(target, poolCap);
    if (spend < cfg.minTradeWei) continue;
    const amountOut = getAmountOut(spend, candidate.probe.reserveNative, candidate.probe.reserveToken);
    const impact = priceImpactBps(spend, candidate.probe.reserveNative, candidate.probe.reserveToken, amountOut);
    if (impact > cfg.maxImpactBps) continue;
    plan.push({ symbol: candidate.symbol, token: candidate.token, spendWei: spend });
    remaining -= spend;
  }
  return plan;
}

function chooseSpeculativeSpend(balance: bigint, cfg: SpeculateConfig, sym: string): bigint | string {
  if (balance <= cfg.gasReserveWei) {
    return `I have only ${formatEther(balance)} ${sym}; my gas reserve is ${formatEther(cfg.gasReserveWei)} ${sym}.`;
  }
  const riskable = balance - cfg.gasReserveWei;
  const walletCap = (riskable * BigInt(cfg.walletFractionBps)) / 10_000n;
  const spend = minBigint(walletCap, cfg.maxNativeWei);
  if (spend < cfg.minNativeWei) {
    return (
      `Position size would be ${formatEther(spend)} ${sym}, below my minimum ` +
      `${formatEther(cfg.minNativeWei)} ${sym} after reserve and risk caps.`
    );
  }
  return spend;
}

function speculatePolicyData(cfg: SpeculateConfig, balance: bigint): Record<string, unknown> {
  return {
    balanceNative: formatEther(balance),
    gasReserveNative: formatEther(cfg.gasReserveWei),
    maxNative: formatEther(cfg.maxNativeWei),
    minNative: formatEther(cfg.minNativeWei),
    walletFractionBps: cfg.walletFractionBps,
    poolFractionBps: cfg.poolFractionBps,
    maxImpactBps: cfg.maxImpactBps,
    slippageBps: cfg.slippageBps,
    deadlineSeconds: cfg.deadlineSeconds,
  };
}

function basketPolicyData(cfg: BasketConfig, balance: bigint, budgetWei: bigint): Record<string, unknown> {
  return {
    balanceNative: formatEther(balance),
    budgetNative: formatEther(budgetWei),
    gasReserveNative: formatEther(cfg.gasReserveWei),
    minTradeNative: formatEther(cfg.minTradeWei),
    poolFractionBps: cfg.poolFractionBps,
    maxImpactBps: cfg.maxImpactBps,
    slippageBps: cfg.slippageBps,
    deadlineSeconds: cfg.deadlineSeconds,
    maxTokens: cfg.maxTokens,
  };
}
