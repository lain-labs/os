/**
 * The group watch: every change in a list of wallets — any ERC20 in or out,
 * and the native balance — collected per tick into one digest.
 *
 * One tick is two getLogs per block window for the whole group (the members
 * OR-ed into the `to` and the `from` topic), one multicall for the balances of
 * the tokens that moved, and one for the native balances. A hundred wallets
 * cost what one used to.
 *
 * Changes are aggregated per wallet and token, so a pool that sees four
 * hundred swaps in a minute is one line ("412 transfers · LAIN +5.3M"), not
 * four hundred alerts. Contracts in the list are kept — the operator put the
 * pool and the locker on the list for a reason — just never allowed to flood.
 */
import type { Address } from "viem";
import { explorerLinks, type NetworkProfile } from "../chain/networks.js";
import { pairKey, type TokenMeta, type Transfer, type WalletSource } from "./chainread.js";
import { shortAddress, type WalletEntry } from "./lists.js";
import { compact, escapeHtml, htmlWallet, type Report } from "./snapshot.js";

export interface GroupState {
  /** Last block scanned. */
  cursor?: string;
  /** Last native balance per lowercase wallet, in wei. */
  native?: Record<string, string>;
}

export interface GroupOptions {
  tokens: boolean;
  native: boolean;
  /** Native moves smaller than this (wei) are gas noise, not news. */
  minNativeWei: bigint;
  /** Most blocks read in one tick; the rest waits for the next one. */
  maxSpan: bigint;
  /** Further behind than this, skip ahead rather than replay (a daemon that slept a day). */
  maxLag: bigint;
}

export interface TokenChange {
  token: Address;
  symbol: string;
  decimals: number;
  in: bigint;
  out: bigint;
  count: number;
  /** Balance after the scanned range, when it could be read. */
  balance?: bigint;
  /** Opened from zero within the range. */
  opened: boolean;
  /** Down to zero at the end of the range. */
  closed: boolean;
  /** The last transaction that moved it. */
  tx: string;
}

export interface WalletChange {
  wallet: WalletEntry;
  isContract: boolean;
  native?: { before: bigint; after: bigint };
  tokens: TokenChange[];
}

export interface GroupScan {
  changes: WalletChange[];
  from: bigint;
  to: bigint;
  /** Blocks skipped because the watch was too far behind. */
  skipped: bigint;
  /** True when the first tick only set the baseline. */
  baseline: boolean;
}

/**
 * Advance the watch by one tick. Mutates `state` (cursor, native baseline);
 * the caller persists it. `meta` caches token metadata across ticks.
 */
export async function scanGroup(
  src: WalletSource,
  members: WalletEntry[],
  state: GroupState,
  opts: GroupOptions,
  meta: Map<string, TokenMeta>,
  contracts?: Set<string>,
): Promise<GroupScan> {
  const head = await src.head();
  const addrs = members.map((m) => m.address);
  const byKey = new Map(members.map((m) => [m.address.toLowerCase(), m]));

  if (state.cursor === undefined) {
    // A new watch reports what happens from now on, not a replay of history.
    state.cursor = head.toString();
    if (opts.native) state.native = toRecord(await src.nativeBalances(addrs));
    return { changes: [], from: head, to: head, skipped: 0n, baseline: true };
  }

  let from = BigInt(state.cursor) + 1n;
  let skipped = 0n;
  if (head - from + 1n > opts.maxLag) {
    skipped = head - opts.maxLag + 1n - from;
    from = head - opts.maxLag + 1n;
  }
  if (from > head) return { changes: [], from, to: head, skipped, baseline: false };
  const to = head - from + 1n > opts.maxSpan ? from + opts.maxSpan - 1n : head;

  const agg = new Map<string, Map<string, TokenChange>>();
  if (opts.tokens) {
    const [ins, outs] = await Promise.all([
      src.transfers(addrs, "in", from, to),
      src.transfers(addrs, "out", from, to),
    ]);
    const touch = (wallet: string, t: Transfer, side: "in" | "out") => {
      const w = wallet.toLowerCase();
      if (!byKey.has(w)) return;
      const tokens = agg.get(w) ?? new Map<string, TokenChange>();
      agg.set(w, tokens);
      const key = t.token.toLowerCase();
      const c = tokens.get(key) ?? {
        token: t.token,
        symbol: "?",
        decimals: 18,
        in: 0n,
        out: 0n,
        count: 0,
        opened: false,
        closed: false,
        tx: t.tx,
      };
      if (side === "in") c.in += t.value;
      else c.out += t.value;
      c.count += 1;
      c.tx = t.tx;
      tokens.set(key, c);
    };
    for (const t of ins) if (t.from.toLowerCase() !== t.to.toLowerCase()) touch(t.to, t, "in");
    for (const t of outs) if (t.from.toLowerCase() !== t.to.toLowerCase()) touch(t.from, t, "out");

    const touched = [...agg.entries()].flatMap(([w, tokens]) =>
      [...tokens.values()].map((c) => ({ token: c.token, wallet: byKey.get(w)!.address })),
    );
    const unknown = [...new Set(touched.map((p) => p.token.toLowerCase()))].filter((t) => !meta.has(t)) as Address[];
    const [balances, fresh] = await Promise.all([
      touched.length ? src.tokenBalances(touched) : Promise.resolve(new Map<string, bigint>()),
      unknown.length ? src.tokenMeta(unknown) : Promise.resolve(new Map<string, TokenMeta>()),
    ]);
    for (const [k, v] of fresh) meta.set(k, v);
    for (const [w, tokens] of agg) {
      for (const c of tokens.values()) {
        const m = meta.get(c.token.toLowerCase());
        if (m) {
          c.symbol = m.symbol;
          c.decimals = m.decimals;
        }
        const bal = balances.get(pairKey(c.token, w));
        if (bal !== undefined) {
          c.balance = bal;
          const net = c.in - c.out;
          c.opened = net > 0n && bal > 0n && bal - net <= 0n;
          c.closed = c.out > 0n && bal === 0n;
        }
      }
    }
  }

  const nativeMoves = new Map<string, { before: bigint; after: bigint }>();
  if (opts.native) {
    const now = await src.nativeBalances(addrs);
    const prev = state.native ?? {};
    for (const [w, after] of now) {
      const before = prev[w] !== undefined ? BigInt(prev[w]) : undefined;
      if (before === undefined) continue;
      const delta = after > before ? after - before : before - after;
      if (delta > 0n && delta >= opts.minNativeWei) nativeMoves.set(w, { before, after });
    }
    state.native = { ...prev, ...toRecord(now) };
  }

  state.cursor = to.toString();
  const keys = new Set([...agg.keys(), ...nativeMoves.keys()]);
  const changes: WalletChange[] = [...keys]
    .map((k) => ({
      wallet: byKey.get(k)!,
      isContract: contracts?.has(k) ?? false,
      native: nativeMoves.get(k),
      tokens: [...(agg.get(k)?.values() ?? [])],
    }))
    .sort((a, b) => a.wallet.rank - b.wallet.rank);
  return { changes, from, to, skipped, baseline: false };
}

