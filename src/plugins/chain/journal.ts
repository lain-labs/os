import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createLogger } from "../../logger.js";

const log = createLogger("plugin:chain:journal");

/**
 * Trade journal — the memory that makes trading more than gambling. Every buy
 * and sell on the configured DEX is recorded here with its native-currency
 * cost, keeping a moving-average cost basis per token. The trader loop and
 * portfolio_pnl read this to know which positions are actually in profit;
 * soul.md's "journal every trade" rule lands in this file.
 *
 * Amounts are stored as decimal strings of raw wei bigints (JSON-safe).
 * Positions with no recorded basis (tokens that arrived by airdrop/transfer)
 * are deliberately invisible here — automation must never "take profit" on a
 * position whose cost it does not know.
 */

export interface TradeRecord {
  ts: number;
  side: "buy" | "sell";
  token: string;
  symbol: string;
  /** Token amount in raw units (wei-scale for the token's decimals). */
  qtyWei: string;
  /** Native currency paid (buy) or received (sell), in wei. */
  nativeWei: string;
  txHash: string;
  reason?: string;
  /** Realised profit in native-currency wei (sell only; proceeds minus basis sold). */
  realizedWei?: string;
}

export interface LiquidityRecord {
  ts: number;
  side: "add";
  pair: string;
  tokenA: string;
  symbolA: string;
  amountAWei: string;
  tokenB: string;
  symbolB: string;
  amountBWei: string;
  lpWei: string;
  txHash: string;
  reason?: string;
}

export interface Position {
  token: string;
  symbol: string;
  qtyWei: string;
  /** Total native-currency wei paid for the remaining qty (moving-average basis). */
  costWei: string;
}

interface JournalFile {
  trades: TradeRecord[];
  positions: Record<string, Position>;
  liquidity?: LiquidityRecord[];
}

const TRADE_CAP = 500;
const LIQUIDITY_CAP = 500;

/** Moving-average position after a buy. */
export function applyBuy(pos: Position | undefined, base: Position, qty: bigint, cost: bigint): Position {
  const prevQty = pos ? BigInt(pos.qtyWei) : 0n;
  const prevCost = pos ? BigInt(pos.costWei) : 0n;
  return {
    ...base,
    qtyWei: (prevQty + qty).toString(),
    costWei: (prevCost + cost).toString(),
  };
}

/**
 * Moving-average position after a sell; returns the realised PnL in
 * native-currency wei. Selling more than the recorded qty (basis unknown for
 * the excess) treats the excess as zero-cost and empties the position.
 */
export function applySell(
  pos: Position,
  qty: bigint,
  proceeds: bigint,
): { position: Position; realizedWei: bigint } {
  const prevQty = BigInt(pos.qtyWei);
  const prevCost = BigInt(pos.costWei);
  const sold = qty > prevQty ? prevQty : qty;
  const basisSold = prevQty > 0n ? (prevCost * sold) / prevQty : 0n;
  const position: Position = {
    ...pos,
    qtyWei: (prevQty - sold).toString(),
    costWei: (prevCost - basisSold).toString(),
  };
  return { position, realizedWei: proceeds - basisSold };
}

export class TradeJournal {
  private file: string;
  private data: JournalFile = { trades: [], positions: {} };
  private loaded = false;

  constructor(file: string) {
    this.file = file;
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as JournalFile;
      this.data = {
        trades: parsed.trades ?? [],
        positions: parsed.positions ?? {},
        liquidity: parsed.liquidity ?? [],
      };
    } catch {
      // Fresh journal.
    }
    this.loaded = true;
  }

  positions(): Position[] {
    return Object.values(this.data.positions).filter((p) => BigInt(p.qtyWei) > 0n);
  }

  positionOf(token: string): Position | undefined {
    const pos = this.data.positions[token.toLowerCase()];
    return pos && BigInt(pos.qtyWei) > 0n ? pos : undefined;
  }

  recentTrades(limit = 10): TradeRecord[] {
    return this.data.trades.slice(-limit);
  }

  recentLiquidity(limit = 10): LiquidityRecord[] {
    return (this.data.liquidity ?? []).slice(-limit);
  }

  async recordBuy(input: {
    token: string;
    symbol: string;
    qtyWei: bigint;
    nativeWei: bigint;
    txHash: string;
    reason?: string;
  }): Promise<void> {
    const key = input.token.toLowerCase();
    const base: Position = { token: input.token, symbol: input.symbol, qtyWei: "0", costWei: "0" };
    this.data.positions[key] = applyBuy(this.data.positions[key], base, input.qtyWei, input.nativeWei);
    this.push({
      ts: Date.now(),
      side: "buy",
      token: input.token,
      symbol: input.symbol,
      qtyWei: input.qtyWei.toString(),
      nativeWei: input.nativeWei.toString(),
      txHash: input.txHash,
      reason: input.reason,
    });
    await this.persist();
  }

  /** Returns realised PnL in native-currency wei (0 when no basis was recorded). */
  async recordSell(input: {
    token: string;
    symbol: string;
    qtyWei: bigint;
    nativeWei: bigint;
    txHash: string;
    reason?: string;
  }): Promise<bigint> {
    const key = input.token.toLowerCase();
    const pos =
      this.data.positions[key] ??
      ({ token: input.token, symbol: input.symbol, qtyWei: "0", costWei: "0" } as Position);
    const { position, realizedWei } = applySell(pos, input.qtyWei, input.nativeWei);
    this.data.positions[key] = position;
    this.push({
      ts: Date.now(),
      side: "sell",
      token: input.token,
      symbol: input.symbol,
      qtyWei: input.qtyWei.toString(),
      nativeWei: input.nativeWei.toString(),
      txHash: input.txHash,
      reason: input.reason,
      realizedWei: realizedWei.toString(),
    });
    await this.persist();
    return realizedWei;
  }

  async recordLiquidityAdd(input: {
    pair: string;
    tokenA: string;
    symbolA: string;
    amountAWei: bigint;
    tokenB: string;
    symbolB: string;
    amountBWei: bigint;
    lpWei: bigint;
    txHash: string;
    reason?: string;
  }): Promise<void> {
    this.data.liquidity ??= [];
    this.data.liquidity.push({
      ts: Date.now(),
      side: "add",
      pair: input.pair,
      tokenA: input.tokenA,
      symbolA: input.symbolA,
      amountAWei: input.amountAWei.toString(),
      tokenB: input.tokenB,
      symbolB: input.symbolB,
      amountBWei: input.amountBWei.toString(),
      lpWei: input.lpWei.toString(),
      txHash: input.txHash,
      reason: input.reason,
    });
    if (this.data.liquidity.length > LIQUIDITY_CAP) {
      this.data.liquidity = this.data.liquidity.slice(-LIQUIDITY_CAP);
    }
    await this.persist();
  }

  private push(trade: TradeRecord): void {
    this.data.trades.push(trade);
    if (this.data.trades.length > TRADE_CAP) {
      this.data.trades = this.data.trades.slice(-TRADE_CAP);
    }
  }

  private async persist(): Promise<void> {
    this.loaded = true;
    try {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(this.file, JSON.stringify(this.data, null, 2), "utf8");
    } catch (err) {
      log.warn("could not persist trade journal", err);
    }
  }
}
