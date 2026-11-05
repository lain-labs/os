import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { formatEther, formatUnits, parseEther, type Address } from "viem";
import { createLogger } from "../../logger.js";
import type { ChainService } from "../chain/index.js";
import { PAIR_ABI } from "../chain/abi.js";
import { executeCycle, findCycles, fmtNative, loadPools, simulateCycle, type Cycle } from "./arb.js";
import type { Action, IAgentRuntime, Service } from "../../types.js";

const log = createLogger("plugin:swing");

/**
 * The swing desk is the buying half of the trader: once an hour (give or take
 * a random quarter hour) Lain looks at every registry token's DEX pool, picks
 * a trade with a dice roll weighted by momentum, sizes it with another roll
 * inside hard risk limits, and posts a short "what looks good to buy / sell"
 * note to a Telegram chat.
 *
 * Prices are sampled from the pools every SAMPLE_MS between runs, so the
 * momentum it trades on is its own on-chain history, not a third-party feed.
 *
 * Risk limits (all settings, see config()):
 *   - never trades the native balance below a floor;
 *   - one buy is at most a few percent of the balance and a hard cap;
 *   - a daily buy budget, a cap on open positions, a price-impact cap;
 *   - a stop-loss and a momentum exit on every position it opened, and buys
 *     pause for a day after a bad day of realised losses.
 *
 * Momentum only counts what the market did: price history from before the
 * desk's own last swap in a pool is dropped (its arbitrage and buys move thin
 * pools, and buying that move back is chasing itself), stablecoins are never
 * bought on momentum, and a position is never added to.
 *
 * Only positions the desk opened itself are ever sold by it. Real trading is
 * daemon-only (or LAINOS_SWING=1), like the take-profit loop.
 */

const HOUR = 3_600_000;
const SAMPLE_MS = 15 * 60_000;
const HISTORY_MS = 48 * HOUR;

export interface SwingEvent {
  kind: "report" | "error";
  text: string;
  chatId?: number;
}

interface Sample {
  t: number;
  /** Price in native per whole token. */
  p: number;
  /** Native side of the pool, whole units. */
  liq: number;
}

interface SwingState {
  samples: Record<string, Sample[]>;
  /** Tokens (lowercase address) whose positions this desk opened. */
  owned: Record<string, { symbol: string; openedAt: number }>;
  buys: { t: number; nativeWei: string }[];
  realized: { t: number; wei: string }[];
  /** Arbitrage cycles sent, with what they made. */
  arbs?: { t: number; label: string; inWei: string; profitWei: string; tx: string }[];
  /** When the desk's own swaps last moved a token's pool: price history before that is not the market's. */
  touched?: Record<string, number>;
  pausedUntil?: number;
  lastRunAt?: number;
  lastReport?: string;
}

interface SwingConfig {
  floorWei: bigint;
  maxTradeWei: bigint;
  maxTradePct: number;
  dailyWei: bigint;
  maxPositions: number;
  maxImpactBps: number;
  slippageBps: number;
  minLiq: number;
  stopLossBps: number;
  partialTakeBps: number;
  skipChance: number;
  dailyLossWei: bigint;
  maxArbWei: bigint;
  minArbProfitWei: bigint;
  dry: boolean;
  chatId?: number;
  /** Symbols never bought on momentum (stablecoins: their "trend" in a thin pool is noise). */
  skip: RegExp;
  holdHours: number;
  startWei?: bigint;
}

export interface Signal {
  token: Address;
  symbol: string;
  price: number;
  liq: number;
  r1: number;
  r6: number;
  r24?: number;
  /** Hours of history the returns are measured over (≤ 6). */
  span: number;
}

export class SwingService implements Service {
  readonly name = "swing";

  private runtime?: IAgentRuntime;
  private sampler: ReturnType<typeof setInterval> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private state: SwingState = { samples: {}, owned: {}, buys: [], realized: [] };
  private path = "";
  private busy = false;
  private nextRunAt = 0;
  private subscribers = new Set<(event: SwingEvent) => void>();

