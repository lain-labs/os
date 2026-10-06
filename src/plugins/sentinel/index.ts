import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isAddress, type Address } from "viem";
import { createLogger } from "../../logger.js";
import { TaskKind } from "../../models/tasks.js";
import {
  ModelTier,
  type Action,
  type IAgentRuntime,
  type Plugin,
  type Provider,
  type Service,
  type State,
} from "../../types.js";
import type { ChainService } from "../chain/index.js";
import { looksLikeNothing } from "../scout/index.js";
import {
  buysWithin,
  chainActivitySource,
  convergingWallets,
  scanWallet,
  type ActivitySource,
  type WalletMove,
} from "./activity.js";
import { briefMaterial, localDay, parseClock, type BriefSnapshot } from "./brief.js";
import { findNetwork, type NetworkProfile } from "../chain/networks.js";
import { rpcWalletSource, type TokenMeta, type WalletSource } from "../wallets/chainread.js";
import type { WalletEntry } from "../wallets/lists.js";
import { formatGroupAlert, scanGroup, type GroupState } from "../wallets/watch.js";
import { sendToOperator } from "../telegram/index.js";
import { currentProfile } from "../chain/networks.js";
import { readFile as readText } from "node:fs/promises";
import { parseUnits } from "viem";
import { mergeWalletLists, parseWalletList } from "../wallets/lists.js";
import { safePath } from "../system/index.js";

const log = createLogger("plugin:sentinel");

/**
 * The sentinel plugin is what makes Lain useful while nobody is talking to
 * her: a background service polls the configured chain on an interval and checks
 * user-defined *watches* (native or token balance below/above a threshold, or
 * any change). When a watch fires it produces an *alert*.
 *
 * Alerts reach the user through two channels:
 *   - push: clients (TUI, Telegram) subscribe via {@link SentinelService.onAlert}
 *     and deliver immediately;
 *   - pull: the `sentinel_alerts` provider injects any not-yet-delivered alerts
 *     into the next conversation turn, so Lain mentions them herself.
 *
 * Beyond balances, the sentinel watches what wallets *do* (see activity.ts):
 *   - `position` — one wallet; alert when it opens a new position, and when it
 *     keeps buying the same token (accumulation);
 *   - `cohort` — a group of wallets; alert when several of them buy into the
 *     same asset within a window.
 * And once a day, at the time the operator chose, it writes a *brief*: the
 * portfolio against yesterday, plus what the watched wallets did — filtered by
 * the model to what matters for the portfolio, or silence.
 *
 * Watches, alerts, scan cursors and recent moves persist to
 * `data/sentinel.json` and survive restarts.
 */

export type WatchKind = "below" | "above" | "change" | "position" | "cohort" | "wallets";

const ACTIVITY_KINDS: WatchKind[] = ["position", "cohort", "wallets"];
const DAY_MS = 86_400_000;
const MOVE_RETENTION_MS = 7 * DAY_MS;
const MOVE_CAP = 1_000;

export interface Watch {
  id: string;
  /** The watched wallet; for a cohort, its first member. */
  address: Address;
  /** Token symbol or 0x address; undefined = the chain's native currency. */
  token?: string;
  kind: WatchKind;
  /** Decimal threshold for below/above. */
  threshold?: number;
  note?: string;
  createdAt: number;
  /** Last observed balance (decimal string), set after the first tick. */
  lastValue?: string;
  /** True while the below/above condition currently holds (edge triggering). */
  firing?: boolean;
  /** cohort: every wallet in the group. */
  members?: Address[];
  /** cohort: how many members must buy the same token to alert. */
  minWallets?: number;
  /** position: buys of one token within the window that count as building. */
  minBuys?: number;
  /** position/cohort: the window the rule looks back over. */
  windowMs?: number;
  /** Rule key → when it last fired, so one episode alerts once. */
  fired?: Record<string, number>;
  /** wallets: a whole list followed for every change, on its own network. */
  group?: GroupWatch;
}

/** A `wallets` watch: every token and native move of every member. */
export interface GroupWatch {
  /** Network profile name — independent of the active chain. */
  network: string;
  members: WalletEntry[];
  /** Lowercase members that are contracts (pool, locker): shown, marked. */
  contracts: string[];
  events: { tokens: boolean; native: boolean };
  /** Native moves below this (wei, decimal string) are ignored. */
  minNative: string;
  /** Deliver each digest to the operator's Telegram directly. */
  telegram: boolean;
  state: GroupState;
  /** Last error, so list_watches can say why a watch is quiet. */
  lastError?: string;
}

export interface Alert {
  id: string;
  watchId: string;
  text: string;
  at: number;
  delivered: boolean;
  /** A morning brief rather than a watch firing. */
  kind?: "watch" | "brief";
  /** Telegram HTML version (explorer links), when the watch made one. */
  html?: string;
  /** Already delivered to the operator's Telegram by the sentinel itself. */
  telegramSent?: boolean;
}

export interface BriefSchedule {
  /** Local "HH:MM". */
  at: string;
  /** The operator's own words on what the brief is for. */
  note?: string;
  lastDay?: string;
  snapshot?: BriefSnapshot;
}

interface SentinelFile {
  watches: Watch[];
  alerts: Alert[];
  counter: number;
  /** Wallet (lowercase) → last scanned block. */
  cursors?: Record<string, string>;
  moves?: WalletMove[];
  brief?: BriefSchedule | null;
}

/** How an alert reads in a feed (Telegram, the TUI). */
export function alertLine(alert: Alert): string {
  return `${alert.kind === "brief" ? "☀" : "⚠"} ${alert.text}`;
}

/** Briefs that arrive more than this long after their time wait for tomorrow. */
const BRIEF_LATE_MS = 3 * 3_600_000;

const ALERT_CAP = 200;

