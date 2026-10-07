/**
 * Every holder of one ERC20, from the RPC alone.
 *
 * Launchpad holder APIs move, redirect and vanish (Pons' went 308 → 404 on
 * 2026-10-07), so the list is rebuilt from the chain: the token's Transfer
 * logs are summed into balances, and every balance is then checked against
 * `balanceOf` — the logs say who ever held it, the contract says who holds it.
 *
 * Public RPCs keep logs but not historical state (Robinhood's answers a
 * `getCode` at an old block with "historical state is not available"), so the
 * deployment block cannot be bisected. The first scan walks back from the head
 * instead, and stops once the mints it has seen account for the whole
 * `totalSupply` — nothing older can have moved a token that did not exist yet.
 * The balances and the last block covered are kept in a ledger, so every later
 * scan reads only the blocks since.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { erc20Abi, type Address } from "viem";
import { networkClient, type NetworkProfile } from "../chain/networks.js";
import { pacer, pairKey, rangeScan, rpcWalletSource, TRANSFER_TOPIC } from "./chainread.js";
import type { WalletEntry } from "./lists.js";

/** One Transfer of the token; addresses lowercase. */
export interface TokenMove {
  from: string;
  to: string;
  value: bigint;
}

export interface HolderSource {
  head(): Promise<bigint>;
  totalSupply(token: Address): Promise<bigint>;
  /** The token's transfers within [from, to]. */
  moves(token: Address, from: bigint, to: bigint): Promise<TokenMove[]>;
  /** balanceOf per lowercase wallet; a failed read is absent. */
  balances(token: Address, wallets: Address[]): Promise<Map<string, bigint>>;
}

export interface HolderLedger {
  /** First block covered. */
  start?: string;
  /** Last block covered; absent until the first scan finished. */
  scannedTo?: string;
  /** Non-zero balance per lowercase address, from the logs (decimal string). */
  balances: Record<string, string>;
}

export interface Holder {
  address: Address;
  balance: bigint;
}

export interface HolderScan {
  /** balanceOf > 0, largest first; the zero and dead addresses never count. */
  holders: Holder[];
  from: bigint;
  to: bigint;
  logs: number;
  /** Addresses whose log balance disagrees with balanceOf (fee or rebasing tokens). */
  mismatched: number;
  /** False when the walk back hit block 0 without accounting for the supply. */
  complete: boolean;
}

const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";

/**
 * Bring `ledger` up to the head and read who holds the token now. The ledger
 * is only updated once the scan succeeded; the caller persists it.
 */
export async function scanHolders(
  src: HolderSource,
  token: Address,
  ledger: HolderLedger,
  span: bigint,
  onProgress?: (blocks: bigint) => void,
): Promise<HolderScan> {
  const head = await src.head();
  const bal = new Map(Object.entries(ledger.balances).map(([k, v]) => [k, BigInt(v)]));
  const apply = (m: TokenMove) => {
    if (m.from === m.to) return;
    if (m.from !== ZERO) bal.set(m.from, (bal.get(m.from) ?? 0n) - m.value);
    if (m.to !== ZERO) bal.set(m.to, (bal.get(m.to) ?? 0n) + m.value);
  };
  let logs = 0;
  let from: bigint;
  let complete = true;

  if (ledger.scannedTo === undefined) {
    const supply = await src.totalSupply(token);
    let minted = 0n;
    let to = head;
    for (;;) {
      from = to + 1n > span ? to - span + 1n : 0n;
      const moves = await src.moves(token, from, to);
      for (const m of moves) {
        apply(m);
        if (m.from === ZERO) minted += m.value;
        if (m.to === ZERO) minted -= m.value;
      }
      logs += moves.length;
      onProgress?.(head - from + 1n);
      if (minted === supply && logs > 0) break;
      if (from === 0n) {
        complete = minted === supply;
        break;
      }
      to = from - 1n;
    }
  } else {
    from = BigInt(ledger.scannedTo) + 1n;
    if (from <= head) {
      const moves = await src.moves(token, from, head);
      for (const m of moves) apply(m);
      logs = moves.length;
    }
  }

  const candidates = [...bal.keys()].filter((a) => a !== ZERO && a !== DEAD) as Address[];
  const onChain = candidates.length ? await src.balances(token, candidates) : new Map<string, bigint>();
  let mismatched = 0;
  const holders: Holder[] = [];
  for (const a of candidates) {
    const fromLogs = bal.get(a)!;
    const real = onChain.get(a) ?? fromLogs;
    if (onChain.has(a) && real !== fromLogs) mismatched += 1;
    if (real > 0n) holders.push({ address: a, balance: real });
  }
  holders.sort((x, y) => (y.balance > x.balance ? 1 : y.balance < x.balance ? -1 : 0));

  ledger.start ??= from.toString();
  ledger.scannedTo = head.toString();
  ledger.balances = Object.fromEntries([...bal].filter(([, v]) => v !== 0n).map(([k, v]) => [k, v.toString()]));
  return { holders, from, to: head, logs, mismatched, complete };
}

