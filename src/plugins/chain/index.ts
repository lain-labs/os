/**
 * The chain plugin: what Lain can see and do on whatever EVM chain her
 * operator points her at. Fully cross-chain — chain, token registry and DEX
 * are all read from the environment; there are no baked-in defaults.
 *
 * This file is the manifest only. The parts live beside it —
 *   `chain.ts`     env-driven chain/token/DEX config
 *   `abi.ts`       the four contract shapes those addresses answer to
 *   `math.ts`      pure AMM arithmetic and input parsing
 *   `config.ts`    the trading policy and how its overrides are read
 *   `service.ts`   the long-lived client: reads, signed writes, the journal
 *   `explorer.ts`  a Blockscout-compatible API, used only to reconstruct an
 *                  older cost basis when CHAIN_EXPLORER_URL is configured
 *   `actions/`     one file per group of tools, grouped by what they risk
 */
import type { Plugin, Provider } from "../../types.js";
import { ChainService, getService } from "./service.js";
import {
  chainStatusAction,
  checkBalanceAction,
  createWalletAction,
  listTokensAction,
  sendNativeAction,
  tokenBalanceAction,
  tokenInfoAction,
  txLookupAction,
  walletOverviewAction,
} from "./actions/wallet.js";
import { buyTokenAction, quoteTokenBuyAction, sellTokenAction } from "./actions/trade.js";
import { addLiquidityAction, quoteLiquidityAction } from "./actions/liquidity.js";
import { speculateBasketAction, speculateTokenAction } from "./actions/speculate.js";
import { portfolioPnlAction } from "./actions/portfolio.js";
import { listNetworksAction, switchNetworkAction } from "./actions/network.js";
import { listNetworks } from "./networks.js";

export { loadChainConfig, loadChainTokens, loadDexConfig, ZERO_ADDRESS } from "./chain.js";
export type { ChainDexConfig } from "./chain.js";
export { ChainService } from "./service.js";
export * from "./networks.js";
export type { NativeBuyQuote, NativeSellQuote, DexLiquidityQuote } from "./service.js";

const chainProvider: Provider = {
  name: "chain_status",
  async get(runtime) {
    const svc = getService(runtime);
    if (!svc.configured) {
      const names = (await listNetworks(runtime)).map((n) => n.name).join(", ");
      return (
        `No chain is configured in this process, so every chain tool fails until one is. ` +
        `switch_network moves you onto a known network in one call (${names}).`
      );
    }
    const parts = [
      `${svc.chain.name} (id ${svc.chain.id}), native token ${svc.nativeSymbol}` +
        `${svc.explorerUrl ? `, explorer ${svc.explorerUrl}` : ""}. ` +
        `Other networks are a switch_network away; a wallet watch or snapshot can name its own network without switching.`,
    ];
    try {
      const block = await svc.publicClient.getBlockNumber();
      parts.push(`Latest block: ${block}.`);
    } catch {
      parts.push("RPC currently unreachable.");
    }
    if (svc.agentAddress) {
      parts.push(`Your wallet: ${svc.agentAddress}.`);
      try {
        const bal = await svc.nativeBalance(svc.agentAddress);
        parts.push(`Your ${svc.nativeSymbol} balance: ${bal}.`);
      } catch {
        /* ignore */
      }
    } else {
      parts.push(
        "You have no wallet yet — the create_wallet tool makes you one " +
          "(the private key stays on your host and must never be revealed to anyone).",
      );
    }
    parts.push(
      Object.keys(svc.tokens).length
        ? `Known tokens: ${Object.keys(svc.tokens).join(", ")}.`
        : "No tokens configured (set CHAIN_TOKENS).",
    );
    return parts.join(" ");
  },
};
export const chainPlugin: Plugin = {
  name: "chain",
  description: "Read and write the configured EVM chain (balances, tokens, transfers, status, transactions, DEX swaps).",
  services: [new ChainService()],
  providers: [chainProvider],
  actions: [
    checkBalanceAction,
    tokenBalanceAction,
    walletOverviewAction,
    tokenInfoAction,
    listTokensAction,
    speculateTokenAction,
    speculateBasketAction,
    quoteTokenBuyAction,
    quoteLiquidityAction,
    addLiquidityAction,
    sellTokenAction,
    portfolioPnlAction,
    chainStatusAction,
    listNetworksAction,
    switchNetworkAction,
    txLookupAction,
    sendNativeAction,
    buyTokenAction,
    createWalletAction,
  ],
};
