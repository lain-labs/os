/**
 * Networks: named chain profiles, and the switch between them.
 *
 * A chain is a dozen CHAIN_* settings that only make sense together — an RPC
 * from one network with the chain id of another is a broken agent, not a
 * half-configured one. Writing them one set_setting at a time cost the
 * operator a confirmation per key and left the chain tools dead until a
 * restart. Here a network is one record, the switch writes the whole record
 * and rebuilds the chain service in place.
 *
 * Profiles come from two places: a few public networks known out of the box
 * (endpoints only — no tokens, no DEX), and `data/networks.json`, where the
 * operator's own profiles live. Switching away from a configuration first
 * saves it there under its own name, so a carefully filled token registry or
 * DEX is never lost to a switch — `/network <old name>` brings it back whole.
 *
 * Profiles are also how a background job reaches a chain other than the
 * active one: a wallet watch on Robinhood keeps running in a daemon that
 * trades on another network.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createPublicClient, defineChain, http, type Chain, type PublicClient } from "viem";
import type { IAgentRuntime } from "../../types.js";

export interface NetworkProfile {
  /** Lowercase key, e.g. "robinhood". */
  name: string;
  /** Human name — CHAIN_NAME. */
  title: string;
  chainId: number;
  rpcUrl: string;
  nativeSymbol: string;
  nativeDecimals?: number;
  explorerUrl?: string;
  explorerName?: string;
  explorerApiUrl?: string;
  /** CHAIN_TOKENS format: SYMBOL:0xaddr,… */
  tokens?: string;
  dexFactory?: string;
  dexRouter?: string;
  dexWrappedNative?: string;
  /** Multicall3 address, when the chain has one (most do, at the canonical address). */
  multicall3?: string;
  /** Largest block span one eth_getLogs may cover on this RPC. */
  maxLogSpan?: number;
  note?: string;
}

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

/** Public networks known out of the box: endpoints only. */
export const BUILTIN_NETWORKS: readonly NetworkProfile[] = [
  {
    name: "robinhood",
    title: "Robinhood Chain",
    chainId: 4663,
    rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    nativeSymbol: "ETH",
    explorerUrl: "https://robinhoodchain.blockscout.com",
    explorerName: "Blockscout",
    explorerApiUrl: "https://robinhoodchain.blockscout.com/api/v2",
    tokens: "LAIN:0x2b79A071a75dd40f1aca68146d7978204eFD156A",
    multicall3: MULTICALL3,
    maxLogSpan: 30_000,
    note: "mainnet; the explorer API sits behind Cloudflare, so tools read the RPC",
  },
  {
    name: "robinhood-testnet",
    title: "Robinhood Chain Testnet",
    chainId: 46630,
    rpcUrl: "https://rpc.testnet.chain.robinhood.com",
    nativeSymbol: "ETH",
    explorerUrl: "https://explorer.testnet.chain.robinhood.com",
    explorerName: "Blockscout",
    explorerApiUrl: "https://explorer.testnet.chain.robinhood.com/api/v2",
    multicall3: MULTICALL3,
    note: "testnet — balances here are not real money",
  },
  {
    name: "cyberia",
    title: "Cyberia",
    chainId: 49406,
    rpcUrl: "https://rpc.cyberia.church",
    nativeSymbol: "CYBER",
    explorerUrl: "https://explorer.cyberia.church",
    explorerName: "Blockscout",
    explorerApiUrl: "https://explorer.cyberia.church/api/v2",
  },
];

/** The settings a profile owns; every one is written on a switch. */
const KEYS = [
  "CHAIN_RPC_URL",
  "CHAIN_ID",
  "CHAIN_NAME",
  "CHAIN_NATIVE_SYMBOL",
  "CHAIN_NATIVE_DECIMALS",
  "CHAIN_EXPLORER_URL",
  "CHAIN_EXPLORER_NAME",
  "CHAIN_EXPLORER_API_URL",
  "CHAIN_TOKENS",
  "CHAIN_DEX_FACTORY",
  "CHAIN_DEX_ROUTER",
  "CHAIN_DEX_WRAPPED_NATIVE",
] as const;