/**
 * Holders not yet on `members`, as new entries ranked after the last one, in
 * balance order. Members are never dropped or re-ranked: someone who sold
 * stays watched. `excluded` (lowercase) is never added.
 */
export function newHolders(members: WalletEntry[], holders: Holder[], excluded: Iterable<string>): WalletEntry[] {
  const skip = new Set([...members.map((m) => m.address.toLowerCase()), ...[...excluded].map((a) => a.toLowerCase())]);
  let rank = members.reduce((r, m) => Math.max(r, m.rank), 0);
  const added: WalletEntry[] = [];
  for (const h of holders) {
    const key = h.address.toLowerCase();
    if (skip.has(key)) continue;
    skip.add(key);
    added.push({ address: h.address, rank: ++rank });
  }
  return added;
}

export function ledgerPath(dataDir: string, chainId: number, token: string): string {
  return join(dataDir, "holders", `${chainId}-${token.toLowerCase()}.json`);
}

export async function loadLedger(path: string): Promise<HolderLedger> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as HolderLedger;
    return { ...parsed, balances: parsed.balances ?? {} };
  } catch {
    return { balances: {} };
  }
}

export async function saveLedger(path: string, ledger: HolderLedger): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(ledger), "utf8");
}

type RawLog = { topics: string[]; data: string };

/** The live chain behind {@link HolderSource}. */
export function rpcHolderSource(profile: NetworkProfile): HolderSource {
  const client = networkClient(profile);
  const wallets = rpcWalletSource(profile, client);
  const maxSpan = BigInt(profile.maxLogSpan ?? 10_000);
  const pace = pacer(120);
  return {
    head: () => client.getBlockNumber(),
    totalSupply: (token) => client.readContract({ address: token, abi: erc20Abi, functionName: "totalSupply" }),
    async moves(token, from, to) {
      const logs = await rangeScan<RawLog>(
        async (a, b) => {
          await pace();
          return (await client.request({
            method: "eth_getLogs",
            params: [{ address: token, fromBlock: `0x${a.toString(16)}`, toBlock: `0x${b.toString(16)}`, topics: [TRANSFER_TOPIC] } as never],
          })) as RawLog[];
        },
        from,
        to,
        maxSpan,
      );
      const out: TokenMove[] = [];
      for (const log of logs) {
        if (log.topics.length !== 3 || !log.data || log.data === "0x") continue;
        out.push({
          from: `0x${log.topics[1].slice(26)}`.toLowerCase(),
          to: `0x${log.topics[2].slice(26)}`.toLowerCase(),
          value: BigInt(log.data.slice(0, 66)),
        });
      }
      return out;
    },
    async balances(token, list) {
      const res = await wallets.tokenBalances(list.map((wallet) => ({ token, wallet })));
      const out = new Map<string, bigint>();
      for (const w of list) {
        const v = res.get(pairKey(token, w));
        if (v !== undefined) out.set(w.toLowerCase(), v);
      }
      return out;
    },
  };
}
