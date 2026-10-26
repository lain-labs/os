import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Action, IAgentRuntime, Plugin, Provider } from "../../types.js";

/**
 * Fomoscan (fomoscan.sh): the social-trading API over Fomo and pump.fun. For a
 * token it returns two walls — trader theses from Fomo (Solana, Base, BNB) and
 * callouts from pump.fun — and, for each author, the position behind the
 * words: still holding, how much, in profit or not, already out.
 *
 * That last part is the point, and it is only as good as the field behind it.
 * A Fomo thesis carries `holdingsUsd` at *post time* and a `closedAt` that
 * stays empty when the author sold from a wallet Fomo does not watch — an
 * author who sold weeks ago still reads as "open" there. So a thesis line says
 * what the author held when they wrote it and never claims they still hold;
 * only `closedAt` is reported, as "closed". The pump.fun position is a live
 * observation and is printed with its age.
 *
 * Only the two cheap reads are used (theses: 200 CU per 20 rows, pump wall:
 * 10 CU a page). Wallet → trader and whole-wallet PnL cost 30,000 CU a hit,
 * more than the free plan's 25,000 in total, so they are not here. Off unless
 * FOMOSCAN_API_KEY is set.
 *
 * Credits are finite, so every complete answer is kept on disk
 * (data/fomoscan-cache.json, raw items, never pruned) and a token asked again
 * within FOMOSCAN_CACHE_HOURS (default 24) is answered from there for free,
 * saying how old it is. Only an explicit `fresh` request spends credits again.
 * A wall that failed is never cached.
 */

const BASE = "https://api.fomoscan.sh";

export interface FomoThesis {
  authorHandle?: string | null;
  authorName?: string | null;
  authorIsDev?: boolean | null;
  thesis?: string | null;
  likeCount?: number | null;
  holdingsUsd?: number | null;
  authorTradeUsd?: number | null;
  realizedPnlUsd?: number | null;
  unrealizedPnlUsd?: number | null;
  closedAt?: string | null;
  fomoCreatedAt?: string | number | null;
  tokenSymbol?: string | null;
  tokenNetwork?: string | null;
}

export interface PumpCallout {
  userName?: string | null;
  xUsername?: string | null;
  isVerified?: boolean | null;
  coinSymbol?: string | null;
  thesis?: string | null;
  calledOutAtMcap?: number | null;
  multiple?: number | null;
  maxMultiplier?: number | null;
  createdAt?: string | null;
  likes?: number | null;
  position?: {
    valueUsd?: number | null;
    pnlUsd?: number | null;
    pnlPercentage?: number | null;
    isExited?: boolean | null;
    observedAt?: string | number | null;
  } | null;
}

export interface SocialWalls {
  token: string;
  theses: FomoThesis[] | null;
  callouts: PumpCallout[] | null;
  errors: string[];
  /** Set when the answer came from the disk cache: when it was fetched (epoch ms). */
  cachedAt?: number;
}

type Fetch = typeof fetch;

export class Fomoscan {
  constructor(
    private readonly key: string,
    private readonly fetcher: Fetch = fetch,
    private readonly cache: { file: string; ttlMs: number } | null = null,
  ) {}

  /** Solana mints are case-sensitive; EVM addresses are not. */
  private static cacheKey(token: string): string {
    const t = token.trim();
    return /^0x[0-9a-f]{40}$/i.test(t) ? t.toLowerCase() : t;
  }

  private async readCache(): Promise<Record<string, SocialWalls & { fetchedAt: number }>> {
    if (!this.cache) return {};
    try {
      return JSON.parse(await readFile(this.cache.file, "utf8"));
    } catch {
      return {};
    }
  }

  private async writeCache(key: string, w: SocialWalls): Promise<void> {
    if (!this.cache) return;
    const all = await this.readCache();
    all[key] = { ...w, fetchedAt: Date.now() };
    await mkdir(dirname(this.cache.file), { recursive: true });
    const tmp = `${this.cache.file}.tmp`;
    await writeFile(tmp, JSON.stringify(all));
    await rename(tmp, this.cache.file);
  }

