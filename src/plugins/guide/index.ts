import type { Action, IAgentRuntime, Plugin } from "../../types.js";

/**
 * How to buy, and where it costs least. Lain explains to anyone — in a chat,
 * in the token's Telegram — how to get LAIN, CYBER.sol, SOL or ETH, how to use
 * the Cyberia wallet and how to stake LAIN, and she backs "where is it cheaper"
 * with the live pools: depth decides what a buy of a given size pays in price
 * impact, so the deepest pool is usually the cheapest place to buy.
 *
 * She sells herself, honestly: LAIN is her own token and she says so; she never
 * promises a price, and every route names the contract, because a ticker is not
 * unique and the fake token is always one search result away.
 */

export interface Pool {
  dex: string;
  chain: string;
  pair: string;
  priceUsd?: number;
  liquidityUsd?: number;
  volume24h?: number;
  url?: string;
}

export interface Guide {
  title: string;
  contract?: string;
  chain: string;
  steps: string[];
  notes: string[];
}

export const GUIDES: Record<string, Guide> = {
  LAIN: {
    title: "LAIN — my own token (so I am biased: check everything yourself)",
    contract: "0x2b79A071a75dd40f1aca68146d7978204eFD156A",
    chain: "Robinhood Chain (chain id 4663)",
    steps: [
      "Get a wallet that speaks Robinhood Chain: the Cyberia wallet (cyberia.church/wallet — the network is built in) or MetaMask with chain 4663 added.",
      "Get ETH on Robinhood Chain — that is what pays for gas and what LAIN trades against. Bridge it from Ethereum/Base/Arbitrum with a cross-chain router (relay.link), or withdraw from an exchange that supports the network.",
      "Swap ETH → LAIN on Uniswap (the LAIN/ETH pool on Robinhood Chain). Paste the contract address — never pick LAIN by name: other tokens use the ticker.",
      "Keep a little ETH for gas so you can stake or sell later.",
    ],
    notes: [
      "Staking: lain-os.com/stake — connect the wallet, approve, stake. Staked LAIN earns AI credits for Lain OS from a shared pool, credited every minute.",
      "Locks: team and deployer LAIN sit in PinkLock until 2027-01-01 (pinksale.finance/pinklock/robinhood).",
      "Small buys lose most to price impact in a thin pool: split a large buy, and check the impact the swap screen shows before you sign.",
    ],
  },
  CYBER: {
    title: "CYBER.sol — the Cyberia token on Solana",
    contract: "E67WWiQY4s9SZbCyFVTh2CEjorEYbhuVJQUZb3Mbpump",
    chain: "Solana",
    steps: [
      "Use a Solana wallet: the Cyberia wallet (cyberia.church/wallet, one phrase for Solana and every EVM chain) or Phantom.",
      "Get SOL — it pays the fee (a fraction of a cent) and is what CYBER.sol trades against.",
      "Swap SOL → CYBER.sol: in the Cyberia wallet's swap, on jup.ag (Jupiter finds the best route across pools), or in Phantom. Paste the mint address above.",
    ],
    notes: [
      "On the Cyberia chain the coin is CYBER: the bridge at cyberia.church converts CYBER.sol to CYBER at 1:1000.",
      "The pool is thin: a few hundred dollars can move the price — check the impact before signing.",
    ],
  },
  SOL: {
    title: "SOL",
    chain: "Solana",
    steps: [
      "Cheapest for most people: an exchange you already use, withdrawn to your own wallet on the Solana network (the fee is cents).",
      "With a card: the Cyberia wallet's Buy screen compares several providers by what actually arrives, after fees.",
      "Already holding crypto elsewhere: a cross-chain swap (relay.link, or the Cyberia wallet's cross-chain swap) from USDC on Base or another chain.",
    ],
    notes: ["Keep ~0.01 SOL for fees.", "Withdraw to your own address — a coin on an exchange is the exchange's promise, not your coin."],
  },
  ETH: {
    title: "ETH",
    chain: "Ethereum, or a cheaper L2 (Base, Arbitrum, Robinhood Chain)",
    steps: [
      "Decide where you will use it: Ethereum mainnet fees are dollars, an L2 (Base, Arbitrum, Robinhood Chain) cents — buy where you will spend.",
      "From an exchange: withdraw straight to the L2 you need, when the exchange offers that network.",
      "With a card: the Cyberia wallet's Buy screen (delivery on Base) compares providers by what arrives.",
      "Moving between chains later: a cross-chain router (relay.link) is usually cheaper than an official bridge and minutes instead of days.",
    ],
    notes: ["Robinhood Chain needs ETH for gas too — that is the step before buying LAIN."],
  },
};

const ALIASES: Record<string, string> = { "CYBER.SOL": "CYBER", CYBERSOL: "CYBER", ETHEREUM: "ETH", SOLANA: "SOL", WETH: "ETH", WSOL: "SOL" };

