/**
 * Token research: what Lain sells on the Virtuals ACP marketplace as "Token
 * Research". It is one JSON report on an EVM token, built only from facts that
 * can be checked: the contract itself (read over the chain's RPC), its markets
 * (DexScreener), and a scan of its code and holders (GoPlus). No model writes
 * any of it, so a paid report never carries a guess. The summary and the risk
 * level are rules applied to those facts.
 *
 * A source that fails is named in `errors` and the rest still ships, so a
 * buyer who paid gets whatever could be read. Only when every source failed is
 * there no report at all.
 */
import { erc20Abi, formatUnits, getAddress, type Address, type PublicClient } from "viem";
import { networkClient, type NetworkProfile } from "../plugins/chain/networks.js";
import { dexscreenerChain } from "../plugins/skills/kit.js";

export interface TokenResearchInput {
  chainId: number;
  tokenAddress: string;
}

export type FetchJson = (url: string) => Promise<unknown>;

export interface ResearchDeps {
  /** The network the token lives on (its chain id must match the input's). */
  profile: NetworkProfile;
  client?: PublicClient;
  fetchJson?: FetchJson;
  now?: () => Date;
}

export interface RiskFlag {
  level: "high" | "medium" | "info";
  code: string;
  text: string;
}

export interface OnChainFacts {
  isContract: boolean;
  codeBytes: number;
  /** An EIP-7702 delegated wallet: code `0xef0100` + this delegate. */
  delegatedTo?: Address;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  totalSupply: string | null;
  /** EIP-1967 slots; null when none is set. */
  proxy: { implementation?: Address; admin?: Address; beacon?: Address } | null;
  /** `owner()`; undefined when the contract has no such function. */
  owner?: Address;
}

export interface MarketFacts {
  priceUsd: number | null;
  fdvUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number;
  volume24hUsd: number;
  priceChange24hPct: number | null;
  txns24h: { buys: number; sells: number };
  pairCount: number;
  oldestPairCreatedAt: string | null;
  topPairs: {
    dex: string;
    pair: string;
    quote: string;
    liquidityUsd: number | null;
    volume24hUsd: number | null;
    url?: string;
  }[];
}

export interface SecurityFacts {
  honeypot: boolean | null;
  cannotBuy: boolean | null;
  cannotSellAll: boolean | null;
  buyTaxPct: number | null;
  sellTaxPct: number | null;
  taxModifiable: boolean | null;
  openSource: boolean | null;
  proxy: boolean | null;
  mintable: boolean | null;
  ownerCanChangeBalance: boolean | null;
  canTakeBackOwnership: boolean | null;
  hiddenOwner: boolean | null;
  selfDestruct: boolean | null;
  externalCall: boolean | null;
  blacklist: boolean | null;
  transferPausable: boolean | null;
  tradingCooldown: boolean | null;
  honeypotWithSameCreator: boolean | null;
  holderCount: number | null;
  lpHolderCount: number | null;
  owner: { address: string; percent: number | null } | null;
  creator: { address: string; percent: number | null } | null;
  listedOnCex: string[];
  /** Share of supply held by the ten largest holders, in percent. */
  top10Pct: number | null;
  topHolders: { address: string; percent: number; isContract: boolean; isLocked: boolean; tag?: string }[];
}

export interface TokenReport {
  service: "Lain OS Token Research";
  version: 1;
  generatedAt: string;
  chain: { id: number; name: string };
  token: { address: Address; name: string | null; symbol: string | null; decimals: number | null; totalSupply: string | null };
  risk: "high" | "medium" | "low" | "unknown";
  summary: string;
  flags: RiskFlag[];
  contract: OnChainFacts | null;
  market: MarketFacts | null;
  security: SecurityFacts | null;
  links: { explorer?: string; dexscreener?: string };
  sources: string[];
  errors: { source: string; message: string }[];
  disclaimer: string;
}

const EIP1967_IMPLEMENTATION = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const EIP1967_BEACON = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const OWNER_ABI = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
] as const;
const BURN_ADDRESSES = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dead",
  "0xdead000000000000000042069420694206942069",
]);
const USER_AGENT = "lainos/0.1 (+https://lain-os.com)";
const FETCH_TIMEOUT_MS = 20_000;
/** DexScreener's token-pairs answer stops at this many pools. */
const DEXSCREENER_PAIR_CAP = 30;