  private async get(path: string): Promise<unknown | null> {
    const res = await this.fetcher(`${BASE}${path}`, {
      headers: { Authorization: `Bearer ${this.key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  /** Both walls for one token. A wall that failed is null and says why; it is never an empty list. */
  async walls(token: string, limit = 20, fresh = false): Promise<SocialWalls> {
    const key = Fomoscan.cacheKey(token);
    if (this.cache && !fresh) {
      const hit = (await this.readCache())[key];
      if (hit && Date.now() - hit.fetchedAt < this.cache.ttlMs) {
        const { fetchedAt, ...walls } = hit;
        return { ...walls, cachedAt: fetchedAt };
      }
    }
    const t = encodeURIComponent(token.trim());
    const errors: string[] = [];
    const [theses, callouts] = await Promise.all([
      this.get(`/v2/thesis/token/${t}?limit=${Math.min(Math.max(limit, 1), 100)}`).then(
        (r) => (r === null ? [] : (((r as { items?: FomoThesis[] }).items) ?? [])),
        (e: Error) => (errors.push(`fomo theses: ${e.message}`), null),
      ),
      this.get(`/v2/pump/thesis/token/${t}`).then(
        (r) => (r === null ? [] : (((r as { items?: PumpCallout[] }).items) ?? [])),
        (e: Error) => (errors.push(`pump.fun callouts: ${e.message}`), null),
      ),
    ]);
    const walls = { token: token.trim(), theses, callouts, errors };
    if (!errors.length) await this.writeCache(key, walls);
    return walls;
  }

  /** Plan and what is left of it (free, not metered). */
  async usage(): Promise<string> {
    const me = (await this.get("/v2/me")) as {
      plan?: string;
      usage?: { unitsUsed?: number; unitsRemaining?: number };
    } | null;
    if (!me) return "fomoscan: key not recognised";
    return `fomoscan plan ${me.plan ?? "?"}: ${me.usage?.unitsRemaining ?? "?"} CU left (${me.usage?.unitsUsed ?? "?"} used)`;
  }
}

const usd = (n: number | null | undefined) =>
  n === null || n === undefined || !Number.isFinite(n)
    ? "?"
    : `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: Math.abs(n) < 100 ? 2 : 0 })}`;
const clip = (s: string | null | undefined, n = 140) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Fomoscan sends times as epoch seconds, epoch millis or ISO strings. */
function toMs(at: string | number | null | undefined): number {
  if (at === null || at === undefined || at === "") return NaN;
  const n = typeof at === "number" ? at : /^\d+$/.test(at) ? Number(at) : NaN;
  if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
  return Date.parse(String(at));
}

function observed(at: string | number | null | undefined): string {
  const ms = toMs(at);
  if (!Number.isFinite(ms)) return "";
  const h = Math.max(0, Math.round((Date.now() - ms) / 3_600_000));
  return h < 1 ? ", seen <1h ago" : h < 48 ? `, seen ${h}h ago` : `, seen ${Math.round(h / 24)}d ago`;
}

/** One line per thesis: who, what they said, and what they held when they said it. */
export function thesisLine(t: FomoThesis): string {
  const who = `@${t.authorHandle ?? t.authorName ?? "?"}${t.authorIsDev ? " (dev)" : ""}`;
  const ms = toMs(t.fomoCreatedAt);
  const when = Number.isFinite(ms) ? ` ${new Date(ms).toISOString().slice(0, 10)}` : "";
  const held = t.holdingsUsd != null ? `held ${usd(t.holdingsUsd)} when posting` : "position at post time unknown";
  const closed = t.closedAt ? ", position closed" : "";
  return `${who}${when} [${held}${closed}] "${clip(t.thesis)}"`;
}

export function calloutLine(c: PumpCallout): string {
  const who = `${c.userName ?? "?"}${c.xUsername ? ` (x: @${c.xUsername})` : ""}${c.isVerified ? " ✓" : ""}`;
  const p = c.position;
  const money = !p
    ? "position unknown"
    : p.isExited
      ? `out, ${(p.pnlUsd ?? 0) >= 0 ? "+" : ""}${usd(p.pnlUsd)}`
      : `holds ${usd(p.valueUsd)}, ${(p.pnlUsd ?? 0) >= 0 ? "+" : ""}${usd(p.pnlUsd)}${observed(p.observedAt)}`;
  const since = c.calledOutAtMcap ? ` · called at ${usd(c.calledOutAtMcap)} mcap${c.multiple ? `, now ${c.multiple.toFixed(2)}×` : ""}` : "";
  return `${who} [${money}]${since} "${clip(c.thesis)}"`;
}

/** The walls as text, with the count of authors who are still in vs already out. */
export function wallsReport(w: SocialWalls, show = 8): string {
  const age = w.cachedAt ? Math.round((Date.now() - w.cachedAt) / 60_000) : null;
  const out: string[] = [
    `social calls on ${w.token} (via fomoscan.sh${age === null ? "" : `, from cache fetched ${age < 60 ? `${age}m` : `${Math.round(age / 60)}h`} ago, no credits spent`}):`,
  ];
  const section = <T>(name: string, rows: T[] | null, line: (r: T) => string, exited: (r: T) => boolean | null) => {
    if (rows === null) return out.push(`${name}: unreadable`);
    if (!rows.length) return out.push(`${name}: none`);
    const known = rows.map(exited).filter((x) => x !== null);
    const outCount = known.filter(Boolean).length;
    out.push(`${name}: ${rows.length} — ${known.length - outCount} still holding, ${outCount} already out${known.length < rows.length ? `, ${rows.length - known.length} unknown` : ""}`);
    for (const r of rows.slice(0, show)) out.push(`  ${line(r)}`);
  };
  if (w.theses === null) out.push("Fomo theses: unreadable");
  else if (!w.theses.length) out.push("Fomo theses: none");
  else {
    const closed = w.theses.filter((t) => t.closedAt).length;
    out.push(`Fomo theses: ${w.theses.length} (${closed} marked closed; who still holds is not known from theses — the amounts are at post time)`);
    for (const t of w.theses.slice(0, show)) out.push(`  ${thesisLine(t)}`);
  }
  section("pump.fun callouts", w.callouts, calloutLine, (c) => (c.position ? Boolean(c.position.isExited) : null));
  for (const e of w.errors) out.push(`! ${e}`);
  out.push("a call is not a result: words plus where the author's money is, never a signal on their own.");
  return out.join("\n");
}

function client(): Fomoscan | null {
  const key = process.env.FOMOSCAN_API_KEY?.trim();
  if (!key) return null;
  const hours = Number(process.env.FOMOSCAN_CACHE_HOURS ?? 24);
  const file = join(process.env.LAINOS_DATA_DIR ?? "./data", "fomoscan-cache.json");
  return new Fomoscan(key, fetch, { file, ttlMs: (Number.isFinite(hours) && hours >= 0 ? hours : 24) * 3_600_000 });
}

const socialCallsAction: Action = {
  name: "social_calls",
  similes: ["fomoscan", "fomo_theses", "pump_callouts", "who_called_it", "token_callouts"],
  description:
    "What traders say about a token on Fomo (theses; Solana, Base, BNB) and on pump.fun (callouts), with each author's position next to the words: " +
    "still holding and for how much, in profit or not, or already sold. Give the token's contract/mint address. " +
    "command 'usage' reports the Fomoscan credits left. Costs credits (free plan, finite): use it when somebody asks about a specific token, not on a loop. " +
    "A token checked in the last day is answered from cache for free; set fresh=true only when the person explicitly asks for new data.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", enum: ["calls", "usage"] },
      token: { type: "string", description: "Token contract or mint address." },
      fresh: { type: "boolean", description: "Bypass the cache and spend credits. Only when explicitly asked." },
    },
  },
  examples: [
    { user: "who is calling this coin? 7xKX…pump", agent: "Reading its Fomo and pump.fun walls…" },
  ],
  async validate() {
    return Boolean(process.env.FOMOSCAN_API_KEY?.trim());
  },
  async handler(_runtime: IAgentRuntime, _state, params) {
    const api = client();
    if (!api) return { ok: false, text: "fomoscan: FOMOSCAN_API_KEY is not set" };
    try {
      if (String(params.command ?? "calls") === "usage") return { ok: true, text: await api.usage() };
      const token = String(params.token ?? "").trim();
      if (!token) return { ok: false, text: "social_calls: give a token address" };
      const walls = await api.walls(token, 20, params.fresh === true);
      return { ok: true, text: wallsReport(walls), data: { walls } };
    } catch (err) {
      return { ok: false, text: `fomoscan: ${(err as Error).message}` };
    }
  },
};

const fomoscanProvider: Provider = {
  name: "fomoscan",
  async get() {
    if (!process.env.FOMOSCAN_API_KEY?.trim()) return "";
    return "You can read what traders say about a token on Fomo and pump.fun, and whether they still hold it, with the social_calls tool (Fomoscan; it costs credits).";
  },
};

export const fomoscanPlugin: Plugin = {
  name: "fomoscan",
  description: "Fomoscan: Fomo theses and pump.fun callouts for a token, each with the author's position.",
  providers: [fomoscanProvider],
  actions: [socialCallsAction],
};
