/**
 * The portfolio: every token on the operator's chain, and what each one is
 * *about*.
 *
 * A token on Cyberia is a wrapper around something that lives elsewhere — a
 * T-Capital fund on the Moscow exchange, gold, the rouble, Bitcoin — or a
 * thing of the chain itself (CYBER, a community coin). News and prices belong
 * to the underlying, so each token gets an {@link AssetSpec}: where its price
 * comes from and what to search the news for.
 *
 * The list comes from the explorer (Blockscout `/api/v2/tokens`), so a token
 * minted tomorrow is in tomorrow's digest. Known underlyings come from the
 * table below; the rest are classified once by the model and cached in
 * `data/digest-assets.json`, where the operator can correct them by hand.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createLogger } from "../../logger.js";
import { TaskKind } from "../../models/tasks.js";
import { ModelTier, type IAgentRuntime } from "../../types.js";
import { digestTask, generateWithFallback } from "./model.js";

const log = createLogger("plugin:digest");

export type AssetKind = "crypto" | "stablecoin" | "fund" | "metal" | "fx" | "index" | "brand" | "native";

export type PriceSource =
  | { source: "coingecko"; id: string }
  | { source: "yahoo"; symbol: string }
  | { source: "cbr"; code: string }
  | { source: "moex"; secid: string; board?: string }
  | { source: "dex" };

export interface NewsQuery {
  q: string;
  lang: "ru" | "en";
}

export interface AssetSpec {
  kind: AssetKind;
  /** What it is, in a few words — "T-Capital fund on Russian stocks (MOEX)". */
  about: string;
  /** Group heading in the digest. */
  group: string;
  price?: PriceSource;
  news: NewsQuery[];
}

export interface Asset extends AssetSpec {
  symbol: string;
  name: string;
  address: string;
  holders: number;
  decimals: number;
}

const RU_FUNDS = "Российский рынок";
const CRYPTO = "Крипта";
const METALS = "Металлы и валюта";

/** Underlyings known without asking anyone. Keyed by upper-case symbol. */
export const KNOWN_ASSETS: Record<string, AssetSpec> = {
  BTC: { kind: "crypto", about: "Bitcoin", group: CRYPTO, price: { source: "coingecko", id: "bitcoin" }, news: [{ q: "Bitcoin", lang: "en" }, { q: "биткоин", lang: "ru" }] },
  ETH: { kind: "crypto", about: "Ethereum", group: CRYPTO, price: { source: "coingecko", id: "ethereum" }, news: [{ q: "Ethereum", lang: "en" }] },
  SOL: { kind: "crypto", about: "Solana", group: CRYPTO, price: { source: "coingecko", id: "solana" }, news: [{ q: "Solana", lang: "en" }] },
  XMR: { kind: "crypto", about: "Monero", group: CRYPTO, price: { source: "coingecko", id: "monero" }, news: [{ q: "Monero XMR", lang: "en" }] },
  LTC: { kind: "crypto", about: "Litecoin", group: CRYPTO, price: { source: "coingecko", id: "litecoin" }, news: [{ q: "Litecoin", lang: "en" }] },
  TRX: { kind: "crypto", about: "Tron", group: CRYPTO, price: { source: "coingecko", id: "tron" }, news: [{ q: "Tron TRX", lang: "en" }] },
  TON: { kind: "crypto", about: "Toncoin", group: CRYPTO, price: { source: "coingecko", id: "the-open-network" }, news: [{ q: "Toncoin TON", lang: "en" }, { q: "Toncoin", lang: "ru" }] },
  BNB: { kind: "crypto", about: "BNB", group: CRYPTO, price: { source: "coingecko", id: "binancecoin" }, news: [{ q: "BNB Binance", lang: "en" }] },
  USDT: { kind: "stablecoin", about: "Tether USD", group: CRYPTO, price: { source: "coingecko", id: "tether" }, news: [{ q: "Tether USDT", lang: "en" }] },
  USDC: { kind: "stablecoin", about: "USD Coin", group: CRYPTO, price: { source: "coingecko", id: "usd-coin" }, news: [{ q: "Circle USDC", lang: "en" }] },
  GOLD: { kind: "metal", about: "gold", group: METALS, price: { source: "yahoo", symbol: "GC=F" }, news: [{ q: "цена золота", lang: "ru" }, { q: "gold price", lang: "en" }] },
  SILVER: { kind: "metal", about: "silver", group: METALS, price: { source: "yahoo", symbol: "SI=F" }, news: [{ q: "цена серебра", lang: "ru" }] },
  RUB: { kind: "fx", about: "Russian rouble (USD/RUB)", group: METALS, price: { source: "cbr", code: "USD" }, news: [{ q: "курс рубля", lang: "ru" }] },
  SPY: { kind: "index", about: "S&P 500 ETF", group: "США", price: { source: "yahoo", symbol: "SPY" }, news: [{ q: "S&P 500", lang: "en" }] },
  TMOS: { kind: "fund", about: "T-Capital fund on Russian stocks (MOEX index)", group: RU_FUNDS, price: { source: "moex", secid: "TMOS" }, news: [{ q: "индекс Мосбиржи", lang: "ru" }] },
  TOFZ: { kind: "fund", about: "T-Capital fund on Russian government bonds (OFZ)", group: RU_FUNDS, price: { source: "moex", secid: "TOFZ" }, news: [{ q: "ОФЗ доходность", lang: "ru" }] },
  TRUR: { kind: "fund", about: "T-Capital rouble liquidity fund (follows the key rate)", group: RU_FUNDS, price: { source: "moex", secid: "TRUR" }, news: [{ q: "ключевая ставка ЦБ", lang: "ru" }] },
  TGLD: { kind: "fund", about: "T-Capital gold fund (gold in roubles)", group: RU_FUNDS, price: { source: "moex", secid: "TGLD" }, news: [{ q: "золото рубли", lang: "ru" }] },
  CYBER: { kind: "native", about: "Cyberia's native coin", group: "Cyberia", price: { source: "dex" }, news: [] },
  WCYBER: { kind: "native", about: "wrapped CYBER", group: "Cyberia", price: { source: "dex" }, news: [] },
};