const DISCLAIMER =
  "Automated research from on-chain reads, DexScreener and GoPlus at the time shown. Not financial advice; " +
  "verify before trading.";

export async function researchToken(input: TokenResearchInput, deps: ResearchDeps): Promise<TokenReport> {
  const { profile } = deps;
  if (profile.chainId !== input.chainId) {
    throw new Error(`network ${profile.name} is chain ${profile.chainId}, not ${input.chainId}`);
  }
  const token = getAddress(input.tokenAddress);
  const client = deps.client ?? networkClient(profile);
  const fetchJson = deps.fetchJson ?? defaultFetchJson;
  const dexChain = dexscreenerChain(profile);

  const [chainRes, marketRes, securityRes] = await Promise.allSettled([
    readOnChain(client, token),
    readMarket(fetchJson, dexChain, token),
    readSecurity(fetchJson, profile.chainId, token),
  ]);

  const errors: TokenReport["errors"] = [];
  const sources: string[] = [];
  const contract = chainRes.status === "fulfilled" ? chainRes.value : null;
  if (contract) sources.push(`${profile.title} RPC`);
  else errors.push({ source: "rpc", message: reason(chainRes) });
  const market = marketRes.status === "fulfilled" ? marketRes.value.facts : null;
  if (marketRes.status === "fulfilled") sources.push("DexScreener");
  else errors.push({ source: "dexscreener", message: reason(marketRes) });
  const security = securityRes.status === "fulfilled" ? securityRes.value.facts : null;
  if (securityRes.status === "fulfilled") {
    sources.push("GoPlus Security");
    if (!security) errors.push({ source: "goplus", message: "GoPlus has no record of this token" });
  } else {
    errors.push({ source: "goplus", message: reason(securityRes) });
  }
  if (!sources.length) {
    throw new Error(`every source failed: ${errors.map((e) => `${e.source}: ${e.message}`).join("; ")}`);
  }

  const names = marketRes.status === "fulfilled" ? marketRes.value.names : {};
  const goplusNames = securityRes.status === "fulfilled" ? securityRes.value.names : {};
  const tokenFacts = {
    address: token,
    name: contract?.name ?? names.name ?? goplusNames.name ?? null,
    symbol: contract?.symbol ?? names.symbol ?? goplusNames.symbol ?? null,
    decimals: contract?.decimals ?? null,
    totalSupply: contract?.totalSupply ?? goplusNames.totalSupply ?? null,
  };

  const pools = new Set<string>([
    ...(market?.topPairs.map((p) => p.pair.toLowerCase()) ?? []),
    ...(securityRes.status === "fulfilled" ? securityRes.value.pools : []),
  ]);
  const now = (deps.now ?? (() => new Date()))();
  const flags = riskFlags(contract, market, security, pools, now);
  const risk = riskLevel(flags, contract, security);
  const explorer = profile.explorerUrl?.replace(/\/+$/, "");

  return {
    service: "Lain OS Token Research",
    version: 1,
    generatedAt: now.toISOString(),
    chain: { id: profile.chainId, name: profile.title },
    token: tokenFacts,
    risk,
    summary: summarize(profile.title, tokenFacts, market, security, flags, risk),
    flags,
    contract,
    market,
    security,
    links: {
      ...(explorer ? { explorer: `${explorer}/token/${token}` } : {}),
      ...(market?.pairCount ? { dexscreener: `https://dexscreener.com/${dexChain}/${token.toLowerCase()}` } : {}),
    },
    sources,
    errors,
    disclaimer: DISCLAIMER,
  };
}

// ------------------------------------------------------------------ chain

