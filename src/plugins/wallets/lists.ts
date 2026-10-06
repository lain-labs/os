/**
 * Wallet lists: the addresses a snapshot or a watch covers, and what to call
 * each one.
 *
 * Lists arrive in whatever shape the last export had — a CSV with a rank
 * column, a holders JSON from a launchpad API, a pasted column of addresses —
 * so the reader does not ask for a format: it walks the text (or the JSON
 * tree) in order and keeps every distinct 0x address it meets, with a label
 * when the record carries one. Order is preserved, because the order of a
 * holders list *is* the rank.
 */
import { isAddress, type Address } from "viem";

export interface WalletEntry {
  address: Address;
  /** 1-based position in the list (a holders list's rank). */
  rank: number;
  /** The operator's name for it ("pool", "my wallet"), when known. */
  label?: string;
}

const ADDRESS_RE = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
const LABEL_KEYS = ["label", "name", "note", "tag", "alias"];

/** Every distinct address in `raw` (file text or JSON), in order of first appearance. */
export function parseWalletList(raw: string): WalletEntry[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return fromJson(JSON.parse(trimmed));
    } catch {
      // Not JSON after all — fall back to scanning the text.
    }
  }
  const out: WalletEntry[] = [];
  const seen = new Set<string>();
  for (const line of trimmed.split(/\r?\n/)) {
    const first = line.match(ADDRESS_RE)?.[0];
    if (!first || seen.has(first.toLowerCase()) || !isAddress(first)) continue;
    seen.add(first.toLowerCase());
    out.push({ address: first as Address, rank: out.length + 1 });
  }
  return out;
}

function fromJson(root: unknown): WalletEntry[] {
  const out: WalletEntry[] = [];
  const seen = new Set<string>();
  const add = (address: string, label?: string) => {
    const key = address.toLowerCase();
    if (seen.has(key) || !isAddress(address)) return;
    seen.add(key);
    out.push({ address: address as Address, rank: out.length + 1, ...(label ? { label } : {}) });
  };
  const walk = (node: unknown, depth: number): void => {
    if (depth > 8 || node === null || node === undefined) return;
    if (typeof node === "string") {
      if (/^0x[0-9a-fA-F]{40}$/.test(node)) add(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (typeof node === "object") {
      const rec = node as Record<string, unknown>;
      const addr = [rec.address, rec.wallet, rec.hash, rec.holder].find(
        (v): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v),
      );
      if (addr) {
        const label = LABEL_KEYS.map((k) => rec[k]).find((v): v is string => typeof v === "string" && v.trim() !== "");
        add(addr, label?.trim());
        return;
      }
      for (const v of Object.values(rec)) walk(v, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

/**
 * Merge an explicit address list, a file's list and a label map into one
 * list. Explicit addresses come first; labels from `labels` (keyed by address,
 * any case) win over labels found in the file.
 */
export function mergeWalletLists(
  lists: WalletEntry[][],
  labels: Record<string, string> = {},
): WalletEntry[] {
  const byKey = new Map<string, WalletEntry>();
  const order: string[] = [];
  for (const list of lists) {
    for (const e of list) {
      const key = e.address.toLowerCase();
      if (!byKey.has(key)) {
        byKey.set(key, { ...e });
        order.push(key);
      } else if (e.label && !byKey.get(key)!.label) {
        byKey.get(key)!.label = e.label;
      }
    }
  }
  const lower = Object.fromEntries(Object.entries(labels).map(([k, v]) => [k.toLowerCase(), v]));
  return order.map((key, i) => {
    const e = byKey.get(key)!;
    const label = lower[key] ?? e.label;
    return { address: e.address, rank: i + 1, ...(label ? { label } : {}) };
  });
}

/** "0xbe0b…c8d9" */
export function shortAddress(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/** "#3 ты (0xbe0b…c8d9)" — how a wallet is named in reports and alerts. */
export function walletName(e: Pick<WalletEntry, "address" | "rank" | "label">): string {
  return `#${e.rank}${e.label ? ` ${e.label}` : ""} ${shortAddress(e.address)}`;
}
