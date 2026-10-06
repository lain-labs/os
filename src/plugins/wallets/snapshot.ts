/**
 * A portfolio snapshot of a list of wallets: native balance and every ERC20
 * each one holds, with totals across the list — "what else do the top-100
 * holders hold, and how much ETH".
 *
 * "Every token" needs a token universe, and without an explorer API that is
 * discovered from the chain: every token a wallet holds it once received, so
 * the incoming Transfer logs of the list over a look-back window name the
 * candidates. Contracts in the list (a pool, a locker) are skipped during
 * discovery — a pool receives every swap on the chain and would drown the scan
 * — but their balances are still read for every discovered token.
 *
 * Discovery is the slow part, so it is cached per network and wallet in
 * `data/wallets-cache.json`: the next snapshot of the same list scans only
 * the blocks since the last one. A full-history first pass can run in the
 * background (`npm run wallets -- snapshot … --from-block 0`).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { formatUnits, type Address } from "viem";
import { explorerLinks, type NetworkProfile } from "../chain/networks.js";
import { pairKey, type TokenMeta, type WalletSource } from "./chainread.js";
import { shortAddress, type WalletEntry } from "./lists.js";

export interface Holding {
  token: Address;
  symbol: string;
  decimals: number;
  raw: bigint;
}

export interface WalletRow extends WalletEntry {
  isContract: boolean;
  native: bigint;
  holdings: Holding[];
}

export interface TokenTotal {
  token: Address;
  symbol: string;
  decimals: number;
  holders: number;
  total: bigint;
  /** Held by plain wallets only (contracts like pools left out). */
  totalWallets: bigint;
}

export interface Snapshot {
  network: { name: string; title: string; chainId: number; nativeSymbol: string; explorerUrl?: string };
  takenAt: string;
  head: bigint;
  discoveredFrom: bigint;
  rows: WalletRow[];
  tokens: TokenTotal[];
  nativeTotal: bigint;
  nativeWallets: bigint;
  notes: string[];
}

interface CacheFile {
  [chainId: string]: { [wallet: string]: { tokens: string[]; from: string; to: string } };
}

export class TokenCache {
  private data: CacheFile = {};
  constructor(private readonly file: string) {}

  async load(): Promise<this> {
    try {
      this.data = JSON.parse(await readFile(this.file, "utf8")) as CacheFile;
    } catch {
      this.data = {};
    }
    return this;
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.data), "utf8");
  }

  get(chainId: number, wallet: string): { tokens: string[]; from: bigint; to: bigint } | undefined {
    const e = this.data[String(chainId)]?.[wallet.toLowerCase()];
    return e ? { tokens: e.tokens, from: BigInt(e.from), to: BigInt(e.to) } : undefined;
  }

  /** Record that [from, to] was scanned for `wallet` and found `tokens` (merged with what was known). */
  put(chainId: number, wallet: string, tokens: Iterable<string>, from: bigint, to: bigint): void {
    const net = (this.data[String(chainId)] ??= {});
    const key = wallet.toLowerCase();
    const prev = net[key];
    const merged = new Set([...(prev?.tokens ?? []), ...[...tokens].map((t) => t.toLowerCase())]);
    const contiguous = prev && from <= BigInt(prev.to) + 1n;
    net[key] = {
      tokens: [...merged],
      from: (contiguous ? (BigInt(prev.from) < from ? BigInt(prev.from) : from) : from).toString(),
      to: (contiguous && BigInt(prev.to) > to ? BigInt(prev.to) : to).toString(),
    };
  }
}

export interface SnapshotInput {
  profile: NetworkProfile;
  wallets: WalletEntry[];
  source: WalletSource;
  /** First block to discover tokens from. */
  fromBlock: bigint;
  /** Tokens always read, discovered or not (the registry, the focus token). */
  extraTokens?: Address[];
  cache?: TokenCache;
  onProgress?: (msg: string) => void;
}

