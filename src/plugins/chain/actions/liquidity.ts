/**
 * Adding liquidity to an existing pair on the configured DEX.
 *
 * Two guards make this different from a swap: the pool share the deposit would
 * take is capped, and a native spend above the confirmation threshold has to be
 * echoed back by the caller before anything is signed. Creating a *first*
 * position in a pair is refused outright — there is no market price to check.
 */
import { formatUnits } from "viem";
import type { Action, IAgentRuntime } from "../../../types.js";
import { getService, type DexLiquidityQuote } from "../service.js";
import {
  DEFAULT_LIQUIDITY_CONFIRM_THRESHOLD_NATIVE,
  DEFAULT_LIQUIDITY_MAX_POOL_SHARE_BPS,
  parseConfigBps,
  parseConfigNative,
  parseDeadlineSeconds,
  parseSlippageBps,
} from "../config.js";

export const quoteLiquidityAction: Action = {
  name: "quote_liquidity",
  similes: ["quote_add_liquidity", "quote_lp", "dex_lp_quote"],
  description:
    "Quote adding liquidity to an existing pool on the configured DEX. Supports native-token and token-token pairs, reads live reserves, computes balanced amounts/refunds, minimums after slippage, expected LP minted, and pool-share impact. Does not sign.",
  parameters: {
    type: "object",
    properties: {
      tokenA: { type: "string", description: "NATIVE, a token symbol, or a 0x token address." },
      tokenB: { type: "string", description: "NATIVE, a token symbol, or a 0x token address." },
      amountA: { type: "string", description: "Maximum amount of tokenA to supply." },
      amountB: { type: "string", description: "Maximum amount of tokenB to supply." },
      slippageBps: { type: "number", description: "Allowed slippage in basis points. Default 100 = 1%." },
      maxPoolShareBps: {
        type: "number",
        description: "Refuse if supplied amounts exceed this share of reserves. Default 500 = 5%.",
      },
    },
    required: ["tokenA", "tokenB", "amountA", "amountB"],
  },
  examples: [
    { user: "quote LP 0.1 native and 100 LAIN", agent: "Reading DEX reserves and balancing the add…" },
  ],
  async validate() {
    return true;
  },
  async handler(runtime, _state, params) {
    const svc = getService(runtime);
    const parsed = parseLiquidityActionParams(runtime, params);
    if (typeof parsed === "string") return { ok: false, text: parsed };
    try {
      const quote = await svc.quoteAddLiquidity(parsed);
      if (quote.poolShareBps > parsed.maxPoolShareBps) {
        return {
          ok: false,
          text:
            `LP add would use ~${quote.poolShareBps / 100}% of the pool reserves, above the ` +
            `${parsed.maxPoolShareBps / 100}% limit. Use smaller amounts or raise maxPoolShareBps deliberately.`,
          data: liquidityQuoteData(quote, parsed.maxPoolShareBps, svc.dex.router),
        };
      }
      return {
        ok: true,
        text: liquidityQuoteText(quote, parsed.maxPoolShareBps),
        data: liquidityQuoteData(quote, parsed.maxPoolShareBps, svc.dex.router),
      };
    } catch (err) {
      return { ok: false, text: `Cannot quote liquidity: ${(err as Error).message}.` };
    }
  },
};

