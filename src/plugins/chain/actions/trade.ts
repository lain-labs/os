/**
 * Quoting and executing swaps against a token's wrapped-native pair on the
 * configured DEX.
 *
 * The shape every path shares: quote first, apply the caller's slippage to get
 * a floor, and send that floor into the transaction — so what the swap is
 * allowed to return is what was quoted, not what the pool says afterwards.
 */
import { formatEther, formatUnits, parseUnits, type Address } from "viem";
import type { Action } from "../../../types.js";
import { paperCoinSymbol } from "../paper.js";
import { tradeTarget, WALLET_PARAM } from "./paper.js";
import { fillNote, getService, type ChainService, type NativeBuyQuote } from "../service.js";
import { minOutForSlippage, parsePositiveNative } from "../math.js";
import { DEFAULT_DEADLINE_SECONDS, parseDeadlineSeconds, parseSlippageBps } from "../config.js";

export const quoteTokenBuyAction: Action = {
  name: "quote_token_buy",
  similes: ["quote_buy", "swap_quote", "price_token", "quote_swap"],
  description:
    "Quote buying an ERC20 on the configured DEX with the chain's native currency. Checks the wrapped-native pair, live reserves, expected output, price impact and slippage minimum. Does not sign a transaction.",
  parameters: {
    type: "object",
    properties: {
      token: { type: "string", description: "Token symbol or 0x address." },
      amountNative: { type: "string", description: "Amount of native currency to spend, e.g. '0.1'." },
      slippageBps: {
        type: "number",
        description: "Allowed slippage in basis points. Default 100 = 1%.",
      },
    },
    required: ["token", "amountNative"],
  },
  examples: [
    { user: "quote buying LAIN for 0.05", agent: "Checking the pool…" },
  ],
  async validate() {
    return true;
  },
  async handler(runtime, _state, params) {
    const svc = getService(runtime);
    const token = svc.resolveToken(String(params.token ?? ""));
    if (!token) return { ok: false, text: unknownToken(svc, params.token) };
    const amountNative = String(params.amountNative ?? "");
    const amountInWei = parsePositiveNative(amountNative);
    if (amountInWei === null) return { ok: false, text: "amountNative must be a positive amount." };
    const slippageBps = parseSlippageBps(params.slippageBps);
    if (slippageBps === null) return { ok: false, text: "slippageBps must be between 0 and 5000." };

    try {
      const quote = await svc.quoteNativeBuy(token, amountInWei);
      const minOut = minOutForSlippage(quote.amountOut, slippageBps);
      const sym = svc.nativeSymbol;
      return {
        ok: true,
        text:
          `Quote: ${amountNative} ${sym} -> ~${formatUnits(quote.amountOut, quote.decimals)} ${quote.symbol} ` +
          `(min ${formatUnits(minOut, quote.decimals)} at ${slippageBps / 100}% slippage). ` +
          `Pair ${quote.pair}, reserves ${formatEther(quote.reserveNative)} ${sym} / ` +
          `${formatUnits(quote.reserveToken, quote.decimals)} ${quote.symbol}, impact ~${quote.priceImpactBps / 100}%.`,
        data: quoteData(quote, minOut, slippageBps, svc.dex.router),
      };
    } catch (err) {
      return { ok: false, text: `Cannot quote buy: ${(err as Error).message}.` };
    }
  },
};