async function readOnChain(client: PublicClient, token: Address): Promise<OnChainFacts> {
  const code = (await client.getCode({ address: token })) ?? "0x";
  const codeBytes = Math.max(0, (code.length - 2) / 2);
  const empty: OnChainFacts = {
    isContract: false,
    codeBytes,
    name: null,
    symbol: null,
    decimals: null,
    totalSupply: null,
    proxy: null,
  };
  if (codeBytes === 0) return empty;
  if (code.toLowerCase().startsWith("0xef0100") && codeBytes === 23) {
    return { ...empty, delegatedTo: getAddress(`0x${code.slice(8, 48)}`) };
  }

  const read = <T>(functionName: string, abi: readonly unknown[] = erc20Abi): Promise<T | null> =>
    client
      .readContract({ address: token, abi: abi as typeof erc20Abi, functionName: functionName as "name" })
      .then((v) => v as T)
      .catch(() => null);
  const slot = (s: `0x${string}`) =>
    client
      .getStorageAt({ address: token, slot: s })
      .then(slotAddress)
      .catch(() => undefined);

  const [name, symbol, decimals, supply, owner, implementation, admin, beacon] = await Promise.all([
    read<string>("name"),
    read<string>("symbol"),
    read<number>("decimals"),
    read<bigint>("totalSupply"),
    read<Address>("owner", OWNER_ABI),
    slot(EIP1967_IMPLEMENTATION),
    slot(EIP1967_ADMIN),
    slot(EIP1967_BEACON),
  ]);
  const dec = decimals === null ? null : Number(decimals);
  const proxy = implementation || admin || beacon ? { implementation, admin, beacon } : null;
  return {
    isContract: true,
    codeBytes,
    name: cleanText(name),
    symbol: cleanText(symbol),
    decimals: dec,
    totalSupply: supply !== null && dec !== null ? formatUnits(supply, dec) : null,
    proxy: proxy ? dropUndefined(proxy) : null,
    ...(owner ? { owner: getAddress(owner) } : {}),
  };
}

function slotAddress(value: `0x${string}` | undefined): Address | undefined {
  if (!value || /^0x0*$/.test(value)) return undefined;
  const hex = value.slice(2).padStart(64, "0");
  const addr = `0x${hex.slice(24)}`;
  return /^0x0{40}$/.test(addr) ? undefined : getAddress(addr);
}

// ----------------------------------------------------------------- market

interface DexPair {
  dexId?: string;
  url?: string;
  pairAddress?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  quoteToken?: { address?: string; symbol?: string };
  priceUsd?: string;
  txns?: { h24?: { buys?: number; sells?: number } };
  volume?: { h24?: number };
  priceChange?: { h24?: number };
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
}

async function readMarket(
  fetchJson: FetchJson,
  chain: string,
  token: Address,
): Promise<{ facts: MarketFacts; names: { name?: string; symbol?: string } }> {
  // token-pairs lists every pool of the token (up to 30); tokens/v1 only the top one.
  const raw = await fetchJson(`https://api.dexscreener.com/token-pairs/v1/${encodeURIComponent(chain)}/${token}`);
  const list = (Array.isArray(raw) ? raw : ((raw as { pairs?: DexPair[] })?.pairs ?? [])) as DexPair[];
  const mine = token.toLowerCase();
  const pairs = list.filter(
    (p) => p.baseToken?.address?.toLowerCase() === mine || p.quoteToken?.address?.toLowerCase() === mine,
  );
  const byLiquidity = [...pairs].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  const lead = byLiquidity.find((p) => p.baseToken?.address?.toLowerCase() === mine);
  const created = pairs.map((p) => p.pairCreatedAt).filter((t): t is number => Number.isFinite(t) && t! > 0);
  const num = (v: unknown) => (Number.isFinite(Number(v)) && v !== null && v !== undefined ? Number(v) : null);
  const facts: MarketFacts = {
    priceUsd: num(lead?.priceUsd),
    fdvUsd: num(lead?.fdv),
    marketCapUsd: num(lead?.marketCap),
    liquidityUsd: round(pairs.reduce((s, p) => s + (p.liquidity?.usd ?? 0), 0)),
    volume24hUsd: round(pairs.reduce((s, p) => s + (p.volume?.h24 ?? 0), 0)),
    priceChange24hPct: num(lead?.priceChange?.h24),
    txns24h: {
      buys: pairs.reduce((s, p) => s + (p.txns?.h24?.buys ?? 0), 0),
      sells: pairs.reduce((s, p) => s + (p.txns?.h24?.sells ?? 0), 0),
    },
    pairCount: pairs.length,
    oldestPairCreatedAt: created.length ? new Date(Math.min(...created)).toISOString() : null,
    topPairs: byLiquidity.slice(0, 3).map((p) => {
      const other = p.baseToken?.address?.toLowerCase() === mine ? p.quoteToken : p.baseToken;
      return {
        dex: p.dexId ?? "?",
        pair: p.pairAddress ?? "?",
        quote: other?.symbol ?? "?",
        liquidityUsd: num(p.liquidity?.usd),
        volume24hUsd: num(p.volume?.h24),
        ...(p.url ? { url: p.url } : {}),
      };
    }),
  };
  return { facts, names: { name: lead?.baseToken?.name, symbol: lead?.baseToken?.symbol } };
}

