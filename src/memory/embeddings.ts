import { createLogger } from "../logger.js";
import type { EmbeddingProvider } from "../types.js";

const log = createLogger("embeddings");

/**
 * Embedding backends for semantic memory retrieval.
 *
 * Two implementations, same interface:
 *   - {@link OpenAIEmbeddingProvider} — any OpenAI-compatible `/embeddings`
 *     endpoint (OpenAI, a local Ollama / text-embeddings-inference server, …).
 *     Real semantic similarity: synonyms and paraphrases score close.
 *   - {@link HashingEmbeddingProvider} — a dependency-free, offline,
 *     deterministic feature-hashing embedder. Lexical (not truly semantic), but
 *     it keeps the framework's "works with zero config" promise and shares the
 *     exact code path, so swapping in a real endpoint needs no other changes.
 *
 * Vectors are L2-normalised, so cosine similarity is a plain dot product
 * ({@link dot}).
 */

// --- vector helpers ---------------------------------------------------------

/** L2-normalise in place-safe fashion; a zero vector is returned unchanged. */
export function normalize(vec: number[]): number[] {
  let norm = 0;
  for (const x of vec) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  return vec.map((x) => x / norm);
}

/** Dot product. With normalised inputs this equals cosine similarity. */
export function dot(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

// --- offline hashing embedder ----------------------------------------------

/** FNV-1a 32-bit. Fast, dependency-free, good enough for feature hashing. */
function fnv1a(str: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gi, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/** Character n-grams (with word boundaries) give the hashing embedder a little
 * fuzziness, so "wallet" and "wallets" land partly in the same buckets. */
function charNGrams(token: string, n = 3): string[] {
  const s = `^${token}$`;
  const out: string[] = [];
  for (let i = 0; i + n <= s.length; i++) out.push(s.slice(i, i + n));
  return out;
}

function addFeature(vec: number[], feature: string, weight: number): void {
  const h = fnv1a(feature);
  const idx = h % vec.length;
  // A sign from an independent hash halves the bias from bucket collisions.
  const sign = (fnv1a(feature, 0x12345678) & 1) === 0 ? 1 : -1;
  vec[idx] += sign * weight;
}

export class HashingEmbeddingProvider implements EmbeddingProvider {
  readonly name = "hash";
  readonly dimensions: number;

  constructor(dimensions = 512) {
    this.dimensions = dimensions > 0 ? dimensions : 512;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }

  private embedOne(text: string): number[] {
    const vec = new Array<number>(this.dimensions).fill(0);
    for (const tok of tokenize(text)) {
      addFeature(vec, tok, 1);
      for (const g of charNGrams(tok)) addFeature(vec, g, 0.5);
    }
    return normalize(vec);
  }
}

// --- OpenAI-compatible embedder --------------------------------------------

export interface OpenAIEmbeddingOptions {
  /** Omit for a local server that needs no auth. */
  apiKey?: string;
  /** Defaults to OpenAI; point at e.g. http://localhost:11434/v1 for Ollama. */
  baseUrl?: string;
  model: string;
  /** Optional `dimensions` param (OpenAI v3 models support shrinking). */
  dimensions?: number;
}

interface EmbeddingsResponse {
  data?: { embedding: number[]; index: number }[];
  error?: { message?: string };
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai";
  readonly dimensions: number;
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly requestDimensions?: number;

  constructor(opts: OpenAIEmbeddingOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.model = opts.model;
    this.requestDimensions = opts.dimensions;
    // A hint only — the store compares query/doc vectors from the same model,
    // so the true length is whatever the endpoint returns.
    this.dimensions = opts.dimensions ?? 1536;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.model,
        input: texts,
        ...(this.requestDimensions ? { dimensions: this.requestDimensions } : {}),
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`embeddings HTTP ${res.status}: ${detail.slice(0, 300)}`);
    }

    const data = (await res.json()) as EmbeddingsResponse;
    if (data.error) throw new Error(`embeddings error: ${data.error.message}`);
    if (!data.data?.length) throw new Error("embeddings: empty response");

    // The API may reorder; restore the input order via `index`.
    const out: number[][] = new Array(texts.length);
    for (const row of data.data) out[row.index] = normalize(row.embedding);
    for (let i = 0; i < out.length; i++) if (!out[i]) out[i] = [];
    return out;
  }
}

// --- selection --------------------------------------------------------------

/**
 * Pick an embedding provider from the environment, mirroring
 * `createModelProvider`'s selection style.
 *
 * Selection order:
 *   1. LAINOS_EMBED_PROVIDER (openai | hash | none), if set
 *   2. LAINOS_EMBED_API_KEY / OPENAI_API_KEY, or LAINOS_EMBED_BASE_URL present
 *      -> OpenAI-compatible endpoint
 *   3. otherwise -> undefined (the memory store keeps its keyword retrieval)
 *
 * Returning `undefined` is deliberate: semantic recall is opt-in, so a default
 * install adds no latency or external dependency and behaves exactly as before.
 */
export function createEmbeddingProvider(
  getSetting: (key: string) => string | undefined,
): EmbeddingProvider | undefined {
  const explicit = getSetting("LAINOS_EMBED_PROVIDER")?.toLowerCase();
  if (explicit === "none") return undefined;

  const dims = getSetting("LAINOS_EMBED_DIMENSIONS");
  const dimsNum = dims ? Number(dims) : undefined;

  if (explicit === "hash") {
    log.info(`using offline hashing embedder (dims=${dimsNum ?? 512}).`);
    return new HashingEmbeddingProvider(dimsNum ?? 512);
  }

  const apiKey = getSetting("LAINOS_EMBED_API_KEY") ?? getSetting("OPENAI_API_KEY");
  const baseUrl = getSetting("LAINOS_EMBED_BASE_URL");
  const model = getSetting("LAINOS_EMBED_MODEL") ?? "text-embedding-3-small";

  if (explicit === "openai" || apiKey || baseUrl) {
    log.info(`using OpenAI-compatible embedder (model=${model}).`);
    return new OpenAIEmbeddingProvider({
      apiKey,
      baseUrl,
      model,
      dimensions: dimsNum && Number.isFinite(dimsNum) ? dimsNum : undefined,
    });
  }

  log.info("no embedding provider configured — memory uses keyword retrieval.");
  return undefined;
}
