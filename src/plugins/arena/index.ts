import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from "undici";
import { createLogger } from "../../logger.js";
import type { IAgentRuntime, Plugin, Provider, Service, State } from "../../types.js";
import type { ChainService } from "../chain/index.js";
import type { TradeRecord } from "../chain/journal.js";

const log = createLogger("plugin:arena");

/**
 * Lain plays in the open arena.
 *
 * The arena at cyberia.church/arena keeps a public record per agent: every
 * trade it reports, the positions and P&L recomputed from those trades, and a
 * page anyone can read. This plugin is the reporting half — it registers Lain
 * once (the key lands in `data/arena.json` and is never printed), then sends
 * every trade from her journals: the real wallet's on the active chain, and
 * each of her paper wallets (including the trench's, on Robinhood Chain).
 *
 *   - **Off unless asked.** `LAINOS_ARENA=1` or a `LAINOS_ARENA_URL`; nothing
 *     is sent otherwise.
 *   - **Idempotent.** A trade's id is ours (`<chain>:<wallet>:<tx>`), so a
 *     batch retried after a lost answer is the same trades, not new ones.
 *   - **History included.** The first run sends what the journals already
 *     hold, so the page starts with a record instead of a blank.
 *
 * Paper trades are reported as paper. Nothing here can make a trade look
 * on-chain that was not.
 */

interface ArenaFile {
  key?: string;
  slug?: string;
  sent: string[];
}

interface ArenaTrade {
  id: string;
  side: "buy" | "sell";
  chain: string;
  token: string;
  symbol: string;
  qty_raw: string;
  decimals: number;
  quote: { symbol: string; amount_raw: string; decimals: number };
  realized?: string;
  tx?: string;
  paper: boolean;
  reason?: string;
  at: number;
}

const DEFAULT_URL = "https://cyberia.church";
const DEFAULT_INTERVAL_MS = 300_000;
const SENT_CAP = 20_000;
const BATCH = 100;
const PONS_CHAIN_ID = 4663;
const NATIVE: Record<number, string> = { 49406: "CYBER", 4663: "ETH", 8453: "ETH", 56: "BNB", 1: "ETH" };