/** Wrappers whose value is another token's: LP shares, lending receipts. */
export function isDerivative(symbol: string, name: string): boolean {
  return /^UNI-V2$/i.test(symbol) || /^cl[A-Z]/.test(symbol) || (/\b(LP|Lend|Liquidity Pool)\b/i.test(name) && !/Rouble Liquidity/i.test(name));
}

interface ExplorerToken {
  address_hash?: string;
  address?: string;
  symbol?: string | null;
  name?: string | null;
  holders_count?: string | number | null;
  holders?: string | number | null;
  decimals?: string | null;
}

/** Every ERC-20 on a Blockscout explorer, all pages. */
export async function explorerTokens(apiBase: string, fetcher: (url: string) => Promise<string>, maxPages = 20): Promise<ExplorerToken[]> {
  const out: ExplorerToken[] = [];
  let params: Record<string, string> | null = { type: "ERC-20" };
  for (let page = 0; params && page < maxPages; page++) {
    const url = new URL(`${apiBase.replace(/\/+$/, "")}/tokens`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const body = JSON.parse(await fetcher(url.toString())) as {
      items?: ExplorerToken[];
      next_page_params?: Record<string, unknown> | null;
    };
    out.push(...(body.items ?? []));
    params = body.next_page_params
      ? { type: "ERC-20", ...Object.fromEntries(Object.entries(body.next_page_params).map(([k, v]) => [k, String(v)])) }
      : null;
  }
  return out;
}

interface AssetFile {
  /** Model classifications and operator corrections, by upper-case symbol. */
  specs: Record<string, AssetSpec>;
  /** Symbols the operator left out of the digest. */
  excluded?: string[];
}

export class AssetBook {
  private data: AssetFile = { specs: {} };
  constructor(private readonly file: string) {}

  static forRuntime(runtime: IAgentRuntime): AssetBook {
    return new AssetBook(join(runtime.getSetting("LAINOS_DATA_DIR") || "./data", "digest-assets.json"));
  }

  async load(): Promise<this> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as Partial<AssetFile>;
      this.data = { ...parsed, specs: parsed.specs ?? {} };
    } catch {
      this.data = { specs: {} };
    }
    return this;
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.data, null, 2), "utf8");
  }

  spec(symbol: string): AssetSpec | undefined {
    return this.data.specs[symbol.toUpperCase()] ?? KNOWN_ASSETS[symbol.toUpperCase()];
  }

  set(symbol: string, spec: AssetSpec): void {
    this.data.specs[symbol.toUpperCase()] = spec;
  }

  excluded(): string[] {
    return [...(this.data.excluded ?? [])];
  }

  setExcluded(symbol: string, out: boolean): void {
    const set = new Set(this.data.excluded ?? []);
    if (out) set.add(symbol.toUpperCase());
    else set.delete(symbol.toUpperCase());
    this.data.excluded = [...set];
  }
}

/**
 * The digest's assets: explorer tokens minus derivatives and exclusions, one
 * per symbol (the most-held contract when a symbol repeats), each with a spec.
 * Symbols with no spec yet are classified by the model in one call and cached.
 */