export function slug(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function storeFile(runtime: IAgentRuntime): string {
  return join(runtime.getSetting("LAINOS_DATA_DIR") || "./data", "networks.json");
}

async function readSaved(runtime: IAgentRuntime): Promise<NetworkProfile[]> {
  try {
    const parsed = JSON.parse(await readFile(storeFile(runtime), "utf8")) as { networks?: NetworkProfile[] };
    return (parsed.networks ?? []).filter((n) => n && n.name && n.rpcUrl && Number.isInteger(n.chainId));
  } catch {
    return [];
  }
}

async function writeSaved(runtime: IAgentRuntime, networks: NetworkProfile[]): Promise<void> {
  const file = storeFile(runtime);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ networks }, null, 2), "utf8");
}

/** Every known profile: the operator's saved ones win over a built-in of the same name. */
export async function listNetworks(runtime: IAgentRuntime): Promise<NetworkProfile[]> {
  const saved = await readSaved(runtime);
  const out = new Map<string, NetworkProfile>();
  for (const n of BUILTIN_NETWORKS) out.set(n.name, n);
  for (const n of saved) out.set(n.name, { ...out.get(n.name), ...n });
  return [...out.values()];
}

/** The profile the current CHAIN_* settings describe, or null when no chain is set. */
export function currentProfile(runtime: IAgentRuntime): NetworkProfile | null {
  const g = (k: string) => runtime.getSetting(k)?.trim() || undefined;
  const rpcUrl = g("CHAIN_RPC_URL");
  const chainId = Number(g("CHAIN_ID"));
  if (!rpcUrl || !Number.isInteger(chainId) || chainId <= 0) return null;
  const title = g("CHAIN_NAME") ?? `chain ${chainId}`;
  const known = BUILTIN_NETWORKS.find((n) => n.chainId === chainId);
  return {
    name: known?.name ?? (slug(title) || `chain-${chainId}`),
    title,
    chainId,
    rpcUrl,
    nativeSymbol: g("CHAIN_NATIVE_SYMBOL") ?? "ETH",
    nativeDecimals: g("CHAIN_NATIVE_DECIMALS") ? Number(g("CHAIN_NATIVE_DECIMALS")) : undefined,
    explorerUrl: g("CHAIN_EXPLORER_URL"),
    explorerName: g("CHAIN_EXPLORER_NAME"),
    explorerApiUrl: g("CHAIN_EXPLORER_API_URL"),
    tokens: g("CHAIN_TOKENS"),
    dexFactory: g("CHAIN_DEX_FACTORY"),
    dexRouter: g("CHAIN_DEX_ROUTER"),
    dexWrappedNative: g("CHAIN_DEX_WRAPPED_NATIVE"),
    multicall3: known?.multicall3,
    maxLogSpan: known?.maxLogSpan,
  };
}

/**
 * Find a profile by name, chain id, or a loose spelling ("robinhood mainnet",
 * "Robinhood Chain"). Null when nothing matches.
 */
export async function findNetwork(runtime: IAgentRuntime, query: string): Promise<NetworkProfile | null> {
  const all = await listNetworks(runtime);
  const q = slug(query);
  if (!q) return null;
  const byId = Number(query);
  return (
    all.find((n) => n.name === q) ??
    (Number.isInteger(byId) ? all.find((n) => n.chainId === byId) : undefined) ??
    all.find((n) => slug(n.title) === q) ??
    // "robinhood-mainnet" → robinhood; never pick a testnet for a bare name.
    all.find((n) => q.startsWith(n.name) && !n.name.includes("testnet") && !q.includes("test")) ??
    (q.includes("test") ? all.find((n) => n.name.startsWith(q.split("-")[0]) && n.name.includes("testnet")) : undefined) ??
    null
  );
}

