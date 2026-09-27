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
import { ROUTER_ABI } from "../abi.js";
import { getService, type NativeBuyQuote } from "../service.js";
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
    if (!token) return { ok: false, text: `Unknown token. Known: ${Object.keys(svc.tokens).join(", ") || "(none configured)"}.` };
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
    "Buy an ERC20 on the configured DEX with native currency from the agent's wallet when the user gives an exact amountNative. If the user asks to buy without specifying an amount or wants the agent to decide, use speculate_token instead. Requires live wrapped-native pair reserves, slippage protection, and a configured signer.",
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
    },
    required: ["token", "amountNative"],
  },
  examples: [
    { user: "buy LAIN for 0.05", agent: "Quoting the pool, then sending the swap…" },
  ],
  async validate() {
    return true;
  },
  async handler(runtime, _state, params) {
    const svc = getService(runtime);
    if (!svc.walletClient || !svc.agentAddress) {
      return { ok: false, text: "No signer configured; I can only quote swaps." };
    }
    const token = svc.resolveToken(String(params.token ?? ""));
    if (!token) return { ok: false, text: `Unknown token. Known: ${Object.keys(svc.tokens).join(", ") || "(none configured)"}.` };
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
      const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSeconds);
      const hash = await svc.walletClient.writeContract({
        account: svc.walletClient.account!,
        chain: svc.chain,
        address: svc.dex.router,
        abi: ROUTER_ABI,
        functionName: "swapExactETHForTokens",
        args: [minOut, quote.path, svc.agentAddress, deadline],
        value: amountInWei,
      });
      const receipt = await svc.publicClient.waitForTransactionReceipt({ hash });
      const explorer = svc.explorerTxUrl(hash);
      if (receipt.status !== "success") {
        return { ok: false, text: `Swap reverted: ${hash}`, data: { hash, explorer, status: receipt.status } };
      }
      await svc.journal.recordBuy({
        token,
        symbol: quote.symbol,
        qtyWei: quote.amountOut,
        nativeWei: amountInWei,
        txHash: hash,
        reason: "buy_token",
      });
      return {
        ok: true,
        text:
          `Bought ${quote.symbol} for ${amountNative} ${svc.nativeSymbol}. Tx: ${hash}. ` +
          `Quoted output was ~${formatUnits(quote.amountOut, quote.decimals)} ${quote.symbol}; ` +
          `minOut was ${formatUnits(minOut, quote.decimals)}.`,
        data: {
          hash,
          explorer,
          status: receipt.status,
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
    "Sell an ERC20 back into the chain's native currency on the configured DEX from the agent's wallet. amountToken may be a number or 'all' (full wallet balance). Quotes live reserves first, refuses above the impact limit, executes with slippage protection, and records the trade (with realised PnL against the journal's cost basis).",
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
    },
    required: ["token", "amountToken"],
  },
  examples: [
    { user: "sell all my LAIN", agent: "Working out the exit against live reserves, then selling…" },
  ],
  async validate(runtime) {
    return Boolean(getService(runtime).walletClient);
  },
  async handler(runtime, _state, params) {
    const svc = getService(runtime);
    if (!svc.walletClient || !svc.agentAddress) {
      return { ok: false, text: "No signer configured; I can only quote sells." };
    }
    const token = svc.resolveToken(String(params.token ?? ""));
    if (!token) return { ok: false, text: `Unknown token. Known: ${Object.keys(svc.tokens).join(", ") || "(none configured)"}.` };
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
      const { raw, decimals, symbol } = await svc.rawTokenBalance(token, svc.agentAddress);
      if (raw <= 0n) return { ok: false, text: `I hold no ${symbol} to sell.` };
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
      const { hash, status } = await svc.sellExactTokens(quote, minOut, DEFAULT_DEADLINE_SECONDS);
      const explorer = svc.explorerTxUrl(hash);
      if (status !== "success") {
        return { ok: false, text: `Sell reverted: ${hash}`, data: { hash, explorer, status } };
      }
      const realizedWei = await svc.journal.recordSell({
        token,
        symbol,
        qtyWei: amountInWei,
        nativeWei: quote.amountOut,
        txHash: hash,
        reason: params.reason ? String(params.reason) : "sell_token",
      });
      const realized = formatEther(realizedWei);
      const sym = svc.nativeSymbol;
      return {
        ok: true,
        text:
          `Sold ${formatUnits(amountInWei, decimals)} ${symbol} for ~${formatEther(quote.amountOut)} ${sym} ` +
          `(impact ~${quote.priceImpactBps / 100}%, realised ${Number(realized) >= 0 ? "+" : ""}${realized} ${sym} vs basis). Tx: ${hash}`,
        data: {
          hash,
          explorer,
          status,
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
