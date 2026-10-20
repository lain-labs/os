import { formatEther, formatUnits, isAddress, type Address } from "viem";
import { createLogger } from "../../logger.js";
import type { ChainService } from "../chain/index.js";
import type {
  Action,
  IAgentRuntime,
  Plugin,
  Provider,
  Service,
} from "../../types.js";

const log = createLogger("plugin:trader");

/**
 * The trader plugin is the mechanical half of Lain's money mission: a
 * background loop that walks her journaled positions on an interval and
 * realises profit without being asked. It is deliberately dumb and safe:
 *
 *   - only positions with a recorded cost basis are ever touched — tokens that
 *     arrived by airdrop or transfer are invisible to automation;
 *   - a position is sold only when its live sell-side quote clears the
 *     take-profit threshold (default +25%) against its moving-average basis;
 *   - an optional stop-loss (off by default) cuts positions that bleed;
 *   - every sale respects a price-impact cap: if the full position would move the
 *     pool too much, it halves the size until it fits (partial take-profit);
 *   - everything lands back in the journal, and every action is pushed to the
 *     operator via the daemon's event wiring.
 *
 * The judgment half of trading (what to buy, when to be afraid) stays with
 * Lain herself through speculate_token / speculate_basket / sell_token.
 *
 * In paper mode the loop walks the paper account instead and sells on paper.
 * Real selling is daemon-only (two processes selling one wallet would double
 * up), but a paper account belongs to its own process — so while paper mode
 * is on, the TUI's loop runs too.
 */

export interface TraderEvent {
  kind: "trade" | "error";
  text: string;
}

interface TraderConfig {
  takeProfitBps: number;
  stopLossBps: number;
  maxImpactBps: number;
  slippageBps: number;
  minProceedsWei: bigint;
}

export class TraderService implements Service {
  readonly name = "trader";

  private runtime?: IAgentRuntime;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private subscribers = new Set<(event: TraderEvent) => void>();
  private lastTickAt = 0;
  /** Whether this process may sell the real wallet (daemon, or LAINOS_TRADER=1). */
  private realEnabled = false;