/** Save (or overwrite) a profile in data/networks.json. */
export async function saveNetwork(runtime: IAgentRuntime, profile: NetworkProfile): Promise<void> {
  const saved = (await readSaved(runtime)).filter((n) => n.name !== profile.name);
  saved.push(profile);
  await writeSaved(runtime, saved);
}

function profileSettings(p: NetworkProfile): Record<(typeof KEYS)[number], string> {
  return {
    CHAIN_RPC_URL: p.rpcUrl,
    CHAIN_ID: String(p.chainId),
    CHAIN_NAME: p.title,
    CHAIN_NATIVE_SYMBOL: p.nativeSymbol,
    CHAIN_NATIVE_DECIMALS: String(p.nativeDecimals ?? 18),
    CHAIN_EXPLORER_URL: p.explorerUrl ?? "",
    CHAIN_EXPLORER_NAME: p.explorerName ?? "",
    CHAIN_EXPLORER_API_URL: p.explorerApiUrl ?? "",
    CHAIN_TOKENS: p.tokens ?? "",
    CHAIN_DEX_FACTORY: p.dexFactory ?? "",
    CHAIN_DEX_ROUTER: p.dexRouter ?? "",
    CHAIN_DEX_WRAPPED_NATIVE: p.dexWrappedNative ?? "",
  };
}

export interface SwitchResult {
  ok: boolean;
  text: string;
  from?: NetworkProfile | null;
  to?: NetworkProfile;
}

/**
 * Make `query` the active network: keep the current configuration as a saved
 * profile, write the target's CHAIN_* settings into the settings file, rebuild
 * the chain service and read the head block to prove it is alive.
 * `write` is injected (set_setting's writer) so this module stays free of the
 * system plugin.
 */
export async function switchNetwork(
  runtime: IAgentRuntime,
  query: string,
  write: (runtime: IAgentRuntime, entries: Record<string, string>) => Promise<{ file: string; chainReload?: string | null }>,
  probe: (p: NetworkProfile) => Promise<bigint> = (p) => networkClient(p).getBlockNumber(),
): Promise<SwitchResult> {
  const target = await findNetwork(runtime, query);
  if (!target) {
    const names = (await listNetworks(runtime)).map((n) => n.name).join(", ");
    return { ok: false, text: `no network "${query}". known: ${names}. (save the current one with /network save <name>)` };
  }
  const from = currentProfile(runtime);
  if (from && from.chainId === target.chainId && from.rpcUrl === target.rpcUrl) {
    return { ok: true, text: `already on ${target.title} (id ${target.chainId}).`, from, to: target };
  }

  let head: bigint;
  try {
    head = await probe(target);
  } catch (err) {
    return {
      ok: false,
      text: `${target.title} did not answer at ${target.rpcUrl} (${(err as Error).message.split("\n")[0]}) — nothing was changed.`,
      from,
      to: target,
    };
  }

  // Never lose the configuration being left: a filled token registry or DEX
  // is work. Saved under its own name, it comes back whole.
  if (from) {
    const existing = (await listNetworks(runtime)).find((n) => n.name === from.name);
    await saveNetwork(runtime, { ...existing, ...from, multicall3: from.multicall3 ?? existing?.multicall3 });
  }

  let written;
  try {
    written = await write(runtime, profileSettings(target));
  } catch (err) {
    return { ok: false, text: `could not write the settings: ${(err as Error).message}`, from, to: target };
  }
  const reload = written.chainReload;
  const lines = [
    `switched to ${target.title} (id ${target.chainId}) — head block ${head}.`,
    `rpc ${target.rpcUrl}${target.explorerUrl ? ` · explorer ${target.explorerUrl}` : ""}`,
    target.tokens ? `tokens: ${target.tokens.split(",").map((t) => t.split(":")[0]).join(", ")}` : "no token registry on this network yet.",
    target.dexRouter ? "dex configured." : "no DEX configured here — trading tools stay off.",
    from ? `previous network kept as profile "${from.name}" — /network ${from.name} switches back.` : "",
    `written to ${written.file}.`,
    reload ? `chain tools did not come up: ${reload}` : "",
  ].filter(Boolean);
  return { ok: !reload, text: lines.join("\n"), from, to: target };
}

