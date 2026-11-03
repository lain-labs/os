import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createLogger } from "../logger.js";
import type { ModelProvider, ModelRequest, ModelResponse, ModelTier } from "../types.js";

const log = createLogger("model:budget");

/**
 * What a model call costs before it is made, and what it cost after.
 *
 * Three pieces, one purpose — spend the paid subscriptions on code and money,
 * and everything else on the free tiers, without running into their walls:
 *
 *   estimate      — tokens in/out and seconds for a request, before sending it;
 *   QuotaBook     — per-model minute/day counters for free tiers (Groq gives
 *                   each model its own 30 req/min, 1000 req/day, 8k tokens/min,
 *                   200k tokens/day), persisted so a restart does not forget;
 *   UsageLedger   — one line per call (task, provider, model, estimate, actual
 *                   output, time), summarised daily: what went where, how long
 *                   it took, and what it would have cost on a paid model.
 *
 * GroqPool spreads a route over Groq's free models — the quota is per model, so
 * three models are ~600k free tokens a day — and refuses a request that cannot
 * fit the per-minute window instead of letting it fail with a 429.
 */

export interface Quota {
  rpm: number;
  rpd: number;
  tpm: number;
  tpd: number;
}

/** Groq's free plan, per model (console.groq.com/settings/limits). */
export const GROQ_FREE_QUOTA: Quota = { rpm: 30, rpd: 1000, tpm: 8000, tpd: 200_000 };

/** The free Groq models, best first, and the tier each suits. */
export const GROQ_FREE_MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"];

/** Output tokens a second, roughly, per provider kind — for the time estimate. */
const THROUGHPUT: Record<string, number> = {
  groq: 400,
  cerebras: 900,
  openrouter: 60,
  anthropic: 70,
  claude: 60,
  codex: 45,
  opencode: 45,
  grok: 60,
  mock: 10_000,
};

/** Seconds of overhead before the first token: a CLI agent starts a process. */
const STARTUP: Record<string, number> = { claude: 6, codex: 8, opencode: 6, grok: 5, groq: 0.4, cerebras: 0.4, openrouter: 1.5, anthropic: 1 };

/** A paid reference price (USD per 1M tokens in / out) to say what free work saved. */
export const REFERENCE_PRICE = { input: 3, output: 15, label: "Claude Sonnet" };

/** Tokens in a text, roughly: ~4 characters a token, one a token for CJK. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[぀-ヿ㐀-鿿가-힯]/g) ?? []).length;
  return Math.ceil((text.length - cjk) / 4) + cjk;
}

export interface Estimate {
  input: number;
  output: number;
  seconds: number;
}

/** What a request will use: its prompt, its tools' schemas, and the output it allows. */
export function estimateRequest(request: ModelRequest, providerKind = "openrouter"): Estimate {
  const input =
    estimateTokens(request.system) +
    request.messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0) +
    (request.tools ?? []).reduce((sum, t) => sum + estimateTokens(JSON.stringify(t)), 0);
  // Most replies use well under the cap; a third of it is the planning figure.
  const output = Math.min(request.maxTokens ?? 1024, Math.max(200, Math.round((request.maxTokens ?? 1024) / 3)));
  return { input, output, seconds: estimateSeconds(providerKind, output) };
}

export function estimateSeconds(providerKind: string, outputTokens: number): number {
  const kind = providerKind.split(/[/:]/)[0].toLowerCase();
  const tps = THROUGHPUT[kind] ?? 60;
  return Math.round(((STARTUP[kind] ?? 1) + outputTokens / tps) * 10) / 10;
}

// ------------------------------------------------------------- quota book

interface Window {
  minute: number;
  minuteRequests: number;
  minuteTokens: number;
  day: string;
  dayRequests: number;
  dayTokens: number;
  /** Until when the model said "slow down" (a 429), ms since epoch. */
  coolUntil?: number;
}

/** Minute and day counters per free-tier model, kept in data/quotas.json. */
export class QuotaBook {
  private windows: Record<string, Window> = {};
  private dirty = false;

  constructor(private readonly file?: string) {
    if (!file) return;
    try {
      this.windows = JSON.parse(readFileSync(file, "utf8")) as Record<string, Window>;
    } catch {
      // Fresh book.
    }
  }