/** A wei amount as a signed decimal string with 18 places, for `realized`. */
function weiToDecimal(wei: string): string {
  const value = BigInt(wei);
  const sign = value < 0n ? "-" : "";
  const abs = value < 0n ? -value : value;
  const whole = abs / 10n ** 18n;
  const frac = (abs % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return `${sign}${whole}${frac ? `.${frac}` : ""}`;
}

export class ArenaService implements Service {
  readonly name = "arena";

  private runtime?: IAgentRuntime;
  private url: string | null = null;
  private file = "";
  private state: ArenaFile = { sent: [] };
  private sent = new Set<string>();
  private decimals = new Map<string, number>();
  private dispatcher?: Dispatcher;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private lastError: string | null = null;

  async start(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
    this.file = join(runtime.getSetting("LAINOS_DATA_DIR") ?? "./data", "arena.json");
    const url = runtime.getSetting("LAINOS_ARENA_URL")?.trim();
    if (!url && runtime.getSetting("LAINOS_ARENA") !== "1") {
      log.info("arena reporting off (set LAINOS_ARENA=1)");
      return;
    }
    this.url = (url || DEFAULT_URL).replace(/\/+$/, "");
    const proxy = runtime.getSetting("LAINOS_ARENA_PROXY")?.trim();
    if (proxy) this.dispatcher = new ProxyAgent(proxy);
    try {
      const saved = JSON.parse(await readFile(this.file, "utf8")) as Partial<ArenaFile>;
      this.state = { ...saved, sent: saved.sent ?? [] };
    } catch {
      // First run.
    }
    this.sent = new Set(this.state.sent);
    log.info(`arena reporting to ${this.url}${this.state.slug ? ` as ${this.state.slug}` : ""}`);
    const interval = Math.max(60_000, Number(runtime.getSetting("LAINOS_ARENA_INTERVAL_MS") ?? DEFAULT_INTERVAL_MS));
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref?.();
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get enabled(): boolean {
    return this.url !== null;
  }

  status(): { enabled: boolean; page?: string; sent: number; lastError?: string } {
    return {
      enabled: this.enabled,
      page: this.state.slug && this.url ? `${this.url}/arena/agents/${this.state.slug}` : undefined,
      sent: this.sent.size,
      lastError: this.lastError ?? undefined,
    };
  }

  tick(): Promise<void> {
    if (!this.running) {
      this.running = this.run()
        .catch((err) => {
          this.lastError = err instanceof Error ? err.message : String(err);
          log.warn(`arena: ${this.lastError}`);
        })
        .finally(() => {
          this.running = null;
        });
    }
    return this.running;
  }

  private async run(): Promise<void> {
    if (!this.url) return;
    if (!this.state.key) await this.register();
    const pending = (await this.collect()).filter((trade) => !this.sent.has(trade.id));
    for (let i = 0; i < pending.length; i += BATCH) {
      const batch = pending.slice(i, i + BATCH);
      const response = await this.post("/api/arena/trades", { trades: batch }, this.state.key);
      if (response.status === 401) {
        // The key was revoked or the agent hidden: register again next sweep.
        this.state.key = undefined;
        await this.persist();
        throw new Error("arena key refused; will register again");
      }
      if (response.status === 422) {
        // A malformed record must not wedge the queue behind it forever.
        log.warn(`arena refused a batch: ${(await response.text()).slice(0, 300)}`);
      } else if (!response.ok) {
        throw new Error(`arena answered ${response.status}`);
      }
      for (const trade of batch) this.sent.add(trade.id);
      await this.persist();
    }
    if (pending.length) log.info(`arena: reported ${pending.length} trade(s)`);
    this.lastError = null;
  }

  private async register(): Promise<void> {
    const runtime = this.runtime as IAgentRuntime;
    const name = runtime.getSetting("LAINOS_ARENA_NAME")?.trim() || runtime.character?.name || "Lain";
    const response = await this.post("/api/arena/agents", {
      name,
      framework: "LainOS",
      description:
        runtime.getSetting("LAINOS_ARENA_DESCRIPTION")?.trim() ||
        `${name} — an autonomous LainOS agent. Real trades from her own wallet, paper trades from her paper desk and the trench.`,
      website: runtime.getSetting("LAINOS_ARENA_WEBSITE")?.trim() || "https://lain-os.com",
    });
    if (response.status !== 201) throw new Error(`arena registration answered ${response.status}`);
    const body = (await response.json()) as { key: string; agent: { slug: string } };
    this.state.key = body.key;
    this.state.slug = body.agent.slug;
    await this.persist();
    log.info(`arena: registered as ${body.agent.slug}`);
  }

  /** Every trade in Lain's journals, oldest first, in the arena's shape. */
  private async collect(): Promise<ArenaTrade[]> {
    const chain = this.runtime?.getService<ChainService>("chain");
    if (!chain?.journal) return [];
    const out: ArenaTrade[] = [];
    let active: number | undefined;
    try {
      active = chain.chain.id;
    } catch {
      active = undefined;
    }
    if (active !== undefined) {
      for (const trade of chain.journal.recentTrades(500)) {
        out.push(await this.shape(trade, active, "wallet", false));
      }
    }
    const chains = [...new Set([active, PONS_CHAIN_ID].filter((id): id is number => id !== undefined))];
    for (const wallet of typeof chain.paper?.wallets === "function" ? chain.paper.wallets() : []) {
      if (!wallet.lain) continue;
      for (const id of chains) {
        const book = await chain.paper.account(id, wallet.name);
        for (const trade of book.journal.recentTrades(500)) {
          out.push(await this.shape(trade, id, `paper-${wallet.name}`, true));
        }
      }
    }
    return out
      .filter((trade) => NATIVE[Number(trade.chain)] && /^0x[0-9a-fA-F]{40}$/.test(trade.token) && /^[0-9]+$/.test(trade.qty_raw) && BigInt(trade.qty_raw) > 0n)
      .sort((a, b) => a.at - b.at);
  }

  private async shape(trade: TradeRecord, chainId: number, wallet: string, paper: boolean): Promise<ArenaTrade> {
    return {
      id: `${chainId}:${wallet}:${trade.txHash}`.slice(0, 100),
      side: trade.side,
      chain: String(chainId),
      token: trade.token,
      symbol: (trade.symbol || "TOKEN").slice(0, 24),
      qty_raw: trade.qtyWei,
      decimals: await this.decimalsOf(trade.token, chainId),
      quote: { symbol: NATIVE[chainId] ?? "ETH", amount_raw: trade.nativeWei, decimals: 18 },
      realized: trade.realizedWei !== undefined ? weiToDecimal(trade.realizedWei) : undefined,
      tx: paper ? undefined : trade.txHash,
      paper,
      reason: trade.reason?.slice(0, 2000),
      at: trade.ts,
    };
  }

  /** Read from the token on the active chain; 18 anywhere it cannot be read. */
  private async decimalsOf(token: string, chainId: number): Promise<number> {
    const key = `${chainId}:${token.toLowerCase()}`;
    const known = this.decimals.get(key);
    if (known !== undefined) return known;
    let decimals = 18;
    const chain = this.runtime?.getService<ChainService>("chain");
    try {
      if (chain && chain.chain.id === chainId) decimals = (await chain.tokenInfo(token as `0x${string}`)).decimals;
    } catch {
      // Unreadable: the launchpads this agent trades mint 18-decimal tokens.
    }
    this.decimals.set(key, decimals);
    return decimals;
  }

  private post(path: string, body: unknown, key?: string) {
    return undiciFetch(`${this.url}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(body),
      dispatcher: this.dispatcher,
      signal: AbortSignal.timeout(20_000),
    });
  }

  private async persist(): Promise<void> {
    this.state.sent = [...this.sent].slice(-SENT_CAP);
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.state, null, 2), { mode: 0o600 });
  }
}

const arenaProvider: Provider = {
  name: "arena",
  async get(runtime: IAgentRuntime, _state: State): Promise<string> {
    const arena = runtime.getService<ArenaService>("arena");
    const status = arena?.status();
    if (!status?.enabled || !status.page) return "";
    return `# Arena\nYour trades are public at ${status.page} (${status.sent} reported${status.lastError ? `; last error: ${status.lastError}` : ""}).`;
  },
};

export const arenaPlugin: Plugin = {
  name: "arena",
  description:
    "Registers Lain in the open AI-trading arena (cyberia.church/arena) and reports every trade from her journals, real and paper, through an idempotent outbox.",
  actions: [],
  providers: [arenaProvider],
  services: [new ArenaService()],
};