export class SentinelService implements Service {
  readonly name = "sentinel";

  private watches: Watch[] = [];
  private alerts: Alert[] = [];
  private counter = 0;
  private file = "";
  private timer: ReturnType<typeof setInterval> | null = null;
  private runtime?: IAgentRuntime;
  private subscribers = new Set<(alert: Alert) => void>();
  private ticking = false;
  private cursors: Record<string, string> = {};
  private moves: WalletMove[] = [];
  private brief: BriefSchedule | null = null;
  private briefTimer: ReturnType<typeof setInterval> | null = null;
  private briefing = false;
  /** Tests inject a fake chain here; otherwise the chain service is used. */
  activitySource?: ActivitySource;
  /** Tests inject a fake reader for `wallets` watches; otherwise the network's RPC. */
  groupSource?: (profile: NetworkProfile) => WalletSource;
  /** Tests replace Telegram delivery; otherwise the operator chat via the bot. */
  deliverTelegram?: (html: string) => Promise<void>;
  /** Token metadata per chain, kept across ticks. */
  private tokenMeta = new Map<string, Map<string, TokenMeta>>();

  async start(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
    const dataDir = runtime.getSetting("LAINOS_DATA_DIR") ?? "./data";
    this.file = join(dataDir, "sentinel.json");
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as SentinelFile;
      this.watches = parsed.watches ?? [];
      this.alerts = parsed.alerts ?? [];
      this.counter = parsed.counter ?? this.watches.length;
      this.cursors = parsed.cursors ?? {};
      this.moves = parsed.moves ?? [];
      this.brief = parsed.brief ?? null;
    } catch {
      // Fresh store.
    }
    const seeded = runtime.getSetting("LAINOS_BRIEF_AT");
    if (!this.brief && seeded && parseClock(seeded)) this.brief = { at: seeded };

    const interval = Number(runtime.getSetting("LAINOS_SENTINEL_INTERVAL_MS") ?? 60_000);
    this.timer = setInterval(() => void this.tick(), Math.max(5_000, interval));
    this.timer.unref?.();
    log.info(
      `sentinel online: ${this.watches.length} watch(es), tick every ${Math.max(5_000, interval) / 1000}s`,
    );