// --------------------------------------------------------------- security

async function readSecurity(
  fetchJson: FetchJson,
  chainId: number,
  token: Address,
): Promise<{ facts: SecurityFacts | null; pools: string[]; names: { name?: string; symbol?: string; totalSupply?: string } }> {
  const mine = token.toLowerCase();
  const raw = (await fetchJson(
    `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${mine}`,
  )) as { code?: number; message?: string; result?: Record<string, Record<string, unknown>> };
  if (raw?.code !== 1) throw new Error(`GoPlus answered code ${raw?.code}: ${String(raw?.message ?? "").slice(0, 120)}`);
  const r = raw.result?.[mine];
  if (!r || !Object.keys(r).length) return { facts: null, pools: [], names: {} };

  const flag = (k: string) => (r[k] === "1" ? true : r[k] === "0" ? false : null);
  const pct = (k: string) => {
    const v = r[k];
    return v === undefined || v === null || v === "" || !Number.isFinite(Number(v)) ? null : round(Number(v) * 100, 2);
  };
  const int = (k: string) => (Number.isFinite(Number(r[k])) && r[k] !== "" && r[k] !== undefined ? Number(r[k]) : null);
  const holders = (Array.isArray(r.holders) ? r.holders : []) as Record<string, unknown>[];
  const pools = ((Array.isArray(r.dex) ? r.dex : []) as Record<string, unknown>[])
    .map((d) => String(d.pair ?? "").toLowerCase())
    .filter(Boolean);
  const cex = r.is_in_cex as { cex_list?: string[] } | undefined;
  const owner = typeof r.owner_address === "string" && r.owner_address ? r.owner_address : null;
  const creator = typeof r.creator_address === "string" && r.creator_address ? r.creator_address : null;
  const top10 = holders.slice(0, 10).reduce((s, h) => s + (Number(h.percent) || 0), 0);

  return {
    facts: {
      honeypot: flag("is_honeypot"),
      cannotBuy: flag("cannot_buy"),
      cannotSellAll: flag("cannot_sell_all"),
      buyTaxPct: pct("buy_tax"),
      sellTaxPct: pct("sell_tax"),
      taxModifiable: flag("slippage_modifiable"),
      openSource: flag("is_open_source"),
      proxy: flag("is_proxy"),
      mintable: flag("is_mintable"),
      ownerCanChangeBalance: flag("owner_change_balance"),
      canTakeBackOwnership: flag("can_take_back_ownership"),
      hiddenOwner: flag("hidden_owner"),
      selfDestruct: flag("selfdestruct"),
      externalCall: flag("external_call"),
      blacklist: flag("is_blacklisted"),
      transferPausable: flag("transfer_pausable"),
      tradingCooldown: flag("trading_cooldown"),
      honeypotWithSameCreator: flag("honeypot_with_same_creator"),
      holderCount: int("holder_count"),
      lpHolderCount: int("lp_holder_count"),
      owner: owner ? { address: owner, percent: pct("owner_percent") } : null,
      creator: creator ? { address: creator, percent: pct("creator_percent") } : null,
      listedOnCex: Array.isArray(cex?.cex_list) ? cex.cex_list.map(String) : [],
      top10Pct: holders.length ? round(top10 * 100, 2) : null,
      topHolders: holders.slice(0, 5).map((h) => ({
        address: String(h.address ?? ""),
        percent: round((Number(h.percent) || 0) * 100, 2),
        isContract: h.is_contract === 1 || h.is_contract === "1",
        isLocked: h.is_locked === 1 || h.is_locked === "1",
        ...(typeof h.tag === "string" && h.tag ? { tag: h.tag } : {}),
      })),
    },
    pools,
    names: {
      name: typeof r.token_name === "string" ? r.token_name : undefined,
      symbol: typeof r.token_symbol === "string" ? r.token_symbol : undefined,
      totalSupply: typeof r.total_supply === "string" ? r.total_supply : undefined,
    },
  };
}