export const addLiquidityAction: Action = {
  name: "add_liquidity",
  similes: ["mint_lp", "add_lp", "dex_add_liquidity"],
  description:
    "Add liquidity to an existing pool on the configured DEX from the agent wallet. Supports native-token and token-token pairs. Re-quotes live reserves, computes balanced amounts/refunds, checks pool share, requires explicit confirmation for large native spends or token-token adds, approves ERC20s only for needed amounts, submits with deadline/slippage protection, verifies LP balance increase, and journals the action.",
  parameters: {
    type: "object",
    properties: {
      tokenA: { type: "string", description: "NATIVE, a token symbol, or a 0x token address." },
      tokenB: { type: "string", description: "NATIVE, a token symbol, or a 0x token address." },
      amountA: { type: "string", description: "Maximum amount of tokenA to supply." },
      amountB: { type: "string", description: "Maximum amount of tokenB to supply." },
      slippageBps: { type: "number", description: "Allowed slippage in basis points. Default 100 = 1%." },
      maxPoolShareBps: {
        type: "number",
        description: "Refuse if supplied amounts exceed this share of reserves. Default 500 = 5%.",
      },
      deadlineSeconds: { type: "number", description: "Transaction deadline from now. Default 300 seconds." },
      execute: {
        type: "boolean",
        description: "Must be true to sign. Omit or false for a dry run quote.",
      },
      confirmation: {
        type: "string",
        description:
          "Required exactly as returned by quote_liquidity when confirmationRequired is true. Only provide it after the operator explicitly confirms.",
      },
      reason: { type: "string", description: "Optional short journal reason." },
    },
    required: ["tokenA", "tokenB", "amountA", "amountB"],
  },
  examples: [
    { user: "add liquidity 0.1 native and 100 LAIN", agent: "Working out the LP add against live reserves first…" },
  ],
  async validate(runtime) {
    return Boolean(getService(runtime).walletClient);
  },
  async handler(runtime, _state, params) {
    const svc = getService(runtime);
    if (!svc.walletClient || !svc.agentAddress) {
      return { ok: false, text: "No signer configured; I can only quote LP adds." };
    }
    const parsed = parseLiquidityActionParams(runtime, params);
    if (typeof parsed === "string") return { ok: false, text: parsed };
    const deadlineSeconds = parseDeadlineSeconds(params.deadlineSeconds);
    if (deadlineSeconds === null) return { ok: false, text: "deadlineSeconds must be between 30 and 3600." };

    try {
      const quote = await svc.quoteAddLiquidity(parsed);
      if (quote.poolShareBps > parsed.maxPoolShareBps) {
        return {
          ok: false,
          text:
            `I will not add this liquidity: it would use ~${quote.poolShareBps / 100}% of reserves, ` +
            `above the ${parsed.maxPoolShareBps / 100}% limit.`,
          data: liquidityQuoteData(quote, parsed.maxPoolShareBps, svc.dex.router),
        };
      }
      if (params.execute !== true) {
        return {
          ok: true,
          text: `${liquidityQuoteText(quote, parsed.maxPoolShareBps)} Dry run only; call again with execute=true to sign.`,
          data: { ...liquidityQuoteData(quote, parsed.maxPoolShareBps, svc.dex.router), dryRun: true },
        };
      }
      if (quote.confirmation && String(params.confirmation ?? "") !== quote.confirmation) {
        return {
          ok: false,
          text:
            `This LP add needs explicit confirmation (${quote.confirmationReason}). ` +
            `To proceed, confirm exactly: ${quote.confirmation}`,
          data: liquidityQuoteData(quote, parsed.maxPoolShareBps, svc.dex.router),
        };
      }

      const { hash, status, mintedLp, approveHashes } = await svc.addLiquidity(quote, deadlineSeconds);
      const explorer = svc.explorerTxUrl(hash);
      if (status !== "success") {
        return { ok: false, text: `LP add reverted: ${hash}`, data: { hash, explorer, status, approveHashes } };
      }
      if (mintedLp <= 0n) {
        return {
          ok: false,
          text: `LP add confirmed but LP balance did not increase; tx ${hash}`,
          data: { hash, explorer, status, approveHashes, mintedLp: "0" },
        };
      }
      await svc.journal.recordLiquidityAdd({
        pair: quote.pair,
        tokenA: quote.assetA.kind === "native" ? svc.nativeSymbol : quote.assetA.token,
        symbolA: quote.assetA.symbol,
        amountAWei: quote.amountAUsed,
        tokenB: quote.assetB.kind === "native" ? svc.nativeSymbol : quote.assetB.token,
        symbolB: quote.assetB.symbol,
        amountBWei: quote.amountBUsed,
        lpWei: mintedLp,
        txHash: hash,
        reason: params.reason ? String(params.reason) : "add_liquidity",
      });
      return {
        ok: true,
        text:
          `Added liquidity to ${quote.assetA.symbol}/${quote.assetB.symbol}: ` +
          `${formatUnits(quote.amountAUsed, quote.assetA.decimals)} ${quote.assetA.symbol} + ` +
          `${formatUnits(quote.amountBUsed, quote.assetB.decimals)} ${quote.assetB.symbol}. ` +
          `Minted ${formatUnits(mintedLp, 18)} LP at ${quote.pair}. Tx: ${hash}`,
        data: {
          hash,
          explorer,
          status,
          approveHashes,
          mintedLp: formatUnits(mintedLp, 18),
          ...liquidityQuoteData(quote, parsed.maxPoolShareBps, svc.dex.router),
        },
      };
    } catch (err) {
      return { ok: false, text: `LP add failed: ${(err as Error).message}.` };
    }
  },
};


