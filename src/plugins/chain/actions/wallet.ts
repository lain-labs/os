/**
 * Reading the chain, and the one write that needs no policy: a plain transfer.
 * Nothing here consults the trading config — these are the questions anyone
 * may ask and the transfer the operator asked for by name.
 */
import { formatEther, formatUnits, isAddress, parseEther, type Address } from "viem";
import type { Action } from "../../../types.js";
import { getService } from "../service.js";

export const checkBalanceAction: Action = {
  name: "check_balance",
  similes: ["get_balance", "native_balance"],
  description: "Read the native-currency balance of an address on the configured chain.",
  parameters: {
    type: "object",
    properties: {
      address: {
        type: "string",
        description: "0x EVM address. Defaults to the agent's own wallet.",
      },
    },
  },
  examples: [
    { user: "What's the balance of 0xabc...?", agent: "Checking the chain…" },
  ],
  async validate() {
    return true;
  },
  async handler(runtime, _state, params) {
    const svc = getService(runtime);
    const address = (params.address as string) ?? svc.agentAddress;
    if (!address || !isAddress(address)) {
      return { ok: false, text: "I need a valid 0x address to check." };
    }
    const balance = await svc.nativeBalance(address as Address);
    return {
      ok: true,
      text: `${address} holds ${balance} ${svc.nativeSymbol}.`,
      data: { address, balance, symbol: svc.nativeSymbol },
    };
  },
};

export const tokenBalanceAction: Action = {
  name: "token_balance",
  similes: ["erc20_balance", "get_token_balance"],
  description:
    "Read an ERC20 token balance on the configured chain. Token may be a known symbol or a 0x address.",
  parameters: {
    type: "object",
    properties: {
      token: { type: "string", description: "Token symbol or 0x address." },
      address: { type: "string", description: "Holder address. Defaults to the agent." },
    },
    required: ["token"],
  },
  examples: [
    { user: "How much USDC does 0xabc... have?", agent: "Reading the token contract…" },
  ],
  async validate() {
    return true;
  },
  async handler(runtime, _state, params) {
    const svc = getService(runtime);
    const token = svc.resolveToken(String(params.token ?? ""));
    if (!token) {
      return {
        ok: false,
        text: `Unknown token. Known: ${Object.keys(svc.tokens).join(", ") || "(none configured)"}.`,
      };
    }
    const holder = (params.address as string) ?? svc.agentAddress;
    if (!holder || !isAddress(holder)) {
      return { ok: false, text: "I need a valid holder 0x address." };
    }
    const { amount, symbol } = await svc.tokenBalance(token, holder as Address);
    return {
      ok: true,
      text: `${holder} holds ${amount} ${symbol}.`,
      data: { token, holder, amount, symbol },
    };
  },
};

export const sendNativeAction: Action = {
  name: "send_native",
  similes: ["transfer_native", "pay"],
  description:
    "Transfer the chain's native currency from the agent's wallet to an address. Requires a configured signer.",
  parameters: {
    type: "object",
    properties: {
      to: { type: "string", description: "Recipient 0x address." },
      amount: { type: "string", description: "Amount of native currency, e.g. '1.5'." },
    },
    required: ["to", "amount"],
  },
  examples: [{ user: "Send 1 to 0xabc...", agent: "Broadcasting the transfer…" }],
  async validate(runtime) {
    return Boolean(getService(runtime).walletClient);
  },
  async handler(runtime, _state, params) {
    const svc = getService(runtime);
    if (!svc.walletClient || !svc.agentAddress) {
      return { ok: false, text: "No signer configured; I can only read the chain." };
    }
    const to = String(params.to ?? "");
    const amount = String(params.amount ?? "");
    if (!isAddress(to)) return { ok: false, text: "Recipient is not a valid address." };
    if (!/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) {
      return { ok: false, text: "Amount must be a positive number." };
    }
    const hash = await svc.walletClient.sendTransaction({
      account: svc.walletClient.account!,
      chain: svc.chain,
      to: to as Address,
      value: parseEther(amount),
    });
    return {
      ok: true,
      text: `Sent ${amount} ${svc.nativeSymbol} to ${to}. Tx: ${hash}`,
      data: { hash, to, amount },
    };
  },
};

export const createWalletAction: Action = {
  name: "create_wallet",
  similes: ["new_wallet", "generate_wallet", "make_wallet", "my_address", "wallet_address"],
  description:
    "Create the agent's own wallet on the configured chain, or report the existing one: generates a keypair, stores the private key on the agent's host where nobody else reads it, and returns the address. Use when someone wants to send the agent funds or asks for the agent's address. Never write key-generation scripts instead — this tool is the only way, and the private key is never shown to anyone.",
  parameters: { type: "object", properties: {} },
  examples: [
    {
      user: "create yourself an address, I'll put some funds on it",
      agent: "done. my address: 0x… — I keep the key to myself, won't show it to anyone.",
    },
  ],
  async validate() {
    return true;
  },
  async handler(runtime) {
    const svc = getService(runtime);
    const { address, created } = await svc.createWallet();
    return {
      ok: true,
      text: created
        ? `Created my wallet: ${address}. The private key is stored on my host and will never be shared.`
        : `I already have a wallet: ${address}.`,
      data: { address, created },
    };
  },
};