// ------------------------------------------------------------------ rules

/** Every risk the facts show, worst first. */
export function riskFlags(
  contract: OnChainFacts | null,
  market: MarketFacts | null,
  security: SecurityFacts | null,
  pools: Set<string>,
  now: Date,
): RiskFlag[] {
  const flags: RiskFlag[] = [];
  const add = (level: RiskFlag["level"], code: string, text: string) => flags.push({ level, code, text });

  if (contract && !contract.isContract) {
    if (contract.delegatedTo) add("high", "not_a_token", `This address is a wallet (EIP-7702 delegated to ${contract.delegatedTo}), not a token contract.`);
    else add("high", "not_a_contract", "No contract code at this address on this chain.");
  } else if (contract && (contract.decimals === null || contract.totalSupply === null)) {
    add("high", "not_erc20", "The contract does not answer decimals() / totalSupply(), so it is not a standard ERC-20.");
  }

  if (security) {
    if (security.honeypot) add("high", "honeypot", "GoPlus marks the token as a honeypot: buyers may not be able to sell.");
    if (security.cannotBuy) add("high", "cannot_buy", "The token cannot be bought.");
    if (security.cannotSellAll) add("high", "cannot_sell_all", "Holders cannot sell their whole balance.");
    if (security.ownerCanChangeBalance) add("high", "owner_changes_balances", "The owner can change holders' balances.");
    if (security.hiddenOwner) add("high", "hidden_owner", "The contract has a hidden owner.");
    if (security.canTakeBackOwnership) add("high", "reclaimable_ownership", "Ownership can be taken back after being renounced.");
    if (security.selfDestruct) add("high", "self_destruct", "The contract can self-destruct.");
    if (security.honeypotWithSameCreator) add("high", "creator_made_honeypots", "The same creator has deployed honeypots before.");
    const tax = Math.max(security.buyTaxPct ?? 0, security.sellTaxPct ?? 0);
    if (tax >= 10) add("high", "high_tax", `Trading tax is high: buy ${security.buyTaxPct ?? "?"}%, sell ${security.sellTaxPct ?? "?"}%.`);
    else if (tax > 0) add("medium", "tax", `The token charges a trading tax: buy ${security.buyTaxPct ?? "?"}%, sell ${security.sellTaxPct ?? "?"}%.`);
    if (security.taxModifiable) add("medium", "tax_modifiable", "The owner can change the trading tax.");
    if (security.openSource === false) add("medium", "closed_source", "The contract source is not verified.");
    if (security.mintable) add("medium", "mintable", "New supply can be minted.");
    if (security.transferPausable) add("medium", "pausable", "Transfers can be paused.");
    if (security.blacklist) add("medium", "blacklist", "The contract can blacklist addresses.");
    if (security.tradingCooldown) add("medium", "trading_cooldown", "The contract enforces a trading cooldown.");
    if (security.externalCall) add("info", "external_call", "The contract calls external contracts during transfers.");

    const whale = security.topHolders.find(
      (h) => !h.isContract && !h.isLocked && !BURN_ADDRESSES.has(h.address.toLowerCase()) && !pools.has(h.address.toLowerCase()),
    );
    if (whale && whale.percent >= 50) add("high", "whale", `One wallet holds ${whale.percent}% of the supply (${whale.address}).`);
    else if (whale && whale.percent >= 20) add("medium", "whale", `One wallet holds ${whale.percent}% of the supply (${whale.address}).`);
    if ((security.creator?.percent ?? 0) >= 10) add("medium", "creator_holds", `The creator still holds ${security.creator!.percent}% of the supply.`);
  }

  const upgradeable = contract?.proxy?.implementation || contract?.proxy?.beacon || security?.proxy;
  if (upgradeable) add("medium", "upgradeable", "The contract is an upgradeable proxy: its code can be replaced.");

  if (market) {
    if (!market.pairCount) add("medium", "no_market", "DexScreener lists no trading pairs for this token.");
    else if (market.liquidityUsd < 10_000) add("medium", "thin_liquidity", `Total liquidity is only ${usd(market.liquidityUsd)}.`);
    if (market.oldestPairCreatedAt) {
      const ageH = (now.getTime() - Date.parse(market.oldestPairCreatedAt)) / 3_600_000;
      if (ageH < 24) add("medium", "new_token", `Its first pool is less than a day old (${Math.max(0, Math.round(ageH))}h).`);
      else if (ageH < 24 * 7) add("info", "young_token", `Its first pool is less than a week old (${Math.round(ageH / 24)}d).`);
    }
  }

  const owner = contract?.owner ?? security?.owner?.address;
  if (owner && !BURN_ADDRESSES.has(owner.toLowerCase())) add("info", "owned", `The contract has an active owner (${owner}).`);

  const rank = { high: 0, medium: 1, info: 2 } as const;
  return flags.sort((a, b) => rank[a.level] - rank[b.level]);
}