  async start(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
    const forced = runtime.getSetting("LAINOS_SWING");
    const enabled = forced !== undefined && forced !== "" ? forced !== "0" : runtime.getSetting("LAINOS_DAEMON") === "1";
    this.path = join(runtime.getSetting("LAINOS_DATA_DIR") ?? "./data", "swing.json");
    await this.load();
    if (!enabled) return;
    this.sampler = setInterval(() => void this.sample().catch((err) => log.warn("sample failed", err)), SAMPLE_MS);
    this.sampler.unref?.();
    void this.backfill()
      .then(() => this.sample())
      .catch((err) => log.warn("backfill failed", err));
    this.schedule();
    const cfg = this.config();
    log.info(
      `swing desk online${cfg.dry ? " (dry run: reports only)" : ""}: ~hourly, floor ${formatEther(cfg.floorWei)}, ` +
        `≤${formatEther(cfg.maxTradeWei)} or ${cfg.maxTradePct}% per buy, ${formatEther(cfg.dailyWei)}/day, ` +
        `≤${cfg.maxPositions} positions, stop -${cfg.stopLossBps / 100}%`,
    );
  }

  async stop(): Promise<void> {
    if (this.sampler) clearInterval(this.sampler);
    if (this.timer) clearTimeout(this.timer);
    this.sampler = null;
    this.timer = null;
  }