export const buyTokenAction: Action = {
  name: "buy_token",
  similes: ["swap_buy", "buy", "purchase_token", "swap_exact_native_for_tokens"],
  description:
    "Buy an ERC20 on the configured DEX with native currency from the agent's wallet when the user gives an exact amountNative. If the user asks to buy without specifying an amount or wants the agent to decide, use speculate_token instead. Requires live wrapped-native pair reserves, slippage protection, and a configured signer. In paper mode the buy is simulated from the paper balance at the live quote; nothing is sent.",
  parameters: {
    type: "object",
    properties: {
      token: { type: "string", description: "Token symbol or 0x address." },
      amountNative: { type: "string", description: "Exact amount of native currency to spend, e.g. '0.1'." },
      slippageBps: {
        type: "number",
        description: "Allowed slippage in basis points. Default 100 = 1%.",
      },
      deadlineSeconds: {
        type: "number",
        description: "Transaction deadline from now. Default 300 seconds.",
      },
      wallet: WALLET_PARAM,
    },
    required: ["token", "amountNative"],
  },
  examples: [
    { user: "buy LAIN for 0.05", agent: "Quoting the pool, then sending the swap…" },
  ],
  async validate() {
    return true;
  },
  async handler(runtime, state, params) {
    const svc = getService(runtime);
    const target = await tradeTarget(svc, state, params.wallet);
    if (target.error) return { ok: false, text: target.error };
    if (!target.book && !svc.canTrade) {
      return { ok: false, text: "No signer configured; I can only quote swaps." };
    }
    const token = svc.resolveToken(String(params.token ?? ""));
    if (!token) return { ok: false, text: unknownToken(svc, params.token) };
    const amountNative = String(params.amountNative ?? "");
    const amountInWei = parsePositiveNative(amountNative);
    if (amountInWei === null) return { ok: false, text: "amountNative must be a positive amount." };
    const slippageBps = parseSlippageBps(params.slippageBps);
    if (slippageBps === null) return { ok: false, text: "slippageBps must be between 0 and 5000." };
    const deadlineSeconds = parseDeadlineSeconds(params.deadlineSeconds);
    if (deadlineSeconds === null) return { ok: false, text: "deadlineSeconds must be between 30 and 3600." };

    try {
      const quote = await svc.quoteNativeBuy(token, amountInWei);
      const minOut = minOutForSlippage(quote.amountOut, slippageBps);
      const fill = await svc.executeBuy(quote, minOut, deadlineSeconds, "buy_token", target.book);
      const { hash, explorer, status, paper } = fill;
      if (status !== "success") {
        return { ok: false, text: `Swap reverted: ${hash}`, data: { hash, explorer, status } };
      }
      return {
        ok: true,
        text:
          `${paper ? `Paper-bought (wallet ${target.wallet})` : "Bought"} ${quote.symbol} for ${amountNative} ${svc.nativeSymbol}. ${fillNote(fill)}. ` +
          `Quoted output was ~${formatUnits(quote.amountOut, quote.decimals)} ${quote.symbol}; ` +
          `minOut was ${formatUnits(minOut, quote.decimals)}.`,
        data: {
          hash,
          explorer,
          status,
          paper,
          ...(paper ? { wallet: target.wallet } : {}),
          ...quoteData(quote, minOut, slippageBps, svc.dex.router),
        },
      };
    } catch (err) {
      return { ok: false, text: `Swap failed: ${(err as Error).message}.` };
    }
  },
};