function parseLiquidityActionParams(
  runtime: IAgentRuntime,
  params: Record<string, unknown>,
):
  | {
      tokenA: string;
      tokenB: string;
      amountA: string;
      amountB: string;
      slippageBps: number;
      maxPoolShareBps: number;
      confirmThresholdWei: bigint;
    }
  | string {
  const tokenA = String(params.tokenA ?? "").trim();
  const tokenB = String(params.tokenB ?? "").trim();
  const amountA = String(params.amountA ?? "").trim();
  const amountB = String(params.amountB ?? "").trim();
  if (!tokenA || !tokenB || !amountA || !amountB) {
    return "tokenA, tokenB, amountA and amountB are required.";
  }
  const slippageBps = parseSlippageBps(params.slippageBps);
  if (slippageBps === null) return "slippageBps must be between 0 and 5000.";
  const maxPoolShareRaw = params.maxPoolShareBps ?? runtime.getSetting("LAINOS_LIQUIDITY_MAX_POOL_SHARE_BPS");
  const maxPoolShareBps = parseConfigBps(
    maxPoolShareRaw === undefined || maxPoolShareRaw === "" ? undefined : String(maxPoolShareRaw),
    DEFAULT_LIQUIDITY_MAX_POOL_SHARE_BPS,
    "LAINOS_LIQUIDITY_MAX_POOL_SHARE_BPS",
  );
  const confirmThresholdWei = parseConfigNative(
    runtime.getSetting("LAINOS_LIQUIDITY_CONFIRM_THRESHOLD_NATIVE"),
    DEFAULT_LIQUIDITY_CONFIRM_THRESHOLD_NATIVE,
    "LAINOS_LIQUIDITY_CONFIRM_THRESHOLD_NATIVE",
  );
  return { tokenA, tokenB, amountA, amountB, slippageBps, maxPoolShareBps, confirmThresholdWei };
}

function liquidityQuoteText(quote: DexLiquidityQuote, maxPoolShareBps: number): string {
  return (
    `LP quote ${quote.assetA.symbol}/${quote.assetB.symbol}: use ` +
    `${formatUnits(quote.amountAUsed, quote.assetA.decimals)} ${quote.assetA.symbol} + ` +
    `${formatUnits(quote.amountBUsed, quote.assetB.decimals)} ${quote.assetB.symbol}, ` +
    `expected ~${formatUnits(quote.expectedLp, 18)} LP. ` +
    `Refund/unused: ${formatUnits(quote.amountARefund, quote.assetA.decimals)} ${quote.assetA.symbol}, ` +
    `${formatUnits(quote.amountBRefund, quote.assetB.decimals)} ${quote.assetB.symbol}. ` +
    `Pool ${quote.pair}, reserves ${formatUnits(quote.reserveA, quote.assetA.decimals)} ${quote.assetA.symbol} / ` +
    `${formatUnits(quote.reserveB, quote.assetB.decimals)} ${quote.assetB.symbol}, ` +
    `pool share ~${quote.poolShareBps / 100}% (limit ${maxPoolShareBps / 100}%).` +
    (quote.confirmation ? ` Confirmation required: ${quote.confirmation}` : "")
  );
}

function liquidityQuoteData(
  quote: DexLiquidityQuote,
  maxPoolShareBps: number,
  router: `0x${string}`,
): Record<string, unknown> {
  return {
    pair: quote.pair,
    router,
    tokenA: quote.assetA.kind === "native" ? "NATIVE" : quote.assetA.token,
    tokenB: quote.assetB.kind === "native" ? "NATIVE" : quote.assetB.token,
    symbolA: quote.assetA.symbol,
    symbolB: quote.assetB.symbol,
    amountADesired: formatUnits(quote.amountADesired, quote.assetA.decimals),
    amountBDesired: formatUnits(quote.amountBDesired, quote.assetB.decimals),
    amountAUsed: formatUnits(quote.amountAUsed, quote.assetA.decimals),
    amountBUsed: formatUnits(quote.amountBUsed, quote.assetB.decimals),
    amountARefund: formatUnits(quote.amountARefund, quote.assetA.decimals),
    amountBRefund: formatUnits(quote.amountBRefund, quote.assetB.decimals),
    amountAMin: formatUnits(quote.amountAMin, quote.assetA.decimals),
    amountBMin: formatUnits(quote.amountBMin, quote.assetB.decimals),
    reserveA: formatUnits(quote.reserveA, quote.assetA.decimals),
    reserveB: formatUnits(quote.reserveB, quote.assetB.decimals),
    expectedLp: formatUnits(quote.expectedLp, 18),
    poolShareBps: quote.poolShareBps,
    maxPoolShareBps,
    slippageBps: quote.slippageBps,
    confirmationRequired: Boolean(quote.confirmation),
    confirmation: quote.confirmation,
    confirmationReason: quote.confirmationReason,
  };
}