  onEvent(fn: (event: SwingEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  config(): SwingConfig {
    const get = (k: string) => this.runtime?.getSetting(k);
    const chat = Number(get("LAINOS_SWING_CHAT_ID"));
    return {
      floorWei: native(get("LAINOS_SWING_FLOOR_NATIVE"), "30"),
      maxTradeWei: native(get("LAINOS_SWING_MAX_TRADE_NATIVE"), "5"),
      maxTradePct: num(get("LAINOS_SWING_MAX_TRADE_PCT"), 5, 0.5, 50),
      dailyWei: native(get("LAINOS_SWING_DAILY_NATIVE"), "20"),
      maxPositions: num(get("LAINOS_SWING_MAX_POSITIONS"), 4, 1, 20),
      maxImpactBps: num(get("LAINOS_SWING_MAX_IMPACT_BPS"), 150, 10, 2_000),
      slippageBps: num(get("LAINOS_SWING_SLIPPAGE_BPS"), 150, 10, 2_000),
      minLiq: num(get("LAINOS_SWING_MIN_LIQUIDITY_NATIVE"), 100, 0, 1e12),
      stopLossBps: num(get("LAINOS_SWING_STOP_LOSS_BPS"), 800, 100, 9_000),
      partialTakeBps: num(get("LAINOS_SWING_PARTIAL_TAKE_BPS"), 1_200, 100, 50_000),
      skipChance: num(get("LAINOS_SWING_SKIP_CHANCE"), 0.25, 0, 1),
      dailyLossWei: native(get("LAINOS_SWING_DAILY_LOSS_NATIVE"), "10"),
      maxArbWei: native(get("LAINOS_SWING_MAX_ARB_NATIVE"), "15"),
      minArbProfitWei: native(get("LAINOS_SWING_MIN_ARB_PROFIT_NATIVE"), "0.03"),
      dry: get("LAINOS_SWING_DRY") === "1",
      chatId: Number.isFinite(chat) && chat !== 0 ? chat : undefined,
      skip: new RegExp(get("LAINOS_SWING_SKIP_PATTERN") || "USD|RUB|EUR|DAI", "i"),
      holdHours: num(get("LAINOS_SWING_MAX_HOLD_HOURS"), 24, 1, 24 * 30),
      startWei: get("LAINOS_SWING_START_NATIVE") ? native(get("LAINOS_SWING_START_NATIVE"), "0") : undefined,
    };
  }

  /** Next run 45–75 minutes out: hourly, but never on the same minute. */
  private schedule(): void {
    const delay = HOUR - 15 * 60_000 + Math.floor(Math.random() * 30 * 60_000);
    this.nextRunAt = Date.now() + delay;
    this.timer = setTimeout(() => {
      void this.run()
        .catch((err) => {
          log.warn("swing run failed", err);
          this.emit({ kind: "error", text: `⚠ swing desk: ${err instanceof Error ? err.message : String(err)}` });
        })
        .finally(() => this.schedule());
    }, delay);
    this.timer.unref?.();
  }

  private chain(): ChainService | undefined {
    return this.runtime?.getService<ChainService>("chain");
  }

  /** Record one price sample per registry token that has a native pool. */
  async sample(): Promise<void> {
    const chain = this.chain();
    if (!chain) return;
    const now = Date.now();
    const probe = parseEther("0.001");
    const entries = Object.entries(chain.tokens);
    for (const [symbol, token] of entries) {
      try {
        const q = await chain.quoteNativeBuy(token, probe);
        const reserveNative = Number(formatEther(q.reserveNative));
        const reserveToken = Number(formatUnits(q.reserveToken, q.decimals));
        if (!(reserveNative > 0 && reserveToken > 0)) continue;
        const key = token.toLowerCase();
        const list = (this.state.samples[key] ??= []);
        list.push({ t: now, p: reserveNative / reserveToken, liq: reserveNative });
        while (list.length && list[0]!.t < now - HISTORY_MS) list.shift();
      } catch {
        // No native pair, or the pool is unreadable right now.
        void symbol;
      }
    }
    await this.save();
  }

  /**
   * Fill a thin history from the pools' past reserves (the RPC serves archive
   * state), so the first note after a start already has 1h/6h/24h momentum.
   */
  async backfill(): Promise<void> {
    const chain = this.chain();
    if (!chain) return;
    const client = chain.publicClient;
    const head = await client.getBlock();
    const now = Number(head.timestamp) * 1000;
    // Seconds per block from the last ~day of blocks.
    const probe = head.number > 86_400n ? head.number - 86_400n : 0n;
    const then = await client.getBlock({ blockNumber: probe });
    const secPerBlock = Math.max(0.1, (Number(head.timestamp - then.timestamp)) / Number(head.number - probe || 1n));
    const ages = [24, 12, 6, 4, 3, 2, 1].map((h) => h * HOUR);
    for (const token of Object.values(chain.tokens)) {
      const key = token.toLowerCase();
      const list = this.state.samples[key] ?? [];
      if (list.length && list[0]!.t <= Date.now() - 6 * HOUR) continue;
      try {
        const q = await chain.quoteNativeBuy(token, parseEther("0.001"));
        const token0 = (await client.readContract({ address: q.pair, abi: PAIR_ABI, functionName: "token0" })) as Address;
        const nativeIs0 = token0.toLowerCase() === chain.dex.wrappedNative.toLowerCase();
        const past: Sample[] = [];
        for (const age of ages) {
          const blockNumber = head.number - BigInt(Math.round(age / 1000 / secPerBlock));
          if (blockNumber <= 0n) continue;
          try {
            const [r0, r1] = (await client.readContract({ address: q.pair, abi: PAIR_ABI, functionName: "getReserves", blockNumber })) as readonly [bigint, bigint, number];
            const rn = Number(formatEther(nativeIs0 ? r0 : r1));
            const rt = Number(formatUnits(nativeIs0 ? r1 : r0, q.decimals));
            if (rn > 0 && rt > 0) past.push({ t: now - age, p: rn / rt, liq: rn });
          } catch {
            // The pool did not exist yet at that block.
          }
        }
        const oldest = list[0]?.t ?? Infinity;
        this.state.samples[key] = [...past.filter((x) => x.t < oldest), ...list];
      } catch {
        // No native pair.
      }
    }
    await this.save();
  }

  /** Momentum per token from its own samples. */
  signals(): Signal[] {
    const chain = this.chain();
    if (!chain) return [];
    const out: Signal[] = [];
    for (const [symbol, token] of Object.entries(chain.tokens)) {
      const since = this.state.touched?.[token.toLowerCase()] ?? 0;
      const list = this.state.samples[token.toLowerCase()]?.filter((x) => x.t > since);
      if (!list || list.length < 2) continue;
      const last = list[list.length - 1]!;
      const at = (ago: number) => {
        const target = last.t - ago;
        let best: Sample | undefined;
        for (const s of list) if (s.t <= target + 5 * 60_000) best = s;
        return best;
      };
      const first = list[0]!;
      const h1 = at(HOUR) ?? first;
      const h6 = at(6 * HOUR) ?? first;
      const h24 = at(24 * HOUR);
      const span = (last.t - h6.t) / HOUR;
      if (span < 2) continue;
      out.push({
        token,
        symbol,
        price: last.p,
        liq: last.liq,
        r1: pct(h1.p, last.p),
        r6: pct(h6.p, last.p),
        r24: h24 && last.t - h24.t >= 20 * HOUR ? pct(h24.p, last.p) : undefined,
        span,
      });
    }
    return out;
  }

  /** One hourly pass: exits first, then maybe one buy, then the note. */
  async run(): Promise<string> {
    if (this.busy) return "already running";
    const chain = this.chain();
    if (!chain) return "no chain";
    this.busy = true;
    try {
      await this.sample();
      const cfg = this.config();
      const now = Date.now();
      this.state.buys = this.state.buys.filter((b) => b.t > now - 24 * HOUR);
      this.state.realized = this.state.realized.filter((r) => r.t > now - 24 * HOUR);
      const sigs = this.signals();
      const bySym = new Map(sigs.map((s) => [s.token.toLowerCase(), s]));
      const did: string[] = [];
      const trading = chain.canTrade && !chain.paperMode && !cfg.dry;

      // Exits on positions this desk opened.
      const positions = new Map(chain.tradeJournal.positions().map((p) => [p.token.toLowerCase(), p]));
      for (const [key, own] of Object.entries(this.state.owned)) {
        const pos = positions.get(key);
        if (!pos || BigInt(pos.qtyWei) <= 0n) {
          delete this.state.owned[key];
          continue;
        }
        if (!trading) continue;
        try {
          const token = pos.token as Address;
          const { raw } = await chain.tradingHolding(token);
          const posQty = BigInt(pos.qtyWei);
          const held = raw < posQty ? raw : posQty;
          if (held <= 0n) continue;
          const full = await chain.quoteNativeSell(token, held);
          const basis = (BigInt(pos.costWei) * held) / posQty;
          if (basis <= 0n) continue;
          const gainBps = Number(((full.amountOut - basis) * 10_000n) / basis);
          const sig = bySym.get(key);
          let share = 0;
          let why = "";
          const ageH = (now - own.openedAt) / HOUR;
          if (gainBps <= -cfg.stopLossBps) [share, why] = [1, `stop-loss ${gainBps / 100}%`];
          else if (cfg.skip.test(own.symbol) && gainBps > -500) [share, why] = [1, `not a momentum asset, closed at ${gainBps / 100}%`];
          else if (ageH >= cfg.holdHours && gainBps < 0) [share, why] = [1, `held ${Math.round(ageH)}h without profit (${gainBps / 100}%)`];
          else if (sig && sig.r6 <= -6 && gainBps < 0) [share, why] = [1, `momentum turned (${fmtPct(sig.r6)}/6h)`];
          else if (gainBps >= cfg.partialTakeBps && Math.random() < 0.5) {
            share = 0.3 + Math.random() * 0.3;
            why = `partial take-profit at +${gainBps / 100}%`;
          }
          if (!share) continue;
          let qty = share >= 1 ? held : (held * BigInt(Math.round(share * 1000))) / 1000n;
          let quote = await chain.quoteNativeSell(token, qty);
          for (let i = 0; i < 4 && quote.priceImpactBps > cfg.maxImpactBps * 2; i += 1) {
            qty /= 2n;
            quote = await chain.quoteNativeSell(token, qty);
          }
          if (qty <= 0n) continue;
          const minOut = (quote.amountOut * BigInt(10_000 - cfg.slippageBps)) / 10_000n;
          const fill = await chain.executeSell(quote, minOut, 300, `swing: ${why}`);
          if (fill.status !== "success") {
            did.push(`sell ${own.symbol} reverted (${fill.hash})`);
            continue;
          }
          const realized = fill.realizedWei ?? 0n;
          this.state.realized.push({ t: now, wei: realized.toString() });
          this.touch(key, Date.now());
          did.push(
            `sold ${trim(formatUnits(qty, quote.decimals))} ${own.symbol} → ${trim(formatEther(quote.amountOut))} ${chain.nativeSymbol}, ${why}, ` +
              `realised ${realized >= 0n ? "+" : ""}${trim(formatEther(realized))}`,
          );
        } catch (err) {
          log.warn(`swing exit ${own.symbol} failed`, err);
        }
      }

      // Arbitrage: pools that drifted apart pay for closing the gap.
      const balance0 = trading ? await chain.tradingBalance() : 0n;
      const arbRoom = trading ? balance0 - cfg.floorWei : cfg.maxArbWei;
      const arbCap = arbRoom < cfg.maxArbWei ? arbRoom : cfg.maxArbWei;
      let leftover: Cycle[] = [];
      if (arbCap > parseEther("0.05")) {
        try {
          for (let round = 0; round < 3; round += 1) {
            const cycles = await findCycles(chain, await loadPools(chain), arbCap, cfg.minArbProfitWei);
            leftover = cycles;
            if (!cycles.length || !trading) break;
            // Dice: one of the best three, weighted by profit, at 60–100% of its best size.
            const pick = pickCycle(cycles.slice(0, 3));
            const amountIn = (pick.amountIn * BigInt(Math.round((0.6 + Math.random() * 0.4) * 1000))) / 1000n;
            const routerOut = await simulateCycle(chain, pick, amountIn);
            if (routerOut === null || routerOut <= amountIn + cfg.minArbProfitWei / 2n) {
              did.push(`arb ${pick.label} refused by the router simulation`);
              break;
            }
            const minOut = amountIn + (routerOut - amountIn) / 2n;
            const fill = await executeCycle(chain, pick, amountIn, minOut);
            const profit = fill.received - amountIn;
            for (const t of pick.path.slice(1, 3)) this.touch(t.toLowerCase(), Date.now());
            (this.state.arbs ??= []).push({ t: now, label: pick.label, inWei: amountIn.toString(), profitWei: profit.toString(), tx: fill.hash });
            this.state.arbs = this.state.arbs.slice(-200);
            this.state.realized.push({ t: now, wei: profit.toString() });
            did.push(`arb ${pick.label}: ${fmtNative(amountIn)} → ${fmtNative(fill.received)} ${chain.nativeSymbol} (${profit >= 0n ? "+" : ""}${fmtNative(profit)})${fill.explorer ? ` ${fill.explorer}` : ""}`);
            if (Math.random() < 0.3) break;
          }
        } catch (err) {
          did.push(`arb failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
        }
      }

      // Maybe one buy.
      const ideas = buyIdeas(sigs, cfg.minLiq).filter((x) => !cfg.skip.test(x.symbol) && !this.state.owned[x.token.toLowerCase()]);
      const balance = trading ? await chain.tradingBalance() : 0n;
      const spent = this.state.buys.reduce((a, b) => a + BigInt(b.nativeWei), 0n);
      const lost = this.state.realized.reduce((a, r) => a + BigInt(r.wei), 0n);
      if (lost <= -cfg.dailyLossWei && !(this.state.pausedUntil && this.state.pausedUntil > now)) {
        this.state.pausedUntil = now + 24 * HOUR;
        did.push(`buys paused for 24h: realised ${trim(formatEther(lost))} ${chain.nativeSymbol} today`);
      }
      let skipped = "";
      if (!trading) skipped = cfg.dry ? "dry run" : "no signer";
      else if (this.state.pausedUntil && this.state.pausedUntil > now) skipped = "buys paused after a losing day";
      else if (!ideas.length) skipped = "nothing worth buying";
      else if (Object.keys(this.state.owned).length >= cfg.maxPositions) skipped = `already ${cfg.maxPositions} positions`;
      else if (Math.random() < cfg.skipChance) skipped = "sat this hour out (dice)";
      if (!skipped) {
        const room = balance - cfg.floorWei;
        let cap = (balance * BigInt(Math.round(cfg.maxTradePct * 100))) / 10_000n;
        if (cap > cfg.maxTradeWei) cap = cfg.maxTradeWei;
        if (cap > room) cap = room;
        if (cap > cfg.dailyWei - spent) cap = cfg.dailyWei - spent;
        const size = (cap * BigInt(Math.round((0.4 + Math.random() * 0.6) * 1000))) / 1000n;
        if (size < parseEther("0.05")) skipped = room <= 0n ? `balance at the ${formatEther(cfg.floorWei)} floor` : "daily budget used";
        else {
          const pick = weightedPick(ideas.slice(0, 3));
          try {
            let amount = size;
            let quote = await chain.quoteNativeBuy(pick.token, amount);
            for (let i = 0; i < 4 && quote.priceImpactBps > cfg.maxImpactBps; i += 1) {
              amount /= 2n;
              quote = await chain.quoteNativeBuy(pick.token, amount);
            }
            if (quote.priceImpactBps > cfg.maxImpactBps || amount < parseEther("0.05")) skipped = `${pick.symbol} pool too thin`;
            else {
              const why = `${fmtPct(pick.r6)}/${pick.span >= 5.5 ? "6" : pick.span.toFixed(1)}h, ${fmtPct(pick.r1)}/1h`;
              const minOut = (quote.amountOut * BigInt(10_000 - cfg.slippageBps)) / 10_000n;
              const fill = await chain.executeBuy(quote, minOut, 300, `swing: momentum ${why}`);
              if (fill.status === "success") {
                this.state.buys.push({ t: now, nativeWei: amount.toString() });
                this.state.owned[pick.token.toLowerCase()] ??= { symbol: pick.symbol, openedAt: now };
                this.touch(pick.token.toLowerCase(), Date.now());
                did.push(`bought ${trim(formatEther(amount))} ${chain.nativeSymbol} of ${pick.symbol} (${why})${fill.explorer ? ` ${fill.explorer}` : ""}`);
              } else did.push(`buy ${pick.symbol} reverted (${fill.hash})`);
            }
          } catch (err) {
            skipped = `buy ${pick.symbol} failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
          }
        }
      }

      const after = trading ? await chain.tradingBalance() : balance;
      const held = trading ? await this.positionsValue() : 0n;
      const text = this.report(sigs, ideas, did, skipped, after, held, trading, leftover);
      this.state.lastRunAt = now;
      this.state.lastReport = text;
      await this.save();
      this.emit({ kind: "report", text, chatId: cfg.chatId });
      return text;
    } finally {
      this.busy = false;
    }
  }

  private touch(token: string, t: number): void {
    (this.state.touched ??= {})[token] = t;
  }

  /** What the desk's open positions would sell for now. */
  private async positionsValue(): Promise<bigint> {
    const chain = this.chain();
    if (!chain) return 0n;
    let total = 0n;
    for (const key of Object.keys(this.state.owned)) {
      try {
        const { raw } = await chain.tradingHolding(key as Address);
        if (raw > 0n) total += (await chain.quoteNativeSell(key as Address, raw)).amountOut;
      } catch {
        // An unquotable position counts as nothing.
      }
    }
    return total;
  }

  private report(sigs: Signal[], ideas: Signal[], did: string[], skipped: string, balance: bigint, held: bigint, trading: boolean, cycles: Cycle[]): string {
    const chain = this.chain()!;
    const sym = chain.nativeSymbol;
    const owned = Object.values(this.state.owned).map((o) => o.symbol);
    const sells = sellIdeas(sigs, this.config().minLiq, new Set(Object.keys(this.state.owned)));
    const line = (s: Signal) =>
      `${s.symbol} ${fmtPct(s.r6)}/${s.span >= 5.5 ? "6" : s.span.toFixed(1)}h, ${fmtPct(s.r1)}/1h${s.r24 !== undefined ? `, ${fmtPct(s.r24)}/24h` : ""} · pool ${Math.round(s.liq)} ${sym}`;
    const out = [`🎲 Lain · hourly desk on ${this.runtime?.getSetting("CHAIN_NAME") || "chain"}`];
    if (trading) {
      const equity = balance + held;
      const start = this.config().startWei;
      const since = start ? ` · ${equity >= start ? "+" : ""}${trim(formatEther(equity - start))} ${sym} since the ${trim(formatEther(start))} start` : "";
      out.push(`Equity ${trim(formatEther(equity))} ${sym} (cash ${trim(formatEther(balance))} + positions ${trim(formatEther(held))})${since}`);
      out.push(`Desk positions: ${owned.length ? owned.join(", ") : "none"}`);
    }
    out.push(did.length ? `Did: ${did.join("; ")}` : `Did: nothing${skipped ? ` (${skipped})` : ""}`);
    if (did.length && skipped) out.push(`No buy: ${skipped}`);
    out.push(ideas.length ? `Looks good to buy:\n${ideas.slice(0, 3).map((s) => `• ${line(s)}`).join("\n")}` : "Looks good to buy: nothing with clean upward momentum yet");
    out.push(sells.length ? `Looks good to sell:\n${sells.slice(0, 3).map((s) => `• ${line(s)}`).join("\n")}` : "Looks good to sell: nothing breaking down");
    if (cycles.length) {
      out.push(
        `Pools out of line (buy in the first, sell in the next):\n` +
          cycles.slice(0, 3).map((c) => `• ${c.label}: ${fmtNative(c.amountIn)} → ${fmtNative(c.amountOut)} ${sym}`).join("\n"),
      );
    }
    const day = (this.state.arbs ?? []).filter((a) => a.t > Date.now() - 24 * HOUR);
    if (day.length) out.push(`Arbitrage, 24h: ${day.length} cycles, ${fmtNative(day.reduce((a, x) => a + BigInt(x.profitWei), 0n))} ${sym} made`);
    out.push(`Momentum from the DEX pools over ${sigs.length ? Math.max(...sigs.map((s) => s.span)).toFixed(1) : "0"}h of samples. Not advice.`);
    return out.join("\n");
  }

  status(): string {
    const cfg = this.config();
    const owned = Object.values(this.state.owned).map((o) => o.symbol);
    return [
      `swing desk: ${this.sampler ? "on" : "off"}${cfg.dry ? " (dry run)" : ""}, next run ${this.nextRunAt ? new Date(this.nextRunAt).toISOString().slice(11, 16) + " UTC" : "—"}`,
      `limits: floor ${formatEther(cfg.floorWei)}, ≤${formatEther(cfg.maxTradeWei)} or ${cfg.maxTradePct}% per buy, ${formatEther(cfg.dailyWei)}/day, ≤${cfg.maxPositions} positions, stop -${cfg.stopLossBps / 100}%`,
      `positions it opened: ${owned.length ? owned.join(", ") : "none"}`,
      this.state.lastReport ? `last note:\n${this.state.lastReport}` : "no run yet",
    ].join("\n");
  }

  private emit(event: SwingEvent): void {
    for (const fn of this.subscribers) {
      try {
        fn(event);
      } catch {
        /* a broken subscriber must never break the desk */
      }
    }
  }

  private async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8")) as Partial<SwingState>;
      this.state = { samples: raw.samples ?? {}, owned: raw.owned ?? {}, buys: raw.buys ?? [], realized: raw.realized ?? [], ...raw } as SwingState;
    } catch {
      /* first start */
    }
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state));
    await rename(tmp, this.path);
  }
}