export const sellTokenAction: Action = {
  name: "sell_token",
  similes: ["swap_sell", "sell", "exit_position", "take_profit", "close_position"],
  description:
    "Sell an ERC20 back into the chain's native currency on the configured DEX from the agent's wallet. amountToken may be a number or 'all' (full wallet balance). Quotes live reserves first, refuses above the impact limit, executes with slippage protection, and records the trade (with realised PnL against the journal's cost basis). In paper mode it sells the paper position at the live quote; nothing is sent.",
  parameters: {
    type: "object",
    properties: {
      token: { type: "string", description: "Token symbol or 0x address." },
      amountToken: {
        type: "string",
        description: "Token amount to sell, e.g. '12.5', or 'all' for the entire balance.",
      },
      slippageBps: {
        type: "number",
        description: "Allowed slippage in basis points. Default 100 = 1%.",
      },
      maxImpactBps: {
        type: "number",
        description: "Max estimated price impact in bps. Default 1000 = 10%; raise only deliberately.",
      },
      reason: { type: "string", description: "Optional short reason for the exit." },
      wallet: WALLET_PARAM,
    },
    required: ["token", "amountToken"],
  },
  examples: [
    { user: "sell all my LAIN", agent: "Working out the exit against live reserves, then selling…" },
  ],
  async validate(runtime) {
    // With a chain there are paper wallets to sell from, signer or not.
    const svc = getService(runtime);
    return svc.canTrade || svc.configured;
  },
  async handler(runtime, state, params) {
    const svc = getService(runtime);
    const target = await tradeTarget(svc, state, params.wallet);
    if (target.error) return { ok: false, text: target.error };
    if (!target.book && !svc.canTrade) {
      return { ok: false, text: "No signer configured; I can only quote sells." };
    }
    const token = svc.resolveToken(String(params.token ?? ""));
    if (!token) return { ok: false, text: unknownToken(svc, params.token) };
    const slippageBps = parseSlippageBps(params.slippageBps);
    if (slippageBps === null) return { ok: false, text: "slippageBps must be between 0 and 5000." };
    const maxImpactRaw = params.maxImpactBps;
    const maxImpactBps =
      maxImpactRaw === undefined || maxImpactRaw === null || maxImpactRaw === ""
        ? 1_000
        : Number(maxImpactRaw);
    if (!Number.isInteger(maxImpactBps) || maxImpactBps < 0 || maxImpactBps > 10_000) {
      return { ok: false, text: "maxImpactBps must be an integer from 0 to 10000." };
    }

    try {
      const { raw, decimals, symbol } = await svc.tradingHolding(token, target.book);
      if (raw <= 0n) return { ok: false, text: `I hold no ${symbol} to sell${target.wallet ? ` in paper wallet ${target.wallet}` : ""}.` };
      const wanted = String(params.amountToken ?? "").trim().toLowerCase();
      let amountInWei: bigint;
      if (wanted === "all") {
        amountInWei = raw;
      } else {
        if (!/^\d+(\.\d+)?$/.test(wanted) || Number(wanted) <= 0) {
          return { ok: false, text: "amountToken must be a positive number or 'all'." };
        }
        amountInWei = parseUnits(wanted, decimals);
        if (amountInWei > raw) {
          return {
            ok: false,
            text: `I only hold ${formatUnits(raw, decimals)} ${symbol}; cannot sell ${wanted}.`,
          };
        }
      }

      const quote = await svc.quoteNativeSell(token, amountInWei);
      if (quote.priceImpactBps > maxImpactBps) {
        return {
          ok: false,
          text:
            `Selling ${formatUnits(amountInWei, decimals)} ${symbol} would move the pool ` +
            `~${quote.priceImpactBps / 100}%, above the ${maxImpactBps / 100}% limit. ` +
            `Sell a smaller amount or raise maxImpactBps deliberately.`,
          data: { priceImpactBps: quote.priceImpactBps, maxImpactBps },
        };
      }
      const minOut = minOutForSlippage(quote.amountOut, slippageBps);
      const fill = await svc.executeSell(
        quote,
        minOut,
        DEFAULT_DEADLINE_SECONDS,
        params.reason ? String(params.reason) : "sell_token",
        target.book,
      );
      const { hash, explorer, status, paper } = fill;
      if (status !== "success") {
        return { ok: false, text: `Sell reverted: ${hash}`, data: { hash, explorer, status } };
      }
      const realized = formatEther(fill.realizedWei ?? 0n);
      const sym = svc.nativeSymbol;
      return {
        ok: true,
        text:
          `${paper ? `Paper-sold (wallet ${target.wallet})` : "Sold"} ${formatUnits(amountInWei, decimals)} ${symbol} for ~${formatEther(quote.amountOut)} ${sym} ` +
          `(impact ~${quote.priceImpactBps / 100}%, realised ${Number(realized) >= 0 ? "+" : ""}${realized} ${sym} vs basis). ${fillNote(fill)}`,
        data: {
          hash,
          explorer,
          status,
          paper,
          ...(paper ? { wallet: target.wallet } : {}),
          symbol,
          amountToken: formatUnits(amountInWei, decimals),
          proceedsNative: formatEther(quote.amountOut),
          realizedNative: realized,
          priceImpactBps: quote.priceImpactBps,
        },
      };
    } catch (err) {
      return { ok: false, text: `Sell failed: ${(err as Error).message}.` };
    }
  },
};


/** The shape every buy-side quote is reported in, quoted or executed. */
export function quoteData(
  quote: NativeBuyQuote,
  minOut: bigint,
  slippageBps: number,
  router: Address,
): Record<string, unknown> {
  return {
    token: quote.token,
    symbol: quote.symbol,
    pair: quote.pair,
    router,
    path: quote.path,
    amountInNative: formatEther(quote.amountInWei),
    amountOut: formatUnits(quote.amountOut, quote.decimals),
    minOut: formatUnits(minOut, quote.decimals),
    slippageBps,
    priceImpactBps: quote.priceImpactBps,
    reserveNative: formatEther(quote.reserveNative),
    reserveToken: formatUnits(quote.reserveToken, quote.decimals),
  };
}

/**
 * The reply to a token this chain does not know. A coin of the paper account
 * (SOL, USDC, …) is not a DEX token here, so in paper mode the reply names the
 * tool that trades it — otherwise "sell my SOL" wanders off to a real wallet.
 */
function unknownToken(svc: ChainService, raw: unknown): string {
  const known = `Unknown token. Known: ${Object.keys(svc.tokens).join(", ") || "(none configured)"}.`;
  const coin = paperCoinSymbol(String(raw ?? ""));
  if (!coin || !svc.paperMode) return known;
  return `${known} ${coin} is a coin of the paper account, not a token on this DEX: paper_trading mode swap trades it (e.g. asset ${coin}, to USDC or ${svc.nativeSymbol}).`;
}
