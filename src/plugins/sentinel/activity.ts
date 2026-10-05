/**
 * Wallet activity: what a watched address is *doing*, not just what it holds.
 *
 * Every tick the sentinel reads the ERC20 `Transfer` logs into and out of each
 * tracked wallet since its cursor, and turns them into {@link WalletMove}s:
 * per token, a self-initiated buy or sell, flagged `fresh` when it opens a
 * position from zero (buy) or closes one to zero (sell). Only transactions the
 * wallet itself sent count as moves — airdrops and dust spam arrive in
 * somebody else's transaction and are ignored.
 *
 * The opening balance is derived, not read at a past block (which would need
 * an archive node): `before = now − (all inflows − all outflows)` over the
 * scanned range.
 *
 * The chain is reached through {@link ActivitySource}, so the detection logic
 * and the rules built on it (accumulation, convergence) are testable offline.
 */
import { formatUnits, parseAbiItem, type Address } from "viem";
import { sameAddress } from "../chain/math.js";
import type { ChainService } from "../chain/index.js";

export interface RawTransfer {
  token: Address;
  from: Address;
  to: Address;
  value: bigint;
  tx: string;
  block: bigint;
}

export interface ActivitySource {
  head(): Promise<bigint>;
  /** ERC20 transfers into or out of `wallet` within [from, to]. */
  transfers(wallet: Address, from: bigint, to: bigint): Promise<RawTransfer[]>;
  /** Who signed the transaction. */
  txSender(hash: string): Promise<Address | undefined>;
  balance(token: Address, wallet: Address): Promise<{ raw: bigint; decimals: number; symbol: string }>;
  /** Tokens that are plumbing, not positions (the wrapped native currency). */
  ignored(): Address[];
}

export interface WalletMove {
  wallet: Address;
  token: Address;
  symbol: string;
  side: "buy" | "sell";
  /** buy: opened from a zero balance. sell: closed to a zero balance. */
  fresh: boolean;
  /** Decimal amount moved by the wallet's own transactions. */
  amount: string;
  /** Decimal balance after the scanned range. */
  balance: string;
  tx: string;
  block: string;
  at: number;
}

/** Most transactions per wallet per tick whose sender is looked up. */
const MAX_SENDER_LOOKUPS = 50;

/** Classify one wallet's transfers in a scanned range into moves. */
export async function scanWallet(
  src: ActivitySource,
  wallet: Address,
  transfers: RawTransfer[],
  at: number,
): Promise<WalletMove[]> {
  const ignored = src.ignored();
  const relevant = transfers.filter((t) => !ignored.some((i) => sameAddress(i, t.token)));
  if (!relevant.length) return [];

  const hashes = [...new Set(relevant.map((t) => t.tx.toLowerCase()))].slice(0, MAX_SENDER_LOOKUPS);
  const own = new Set<string>();
  await Promise.all(
    hashes.map(async (hash) => {
      const sender = await src.txSender(hash).catch(() => undefined);
      if (sender && sameAddress(sender, wallet)) own.add(hash);
    }),
  );

  const byToken = new Map<string, RawTransfer[]>();
  for (const t of relevant) {
    const key = t.token.toLowerCase();
    byToken.set(key, [...(byToken.get(key) ?? []), t]);
  }

  const moves: WalletMove[] = [];
  for (const list of byToken.values()) {
    let netAll = 0n;
    let ownIn = 0n;
    let ownOut = 0n;
    let last = list[0];
    for (const t of list) {
      const into = sameAddress(t.to, wallet);
      const outOf = sameAddress(t.from, wallet);
      if (into === outOf) continue; // self-transfer
      netAll += into ? t.value : -t.value;
      if (own.has(t.tx.toLowerCase())) {
        if (into) ownIn += t.value;
        else ownOut += t.value;
        if (t.block >= last.block) last = t;
      }
    }
    if (ownIn === 0n && ownOut === 0n) continue;

    const { raw, decimals, symbol } = await src.balance(last.token, wallet);
    const before = raw - netAll;
    const buying = ownIn > ownOut;
    moves.push({
      wallet,
      token: last.token,
      symbol,
      side: buying ? "buy" : "sell",
      fresh: buying ? before <= 0n && raw > 0n : raw === 0n,
      amount: formatUnits(buying ? ownIn - ownOut : ownOut - ownIn, decimals),
      balance: formatUnits(raw, decimals),
      tx: last.tx,
      block: last.block.toString(),
      at,
    });
  }
  return moves;
}

/** A wallet's buys of one token within the window ending at `now`. */
export function buysWithin(
  moves: WalletMove[],
  wallet: Address,
  token: Address,
  windowMs: number,
  now: number,
): WalletMove[] {
  return moves.filter(
    (m) =>
      m.side === "buy" &&
      now - m.at <= windowMs &&
      sameAddress(m.wallet, wallet) &&
      sameAddress(m.token, token),
  );
}

/** Distinct members that bought `token` within the window ending at `now`. */
export function convergingWallets(
  moves: WalletMove[],
  members: Address[],
  token: Address,
  windowMs: number,
  now: number,
): Address[] {
  const buyers = new Map<string, Address>();
  for (const m of moves) {
    if (m.side !== "buy" || now - m.at > windowMs || !sameAddress(m.token, token)) continue;
    const member = members.find((a) => sameAddress(a, m.wallet));
    if (member) buyers.set(member.toLowerCase(), member);
  }
  return [...buyers.values()];
}

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

/** The live chain behind {@link ActivitySource}. */
export function chainActivitySource(chain: ChainService): ActivitySource {
  const pc = chain.publicClient;
  return {
    head: () => pc.getBlockNumber(),
    async transfers(wallet, fromBlock, toBlock) {
      const [ins, outs] = await Promise.all([
        pc.getLogs({ event: TRANSFER, args: { to: wallet }, fromBlock, toBlock }),
        pc.getLogs({ event: TRANSFER, args: { from: wallet }, fromBlock, toBlock }),
      ]);
      const out: RawTransfer[] = [];
      for (const log of [...ins, ...outs]) {
        // ERC721 shares the Transfer signature with an indexed tokenId and no
        // value — those are not positions this reads.
        const { from, to, value } = log.args;
        if (!from || !to || typeof value !== "bigint" || !log.transactionHash || log.blockNumber === null) continue;
        out.push({ token: log.address, from, to, value, tx: log.transactionHash, block: log.blockNumber });
      }
      return out;
    },
    async txSender(hash) {
      const tx = await pc.getTransaction({ hash: hash as `0x${string}` });
      return tx.from;
    },
    balance: (token, wallet) => chain.rawTokenBalance(token, wallet),
    ignored() {
      try {
        return [chain.dex.wrappedNative];
      } catch {
        return [];
      }
    },
  };
}