/** Upward momentum that is not a spike in progress, in pools deep enough to exit. */
export function buyIdeas(sigs: Signal[], minLiq: number): Signal[] {
  return sigs
    .filter((s) => s.liq >= minLiq && s.r6 >= 3 && s.r1 > -2 && s.r1 < 10 && (s.r24 === undefined || s.r24 < 60))
    .sort((a, b) => score(b) - score(a));
}

/** Momentum breaking down: held desk positions first, then the weakest liquid pools. */
export function sellIdeas(sigs: Signal[], minLiq: number, held: Set<string>): Signal[] {
  return sigs
    .filter((s) => s.liq >= minLiq && (s.r6 <= -4 || (s.r24 !== undefined && s.r24 >= 60 && s.r1 < 0)))
    .sort((a, b) => Number(held.has(b.token.toLowerCase())) - Number(held.has(a.token.toLowerCase())) || a.r6 - b.r6);
}

function score(s: Signal): number {
  return s.r6 + 0.5 * s.r1 - (s.r1 > 5 ? s.r1 - 5 : 0);
}

function pickCycle(cycles: Cycle[]): Cycle {
  const weights = cycles.map((c) => Number(formatEther(c.profit)));
  let roll = Math.random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < cycles.length; i += 1) {
    roll -= weights[i]!;
    if (roll <= 0) return cycles[i]!;
  }
  return cycles[0]!;
}