    // The brief is delivered once per day per operator, so only the daemon
    // writes it — a TUI next to it would send a second one.
    const forced = runtime.getSetting("LAINOS_BRIEF");
    const briefs = forced !== undefined && forced !== "" ? forced !== "0" : runtime.getSetting("LAINOS_DAEMON") === "1";
    if (briefs) {
      this.briefTimer = setInterval(() => void this.briefTick(), 60_000);
      this.briefTimer.unref?.();
      if (this.brief) log.info(`morning brief at ${this.brief.at} local`);
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.briefTimer) clearInterval(this.briefTimer);
    this.timer = null;
    this.briefTimer = null;
  }

  /** Subscribe to alerts as they fire (returns an unsubscribe fn). */
  onAlert(fn: (alert: Alert) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  listWatches(): Watch[] {
    return [...this.watches];
  }

  /** Newest-last recent alerts (delivered or not). */
  recentAlerts(limit = 20): Alert[] {
    return this.alerts.slice(-limit);
  }

  /** Return undelivered alerts and mark them delivered (the pull channel). */
  takeUndelivered(): Alert[] {
    const fresh = this.alerts.filter((a) => !a.delivered);
    if (fresh.length) {
      for (const a of fresh) a.delivered = true;
      void this.persist();
    }
    return fresh;
  }

  /** Wallet moves seen within the last `withinMs`, oldest first. */
  recentMoves(withinMs = DAY_MS, now = Date.now()): WalletMove[] {
    return this.moves.filter((m) => now - m.at <= withinMs);
  }

  briefSchedule(): BriefSchedule | null {
    return this.brief ? { ...this.brief } : null;
  }

  /** Set (or with null, cancel) the daily brief. */
  async setBrief(input: { at: string; note?: string } | null): Promise<void> {
    this.brief = input ? { ...this.brief, at: input.at, note: input.note ?? this.brief?.note } : null;
    await this.persist();
  }

  async addWatch(input: {
    address: Address;
    token?: string;
    kind: WatchKind;
    threshold?: number;
    note?: string;
    members?: Address[];
    minWallets?: number;
    minBuys?: number;
    windowMs?: number;
    group?: GroupWatch;
  }): Promise<Watch> {
    this.counter += 1;
    const watch: Watch = {
      id: `w${this.counter}`,
      address: input.address,
      token: input.token,
      kind: input.kind,
      threshold: input.threshold,
      note: input.note,
      members: input.members,
      minWallets: input.minWallets,
      minBuys: input.minBuys,
      windowMs: input.windowMs,
      ...(input.group ? { group: input.group } : {}),
      createdAt: Date.now(),
    };
    this.watches.push(watch);
    await this.persist();
    return watch;
  }

  async removeWatch(id: string): Promise<boolean> {
    const before = this.watches.length;
    this.watches = this.watches.filter((w) => w.id !== id);
    if (this.watches.length !== before) {
      await this.persist();
      return true;
    }
    return false;
  }

  /** One poll cycle. Public so tests (and the smoke script) can force it. */
  async tick(now = Date.now()): Promise<void> {
    if (this.ticking || !this.watches.length) return;
    this.ticking = true;
    try {
      let dirty = false;
      // Group watches name their own network, so they run with or without
      // an active chain in this process.
      for (const watch of this.watches) {
        if (watch.kind !== "wallets" || !watch.group) continue;
        dirty = (await this.scanGroupWatch(watch)) || dirty;
      }
      const chain = this.runtime?.getService<ChainService>("chain");
      const source = this.activitySource ?? (chain?.configured ? chainActivitySource(chain) : undefined);
      if (chain?.configured) {
        for (const watch of this.watches) {
          if (ACTIVITY_KINDS.includes(watch.kind)) continue;
          try {
            dirty = (await this.checkWatch(chain, watch)) || dirty;
          } catch (err) {
            log.warn(`watch ${watch.id} check failed`, err);
          }
        }
      }
      if (source) dirty = (await this.scanActivity(source, now)) || dirty;
      if (dirty) await this.persist();
    } finally {
      this.ticking = false;
    }
  }

  /**
   * One tick of a `wallets` watch: read what moved since its cursor on its
   * own network and fire one digest. Returns "state changed".
   */
  private async scanGroupWatch(watch: Watch): Promise<boolean> {
    const group = watch.group!;
    const runtime = this.runtime;
    if (!runtime) return false;
    const profile = await findNetwork(runtime, group.network);
    if (!profile) {
      const err = `unknown network "${group.network}"`;
      if (group.lastError !== err) {
        group.lastError = err;
        return true;
      }
      return false;
    }
    const src = this.groupSource ? this.groupSource(profile) : rpcWalletSource(profile);
    const metaKey = String(profile.chainId);
    const meta = this.tokenMeta.get(metaKey) ?? new Map<string, TokenMeta>();
    this.tokenMeta.set(metaKey, meta);
    const maxSpan = BigInt(Math.max(100, Number(runtime.getSetting("LAINOS_GROUP_MAX_BLOCKS") ?? 20_000)));
    try {
      const scan = await scanGroup(
        src,
        group.members,
        group.state,
        {
          tokens: group.events.tokens,
          native: group.events.native,
          minNativeWei: BigInt(group.minNative || "0"),
          maxSpan,
          maxLag: maxSpan * 20n,
        },
        meta,
        new Set(group.contracts),
      );
      group.lastError = undefined;
      const report = formatGroupAlert(watch.note ?? `watch ${watch.id}`, profile, scan);
      if (report) await this.fireGroup(watch, report.text, report.html);
      return true;
    } catch (err) {
      const msg = (err as Error).message?.split("\n")[0] ?? String(err);
      log.warn(`wallets watch ${watch.id} scan failed: ${msg}`);
      const changed = group.lastError !== msg;
      group.lastError = msg;
      return changed;
    }
  }

  /** Fire a group digest; deliver it to Telegram first when the watch asks for it. */
  private async fireGroup(watch: Watch, text: string, html: string): Promise<void> {
    const alert: Alert = { id: randomUUID(), watchId: watch.id, text, html, at: Date.now(), delivered: false };
    if (watch.group?.telegram) {
      try {
        const runtime = this.runtime!;
        if (this.deliverTelegram) await this.deliverTelegram(html);
        else await sendToOperator((k) => runtime.getSetting(k), html, { html: true });
        alert.telegramSent = true;
      } catch (err) {
        log.warn(`watch ${watch.id}: telegram delivery failed — ${(err as Error).message}`);
      }
    }
    this.emit(alert);
  }

  /** Every wallet an activity watch covers, deduplicated. */
  private trackedWallets(): Address[] {
    const out = new Map<string, Address>();
    for (const w of this.watches) {
      if (w.kind === "position") out.set(w.address.toLowerCase(), w.address);
      if (w.kind === "cohort") for (const m of w.members ?? []) out.set(m.toLowerCase(), m);
    }
    return [...out.values()];
  }

  /**
   * Read new transfers for each tracked wallet and apply the activity rules.
   * A wallet seen for the first time starts at the chain head — a new watch
   * reports what happens from now on, not a replay of its history.
   */
  private async scanActivity(src: ActivitySource, now: number): Promise<boolean> {
    const wallets = this.trackedWallets();
    if (!wallets.length) return false;
    const head = await src.head();
    const maxSpan = BigInt(Math.max(1, Number(this.runtime?.getSetting("LAINOS_SENTINEL_MAX_BLOCKS") ?? 2_000)));
    let dirty = false;
    const fresh: WalletMove[] = [];

    for (const wallet of wallets) {
      const key = wallet.toLowerCase();
      const cursor = this.cursors[key];
      if (cursor === undefined) {
        this.cursors[key] = head.toString();
        dirty = true;
        continue;
      }
      let from = BigInt(cursor) + 1n;
      if (from > head) continue;
      if (head - from + 1n > maxSpan) {
        log.warn(`${key}: ${head - from + 1n} blocks behind, scanning only the last ${maxSpan}`);
        from = head - maxSpan + 1n;
      }
      try {
        const transfers = await src.transfers(wallet, from, head);
        fresh.push(...(await scanWallet(src, wallet, transfers, now)));
        this.cursors[key] = head.toString();
        dirty = true;
      } catch (err) {
        log.warn(`activity scan of ${key} failed`, err);
      }
    }

    if (fresh.length) {
      this.moves = [...this.moves, ...fresh]
        .filter((m) => now - m.at <= MOVE_RETENTION_MS)
        .slice(-MOVE_CAP);
      for (const move of fresh) this.applyActivityRules(move, now);
    }
    return dirty;
  }

  private applyActivityRules(move: WalletMove, now: number): void {
    if (move.side !== "buy") return;
    for (const watch of this.watches) {
      const windowMs = watch.windowMs ?? DAY_MS;
      if (watch.kind === "position" && sameWallet(watch.address, move.wallet)) {
        const who = this.labelFor(move.wallet);
        if (move.fresh) {
          this.fire(
            watch,
            `${who} opened a new position: ${move.amount} ${move.symbol} (${move.token}).${this.txSuffix(move.tx)}`,
          );
          continue;
        }
        const buys = buysWithin(this.moves, move.wallet, move.token, windowMs, now);
        const minBuys = watch.minBuys ?? 3;
        if (buys.length >= minBuys && this.once(watch, `build:${move.token.toLowerCase()}`, windowMs, now)) {
          this.fire(
            watch,
            `${who} keeps building ${move.symbol}: ${buys.length} buys in ${hours(windowMs)}, now holds ${move.balance}.${this.txSuffix(move.tx)}`,
          );
        }
      }
      if (watch.kind === "cohort" && watch.members?.some((m) => sameWallet(m, move.wallet))) {
        const members = watch.members;
        const buyers = convergingWallets(this.moves, members, move.token, windowMs, now);
        const min = watch.minWallets ?? Math.min(3, members.length);
        if (buyers.length >= min && this.once(watch, `conv:${move.token.toLowerCase()}`, windowMs, now)) {
          const group = watch.note ?? `cohort ${watch.id}`;
          this.fire(
            watch,
            `${buyers.length} of ${members.length} wallets in ${group} bought ${move.symbol} (${move.token}) ` +
              `within ${hours(windowMs)}: ${buyers.map((b) => this.labelFor(b)).join(", ")}.`,
          );
        }
      }
    }
  }

  /** True the first time `key` fires within the window; records it. */
  private once(watch: Watch, key: string, windowMs: number, now: number): boolean {
    const fired = (watch.fired ??= {});
    for (const [k, at] of Object.entries(fired)) if (now - at > windowMs) delete fired[k];
    if (fired[key] !== undefined) return false;
    fired[key] = now;
    return true;
  }

  /** A wallet's own note when some position watch names it, else its short form. */
  labelFor(wallet: Address): string {
    const short = `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
    const named = this.watches.find((w) => w.kind === "position" && w.note && sameWallet(w.address, wallet));
    return named ? `${named.note} (${short})` : short;
  }

  private txSuffix(hash: string): string {
    const url = this.runtime?.getService<ChainService>("chain")?.explorerTxUrl(hash);
    return url ? ` ${url}` : "";
  }

  // ------------------------------------------------------------- brief

  private async briefTick(now = new Date()): Promise<void> {
    const brief = this.brief;
    const clock = brief ? parseClock(brief.at) : null;
    if (!brief || !clock || this.briefing) return;
    const day = localDay(now);
    if (brief.lastDay === day) return;
    const due = new Date(now);
    due.setHours(clock.hour, clock.minute, 0, 0);
    if (now < due) return;
    this.briefing = true;
    try {
      // Mark the day first: a brief that failed is not retried every minute.
      brief.lastDay = day;
      await this.persist();
      if (now.getTime() - due.getTime() > BRIEF_LATE_MS) {
        log.info(`brief for ${day} is over ${BRIEF_LATE_MS / 3_600_000}h late, skipping to tomorrow`);
        return;
      }
      const text = await this.composeBrief(now.getTime(), true);
      if (text) this.fireBrief(text);
    } catch (err) {
      log.warn("morning brief failed", err);
    } finally {
      this.briefing = false;
    }
  }

  /**
   * Write the brief: the portfolio against the last brief's snapshot, the
   * watched wallets' moves and the alerts of the last day, filtered by the
   * model down to what matters for the portfolio. Null means silence.
   * `remember` stores today's snapshot as the next brief's baseline.
   */
  async composeBrief(now = Date.now(), remember = false): Promise<string | null> {
    const runtime = this.runtime;
    if (!runtime) return null;
    const portfolio = await readPortfolio(runtime);
    const material = briefMaterial({
      portfolioText: portfolio?.text,
      positions: portfolio?.positions ?? [],
      previous: this.brief?.snapshot,
      moves: this.recentMoves(DAY_MS, now),
      alerts: this.alerts.filter((a) => a.kind !== "brief" && now - a.at <= DAY_MS),
      labelFor: (w) => this.labelFor(w),
    });
    if (remember && this.brief && portfolio) {
      this.brief.snapshot = { at: now, positions: portfolio.positions };
      await this.persist();
    }
    if (!material) return null;

    const res = await runtime.model.generate({
      tier: ModelTier.MEDIUM,
      task: TaskKind.ANALYSIS,
      system:
        `You are ${runtime.character.name}, writing the operator's morning brief. ` +
        `It is not a news feed. Report only what matters to THEIR portfolio: watched wallets buying or ` +
        `dumping tokens the operator holds, several watched wallets converging on one asset, a watched ` +
        `wallet opening a new position worth a look, a position that moved sharply since the last brief, ` +
        `an alert that still needs action. Never retell an unchanged portfolio. ` +
        `At most 6 short lines, plain text, most important first, in your own voice. ` +
        `If nothing clears the bar, reply with exactly the single word: NOTHING.`,
      messages: [
        {
          role: "user",
          content:
            (this.brief?.note ? `The operator asked for: ${this.brief.note}

` : "") + material,
        },
      ],
      maxTokens: 700,
      temperature: 0.3,
    });
    const text = res.text.trim();
    return looksLikeNothing(text) ? null : text;
  }

  private fireBrief(text: string): void {
    this.emit({
      id: randomUUID(),
      watchId: "brief",
      text,
      at: Date.now(),
      delivered: false,
      kind: "brief",
    });
  }

  /** Read the watched balance, fire on condition edges. Returns "state changed". */
  private async checkWatch(chain: ChainService, watch: Watch): Promise<boolean> {
    let value: string;
    let symbol = chain.nativeSymbol;
    if (watch.token) {
      const token = chain.resolveToken(watch.token);
      if (!token) return false;
      const res = await chain.tokenBalance(token, watch.address);
      value = res.amount;
      symbol = res.symbol;
    } else {
      value = await chain.nativeBalance(watch.address);
    }

    const prev = watch.lastValue;
    watch.lastValue = value;
    const short = `${watch.address.slice(0, 6)}…${watch.address.slice(-4)}`;
    const label = watch.note ? `${watch.note} (${short})` : short;

    if (watch.kind === "change") {
      if (prev !== undefined && prev !== value) {
        this.fire(watch, `${label}: balance moved ${prev} → ${value} ${symbol}.`);
      }
      return prev !== value;
    }

    const num = Number(value);
    const threshold = watch.threshold ?? 0;
    if (!Number.isFinite(num)) return prev !== value;
    const holds = watch.kind === "below" ? num < threshold : num > threshold;
    const wasFiring = watch.firing ?? false;
    watch.firing = holds;
    if (holds && !wasFiring) {
      this.fire(
        watch,
        `${label}: ${value} ${symbol} is ${watch.kind} the ${threshold} ${symbol} threshold.`,
      );
    }
    return prev !== value || wasFiring !== holds;
  }

  private fire(watch: Watch, text: string): void {
    this.emit({
      id: randomUUID(),
      watchId: watch.id,
      text,
      at: Date.now(),
      delivered: false,
    });
  }

  private emit(alert: Alert): void {
    this.alerts.push(alert);
    if (this.alerts.length > ALERT_CAP) this.alerts = this.alerts.slice(-ALERT_CAP);
    log.info(`alert [${alert.watchId}] ${alert.text}`);
    for (const fn of this.subscribers) {
      try {
        fn(alert);
        // A live client saw it — don't repeat it in the next chat turn.
        alert.delivered = true;
      } catch {
        /* a broken subscriber must never break the sentinel */
      }
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const payload: SentinelFile = {
      watches: this.watches,
      alerts: this.alerts,
      counter: this.counter,
      cursors: this.cursors,
      moves: this.moves,
      brief: this.brief,
    };
    await writeFile(this.file, JSON.stringify(payload, null, 2), "utf8");
  }
}