/** A viem chain for a profile (with Multicall3 when it has one). */
export function profileChain(p: NetworkProfile): Chain {
  return defineChain({
    id: p.chainId,
    name: p.title,
    nativeCurrency: { name: p.nativeSymbol, symbol: p.nativeSymbol, decimals: p.nativeDecimals ?? 18 },
    rpcUrls: { default: { http: [p.rpcUrl] } },
    ...(p.explorerUrl ? { blockExplorers: { default: { name: p.explorerName || "Explorer", url: p.explorerUrl } } } : {}),
    ...(p.multicall3 ? { contracts: { multicall3: { address: p.multicall3 as `0x${string}` } } } : {}),
  });
}

const clients = new Map<string, PublicClient>();

/**
 * A read client for a profile, retrying, with reads folded into Multicall3
 * where the chain has it: public RPCs rate-limit (429) and a 100-wallet read
 * is thousands of calls. Cached per endpoint.
 */
export function networkClient(p: NetworkProfile): PublicClient {
  const key = `${p.chainId}:${p.rpcUrl}`;
  let client = clients.get(key);
  if (!client) {
    client = createPublicClient({
      chain: profileChain(p),
      batch: p.multicall3 ? { multicall: { batchSize: 1024 * 16 } } : undefined,
      // No JSON-RPC batching: a batch of heavy getLogs is priced as one burst
      // and comes back 429. Short viem retries; the callers pace themselves.
      transport: http(p.rpcUrl, {
        retryCount: 3,
        retryDelay: 500,
        timeout: 45_000,
        // Some public RPCs sit behind Cloudflare and refuse unknown agents.
        fetchOptions: { headers: { "user-agent": "lainos/0.1 (+https://lain-os.com)" } },
      }),
    }) as PublicClient;
    clients.set(key, client);
  }
  return client;
}

/** Address / tx links on a profile's explorer. */
export function explorerLinks(p: NetworkProfile | null | undefined): {
  address: (a: string) => string | undefined;
  tx: (h: string) => string | undefined;
} {
  const base = p?.explorerUrl?.replace(/\/+$/, "");
  return {
    address: (a) => (base ? `${base}/address/${a}` : undefined),
    tx: (h) => (base ? `${base}/tx/${h}` : undefined),
  };
}

/** One line per profile, the active one marked — /network and list_networks. */
export async function describeNetworks(runtime: IAgentRuntime): Promise<string> {
  const current = currentProfile(runtime);
  const all = await listNetworks(runtime);
  const lines = all.map((n) => {
    const on = current && current.chainId === n.chainId && current.rpcUrl === n.rpcUrl;
    const extras = [n.tokens ? "tokens" : "", n.dexRouter ? "dex" : ""].filter(Boolean).join("+");
    return `${on ? "●" : " "} ${n.name.padEnd(18)} ${n.title} · id ${n.chainId}${extras ? ` · ${extras}` : ""}${n.note ? ` — ${n.note}` : ""}`;
  });
  const head = current
    ? `active: ${current.title} (id ${current.chainId}) · ${current.rpcUrl}${current.explorerUrl ? ` · ${current.explorerUrl}` : ""}`
    : "active: none — no CHAIN_* configured";
  if (current && !all.some((n) => n.chainId === current.chainId && n.rpcUrl === current.rpcUrl)) {
    lines.unshift(`● ${current.name.padEnd(18)} ${current.title} · id ${current.chainId} (unsaved — /network save <name>)`);
  }
  return [head, "", ...lines].join("\n");
}