function weightedPick(ideas: Signal[]): Signal {
  const weights = ideas.map((s) => Math.max(0.1, score(s)));
  let roll = Math.random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < ideas.length; i += 1) {
    roll -= weights[i]!;
    if (roll <= 0) return ideas[i]!;
  }
  return ideas[0]!;
}

function pct(from: number, to: number): number {
  return from > 0 ? ((to - from) / from) * 100 : 0;
}

function fmtPct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function trim(s: string): string {
  const n = Number(s);
  return Number.isFinite(n) ? String(Math.round(n * 1e4) / 1e4) : s;
}

function num(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = raw === undefined || raw === "" ? fallback : Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

function native(raw: string | undefined, fallback: string): bigint {
  try {
    return parseEther(raw === undefined || raw === "" ? fallback : raw);
  } catch {
    return parseEther(fallback);
  }
}

export const swingStatusAction: Action = {
  name: "swing_status",
  similes: ["hourly_desk", "swing_desk", "what_to_buy_now"],
  description:
    "Report Lain's hourly swing desk on the chain: its risk limits, the positions it opened, when it runs next, and its last buy/sell note.",
  parameters: { type: "object", properties: {} },
  examples: [{ user: "what does your hourly desk say?", agent: "Reading the swing desk…" }],
  async validate(runtime) {
    return Boolean(runtime.getService("swing"));
  },
  async handler(runtime) {
    const svc = runtime.getService<SwingService>("swing");
    return { ok: true, text: svc ? svc.status() : "swing desk not started" };
  },
};