function sameWallet(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function hours(ms: number): string {
  const h = ms / 3_600_000;
  return h >= 1 && Number.isInteger(h) ? `${h}h` : `${Math.round(ms / 60_000)}m`;
}

/**
 * The portfolio as portfolio_pnl reports it — the brief and the chat must
 * agree on what is held. Null when there is no chain or wallet.
 */
async function readPortfolio(
  runtime: IAgentRuntime,
): Promise<{ text: string; positions: BriefSnapshot["positions"] } | null> {
  const action = runtime.actions.find((a) => a.name === "portfolio_pnl");
  const chain = runtime.getService<ChainService>("chain");
  if (!action || !chain?.configured || !chain.agentAddress) return null;
  try {
    // portfolio_pnl reads nothing from the turn state.
    const res = await action.handler(runtime, {} as State, {});
    if (!res.ok || !res.text) return null;
    const raw = (res.data?.positions ?? []) as { token: string; symbol: string; valueNative: string }[];
    return {
      text: res.text,
      positions: raw.map((p) => ({ token: p.token, symbol: p.symbol, valueNative: Number(p.valueNative) })),
    };
  } catch (err) {
    log.warn("brief could not read the portfolio", err);
    return null;
  }
}

function getSentinel(runtime: IAgentRuntime): SentinelService {
  const svc = runtime.getService<SentinelService>("sentinel");
  if (!svc) throw new Error("sentinel service not started");
  return svc;
}

export function describeWatch(w: Watch, nativeSymbol: string): string {
  const note = w.note ? ` — ${w.note}` : "";
  if (w.kind === "wallets" && w.group) {
    const g = w.group;
    const what = [g.events.tokens ? "every token" : "", g.events.native ? "native balance" : ""].filter(Boolean).join(" + ");
    return (
      `${w.id}: ${g.members.length} wallets on ${g.network} — ${what}` +
      `${g.contracts.length ? ` (${g.contracts.length} contracts among them)` : ""}` +
      `${g.telegram ? " → telegram" : ""}${note}` +
      `${g.state.cursor ? ` · at block ${g.state.cursor}` : " · starts next tick"}` +
      `${g.lastError ? ` · last error: ${g.lastError}` : ""}`
    );
  }
  const window = hours(w.windowMs ?? DAY_MS);
  if (w.kind === "position") {
    return `${w.id}: activity of ${w.address} — new positions, and ${w.minBuys ?? 3}+ buys of one token in ${window}${note}`;
  }
  if (w.kind === "cohort") {
    const members = w.members ?? [];
    return (
      `${w.id}: cohort of ${members.length} wallets — ${w.minWallets ?? Math.min(3, members.length)}+ buying ` +
      `the same token within ${window}${note}`
    );
  }
  const target = w.token ? `${w.token.toUpperCase()} of ${w.address}` : `${nativeSymbol} of ${w.address}`;
  const cond =
    w.kind === "change" ? "on any change" : `when ${w.kind} ${w.threshold}`;
  const last = w.lastValue !== undefined ? ` (last seen: ${w.lastValue})` : "";
  return `${w.id}: ${target} ${cond}${note}${last}`;
}

/** Pull channel: surface not-yet-delivered alerts in the next turn's context. */
const alertsProvider: Provider = {
  name: "sentinel_alerts",
  async get(runtime) {
    const svc = runtime.getService<SentinelService>("sentinel");
    if (!svc) return "";
    const fresh = svc.takeUndelivered();
    if (!fresh.length) return "";
    // A group digest can run to forty lines; the model needs the gist, the
    // operator already has the whole thing in Telegram.
    const lines = fresh.map((a) => {
      const body = a.text.length > 700 ? `${a.text.slice(0, 700)}…` : a.text;
      return `- ${new Date(a.at).toISOString()} ${body}${a.telegramSent ? " (already sent to Telegram)" : ""}`;
    });
    return (
      `While the user was away, your watches fired these alerts. ` +
      `Mention them naturally in your reply:\n${lines.join("\n")}`
    );
  },
};

const watchBalanceAction: Action = {
  name: "watch_balance",
  similes: ["add_watch", "monitor_address", "watch_address", "track_balance"],
  description:
    "Start watching an address's balance on the configured chain in the background. Alerts fire when it drops below / rises above a threshold, or on any change. Watches persist across restarts.",
  parameters: {
    type: "object",
    properties: {
      address: { type: "string", description: "0x address to watch." },
      token: {
        type: "string",
        description: "Optional token symbol or 0x address. Omit for the chain's native currency.",
      },
      condition: {
        type: "string",
        enum: ["below", "above", "change"],
        description: "When to alert. Default: change.",
      },
      threshold: {
        type: "number",
        description: "Decimal threshold, required for below/above.",
      },
      note: { type: "string", description: "Short human label, e.g. 'relayer wallet'." },
    },
    required: ["address"],
  },
  examples: [
    {
      user: "warn me if the relayer 0xfA41… drops under 5",
      agent: "I'll keep an eye on it.",
    },
  ],
  async validate(runtime) {
    return Boolean(runtime.getService("sentinel"));
  },
  async handler(runtime, _state, params) {
    const svc = getSentinel(runtime);
    const address = String(params.address ?? "");
    if (!isAddress(address)) return { ok: false, text: "I need a valid 0x address to watch." };
    const kind = (params.condition as WatchKind) ?? "change";
    if (!["below", "above", "change"].includes(kind)) {
      return { ok: false, text: "Condition must be below, above, or change." };
    }
    const threshold = params.threshold !== undefined ? Number(params.threshold) : undefined;
    if (kind !== "change" && (threshold === undefined || !Number.isFinite(threshold))) {
      return { ok: false, text: `A numeric threshold is required for '${kind}'.` };
    }
    const watch = await svc.addWatch({
      address: address as Address,
      token: params.token ? String(params.token) : undefined,
      kind,
      threshold,
      note: params.note ? String(params.note) : undefined,
    });
    const nativeSymbol = runtime.getService<ChainService>("chain")?.nativeSymbol ?? "native currency";
    return {
      ok: true,
      text: `Watching now — ${describeWatch(watch, nativeSymbol)}.`,
      data: { watch: { ...watch } },
    };
  },
};

const listWatchesAction: Action = {
  name: "list_watches",
  similes: ["show_watches", "watches", "what_are_you_watching"],
  description: "List the background watches currently active (balances, wallets, wallet groups), with their ids, and the daily brief if one is set.",
  parameters: { type: "object", properties: {} },
  examples: [{ user: "what are you watching?", agent: "Here are my open eyes…" }],
  async validate(runtime) {
    return Boolean(runtime.getService("sentinel"));
  },
  async handler(runtime) {
    const svc = getSentinel(runtime);
    const watches = svc.listWatches();
    const brief = svc.briefSchedule();
    const briefLine = brief ? `\nDaily brief at ${brief.at} local${brief.note ? ` — ${brief.note}` : ""}.` : "";
    if (!watches.length) return { ok: true, text: `I'm not watching anything yet.${briefLine}` };
    const nativeSymbol = runtime.getService<ChainService>("chain")?.nativeSymbol ?? "native currency";
    return {
      ok: true,
      text: `Active watches:\n${watches.map((w) => describeWatch(w, nativeSymbol)).join("\n")}${briefLine}`,
      data: { count: watches.length },
    };
  },
};

const unwatchAction: Action = {
  name: "unwatch",
  similes: ["remove_watch", "stop_watching", "delete_watch"],
  description: "Stop a background watch by its id (see list_watches).",
  parameters: {
    type: "object",
    properties: { id: { type: "string", description: "Watch id, e.g. 'w1'." } },
    required: ["id"],
  },
  examples: [{ user: "stop watching w1", agent: "Closing that eye." }],
  async validate(runtime) {
    return Boolean(runtime.getService("sentinel"));
  },
  async handler(runtime, _state, params) {
    const svc = getSentinel(runtime);
    const id = String(params.id ?? "").trim();
    const removed = await svc.removeWatch(id);
    return removed
      ? { ok: true, text: `Stopped watching ${id}.` }
      : { ok: false, text: `No watch named ${id}. Ask me to list watches.` };
  },
};

function windowParam(raw: unknown, fallbackHours = 24): number | null {
  const h = raw === undefined ? fallbackHours : Number(raw);
  return Number.isFinite(h) && h > 0 && h <= 24 * 30 ? Math.round(h * 3_600_000) : null;
}

const watchWalletAction: Action = {
  name: "watch_wallet",
  similes: ["track_wallet", "follow_wallet", "watch_positions", "copy_watch"],
  description:
    "Watch what a wallet DOES, in the background: alert when it opens a new token position (buys a token it held none of), and when it keeps building one (several buys of the same token within a window). Only the wallet's own transactions count; airdrops are ignored. Use for 'tell me when this wallet starts building a position'. For balance thresholds use watch_balance instead.",
  parameters: {
    type: "object",
    properties: {
      address: { type: "string", description: "0x address of the wallet." },
      note: { type: "string", description: "Short human label, e.g. 'the fund wallet'." },
      min_buys: {
        type: "number",
        description: "Buys of one token within the window that count as building a position. Default 3.",
      },
      window_hours: { type: "number", description: "Look-back window for repeated buys. Default 24." },
    },
    required: ["address"],
  },
  examples: [
    { user: "watch 0x9c2e… and tell me when it starts building a new position", agent: "Eyes on it." },
  ],
  async validate(runtime) {
    return Boolean(runtime.getService("sentinel"));
  },
  async handler(runtime, _state, params) {
    const svc = getSentinel(runtime);
    const address = String(params.address ?? "");
    if (!isAddress(address)) return { ok: false, text: "I need a valid 0x address to watch." };
    const windowMs = windowParam(params.window_hours);
    if (windowMs === null) return { ok: false, text: "window_hours must be between 0 and 720." };
    const minBuys = params.min_buys !== undefined ? Math.round(Number(params.min_buys)) : 3;
    if (!Number.isFinite(minBuys) || minBuys < 2) return { ok: false, text: "min_buys must be 2 or more." };
    const watch = await svc.addWatch({
      address: address as Address,
      kind: "position",
      note: params.note ? String(params.note) : undefined,
      minBuys,
      windowMs,
    });
    return {
      ok: true,
      text: `Watching now — ${describeWatch(watch, "")}. I report from the next block on, not its history.`,
      data: { watch: { ...watch } },
    };
  },
};

/** Most wallets one `wallets` watch follows. */
const MAX_GROUP = 1000;

/**
 * Read the wallets a request names: `addresses`, a workspace `file` (CSV,
 * JSON, or one address per line — the order is the rank), and `labels`.
 * Shared by watch_wallets and wallets_snapshot.
 */
export async function walletsFromParams(params: Record<string, unknown>): Promise<{ wallets: WalletEntry[]; error?: string }> {
  const lists: WalletEntry[][] = [];
  if (Array.isArray(params.addresses) && params.addresses.length) {
    const raw = params.addresses.map(String);
    const bad = raw.filter((a) => !isAddress(a));
    if (bad.length) return { wallets: [], error: `not valid 0x addresses: ${bad.slice(0, 5).join(", ")}` };
    lists.push(parseWalletList(raw.join("\n")));
  }
  if (params.file) {
    const path = safePath(String(params.file));
    if (!path) return { wallets: [], error: `${String(params.file)} is outside the workspace` };
    let text: string;
    try {
      text = await readText(path, "utf8");
    } catch (err) {
      return { wallets: [], error: `could not read ${String(params.file)}: ${(err as Error).message}` };
    }
    const fromFile = parseWalletList(text);
    if (!fromFile.length) return { wallets: [], error: `no 0x addresses found in ${String(params.file)}` };
    lists.push(fromFile);
  }
  const labels =
    params.labels && typeof params.labels === "object"
      ? Object.fromEntries(Object.entries(params.labels as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
      : {};
  return { wallets: mergeWalletLists(lists, labels) };
}

const watchWalletsAction: Action = {
  name: "watch_wallets",
  similes: ["watch_cohort", "watch_group", "watch_addresses", "smart_money_watch", "track_wallets", "watch_holders"],
  description:
    "Follow a list of wallets in the background (up to 1000; from `addresses` and/or a workspace `file` — CSV/JSON/one per line, its order is the rank). " +
    "Default mode 'all': every change — any ERC20 token in or out (new positions, exits, buys, sells, transfers) and native balance moves — " +
    "one digest per tick with explorer links, delivered straight to the operator's Telegram. Runs on any known network (`network`, e.g. robinhood) " +
    "without switching the active chain. `replace` removes older watches it supersedes in the same call. " +
    "mode 'convergence': alert only when several of them buy the same token within a window.",
  parameters: {
    type: "object",
    properties: {
      addresses: { type: "array", items: { type: "string" }, description: "0x addresses." },
      file: { type: "string", description: "Workspace path of a list of addresses, e.g. exports/holders.csv." },
      labels: {
        type: "object",
        additionalProperties: { type: "string" },
        description: "Names for some of them: { \"0x…\": \"pool\" }.",
      },
      network: { type: "string", description: "Network profile (list_networks). Default: the active chain." },
      mode: { type: "string", enum: ["all", "convergence"], description: "Default all." },
      events: {
        type: "array",
        items: { type: "string", enum: ["tokens", "native"] },
        description: "mode all: what counts as a change. Default both.",
      },
      min_native: { type: "number", description: "Ignore native moves smaller than this (gas). Default 0.001." },
      telegram: { type: "boolean", description: "Send each digest to the operator's Telegram. Default true." },
      replace: { type: "array", items: { type: "string" }, description: "Watch ids to remove, e.g. [\"w1\",\"w2\"]." },
      note: { type: "string", description: "Name for the group, e.g. 'LAIN top-100'." },
      min_wallets: { type: "number", description: "convergence: how many must buy the same token. Default 3." },
      window_hours: { type: "number", description: "convergence: within how many hours. Default 24." },
    },
  },
  examples: [
    {
      user: "следи за всеми 100 холдерами по всем токенам и пиши в тг",
      agent: "ставлю одну слежку на всех сотню.",
    },
  ],
  async validate(runtime) {
    return Boolean(runtime.getService("sentinel"));
  },
  async handler(runtime, _state, params) {
    const svc = getSentinel(runtime);
    const { wallets, error } = await walletsFromParams(params);
    if (error) return { ok: false, text: `${error}.` };
    if (wallets.length < 1) return { ok: false, text: "Give me the wallets: addresses, or a file in the workspace with them." };
    if (wallets.length > MAX_GROUP) return { ok: false, text: `That is ${wallets.length} wallets; one watch follows at most ${MAX_GROUP}.` };

    const removed: string[] = [];
    for (const id of Array.isArray(params.replace) ? params.replace.map(String) : []) {
      if (await svc.removeWatch(id.trim())) removed.push(id.trim());
    }
    const removedNote = removed.length ? ` Removed ${removed.join(", ")}.` : "";

    if (params.mode === "convergence") {
      const members = wallets.map((w) => w.address);
      if (members.length < 2) return { ok: false, text: "Convergence needs at least 2 wallets." };
      const windowMs = windowParam(params.window_hours);
      if (windowMs === null) return { ok: false, text: "window_hours must be between 0 and 720." };
      const minWallets =
        params.min_wallets !== undefined ? Math.round(Number(params.min_wallets)) : Math.min(3, members.length);
      if (!Number.isFinite(minWallets) || minWallets < 2 || minWallets > members.length) {
        return { ok: false, text: `min_wallets must be between 2 and ${members.length}.` };
      }
      const watch = await svc.addWatch({
        address: members[0],
        kind: "cohort",
        members,
        minWallets,
        windowMs,
        note: params.note ? String(params.note) : undefined,
      });
      return { ok: true, text: `Watching now — ${describeWatch(watch, "")}.${removedNote}`, data: { watch: watch.id, removed } };
    }

    const profile = params.network ? await findNetwork(runtime, String(params.network)) : currentProfile(runtime);
    if (!profile) {
      return {
        ok: false,
        text: params.network
          ? `No network "${String(params.network)}" — list_networks shows the known ones.`
          : "No chain is active here; name the network (e.g. network: robinhood).",
      };
    }
    const events = Array.isArray(params.events) && params.events.length ? params.events.map(String) : ["tokens", "native"];
    const minNative = params.min_native !== undefined ? Number(params.min_native) : 0.001;
    if (!Number.isFinite(minNative) || minNative < 0) return { ok: false, text: "min_native must be 0 or more." };

    // Which members are contracts — the pool and the locker stay on the list,
    // marked, so their floods read as one line instead of passing for a person.
    let contracts: string[] = [];
    try {
      const src = svc.groupSource ? svc.groupSource(profile) : rpcWalletSource(profile);
      contracts = [...(await src.contracts(wallets.map((w) => w.address)))];
    } catch (err) {
      return { ok: false, text: `${profile.title} did not answer (${(err as Error).message.split("\n")[0]}); nothing was set up.${removedNote}` };
    }

    const watch = await svc.addWatch({
      address: wallets[0].address,
      kind: "wallets",
      note: params.note ? String(params.note) : `${wallets.length} wallets`,
      group: {
        network: profile.name,
        members: wallets,
        contracts,
        events: { tokens: events.includes("tokens"), native: events.includes("native") },
        minNative: parseUnits(String(minNative), profile.nativeDecimals ?? 18).toString(),
        telegram: params.telegram !== false,
        state: {},
      },
    });
    const interval = Math.round(Math.max(5_000, Number(runtime.getSetting("LAINOS_SENTINEL_INTERVAL_MS") ?? 60_000)) / 1000);
    return {
      ok: true,
      text:
        `Watching now — ${describeWatch(watch, profile.nativeSymbol)}. ` +
        `Checks every ${interval}s from the next block on; one digest per check when something moved.${removedNote}` +
        (runtime.getSetting("LAINOS_DAEMON") === "1"
          ? ""
          : " Note: this process is not the daemon — the watch runs while this session is open."),
      data: { watch: watch.id, members: wallets.length, contracts: contracts.length, network: profile.name, removed },
    };
  },
};

const scheduleBriefAction: Action = {
  name: "schedule_brief",
  similes: ["morning_brief_schedule", "daily_brief", "set_brief", "cancel_brief"],
  description:
    "Set up (or cancel) a daily brief delivered at a local time: the portfolio against the day before, what the watched wallets did, and open alerts — cut down to only what matters for the portfolio, or nothing at all on a quiet day. Use for 'every morning tell me only what matters'. at='off' cancels it.",
  parameters: {
    type: "object",
    properties: {
      at: { type: "string", description: "Local time HH:MM (24h), e.g. '08:30', or 'off'. Default 08:00." },
      note: { type: "string", description: "The operator's own words on what the brief is for." },
    },
  },
  examples: [{ user: "every morning tell me only what actually matters to my portfolio", agent: "Every morning at eight." }],
  async validate(runtime) {
    return Boolean(runtime.getService("sentinel"));
  },
  async handler(runtime, _state, params) {
    const svc = getSentinel(runtime);
    const at = String(params.at ?? "08:00").trim();
    if (at.toLowerCase() === "off") {
      await svc.setBrief(null);
      return { ok: true, text: "Daily brief cancelled." };
    }
    const clock = parseClock(at);
    if (!clock) return { ok: false, text: "Give the time as HH:MM, e.g. 08:30." };
    const normalized = `${String(clock.hour).padStart(2, "0")}:${String(clock.minute).padStart(2, "0")}`;
    await svc.setBrief({ at: normalized, note: params.note ? String(params.note) : undefined });
    return {
      ok: true,
      text: `Daily brief set for ${normalized} local time. Quiet days stay quiet.`,
      data: { brief: svc.briefSchedule() },
    };
  },
};

const briefNowAction: Action = {
  name: "brief_now",
  similes: ["morning_brief", "what_matters", "portfolio_brief", "daily_summary"],
  description:
    "Write the brief right now: what matters for the portfolio from the last 24 hours — watched wallets' moves, alerts, positions that moved since the last brief. Returns NOTHING-style silence as 'nothing worth your attention'.",
  parameters: { type: "object", properties: {} },
  examples: [{ user: "anything I should know about today?", agent: "Let me look over the last day." }],
  async validate(runtime) {
    return Boolean(runtime.getService("sentinel"));
  },
  async handler(runtime) {
    const text = await getSentinel(runtime).composeBrief();
    return { ok: true, text: text ?? "Nothing in the last day worth your attention." };
  },
};

export const sentinelPlugin: Plugin = {
  name: "sentinel",
  description:
    "Background chain sentinel: persistent balance and wallet-activity watches that raise alerts (push to clients, or mentioned in the next conversation), and a daily portfolio brief.",
  services: [new SentinelService()],
  providers: [alertsProvider],
  actions: [
    watchBalanceAction,
    watchWalletAction,
    watchWalletsAction,
    scheduleBriefAction,
    briefNowAction,
    listWatchesAction,
    unwatchAction,
  ],
};