export async function takeSnapshot(input: SnapshotInput): Promise<Snapshot> {
  const { profile, wallets, source, cache } = input;
  const t0 = Date.now();
  const say = (msg: string) => input.onProgress?.(`${msg} (+${Math.round((Date.now() - t0) / 1000)}s)`);
  const notes: string[] = [];
  const head = await source.head();
  const start = input.fromBlock < 0n ? 0n : input.fromBlock > head ? head : input.fromBlock;
  const addresses = wallets.map((w) => w.address);

  const contracts = await source.contracts(addresses);
  const eoas = addresses.filter((a) => !contracts.has(a.toLowerCase()));
  if (contracts.size) notes.push(`${contracts.size} of the list are contracts (pool, locker…): their tokens are read but not used for discovery.`);

  // What is already known lets the scan start where the last one ended.
  const known = new Map<string, Set<string>>();
  let scanFrom = start;
  if (cache) {
    const entries = eoas.map((a) => cache.get(profile.chainId, a));
    if (eoas.length && entries.every((e) => e && e.from <= start)) {
      const resume = entries.reduce((m, e) => (e!.to < m ? e!.to : m), head) + 1n;
      if (resume > start) scanFrom = resume;
    }
    eoas.forEach((a, i) => {
      if (entries[i]) known.set(a.toLowerCase(), new Set(entries[i]!.tokens));
    });
  }

  if (scanFrom <= head && eoas.length) {
    say(`discovering tokens: blocks ${scanFrom}–${head} for ${eoas.length} wallets`);
    let lastPct = -1;
    const gaps: string[] = [];
    const received = await source.receivedTokens(
      eoas,
      scanFrom,
      head,
      (done, total) => {
        const pct = Number((done * 100n) / (total || 1n));
        if (pct >= lastPct + 10) {
          lastPct = pct;
          say(`  ${pct}%`);
        }
      },
      (a, b, reason) => gaps.push(`${a}–${b} (${reason})`),
    );
    for (const [wallet, tokens] of received) {
      if (!known.has(wallet)) known.set(wallet, new Set());
      for (const t of tokens) known.get(wallet)!.add(t);
    }
    if (gaps.length) {
      notes.push(
        `${gaps.length} block range(s) could not be read and were skipped, so a token received only there may be missing: ` +
          gaps.slice(0, 3).join("; ") + (gaps.length > 3 ? "; …" : ""),
      );
    }
    if (cache && !gaps.length) {
      for (const a of eoas) cache.put(profile.chainId, a, known.get(a.toLowerCase()) ?? [], scanFrom, head);
      await cache.save();
    }
  }
  if (start > 0n) notes.push(`tokens discovered from block ${start} on; anything received earlier and never touched since may be missing.`);

  const universe = new Set<string>((input.extraTokens ?? []).map((t) => t.toLowerCase()));
  for (const set of known.values()) for (const t of set) universe.add(t);
  const tokens = [...universe] as Address[];
  say(`reading balances: ${addresses.length} wallets × ${tokens.length} tokens`);

  const [natives, meta] = await Promise.all([source.nativeBalances(addresses), source.tokenMeta(tokens)]);
  // Every wallet against every token in the universe: a contract's or a
  // wallet's position from before the window still shows if it is in the set.
  const pairs = addresses.flatMap((wallet) => tokens.map((token) => ({ token, wallet })));
  const balances = await source.tokenBalances(pairs);
  say("balances read");

  const rows: WalletRow[] = wallets.map((w) => {
    const holdings: Holding[] = [];
    for (const token of tokens) {
      const raw = balances.get(pairKey(token, w.address)) ?? 0n;
      if (raw <= 0n) continue;
      const m: TokenMeta = meta.get(token.toLowerCase()) ?? { symbol: "?", decimals: 18 };
      holdings.push({ token, symbol: m.symbol, decimals: m.decimals, raw });
    }
    return {
      ...w,
      isContract: contracts.has(w.address.toLowerCase()),
      native: natives.get(w.address.toLowerCase()) ?? 0n,
      holdings,
    };
  });

  const totals = new Map<string, TokenTotal>();
  for (const r of rows) {
    for (const h of r.holdings) {
      const key = h.token.toLowerCase();
      const t = totals.get(key) ?? { token: h.token, symbol: h.symbol, decimals: h.decimals, holders: 0, total: 0n, totalWallets: 0n };
      t.holders += 1;
      t.total += h.raw;
      if (!r.isContract) t.totalWallets += h.raw;
      totals.set(key, t);
    }
  }
  const failedNative = addresses.length - natives.size;
  if (failedNative > 0) notes.push(`${failedNative} native balances could not be read.`);

  return {
    network: {
      name: profile.name,
      title: profile.title,
      chainId: profile.chainId,
      nativeSymbol: profile.nativeSymbol,
      explorerUrl: profile.explorerUrl,
    },
    takenAt: new Date().toISOString(),
    head,
    discoveredFrom: start,
    rows,
    tokens: [...totals.values()].sort((a, b) => b.holders - a.holders || a.symbol.localeCompare(b.symbol)),
    nativeTotal: rows.reduce((s, r) => s + r.native, 0n),
    nativeWallets: rows.filter((r) => !r.isContract).reduce((s, r) => s + r.native, 0n),
    notes,
  };
}