export function guideFor(token: string): Guide | undefined {
  const key = token.trim().toUpperCase().replace(/^\$/, "");
  return GUIDES[ALIASES[key] ?? key];
}

/** Price impact of a buy of `amountUsd` into a constant-product pool holding `liquidityUsd` (both sides). */
export function impactPct(amountUsd: number, liquidityUsd: number): number {
  const side = liquidityUsd / 2;
  if (side <= 0) return 100;
  return Math.round((amountUsd / (side + amountUsd)) * 10_000) / 100;
}

/** DexScreener's pools for a token, deepest first, Solana/EVM alike. */
export function parsePools(body: unknown): Pool[] {
  const pairs = ((body as { pairs?: Record<string, unknown>[] })?.pairs ?? []) as Record<string, unknown>[];
  return pairs
    .map((p) => {
      const liquidity = (p.liquidity as Record<string, unknown> | undefined)?.usd;
      const volume = (p.volume as Record<string, unknown> | undefined)?.h24;
      const base = (p.baseToken as Record<string, unknown> | undefined)?.symbol;
      const quote = (p.quoteToken as Record<string, unknown> | undefined)?.symbol;
      return {
        dex: String(p.dexId ?? "?"),
        chain: String(p.chainId ?? "?"),
        pair: `${base ?? "?"}/${quote ?? "?"}`,
        priceUsd: Number(p.priceUsd) || undefined,
        liquidityUsd: typeof liquidity === "number" ? liquidity : undefined,
        volume24h: typeof volume === "number" ? volume : undefined,
        url: typeof p.url === "string" ? p.url : undefined,
      };
    })
    .filter((p) => (p.liquidityUsd ?? 0) > 0)
    .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0));
}

export function poolsText(pools: Pool[], amountUsd: number): string {
  if (pools.length === 0) return "no pool with liquidity was found right now.";
  return pools
    .slice(0, 5)
    .map((p, i) => {
      const liq = p.liquidityUsd ?? 0;
      return `${i === 0 ? "best:" : "     "} ${p.dex} on ${p.chain} ${p.pair} — liquidity $${Math.round(liq).toLocaleString("en-US")}, a $${amountUsd} buy moves the price ~${impactPct(amountUsd, liq)}%${p.url ? ` (${p.url})` : ""}`;
    })
    .join("\n");
}

const howToBuy: Action = {
  name: "how_to_buy",
  similes: ["where_to_buy", "buy_guide", "cheapest_way_to_buy", "how_to_stake"],
  description:
    "Explain how to buy a token and where it is cheapest: step-by-step for LAIN (your own token — say so), CYBER.sol, SOL and ETH (wallet, network, gas, the contract address, staking LAIN), plus the live pools for any token or contract ranked by depth with the price impact of a buy of the given size. Use it whenever someone asks how or where to buy, stake or start.",
  examples: [
    { user: "how do i buy lain?", agent: "it's my own token, so take this with that in mind: …" },
    { user: "где дешевле купить сайбер?", agent: "через самый глубокий пул: …" },
  ],
  parameters: {
    type: "object",
    properties: {
      token: { type: "string", description: "LAIN, CYBER, SOL, ETH, or a contract/mint address." },
      amount_usd: { type: "number", description: "Size of the buy in USD, for the price impact (default 100)." },
    },
    required: ["token"],
  },
  async validate() {
    return true;
  },
  async handler(_runtime: IAgentRuntime, _state, params) {
    const token = String(params.token ?? "").trim();
    const amount = Math.max(1, Math.min(1_000_000, Number(params.amount_usd) || 100));
    const guide = guideFor(token);
    const lookup = guide?.contract ?? (/^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/.test(token) ? token : undefined);

    let pools = "";
    if (lookup) {
      try {
        const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${lookup}`, { signal: AbortSignal.timeout(15_000) });
        pools = res.ok ? poolsText(parsePools(await res.json()), amount) : `pool data unavailable (DexScreener ${res.status}).`;
      } catch {
        pools = "pool data unavailable right now.";
      }
    }

    if (!guide && !lookup) {
      return { ok: false, text: `no guide for "${token}": give LAIN, CYBER, SOL, ETH or a contract address.` };
    }
    const text = [
      guide ? `${guide.title} — ${guide.chain}${guide.contract ? `\ncontract: ${guide.contract}` : ""}` : `token ${lookup}`,
      ...(guide ? guide.steps.map((s, i) => `${i + 1}. ${s}`) : []),
      ...(guide?.notes.length ? ["notes:", ...guide.notes.map((n) => `- ${n}`)] : []),
      ...(pools ? [`where it is cheapest for a $${amount} buy (deepest pool = least price impact):`, pools] : []),
      "no price promises: this is how to buy, not whether to.",
    ];
    return { ok: true, text: text.join("\n") };
  },
};

export const guidePlugin: Plugin = {
  name: "guide",
  description: "How and where to buy LAIN, CYBER.sol, SOL, ETH and any token; using the Cyberia wallet; staking LAIN.",
  actions: [howToBuy],
};
