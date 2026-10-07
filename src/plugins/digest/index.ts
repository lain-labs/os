/**
 * Portfolio-aware briefings: one daily digest over everything the operator
 * holds on the chain — every token the explorer lists — written for those
 * holdings, not as a news feed.
 *
 * For each token the digest knows what it is *about* (assets.ts): a T-Capital
 * fund, gold, the rouble, Bitcoin, a brand, or a coin of the chain itself. It
 * then reads
 *   - the underlying's daily move from a public source (markets.ts),
 *   - the token's own price and pool depth on the chain's DEX, against the
 *     last digest (onchain.ts), and holder counts against the last digest,
 *   - the last day and a half of news on the underlying (news.ts),
 * and has the model write a short digest: what moved, what happened, and why
 * it matters for these holdings — every number from the material, every news
 * line with its link.
 *
 * Delivered to the operator's Telegram daily at `at` (daemon only), and on
 * demand: /digest in Telegram and the TUI, portfolio_digest for Lain.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fetch as undiciFetch, ProxyAgent } from "undici";
import { createLogger } from "../../logger.js";
import { TaskKind } from "../../models/tasks.js";
import {
  ModelTier,
  type Action,
  type IAgentRuntime,
  type Plugin,
  type Provider,
  type Service,
} from "../../types.js";
import { currentProfile, findNetwork, networkClient, type NetworkProfile } from "../chain/networks.js";
import { localDay, parseClock } from "../sentinel/brief.js";
import { sendToOperator } from "../telegram/index.js";
import { AssetBook, explorerTokens, resolveAssets, type Asset } from "./assets.js";
import { fetchQuotes, type Http, type Quote } from "./markets.js";
import { gatherNews, type AssetNews } from "./news.js";
import { digestTask, generateWithFallback } from "./model.js";
import { dexPrices, type PoolPrice } from "./onchain.js";

export * from "./assets.js";
export * from "./markets.js";
export * from "./news.js";
export * from "./onchain.js";
export * from "./model.js";

const log = createLogger("plugin:digest");

/** News older than this is yesterday's digest's business. */
const NEWS_WINDOW_MS = 36 * 3_600_000;
const SEEN_CAP = 3_000;
/** A digest more than this late is skipped until tomorrow. */
const LATE_MS = 4 * 3_600_000;

export interface DigestSnapshot {
  at: number;
  /** Native price per symbol on the DEX. */
  dex: Record<string, number>;
  holders: Record<string, number>;
}

interface DigestFile {
  at?: string | null;
  note?: string;
  lastDay?: string;
  snapshot?: DigestSnapshot;
  seen?: string[];
}

export interface DigestInput {
  network: string;
  nativeSymbol: string;
  assets: Asset[];
  quotes: Map<string, Quote>;
  missing: Map<string, string>;
  dex: Map<string, PoolPrice>;
  nativeUsd?: number;
  previous?: DigestSnapshot;
  news: AssetNews[];
  notes: string[];
}