// ------------------------------------------------------------- formatting

/** 54586381.54 → "54.59M"; small amounts keep a few significant digits. */
export function compact(raw: bigint, decimals: number): string {
  const n = Number(formatUnits(raw, decimals));
  if (!Number.isFinite(n)) return formatUnits(raw, decimals);
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  if (abs >= 1) return n.toFixed(2).replace(/\.?0+$/, "");
  if (abs === 0) return "0";
  return n.toPrecision(3).replace(/\.?0+$/, "");
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** "#3 ты 0xbe0b…c8d9" — as HTML with the address linked to the explorer. */
export function htmlWallet(w: Pick<WalletEntry, "address" | "rank" | "label">, link?: string): string {
  const name = `#${w.rank}${w.label ? ` ${escapeHtml(w.label)}` : ""}`;
  const short = shortAddress(w.address);
  return `${name} ${link ? `<a href="${escapeHtml(link)}">${short}</a>` : short}`;
}

/**
 * Display names for tokens: the symbol, or `SYMBOL·1a2b` (the address's last
 * hex digits, as in a short address) when two tokens in view share a symbol or a token borrows the
 * native currency's — copycat tickers are common and must not read as one.
 */
export function tokenLabels(tokens: { token: string; symbol: string }[], nativeSymbol: string): Map<string, string> {
  const bySymbol = new Map<string, Set<string>>();
  for (const t of tokens) {
    const key = t.symbol.toUpperCase();
    if (!bySymbol.has(key)) bySymbol.set(key, new Set());
    bySymbol.get(key)!.add(t.token.toLowerCase());
  }
  const out = new Map<string, string>();
  for (const t of tokens) {
    const clash = bySymbol.get(t.symbol.toUpperCase())!.size > 1 || t.symbol.toUpperCase() === nativeSymbol.toUpperCase();
    out.set(t.token.toLowerCase(), clash ? `${t.symbol}·${t.token.slice(-4).toLowerCase()}` : t.symbol);
  }
  return out;
}

export interface Report {
  /** Telegram HTML (parse_mode=HTML), address links to the explorer. */
  html: string;
  /** The same without markup, for the terminal and the model. */
  text: string;
}

/**
 * The snapshot as a message: header, totals, the tokens most held across the
 * list, then one line per wallet. `focus` (a token address) is listed first on
 * every line — the token the list is about.
 */
export function formatSnapshot(s: Snapshot, opts: { focus?: string; title?: string; maxTokensPerWallet?: number } = {}): Report {
  const links = explorerLinks({ explorerUrl: s.network.explorerUrl } as NetworkProfile);
  const sym = s.network.nativeSymbol;
  const per = opts.maxTokensPerWallet ?? 6;
  const focus = opts.focus?.toLowerCase();
  const when = s.takenAt.replace("T", " ").slice(0, 16) + " UTC";
  const contracts = s.rows.filter((r) => r.isContract).length;
  const names = tokenLabels(s.tokens, sym);
  const nameOf = (token: string, fallback: string) => names.get(token.toLowerCase()) ?? fallback;

  const head = [
    `${opts.title ?? "wallets"} · ${s.network.title} · block ${s.head} · ${when}`,
    `${s.rows.length} addresses${contracts ? ` (${contracts} contracts)` : ""} · ${sym} total ${compact(s.nativeTotal, 18)}` +
      (contracts ? ` (without contracts ${compact(s.nativeWallets, 18)})` : ""),
  ];
  const top = s.tokens
    .slice(0, 15)
    .map((t) => `${nameOf(t.token, t.symbol)} ×${t.holders}`)
    .join(" · ");
  if (top) head.push(`most held: ${top}`);

  const lineFor = (r: WalletRow, html: boolean) => {
    const sorted = [...r.holdings].sort((a, b) => {
      if (focus && a.token.toLowerCase() === focus) return -1;
      if (focus && b.token.toLowerCase() === focus) return 1;
      return a.symbol.localeCompare(b.symbol);
    });
    const shown = sorted.slice(0, per).map((h) => {
      const label = nameOf(h.token, h.symbol);
      return `${html ? escapeHtml(label) : label} ${compact(h.raw, h.decimals)}`;
    });
    if (sorted.length > per) shown.push(`+${sorted.length - per} more`);
    const name = html ? htmlWallet(r, links.address(r.address)) : `#${r.rank}${r.label ? ` ${r.label}` : ""} ${r.address}`;
    return `${name}${r.isContract ? " [contract]" : ""} — ${compact(r.native, 18)} ${sym}${shown.length ? ` · ${shown.join(" · ")}` : ""}`;
  };

  const notes = s.notes.map((n) => `note: ${n}`);
  return {
    html: [...head.map(escapeHtml), "", ...s.rows.map((r) => lineFor(r, true)), ...(notes.length ? ["", ...notes.map(escapeHtml)] : [])].join("\n"),
    text: [...head, "", ...s.rows.map((r) => lineFor(r, false)), ...(notes.length ? ["", ...notes] : [])].join("\n"),
  };
}

/** Rows for a spreadsheet: one per (wallet, holding), plus one native row per wallet. */
export function snapshotCsv(s: Snapshot): string {
  const q = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = ["rank,address,label,is_contract,asset,token_address,amount"];
  for (const r of s.rows) {
    const base = [String(r.rank), r.address, q(r.label ?? ""), r.isContract ? "1" : "0"];
    lines.push([...base, s.network.nativeSymbol, "", formatUnits(r.native, 18)].join(","));
    for (const h of r.holdings) lines.push([...base, q(h.symbol), h.token, formatUnits(h.raw, h.decimals)].join(","));
  }
  return lines.join("\n") + "\n";
}

/** The snapshot as JSON (bigints as decimal strings). */
export function snapshotJson(s: Snapshot): string {
  return JSON.stringify(
    {
      ...s,
      rows: s.rows.map((r) => ({
        ...r,
        native: formatUnits(r.native, 18),
        holdings: r.holdings.map((h) => ({ ...h, amount: formatUnits(h.raw, h.decimals), raw: h.raw.toString() })),
      })),
      tokens: s.tokens.map((t) => ({
        ...t,
        total: formatUnits(t.total, t.decimals),
        totalWallets: formatUnits(t.totalWallets, t.decimals),
      })),
      nativeTotal: formatUnits(s.nativeTotal, 18),
      nativeWallets: formatUnits(s.nativeWallets, 18),
    },
    (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    2,
  );
}