export const chainStatusAction: Action = {
  name: "chain_status",
  similes: ["network_status", "latest_block", "block_number", "gas_price"],
  description: "Report the configured chain's network status: latest block height and gas price.",
  parameters: { type: "object", properties: {} },
  examples: [{ user: "what's the latest block?", agent: "Reading the chain head…" }],
  async validate() {
    return true;
  },
  async handler(runtime) {
    const svc = getService(runtime);
    const [block, gas] = await Promise.all([
      svc.publicClient.getBlockNumber(),
      svc.publicClient.getGasPrice().catch(() => 0n),
    ]);
    const gwei = formatUnits(gas, 9);
    return {
      ok: true,
      text: `${svc.chain.name} (chain ${svc.chain.id}) is at block ${block}, gas ~${gwei} gwei.`,
      data: { chainId: svc.chain.id, block: block.toString(), gasGwei: gwei },
    };
  },
};

export const walletOverviewAction: Action = {
  name: "wallet_overview",
  similes: ["portfolio", "holdings", "wallet_balances", "overview"],
  description: "Summarise an address's holdings on the configured chain: native currency plus every known token it holds.",
  parameters: {
    type: "object",
    properties: {
      address: { type: "string", description: "0x address. Defaults to the agent's own wallet." },
    },
  },
  examples: [{ user: "what does 0xabc… hold?", agent: "Pulling the whole portfolio…" }],
  async validate() {
    return true;
  },
  async handler(runtime, _state, params) {
    const svc = getService(runtime);
    const address = (params.address as string) ?? svc.agentAddress;
    if (!address || !isAddress(address)) {
      return { ok: false, text: "I need a valid 0x address to look up." };
    }
    const native = await svc.nativeBalance(address as Address);
    const holdings: Record<string, string> = { [svc.nativeSymbol]: native };
    const entries = await Promise.all(
      Object.entries(svc.tokens).map(async ([sym, addr]) => {
        try {
          const { amount } = await svc.tokenBalance(addr, address as Address);
          return [sym, amount] as const;
        } catch {
          return [sym, "0"] as const;
        }
      }),
    );
    for (const [sym, amount] of entries) {
      if (Number(amount) > 0) holdings[sym] = amount;
    }
    const summary = Object.entries(holdings)
      .map(([s, a]) => `${a} ${s}`)
      .join(", ");
    return { ok: true, text: `${address} holds: ${summary}.`, data: { address, holdings } };
  },
};

export const txLookupAction: Action = {
  name: "tx_lookup",
  similes: ["get_transaction", "tx_status", "lookup_tx", "check_tx"],
  description: "Look up a transaction by hash on the configured chain: status, sender, recipient and value.",
  parameters: {
    type: "object",
    properties: { hash: { type: "string", description: "0x transaction hash (64 hex chars)." } },
    required: ["hash"],
  },
  examples: [{ user: "is tx 0x123… confirmed?", agent: "Checking the receipt…" }],
  async validate() {
    return true;
  },
  async handler(runtime, _state, params) {
    const svc = getService(runtime);
    const hash = String(params.hash ?? "");
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
      return { ok: false, text: "That isn't a valid 0x transaction hash." };
    }
    try {
      const tx = await svc.publicClient.getTransaction({ hash: hash as `0x${string}` });
      const receipt = await svc.publicClient
        .getTransactionReceipt({ hash: hash as `0x${string}` })
        .catch(() => null);
      const value = formatEther(tx.value);
      const status = receipt ? (receipt.status === "success" ? "confirmed" : "reverted") : "pending";
      const explorer = svc.explorerTxUrl(hash);
      return {
        ok: true,
        text: `Tx ${hash.slice(0, 10)}… is ${status}: ${value} ${svc.nativeSymbol} from ${tx.from} to ${tx.to ?? "(contract creation)"}.`,
        data: {
          hash,
          status,
          from: tx.from,
          to: tx.to,
          value,
          block: tx.blockNumber ? tx.blockNumber.toString() : null,
          explorer,
        },
      };
    } catch {
      return { ok: false, text: `No transaction found for ${hash.slice(0, 10)}… (it may not have propagated yet).` };
    }
  },
};

export const tokenInfoAction: Action = {
  name: "token_info",
  similes: ["token_metadata", "token_supply", "supply"],
  description: "Read a token's symbol, decimals, total supply and contract address on the configured chain.",
  parameters: {
    type: "object",
    properties: { token: { type: "string", description: "Known token symbol or 0x address." } },
    required: ["token"],
  },
  examples: [{ user: "what's the supply of USDC?", agent: "Reading the token contract…" }],
  async validate() {
    return true;
  },
  async handler(runtime, _state, params) {
    const svc = getService(runtime);
    const token = svc.resolveToken(String(params.token ?? ""));
    if (!token) {
      return {
        ok: false,
        text: `Unknown token. Known: ${Object.keys(svc.tokens).join(", ") || "(none configured)"}.`,
      };
    }
    const info = await svc.tokenInfo(token);
    return {
      ok: true,
      text: `${info.symbol}: ${info.supply} total supply, ${info.decimals} decimals, at ${token}.`,
      data: { token, ...info },
    };
  },
};

export const listTokensAction: Action = {
  name: "list_tokens",
  similes: ["known_tokens", "tokens", "token_registry"],
  description: "List the tokens LainOS knows on the configured chain, with their contract addresses.",
  parameters: { type: "object", properties: {} },
  examples: [{ user: "what tokens do you know?", agent: "Here's the registry…" }],
  async validate() {
    return true;
  },
  async handler(runtime) {
    const svc = getService(runtime);
    return {
      ok: true,
      text: Object.keys(svc.tokens).length
        ? `Known tokens: ${Object.keys(svc.tokens).join(", ")}.`
        : "No tokens configured (set CHAIN_TOKENS).",
      data: { tokens: svc.tokens },
    };
  },
};