  private window(key: string, now: number): Window {
    const minute = Math.floor(now / 60_000);
    const day = new Date(now).toISOString().slice(0, 10);
    const w = (this.windows[key] ??= { minute, minuteRequests: 0, minuteTokens: 0, day, dayRequests: 0, dayTokens: 0 });
    if (w.minute !== minute) Object.assign(w, { minute, minuteRequests: 0, minuteTokens: 0 });
    if (w.day !== day) Object.assign(w, { day, dayRequests: 0, dayTokens: 0 });
    return w;
  }

  /** Whether `tokens` more fit this model's quota right now. */
  fits(key: string, quota: Quota, tokens: number, now = Date.now()): boolean {
    const w = this.window(key, now);
    if (w.coolUntil && w.coolUntil > now) return false;
    return (
      w.minuteRequests + 1 <= quota.rpm &&
      w.dayRequests + 1 <= quota.rpd &&
      w.minuteTokens + tokens <= quota.tpm &&
      w.dayTokens + tokens <= quota.tpd
    );
  }

  record(key: string, tokens: number, now = Date.now()): void {
    const w = this.window(key, now);
    w.minuteRequests++;
    w.dayRequests++;
    w.minuteTokens += tokens;
    w.dayTokens += tokens;
    this.flush();
  }

  /** The model refused for rate: leave it alone for a while. */
  cool(key: string, ms = 60_000, now = Date.now()): void {
    this.window(key, now).coolUntil = now + ms;
    this.flush();
  }

  /** Today's use per model, for the digest. */
  today(now = Date.now()): Record<string, { requests: number; tokens: number }> {
    const day = new Date(now).toISOString().slice(0, 10);
    const out: Record<string, { requests: number; tokens: number }> = {};
    for (const [key, w] of Object.entries(this.windows)) {
      if (w.day === day) out[key] = { requests: w.dayRequests, tokens: w.dayTokens };
    }
    return out;
  }

  private flush(): void {
    if (!this.file) return;
    this.dirty = true;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.windows), "utf8");
      this.dirty = false;
    } catch (err) {
      log.debug(`quota book not saved: ${String(err)}`);
    }
  }
}

// ----------------------------------------------------------- usage ledger

export interface LedgerLine {
  at: string;
  task: string;
  provider: string;
  model: string;
  estIn: number;
  estOut: number;
  out: number;
  ms: number;
  ok: boolean;
}

/** One JSON line per model call in data/usage-ledger.jsonl. */
export class UsageLedger {
  constructor(private readonly file?: string) {}

  append(line: LedgerLine): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, `${JSON.stringify(line)}\n`, "utf8");
    } catch (err) {
      log.debug(`ledger line not written: ${String(err)}`);
    }
  }

  lines(sinceMs: number): LedgerLine[] {
    if (!this.file) return [];
    try {
      return readFileSync(this.file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as LedgerLine)
        .filter((l) => Date.parse(l.at) >= sinceMs);
    } catch {
      return [];
    }
  }
}

export interface UsageSummary {
  calls: number;
  failed: number;
  tokens: number;
  seconds: number;
  freeTokens: number;
  savedUsd: number;
  byTask: { task: string; calls: number; tokens: number; seconds: number; providers: string }[];
  /** How far the estimates were off, actual output / estimated output. */
  estimateRatio: number | null;
}

/** What the last day of calls added up to: per task, and what the free share saved. */
export function summarizeUsage(lines: LedgerLine[], freeProviders: string[] = ["groq", "cerebras", "mock"]): UsageSummary {
  const free = (l: LedgerLine) => freeProviders.includes(l.provider.split(/[/:]/)[0]) || /:free$|^openrouter\/free$/.test(l.model);
  const tokens = (l: LedgerLine) => l.estIn + l.out;
  const groups = new Map<string, LedgerLine[]>();
  for (const l of lines) groups.set(l.task, [...(groups.get(l.task) ?? []), l]);
  const freeLines = lines.filter(free);
  const outs = lines.filter((l) => l.ok && l.estOut > 0);
  return {
    calls: lines.length,
    failed: lines.filter((l) => !l.ok).length,
    tokens: lines.reduce((s, l) => s + tokens(l), 0),
    seconds: Math.round(lines.reduce((s, l) => s + l.ms, 0) / 1000),
    freeTokens: freeLines.reduce((s, l) => s + tokens(l), 0),
    savedUsd:
      Math.round(
        freeLines.reduce((s, l) => s + (l.estIn * REFERENCE_PRICE.input + l.out * REFERENCE_PRICE.output) / 1_000_000, 0) * 100,
      ) / 100,
    byTask: [...groups.entries()]
      .map(([task, ls]) => ({
        task,
        calls: ls.length,
        tokens: ls.reduce((s, l) => s + tokens(l), 0),
        seconds: Math.round(ls.reduce((s, l) => s + l.ms, 0) / 1000),
        providers: [...new Set(ls.map((l) => l.provider))].join(", "),
      }))
      .sort((a, b) => b.tokens - a.tokens),
    estimateRatio: outs.length
      ? Math.round((outs.reduce((s, l) => s + l.out, 0) / outs.reduce((s, l) => s + l.estOut, 0)) * 100) / 100
      : null,
  };
}