export async function resolveAssets(
  runtime: IAgentRuntime,
  tokens: ExplorerToken[],
  book: AssetBook,
  nativeSymbol: string,
): Promise<Asset[]> {
  const bySymbol = new Map<string, Asset>();
  const excluded = new Set(book.excluded());
  for (const t of tokens) {
    const symbol = (t.symbol ?? "").trim();
    const name = (t.name ?? symbol).trim();
    const address = t.address_hash ?? t.address ?? "";
    if (!symbol || !address || isDerivative(symbol, name) || excluded.has(symbol.toUpperCase())) continue;
    const holders = Number(t.holders_count ?? t.holders ?? 0) || 0;
    const prev = bySymbol.get(symbol.toUpperCase());
    if (prev && prev.holders >= holders) continue;
    bySymbol.set(symbol.toUpperCase(), {
      symbol,
      name,
      address,
      holders,
      decimals: Number(t.decimals ?? 18) || 0,
      kind: "native",
      about: name,
      group: "Cyberia",
      news: [],
    });
  }

  const unknown = [...bySymbol.values()].filter((a) => !book.spec(a.symbol));
  if (unknown.length) {
    // Only an answer is cached: a token the model could not place is tried
    // again next time instead of being filed as "no news" for good.
    const classified = await classify(runtime, unknown, nativeSymbol);
    for (const [sym, spec] of classified) book.set(sym, spec);
    if (classified.size) await book.save();
  }
  return [...bySymbol.values()]
    .map((a) => ({ ...a, ...(book.spec(a.symbol) ?? nativeSpec(a)) }))
    .sort((a, b) => b.holders - a.holders);
}

function nativeSpec(a: { name: string }): AssetSpec {
  return { kind: "native", about: a.name, group: "Cyberia", price: { source: "dex" }, news: [] };
}

/**
 * Ask the model once what each unknown token is about. A token named after a
 * real thing (Telegram, Minecraft, Claude) gets news about that thing; a coin
 * of the chain's own community gets on-chain numbers only. Anything the reply
 * does not cover stays native.
 */
async function classify(runtime: IAgentRuntime, assets: Asset[], nativeSymbol: string): Promise<Map<string, AssetSpec>> {
  const out = new Map<string, AssetSpec>();
  // In batches: one answer for sixty tokens is long enough to be cut off.
  for (let i = 0; i < assets.length; i += 15) {
    const batch = assets.slice(i, i + 15);
    try {
      for (const [sym, spec] of await classifyBatch(runtime, batch, nativeSymbol)) out.set(sym, spec);
    } catch (err) {
      log.warn(`could not classify ${batch.map((a) => a.symbol).join(", ")}: ${(err as Error).message}`);
    }
  }
  return out;
}

/** Every complete {…} object in a reply, even when the array around them was cut off. */
export function jsonObjects(text: string): Record<string, unknown>[] {
  try {
    const whole = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1));
    if (Array.isArray(whole)) return whole;
  } catch {
    // fall through to object-by-object
  }
  const out: Record<string, unknown>[] = [];
  for (const m of text.matchAll(/\{[^{}]*(?:\[[^\[\]]*\][^{}]*)*\}/g)) {
    try {
      out.push(JSON.parse(m[0]));
    } catch {
      // skip a broken one
    }
  }
  return out;
}

async function classifyBatch(runtime: IAgentRuntime, assets: Asset[], nativeSymbol: string): Promise<Map<string, AssetSpec>> {
  const out = new Map<string, AssetSpec>();
  const list = assets.map((a) => `${a.symbol} — "${a.name}"`).join("\n");
  const res = await generateWithFallback(runtime, {
    tier: ModelTier.MEDIUM,
    task: digestTask(runtime),
    system:
      `You map tokens on a small EVM chain (native coin ${nativeSymbol}) to the real-world subject their news should be about. ` +
      `Reply with JSON only: an array of {"symbol","kind","about","news":[{"q","lang"}],"coingecko"?}. ` +
      `kind: "crypto" (a real coin — give its coingecko id), "stablecoin", "brand" (named after a real company, product or project — news about it), ` +
      `or "native" (a community/meme/utility/test coin of this chain with no outside news — news: []). ` +
      `news: one or two short search queries, lang "ru" or "en", whichever finds better news. about: 3–8 words. ` +
      `When unsure, choose "native".`,
    messages: [{ role: "user", content: list }],
    maxTokens: 3000,
    temperature: 0,
  });
  const rows = jsonObjects(res.text) as { symbol?: string; kind?: string; about?: string; news?: NewsQuery[]; coingecko?: string }[];
  if (!rows.length) throw new Error(`no JSON in the reply (${res.text.slice(0, 80).replace(/\s+/g, " ")}…)`);
  for (const r of rows) {
    const sym = String(r.symbol ?? "").toUpperCase();
    const asset = assets.find((a) => a.symbol.toUpperCase() === sym);
    if (!asset) continue;
    const kind = (["crypto", "stablecoin", "brand"].includes(String(r.kind)) ? r.kind : "native") as AssetKind;
    const news = (Array.isArray(r.news) ? r.news : [])
      .filter((n) => n && typeof n.q === "string" && n.q.trim())
      .slice(0, 2)
      .map((n) => ({ q: n.q.trim().slice(0, 80), lang: n.lang === "ru" ? ("ru" as const) : ("en" as const) }));
    out.set(sym, {
      kind,
      about: String(r.about ?? asset.name).slice(0, 80),
      group: kind === "brand" ? "Бренды и проекты" : kind === "native" ? "Cyberia" : CRYPTO,
      price: kind === "native" ? { source: "dex" } : r.coingecko ? { source: "coingecko", id: String(r.coingecko) } : { source: "dex" },
      news: kind === "native" ? [] : news,
    });
  }
  return out;
}