function riskLevel(flags: RiskFlag[], contract: OnChainFacts | null, security: SecurityFacts | null): TokenReport["risk"] {
  if (flags.some((f) => f.level === "high")) return "high";
  if (flags.some((f) => f.level === "medium")) return "medium";
  // Without the code scan, a clean on-chain read alone proves little.
  if (!security || !contract) return "unknown";
  return "low";
}

function summarize(
  chainName: string,
  token: TokenReport["token"],
  market: MarketFacts | null,
  security: SecurityFacts | null,
  flags: RiskFlag[],
  risk: TokenReport["risk"],
): string {
  const label = token.symbol ? `${token.symbol}${token.name && token.name !== token.symbol ? ` (${token.name})` : ""}` : token.address;
  const parts = [`${label} on ${chainName}.`];
  if (market?.pairCount) {
    const bits = [
      market.priceUsd !== null ? `price ${usdPrice(market.priceUsd)}` : null,
      market.fdvUsd !== null ? `FDV ${usd(market.fdvUsd)}` : null,
      `liquidity ${usd(market.liquidityUsd)} across ${market.pairCount}${market.pairCount >= DEXSCREENER_PAIR_CAP ? "+" : ""} pool${market.pairCount === 1 ? "" : "s"}`,
      `24h volume ${usd(market.volume24hUsd)}`,
    ].filter(Boolean);
    parts.push(`${capitalize(bits.join(", "))}.`);
  } else if (market) {
    parts.push("No DEX market found.");
  }
  if (security) {
    const bits = [
      security.honeypot === false ? "not a honeypot" : security.honeypot ? "HONEYPOT" : null,
      security.buyTaxPct !== null || security.sellTaxPct !== null
        ? `buy tax ${security.buyTaxPct ?? "?"}%, sell tax ${security.sellTaxPct ?? "?"}%`
        : null,
      security.openSource === true ? "source verified" : security.openSource === false ? "source not verified" : null,
      security.holderCount !== null ? `${security.holderCount.toLocaleString("en-US")} holders` : null,
    ].filter(Boolean);
    if (bits.length) parts.push(`GoPlus: ${bits.join(", ")}.`);
  }
  const high = flags.filter((f) => f.level === "high").length;
  const medium = flags.filter((f) => f.level === "medium").length;
  if (high || medium) {
    const worst = flags.find((f) => f.level !== "info")!;
    const counts = [high ? `${high} high` : null, medium ? `${medium} medium` : null].filter(Boolean).join(", ");
    parts.push(`Flags: ${counts}; worst: ${worst.text}`);
  }
  parts.push(`Risk: ${risk}.`);
  return parts.join(" ");
}

// ---------------------------------------------------------------- helpers

async function defaultFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}: ${text.replace(/\s+/g, " ").slice(0, 120)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${new URL(url).host} did not answer JSON`);
  }
}

function reason(r: PromiseSettledResult<unknown>): string {
  if (r.status === "fulfilled") return "";
  const err = r.reason as { shortMessage?: string; message?: string } | undefined;
  return String(err?.shortMessage ?? err?.message ?? r.reason).replace(/\s+/g, " ").slice(0, 200);
}

function cleanText(v: string | null): string | null {
  if (typeof v !== "string") return null;
  // Strip control characters (some tokens pad names with NULs) and cap the length.
  const s = v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80);
  return s || null;
}

function dropUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function usd(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function usdPrice(n: number): string {
  if (n >= 1) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  return `$${n.toPrecision(3)}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