// ------------------------------------------------------- metered provider

/** Writes every call of the wrapped provider to the ledger; changes nothing else. */
export class MeteredModelProvider implements ModelProvider {
  readonly name: string;
  stream?: ModelProvider["stream"];

  constructor(private readonly inner: ModelProvider, private readonly ledger: UsageLedger) {
    this.name = inner.name;
    if (inner.stream) {
      this.stream = (request, onText) => this.measure(request, () => inner.stream!(request, onText));
    }
  }

  modelFor(tier: ModelTier): string {
    return this.inner.modelFor(tier);
  }

  generate(request: ModelRequest): Promise<ModelResponse> {
    return this.measure(request, () => this.inner.generate(request));
  }

  private async measure(request: ModelRequest, call: () => Promise<ModelResponse>): Promise<ModelResponse> {
    const estimate = estimateRequest(request, this.name);
    const started = Date.now();
    const line = (ok: boolean, response?: ModelResponse): LedgerLine => ({
      at: new Date().toISOString(),
      task: request.task ?? "chat",
      provider: response?.provider ?? this.name,
      model: response?.model ?? this.inner.modelFor(request.tier),
      estIn: estimate.input,
      estOut: estimate.output,
      out: response ? estimateTokens(response.text) + estimateTokens(JSON.stringify(response.toolCalls ?? [])) : 0,
      ms: Date.now() - started,
      ok,
    });
    try {
      const response = await call();
      this.ledger.append(line(true, response));
      return response;
    } catch (err) {
      this.ledger.append(line(false));
      throw err;
    }
  }
}

// --------------------------------------------------------------- Groq pool

/**
 * Groq's free models as one provider. A request goes to the first model of
 * its tier's order that has room in its quota; a 429 cools that model for a
 * minute and the next one answers. A request too long for any model's
 * per-minute token window is refused with a reason (the router then hands it
 * to a long-context provider) rather than sent to fail.
 */
export class GroqPool implements ModelProvider {
  readonly name = "groq";

  constructor(
    private readonly members: { model: string; provider: ModelProvider }[],
    private readonly book: QuotaBook,
    private readonly order: (tier: ModelTier) => string[],
    private readonly quota: Quota = GROQ_FREE_QUOTA,
  ) {}

  modelFor(tier: ModelTier): string {
    return this.order(tier)[0] ?? this.members[0]?.model ?? "groq";
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    return this.run(request, (p) => p.generate(request));
  }

  async stream(request: ModelRequest, onText: (delta: string) => void): Promise<ModelResponse> {
    return this.run(request, (p) => (p.stream ? p.stream(request, onText) : p.generate(request)));
  }

  private async run(request: ModelRequest, call: (p: ModelProvider) => Promise<ModelResponse>): Promise<ModelResponse> {
    const estimate = estimateRequest(request, "groq");
    const tokens = estimate.input + estimate.output;
    if (tokens > this.quota.tpm * 0.9) {
      throw new Error(`groq free tier: ~${tokens} tokens do not fit its ${this.quota.tpm}/minute window — needs a long-context model`);
    }
    const wanted = this.order(request.tier);
    const candidates = [
      ...wanted.map((m) => this.members.find((x) => x.model === m)).filter(Boolean),
      ...this.members.filter((x) => !wanted.includes(x.model)),
    ] as { model: string; provider: ModelProvider }[];
    let lastError: unknown;
    for (const member of candidates) {
      const key = `groq/${member.model}`;
      if (!this.book.fits(key, this.quota, tokens)) continue;
      this.book.record(key, tokens);
      try {
        return await call(member.provider);
      } catch (err) {
        lastError = err;
        if (/\b429\b|rate.?limit/i.test(String(err))) {
          this.book.cool(key);
          continue;
        }
        throw err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("groq free tier: every model is at its quota right now");
  }
}

/** Where the ledger and the quota book live. */
export function budgetFiles(dataDir: string): { ledger: string; quotas: string } {
  return { ledger: join(dataDir, "usage-ledger.jsonl"), quotas: join(dataDir, "quotas.json") };
}