  async start(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
    const forced = runtime.getSetting("LAINOS_TRADER");
    const disabled = forced === "0";
    this.realEnabled = forced !== undefined && forced !== ""
      ? forced !== "0"
      : runtime.getSetting("LAINOS_DAEMON") === "1";
    if (disabled) {
      log.info("trader loop off (LAINOS_TRADER=0)");
      return;
    }
    const interval = Math.max(
      60_000,
      Number(runtime.getSetting("LAINOS_TRADER_INTERVAL_MS") ?? 900_000),
    );
    // Always armed: each tick decides whether there is anything it may sell.
    this.timer = setInterval(() => void this.safeTick(), interval);
    this.timer.unref?.();
    const cfg = this.config();
    log.info(
      `trader loop ${this.realEnabled ? "online" : "on paper only (real selling is daemon-only; force with LAINOS_TRADER=1)"}: ` +
        `every ${Math.round(interval / 60_000)}m, take-profit +${cfg.takeProfitBps / 100}%` +
        `${cfg.stopLossBps > 0 ? `, stop-loss -${cfg.stopLossBps / 100}%` : ", stop-loss off"}`,
    );
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  onEvent(fn: (event: TraderEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  config(): TraderConfig {
    const get = (k: string) => this.runtime?.getSetting(k);
    return {
      takeProfitBps: intSetting(get("LAINOS_TRADER_TAKE_PROFIT_BPS"), 2_500, 100, 100_000),
      stopLossBps: intSetting(get("LAINOS_TRADER_STOP_LOSS_BPS"), 0, 0, 10_000),
      maxImpactBps: intSetting(get("LAINOS_TRADER_MAX_IMPACT_BPS"), 300, 10, 10_000),
      slippageBps: intSetting(get("LAINOS_TRADER_SLIPPAGE_BPS"), 100, 0, 5_000),
      minProceedsWei: nativeSetting(get("LAINOS_TRADER_MIN_PROCEEDS_NATIVE"), "0.005"),
    };
  }

  private async safeTick(): Promise<void> {
    if (this.ticking) return;
    const chain = this.runtime?.getService<ChainService>("chain");
    if (!this.realEnabled && !chain?.paperMode) return;
    this.ticking = true;
    try {
      await this.tick();
    } catch (err) {
      log.warn("trader tick failed", err);
    } finally {
      this.ticking = false;
    }
  }

  /** One pass over journaled positions. Exposed for tests/manual runs. */
  async tick(): Promise<string[]> {
    const runtime = this.runtime;
    if (!runtime) return [];
    const chain = runtime.getService<ChainService>("chain");
    if (!chain?.canTrade) return [];
    this.lastTickAt = Date.now();

    const cfg = this.config();
    const actions: string[] = [];
    // In paper mode every paper wallet Lain trades is managed here — and never one
    // that is the operator's alone. For real, the one wallet and its journal.
    const books = chain.paperMode ? await chain.lainPaperBooks() : [{ wallet: undefined, book: undefined }];
    const held = books.flatMap(({ wallet, book }) =>
      (book?.journal ?? chain.tradeJournal).positions().map((pos) => ({ pos, wallet, book })),
    );
    for (const { pos, wallet, book } of held) {
      if (!isAddress(pos.token)) continue;
      // A position another venue manages (a PONS curve) has its own exits.
      if (chain.venueFor(pos.token)) continue;
      const token = pos.token as Address;
      try {
        const { raw, decimals, symbol } = await chain.tradingHolding(token, book);
        const posQty = BigInt(pos.qtyWei);
        let sellable = raw < posQty ? raw : posQty;
        if (sellable <= 0n) continue;

        let quote = await chain.quoteNativeSell(token, sellable);
        const basis = (BigInt(pos.costWei) * sellable) / posQty;
        if (basis <= 0n) continue;
        const gainBps = Number(((quote.amountOut - basis) * 10_000n) / basis);

        let motive: "take-profit" | "stop-loss" | null = null;
        if (gainBps >= cfg.takeProfitBps) motive = "take-profit";
        else if (cfg.stopLossBps > 0 && gainBps <= -cfg.stopLossBps) motive = "stop-loss";
        if (!motive) continue;

        // Partial exit when the full size would move the pool too hard.
        let halvings = 0;
        while (quote.priceImpactBps > cfg.maxImpactBps && halvings < 4) {
          sellable /= 2n;
          if (sellable <= 0n) break;
          quote = await chain.quoteNativeSell(token, sellable);
          halvings += 1;
        }
        if (sellable <= 0n || quote.priceImpactBps > cfg.maxImpactBps) {
          log.info(`${symbol}: ${motive} signal but pool too thin to exit cleanly — skipping`);
          continue;
        }
        if (quote.amountOut < cfg.minProceedsWei) continue;

        const minOut = (quote.amountOut * BigInt(10_000 - cfg.slippageBps)) / 10_000n;
        const fill = await chain.executeSell(quote, minOut, 300, `auto ${motive}`, book);
        if (fill.status !== "success") {
          this.emit({ kind: "error", text: `⚠ trader: ${motive} sell of ${symbol} reverted (${fill.hash})` });
          continue;
        }
        const realized = formatEther(fill.realizedWei ?? 0n);
        const line =
          `${motive === "take-profit" ? "📈" : "📉"} auto ${motive}${fill.paper ? ` (paper, wallet ${wallet ?? chain.paper.current("lain")})` : ""}: sold ` +
          `${formatUnits(sellable, decimals)} ${symbol} → ${formatEther(quote.amountOut)} ${chain.nativeSymbol} ` +
          `(${gainBps >= 0 ? "+" : ""}${gainBps / 100}% vs basis, realised ${Number(realized) >= 0 ? "+" : ""}${realized} ${chain.nativeSymbol}). ` +
          (fill.paper ? "nothing sent" : `tx ${fill.hash}`);
        actions.push(line);
        this.emit({ kind: "trade", text: line });
        log.info(line);
      } catch (err) {
        log.warn(`trader: position ${pos.symbol} evaluation failed`, err);
      }
    }
    return actions;
  }

  private emit(event: TraderEvent): void {
    for (const fn of this.subscribers) {
      try {
        fn(event);
      } catch {
        /* a broken subscriber must never break the trader */
      }
    }
  }

  get lastTick(): number {
    return this.lastTickAt;
  }
}

function intSetting(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

function nativeSetting(raw: string | undefined, fallback: string): bigint {
  const value = raw === undefined || raw === "" ? fallback : raw;
  try {
    const wei = BigInt(Math.round(Number(value) * 1e9)) * 10n ** 9n;
    return wei > 0n ? wei : 0n;
  } catch {
    return 0n;
  }
}

function getTrader(runtime: IAgentRuntime): TraderService {
  const svc = runtime.getService<TraderService>("trader");
  if (!svc) throw new Error("trader service not started");
  return svc;
}

// ------------------------------------------------------------------ actions

const traderStatusAction: Action = {
  name: "trader_status",
  similes: ["trading_status", "auto_trader", "how_is_trading"],
  description:
    "Report the autonomous trader loop: whether it runs, its thresholds (take-profit, stop-loss, impact cap), journaled positions, and the most recent trades.",
  parameters: { type: "object", properties: {} },
  examples: [{ user: "how's your auto-trader doing?", agent: "Checking the journal and settings…" }],
  async validate(runtime) {
    return Boolean(runtime.getService("trader"));
  },
  async handler(runtime) {
    const svc = getTrader(runtime);
    const chain = runtime.getService<ChainService>("chain");
    const cfg = svc.config();
    const lines = [
      `take-profit +${cfg.takeProfitBps / 100}%, ` +
        `${cfg.stopLossBps > 0 ? `stop-loss -${cfg.stopLossBps / 100}%` : "stop-loss off"}, ` +
        `impact cap ${cfg.maxImpactBps / 100}%, last tick ${svc.lastTick ? new Date(svc.lastTick).toISOString() : "never"}`,
    ];
    if (chain) {
      if (chain.paperMode) {
        lines.push(
          `📝 paper mode: the positions and trades below are paper wallet ${chain.paper.current("lain")}'s; ` +
            `the loop manages every wallet Lain trades (${chain.paper.wallets().filter((w) => w.lain).map((w) => w.name).join(", ")}).`,
        );
      }
      const positions = chain.tradeJournal.positions();
      lines.push(
        positions.length
          ? `open positions: ${positions.map((p) => p.symbol).join(", ")}`
          : "no journaled positions.",
      );
      const trades = chain.tradeJournal.recentTrades(5);
      for (const t of trades) {
        lines.push(
          `· ${new Date(t.ts).toISOString().slice(0, 16)} ${t.side} ${t.symbol}` +
            `${t.realizedWei ? ` (realised ${formatEther(BigInt(t.realizedWei))} ${chain.nativeSymbol})` : ""}`,
        );
      }
    }
    return { ok: true, text: lines.join("\n") };
  },
};

// ------------------------------------------------------------------ provider

const traderProvider: Provider = {
  name: "trader",
  async get(runtime) {
    const chain = runtime.getService<ChainService>("chain");
    if (!chain) return "";
    const positions = chain.tradeJournal.positions();
    const last = chain.tradeJournal.recentTrades(1)[0];
    const svc = runtime.getService<TraderService>("trader");
    const cfg = svc?.config();
    return (
      (chain.paperMode ? `PAPER MODE: these are your positions in paper wallet ${chain.paper.current("lain")}; every trade is simulated. ` : "") +
      `You trade to grow your treasury. Journaled positions: ` +
      (positions.length ? positions.map((p) => p.symbol).join(", ") : "none") +
      (last
        ? `. Last trade: ${last.side} ${last.symbol}${last.realizedWei ? ` (realised ${formatEther(BigInt(last.realizedWei))} ${chain.nativeSymbol})` : ""}.`
        : ". No trades yet.") +
      (cfg ? ` Auto take-profit at +${cfg.takeProfitBps / 100}% runs in the background.` : "") +
      ` Use portfolio_pnl for live values and sell_token to exit.`
    );
  },
};

export const traderPlugin: Plugin = {
  name: "trader",
  description:
    "Autonomous profit-taking: a background loop that sells journaled positions when they clear the take-profit threshold, within pool-impact limits.",
  services: [new TraderService()],
  providers: [traderProvider],
  actions: [traderStatusAction],
};