function toRecord(m: Map<string, bigint>): Record<string, string> {
  return Object.fromEntries([...m].map(([k, v]) => [k, v.toString()]));
}

function signed(raw: bigint, decimals: number): string {
  return `${raw >= 0n ? "+" : "−"}${compact(raw >= 0n ? raw : -raw, decimals)}`;
}

/** Most wallet lines in one digest; the rest is counted. */
const MAX_LINES = 40;
/** Most tokens named on one wallet's line. */
const MAX_TOKENS = 5;

/**
 * One digest for a tick: a header, then a line per wallet that changed, most
 * relevant first by rank. Null when nothing changed.
 */
export function formatGroupAlert(
  title: string,
  profile: Pick<NetworkProfile, "title" | "nativeSymbol" | "explorerUrl" | "nativeDecimals">,
  scan: GroupScan,
): Report | null {
  if (!scan.changes.length) return null;
  const links = explorerLinks(profile as NetworkProfile);
  const decimals = profile.nativeDecimals ?? 18;
  const header = `👁 ${title} · ${profile.title} · ${scan.changes.length} wallet${scan.changes.length === 1 ? "" : "s"} moved · blocks ${scan.from}–${scan.to}`;

  const line = (c: WalletChange, html: boolean): string => {
    const parts: string[] = [];
    const total = c.tokens.reduce((s, t) => s + t.count, 0);
    if (c.tokens.length > MAX_TOKENS || total > 20) parts.push(`${total} transfers`);
    const ordered = [...c.tokens].sort((a, b) => Number(b.opened || b.closed) - Number(a.opened || a.closed) || b.count - a.count);
    for (const t of ordered.slice(0, MAX_TOKENS)) {
      const net = t.in - t.out;
      const sym = html ? escapeHtml(t.symbol) : t.symbol;
      const tag = t.opened ? " new position" : t.closed ? " exited" : "";
      const amount = net === 0n ? `±${compact(t.in, t.decimals)} (in=out)` : signed(net, t.decimals);
      const hold = t.balance !== undefined && !t.closed ? `, holds ${compact(t.balance, t.decimals)}` : "";
      const txUrl = t.count === 1 ? links.tx(t.tx) : undefined;
      const tx = txUrl ? (html ? ` <a href="${escapeHtml(txUrl)}">tx</a>` : ` ${txUrl}`) : "";
      parts.push(`${sym} ${amount}${tag}${hold}${tx}`);
    }
    if (ordered.length > MAX_TOKENS) parts.push(`+${ordered.length - MAX_TOKENS} more tokens`);
    if (c.native) parts.push(`${profile.nativeSymbol} ${signed(c.native.after - c.native.before, decimals)} → ${compact(c.native.after, decimals)}`);
    const who = html
      ? htmlWallet(c.wallet, links.address(c.wallet.address))
      : `#${c.wallet.rank}${c.wallet.label ? ` ${c.wallet.label}` : ""} ${shortAddress(c.wallet.address)}`;
    return `${who}${c.isContract ? " [contract]" : ""}: ${parts.join(" · ")}`;
  };

  const shown = scan.changes.slice(0, MAX_LINES);
  const rest = scan.changes.length - shown.length;
  const tail = [
    ...(rest > 0 ? [`…and ${rest} more wallets`] : []),
    ...(scan.skipped > 0n ? [`(was ${scan.skipped} blocks behind — those were skipped)`] : []),
  ];
  return {
    html: [escapeHtml(header), ...shown.map((c) => line(c, true)), ...tail.map(escapeHtml)].join("\n"),
    text: [header, ...shown.map((c) => line(c, false)), ...tail].join("\n"),
  };
}