function pct(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "n/a";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function num(n: number): string {
  if (!Number.isFinite(n)) return "?";
  const abs = Math.abs(n);
  if (abs >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (abs >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return n.toPrecision(3);
}

/** News URLs by the ids digestMaterial() gave them, in the same order. */
export function newsIds(news: AssetNews[]): Map<string, string> {
  const out = new Map<string, string>();
  let id = 0;
  for (const n of news) for (const i of n.items) out.set(`n${++id}`, i.url);
  return out;
}

/**
 * Put the real URLs back: `[source](n12)` → `[source](https://…)`. A link to
 * an id that does not exist is dropped to plain text — the model may not
 * invent a source.
 */
export function digestLinks(text: string, ids: Map<string, string>): string {
  return text.replace(/\[([^\]\n]+)\]\((n\d+)\)/g, (_m, label: string, ref: string) => {
    const url = ids.get(ref);
    return url ? `[${label}](${url})` : label;
  });
}

/** Everything the writer may use, as plain text. Pure — the smoke test reads it. */
export function digestMaterial(d: DigestInput): string {
  const lines: string[] = [];
  const sym = (a: Asset) => a.symbol.toUpperCase();

  lines.push(`Network: ${d.network}. Tokens followed: ${d.assets.length}.`);
  lines.push("", "## Underlying markets (last day)");
  const groups = new Map<string, Asset[]>();
  for (const a of d.assets) if (a.kind !== "native") groups.set(a.group, [...(groups.get(a.group) ?? []), a]);
  for (const [group, list] of groups) {
    lines.push(`${group}:`);
    for (const a of list) {
      const q = d.quotes.get(sym(a));
      const why = d.missing.get(sym(a));
      lines.push(
        q
          ? `- ${a.symbol} (${a.about}): ${num(q.price)} ${q.currency}, ${pct(q.changePct)} [${q.source}]`
          : `- ${a.symbol} (${a.about}): no external quote${why ? ` — ${why}` : ""}`,
      );
    }
  }

  lines.push("", `## On ${d.network} (DEX vs the previous digest${d.previous ? ` of ${new Date(d.previous.at).toISOString().slice(0, 16)} UTC` : " — none yet"})`);
  if (d.nativeUsd) lines.push(`${d.nativeSymbol} = ${num(d.nativeUsd)} USD`);
  for (const a of d.assets) {
    const p = d.dex.get(sym(a));
    const before = d.previous?.dex[sym(a)];
    const hBefore = d.previous?.holders[sym(a)];
    const parts: string[] = [];
    if (p) {
      parts.push(`${num(p.native)} ${d.nativeSymbol}${p.usd ? ` (${num(p.usd)} USD)` : ""}, pool depth ${num(p.depthNative)} ${d.nativeSymbol}`);
      if (before) parts.push(`price ${pct(((p.native - before) / before) * 100)}`);
    } else parts.push("no DEX pool");
    parts.push(`holders ${a.holders}${hBefore !== undefined && hBefore !== a.holders ? ` (was ${hBefore})` : ""}`);
    lines.push(`- ${a.symbol}: ${parts.join(", ")}`);
  }

  lines.push("", "## News (last 36h) — link an item as [source](its id), e.g. [РБК](n3)");
  if (!d.news.length) lines.push("(none found)");
  let id = 0;
  for (const n of d.news) {
    lines.push(`[${n.symbols.join(", ")} — query "${n.query.q}"]`);
    for (const i of n.items) {
      // An id instead of the URL: Google News links are 250 characters each,
      // and a model copying one can only get it wrong. digestLinks() puts the
      // real URL back.
      lines.push(`- n${++id}: ${i.title.slice(0, 160)}${i.at ? ` (${new Date(i.at).toISOString().slice(5, 16).replace("T", " ")})` : ""}`);
    }
  }
  if (d.notes.length) lines.push("", "## Gaps", ...d.notes.map((n) => `- ${n}`));
  return lines.join("\n");
}

export class DigestService implements Service {
  readonly name = "digest";
  private runtime?: IAgentRuntime;
  private file = "";
  private state: DigestFile = {};
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<string> | null = null;
  /** Tests replace the network and the model's chain reads. */
  http?: Http;
  dexReader?: (profile: NetworkProfile, assets: Asset[]) => ReturnType<typeof dexPrices>;

  async start(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
    this.file = join(runtime.getSetting("LAINOS_DATA_DIR") || "./data", "digest.json");
    try {
      this.state = JSON.parse(await readFile(this.file, "utf8")) as DigestFile;
    } catch {
      this.state = {};
    }
    const seeded = runtime.getSetting("LAINOS_DIGEST_AT")?.trim();
    if (this.state.at === undefined && seeded && parseClock(seeded)) this.state.at = seeded;

    // Delivered once a day per operator: only the daemon sends it, so a TUI
    // next to it never doubles the message.
    const forced = runtime.getSetting("LAINOS_DIGEST");
    const scheduled = forced !== undefined && forced !== "" ? forced !== "0" : runtime.getSetting("LAINOS_DAEMON") === "1";
    if (scheduled) {
      this.timer = setInterval(() => void this.tick(), 60_000);
      this.timer.unref?.();
    }
    log.info(`digest ${this.state.at ? `daily at ${this.state.at} local` : "not scheduled"}${scheduled ? "" : " (delivery runs in the daemon)"}`);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  schedule(): { at: string | null; note?: string; lastDay?: string } {
    return { at: this.state.at ?? null, note: this.state.note, lastDay: this.state.lastDay };
  }

  async setSchedule(at: string | null, note?: string): Promise<void> {
    this.state.at = at;
    if (note !== undefined) this.state.note = note;
    await this.persist();
  }

  private async tick(now = new Date()): Promise<void> {
    const at = this.state.at;
    const clock = at ? parseClock(at) : null;
    if (!clock || this.running) return;
    const day = localDay(now);
    if (this.state.lastDay === day) return;
    const due = new Date(now);
    due.setHours(clock.hour, clock.minute, 0, 0);
    if (now < due) return;
    // Mark the day first: a failed digest is not retried every minute.
    this.state.lastDay = day;
    await this.persist();
    if (now.getTime() - due.getTime() > LATE_MS) {
      log.info(`digest for ${day} is over ${LATE_MS / 3_600_000}h late — skipping to tomorrow`);
      return;
    }
    try {
      const text = await this.generate({ remember: true });
      await sendToOperator((k) => this.runtime!.getSetting(k), text);
      log.info(`digest for ${day} delivered`);
    } catch (err) {
      log.warn(`digest for ${day} failed: ${(err as Error).message}`);
      await sendToOperator((k) => this.runtime!.getSetting(k), `дайджест за ${day} не собрался: ${(err as Error).message}`, { plain: true }).catch(() => {});
    }
  }

  /**
   * Build the digest now. One at a time: a second request while one is being
   * written waits for the same result. `remember` stores today's prices,
   * holders and shown links as the baseline for the next one.
   */
  generate(opts: { remember?: boolean; onProgress?: (msg: string) => void } = {}): Promise<string> {
    if (this.running) return this.running;
    this.running = this.compose(opts).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async compose(opts: { remember?: boolean; onProgress?: (msg: string) => void }): Promise<string> {
    const runtime = this.runtime;
    if (!runtime) throw new Error("digest service not started");
    const say = opts.onProgress ?? (() => {});
    const name = runtime.getSetting("LAINOS_DIGEST_NETWORK")?.trim();
    const profile = name ? await findNetwork(runtime, name) : currentProfile(runtime);
    if (!profile) throw new Error(name ? `unknown network "${name}"` : "no chain is configured");
    const api = explorerApi(profile);
    if (!api) throw new Error(`${profile.title} has no explorer to list its tokens`);
    const http = this.http ?? makeHttp(runtime);
    const notes: string[] = [];

    say(`tokens of ${profile.title}…`);
    const book = await AssetBook.forRuntime(runtime).load();
    const assets = await resolveAssets(runtime, await explorerTokens(api, (u) => http(u)), book, profile.nativeSymbol);
    if (!assets.length) throw new Error(`the explorer lists no tokens on ${profile.title}`);

    say(`prices for ${assets.length} assets…`);
    const [{ quotes, missing }, dex] = await Promise.all([
      fetchQuotes(assets, http),
      (this.dexReader ? this.dexReader(profile, assets) : dexPrices(networkClient(profile), profile, assets)).catch((err: Error) => {
        notes.push(`DEX prices could not be read: ${err.message.split("\n")[0]}`);
        return { prices: new Map<string, PoolPrice>(), nativeUsd: undefined, note: undefined };
      }),
    ]);
    if (dex.note) notes.push(dex.note);

    say("news…");
    const seen = new Set(this.state.seen ?? []);
    let failedQueries = 0;
    const news = await gatherNews(assets, http, {
      sinceMs: Date.now() - NEWS_WINDOW_MS,
      seen,
      onError: () => void failedQueries++,
    });
    if (failedQueries) notes.push(`${failedQueries} news searches failed`);

    const material = digestMaterial({
      network: profile.title,
      nativeSymbol: profile.nativeSymbol,
      assets,
      quotes,
      missing,
      dex: dex.prices,
      nativeUsd: dex.nativeUsd,
      previous: this.state.snapshot,
      news,
      notes,
    });

    // Kept on disk: what the digest was written from, so any line in it can
    // be checked against its source.
    await writeFile(join(dirname(this.file), "digest-material.txt"), material, "utf8").catch(() => {});

    say("writing…");
    const text = digestLinks(await this.write(runtime, material), newsIds(news));

    if (opts.remember) {
      this.state.snapshot = {
        at: Date.now(),
        dex: Object.fromEntries([...dex.prices].map(([k, v]) => [k, v.native])),
        holders: Object.fromEntries(assets.map((a) => [a.symbol.toUpperCase(), a.holders])),
      };
      const shown = news.flatMap((n) => n.items.map((i) => i.url));
      this.state.seen = [...(this.state.seen ?? []), ...shown].slice(-SEEN_CAP);
      await this.persist();
    }
    return text;
  }

  private async write(runtime: IAgentRuntime, material: string): Promise<string> {
    const lang = runtime.getSetting("LAINOS_DIGEST_LANG")?.trim() || "Russian";
    const res = await generateWithFallback(runtime, {
      tier: ModelTier.MEDIUM,
      task: digestTask(runtime),
      system:
        `You are ${runtime.character.name}, writing the operator's daily portfolio digest. The operator holds every one of these tokens; ` +
        `each wraps an underlying (a fund, a metal, a currency, a coin, a brand) or is a coin of the chain itself. ` +
        `Write for those holdings, not as a news feed: what moved, what happened, and what it means for what they hold. Language: ${lang}. Markdown.\n` +
        `Shape:\n` +
        `1. One or two sentences: the day for this portfolio.\n` +
        `2. **Рынки** (or the equivalent heading in the language): the notable moves grouped as in the material — biggest first, ` +
        `small moves of stable things (stablecoins, the money-market fund) only if unusual. Say plainly where there is no quote.\n` +
        `3. An on-chain section (the chain's name as its heading): moves since the last digest that stand out — price swings, holder changes, pools that vanished. Skip it if nothing stands out.\n` +
        `4. **Новости**: grouped by asset group; each bullet "**SYMBOL** — what happened, why it matters for the holding [source](nID)" — ` +
        `the source is the outlet named at the end of the item's title, nID is the item's id from the material. ` +
        `Only news that can move the asset or matters to holding it; drop noise, rehashed price chatter, ads, duplicates. At most 12 bullets.\n` +
        `Rules: every number and every link must come from the material — never invent or round into something new. ` +
        `Hard limit 3000 characters: cut the least important lines, never the links of the lines you keep. ` +
        `Output only the digest itself — no preamble, no notes about the task, no closing pleasantries.`,
      messages: [{ role: "user", content: material }],
      maxTokens: 4000,
      temperature: 0.3,
    });
    const text = res.text.trim();
    if (!text) throw new Error("the model wrote nothing");
    return text;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.state, null, 2), "utf8");
  }
}

/** The Blockscout v2 API of a profile, whichever way its URL was written ("/api", "/api/v2", or none). */
export function explorerApi(profile: NetworkProfile): string {
  const raw = (profile.explorerApiUrl || (profile.explorerUrl ? `${profile.explorerUrl}/api/v2` : "")).replace(/\/+$/, "");
  return raw.replace(/\/api$/, "/api/v2");
}

/** GET with a timeout — direct first (Russian sources dislike proxies), then the scout's proxy. */
export function makeHttp(runtime: IAgentRuntime): Http {
  const proxy =
    runtime.getSetting("LAINOS_SCOUT_PROXY") ?? runtime.getSetting("LAINOS_MODEL_PROXY") ?? runtime.getSetting("HTTPS_PROXY");
  const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
  const once = async (url: string, timeoutMs: number, headers: Record<string, string>, viaProxy: boolean) => {
    const res = await undiciFetch(url, {
      headers: { "user-agent": "LainOS-digest/0.1", accept: "*/*", ...headers },
      dispatcher: viaProxy ? dispatcher : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`${new URL(url).host} HTTP ${res.status}`);
    return res.text();
  };
  return async (url, opts = {}) => {
    const timeoutMs = opts.timeoutMs ?? 20_000;
    try {
      return await once(url, timeoutMs, opts.headers ?? {}, false);
    } catch (err) {
      if (!dispatcher) throw err;
      return once(url, timeoutMs, opts.headers ?? {}, true);
    }
  };
}

function getDigest(runtime: IAgentRuntime): DigestService {
  const svc = runtime.getService<DigestService>("digest");
  if (!svc) throw new Error("digest service not started");
  return svc;
}

/** "/digest", "/digest at 09:30", "/digest off" — shared by Telegram and the TUI. */
export async function digestCommand(runtime: IAgentRuntime, args: string[], onProgress?: (msg: string) => void): Promise<string> {
  const svc = getDigest(runtime);
  const sub = args[0]?.toLowerCase();
  if (sub === "off") {
    await svc.setSchedule(null);
    return "ежедневный дайджест выключен. /digest — собрать сейчас, /digest at 09:00 — включить.";
  }
  if (sub === "at" || (sub && parseClock(sub))) {
    const raw = sub === "at" ? args[1] : sub;
    const clock = raw ? parseClock(raw) : null;
    if (!clock) return "время как HH:MM, например /digest at 09:00";
    const at = `${String(clock.hour).padStart(2, "0")}:${String(clock.minute).padStart(2, "0")}`;
    await svc.setSchedule(at);
    return `дайджест каждый день в ${at} (время хоста), в телеграм.`;
  }
  if (sub === "when" || sub === "status") {
    const s = svc.schedule();
    return s.at ? `дайджест каждый день в ${s.at}; последний — ${s.lastDay ?? "ещё не было"}.` : "ежедневный дайджест выключен.";
  }
  return svc.generate({ onProgress });
}

const portfolioDigestAction: Action = {
  name: "portfolio_digest",
  similes: ["digest", "daily_digest", "portfolio_news", "asset_news", "news_digest"],
  description:
    "Write the portfolio digest now: every token on the chain's explorer (the operator holds them all), each mapped to its underlying — " +
    "funds, metals, the rouble, coins, brands, the chain's own coins — with the day's market moves, DEX moves since the last digest, " +
    "and the news that matters for those holdings, with links. Takes two or three minutes. telegram: true also sends it to the operator. " +
    "Use for 'дайджест', 'что по моим активам', 'новости по портфелю'.",
  parameters: {
    type: "object",
    properties: { telegram: { type: "boolean", description: "Also send it to the operator's Telegram." } },
  },
  examples: [{ user: "что нового по моим активам?", agent: "собираю дайджест." }],
  async validate(runtime) {
    return Boolean(runtime.getService("digest"));
  },
  async handler(runtime, _state, params) {
    try {
      const text = await getDigest(runtime).generate();
      let sent = "";
      if (params.telegram === true) {
        try {
          const chat = await sendToOperator((k) => runtime.getSetting(k), text);
          sent = `\n\n(sent to Telegram chat ${chat})`;
        } catch (err) {
          sent = `\n\n(Telegram delivery FAILED: ${(err as Error).message})`;
        }
      }
      return { ok: true, text: `${text}${sent}` };
    } catch (err) {
      return { ok: false, text: `digest failed: ${(err as Error).message}` };
    }
  },
};

const scheduleDigestAction: Action = {
  name: "schedule_digest",
  similes: ["digest_schedule", "daily_digest_at", "set_digest_time"],
  description: "Set the daily portfolio digest's local time (HH:MM), or 'off'. It goes to the operator's Telegram from the daemon.",
  parameters: {
    type: "object",
    properties: {
      at: { type: "string", description: "HH:MM (24h) or 'off'." },
      note: { type: "string", description: "The operator's own words on what the digest should focus on." },
    },
    required: ["at"],
  },
  examples: [{ user: "присылай дайджест каждое утро в 9", agent: "каждый день в 09:00." }],
  async validate(runtime) {
    return Boolean(runtime.getService("digest"));
  },
  async handler(runtime, _state, params) {
    const svc = getDigest(runtime);
    const at = String(params.at ?? "").trim();
    if (at.toLowerCase() === "off") {
      await svc.setSchedule(null);
      return { ok: true, text: "Daily digest turned off." };
    }
    const clock = parseClock(at);
    if (!clock) return { ok: false, text: "Give the time as HH:MM." };
    const norm = `${String(clock.hour).padStart(2, "0")}:${String(clock.minute).padStart(2, "0")}`;
    await svc.setSchedule(norm, params.note ? String(params.note) : undefined);
    const daemon = runtime.getSetting("LAINOS_DAEMON") === "1";
    return {
      ok: true,
      text: `Daily digest at ${norm} local time, to Telegram.${daemon ? "" : " Note: set here, it is delivered by this process only if it is the daemon — ask me in Telegram to set it there."}`,
    };
  },
};

const digestAssetsAction: Action = {
  name: "digest_assets",
  similes: ["portfolio_assets", "asset_map", "digest_tokens"],
  description:
    "Show or correct what the digest thinks each token is about: list the map, leave tokens out (exclude) or back in (include), " +
    "or set a token's subject and news searches (symbol + about + news queries).",
  parameters: {
    type: "object",
    properties: {
      exclude: { type: "array", items: { type: "string" }, description: "Symbols to leave out of the digest." },
      include: { type: "array", items: { type: "string" }, description: "Symbols to bring back." },
      symbol: { type: "string", description: "Token to (re)describe." },
      about: { type: "string", description: "What it is, a few words." },
      news: { type: "array", items: { type: "string" }, description: "News search queries for it." },
      lang: { type: "string", enum: ["ru", "en"], description: "Language of those queries. Default ru." },
    },
  },
  examples: [{ user: "по TG ищи новости про Telegram на русском", agent: "поправила." }],
  async validate(runtime) {
    return Boolean(runtime.getService("digest"));
  },
  async handler(runtime, _state, params) {
    const book = await AssetBook.forRuntime(runtime).load();
    const changed: string[] = [];
    for (const s of Array.isArray(params.exclude) ? params.exclude.map(String) : []) {
      book.setExcluded(s, true);
      changed.push(`-${s.toUpperCase()}`);
    }
    for (const s of Array.isArray(params.include) ? params.include.map(String) : []) {
      book.setExcluded(s, false);
      changed.push(`+${s.toUpperCase()}`);
    }
    if (params.symbol) {
      const sym = String(params.symbol).toUpperCase();
      const prev = book.spec(sym);
      const lang = params.lang === "en" ? "en" : "ru";
      const news = Array.isArray(params.news) ? params.news.map((q) => ({ q: String(q), lang: lang as "ru" | "en" })) : prev?.news ?? [];
      book.set(sym, {
        kind: news.length ? prev?.kind === "native" || !prev ? "brand" : prev.kind : prev?.kind ?? "native",
        about: params.about ? String(params.about) : prev?.about ?? sym,
        group: prev?.group && prev.group !== "Cyberia" ? prev.group : news.length ? "Бренды и проекты" : "Cyberia",
        price: prev?.price ?? { source: "dex" },
        news,
      });
      changed.push(`${sym} updated`);
    }
    if (changed.length) await book.save();
    const profile = currentProfile(runtime);
    const lines: string[] = [];
    const api = profile ? explorerApi(profile) : "";
    if (profile && api) {
      try {
        const http = makeHttp(runtime);
        const assets = await resolveAssets(runtime, await explorerTokens(api, (u) => http(u)), book, profile.nativeSymbol);
        for (const a of assets) {
          const price = a.price ? a.price.source : "—";
          lines.push(`${a.symbol} — ${a.about} · price: ${price} · news: ${a.news.map((n) => `"${n.q}"(${n.lang})`).join(", ") || "on-chain only"}`);
        }
      } catch (err) {
        lines.push(`(could not list the tokens: ${(err as Error).message})`);
      }
    }
    const ex = book.excluded();
    return {
      ok: true,
      text: [changed.length ? `Changed: ${changed.join(", ")}.` : "", ...lines, ex.length ? `Left out: ${ex.join(", ")}` : ""].filter(Boolean).join("\n"),
    };
  },
};

const digestProvider: Provider = {
  name: "digest",
  async get(runtime) {
    const svc = runtime.getService<DigestService>("digest");
    if (!svc) return "";
    const s = svc.schedule();
    return (
      `Portfolio digest: portfolio_digest writes it now (market moves, on-chain moves and news for every token the operator holds); ` +
      `${s.at ? `it also goes to Telegram daily at ${s.at}` : "no daily schedule (schedule_digest sets one)"}; digest_assets shows or fixes what each token maps to.`
    );
  },
};

export const digestPlugin: Plugin = {
  name: "digest",
  description: "Portfolio-aware daily digest over every token on the chain: underlying market moves, DEX moves, and news that matters, to Telegram.",
  services: [new DigestService()],
  providers: [digestProvider],
  actions: [portfolioDigestAction, scheduleDigestAction, digestAssetsAction],
};
