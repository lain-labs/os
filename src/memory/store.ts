import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createLogger } from "../logger.js";
import type { EmbeddingProvider, Memory, MemoryStore } from "../types.js";
import { dot } from "./embeddings.js";

const log = createLogger("memory");

/**
 * File-backed memory store. Deliberately dependency-free: the whole store is
 * an in-memory array persisted to a JSON file.
 *
 * Retrieval has two modes, selected by whether an {@link EmbeddingProvider} is
 * supplied:
 *   - no embedder: a naive blend of keyword overlap, recency, and importance.
 *   - with embedder: semantic similarity (embedding cosine) blended with the
 *     same recency/importance terms. Per-memory vectors live in a sidecar
 *     `embeddings.json` so `memory.json` stays small and human-readable; they
 *     are backfilled lazily for any memory that predates the embedder. Note a
 *     stored vector is only comparable to others from the same embedding model,
 *     so if you change `LAINOS_EMBED_MODEL`, delete `embeddings.json`.
 *
 * Either way it is good enough for an agent's working memory, and swappable for
 * a real vector DB later (the MemoryStore interface is the contract).
 */
export class FileMemoryStore implements MemoryStore {
  private memories: Memory[] = [];
  private learned: { fact: string; metadata?: Record<string, unknown>; at: number }[] = [];
  /** memory id -> embedding vector (only populated when `embedder` is set). */
  private embeddings = new Map<string, number[]>();
  private loaded = false;
  private readonly file: string;
  private readonly embedFile: string;
  private readonly embedder?: EmbeddingProvider;

  constructor(dataDir: string, embedder?: EmbeddingProvider) {
    this.file = join(dataDir, "memory.json");
    this.embedFile = join(dataDir, "embeddings.json");
    this.embedder = embedder;
  }

  private async ensureLoaded() {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw);
      this.memories = parsed.memories ?? [];
      this.learned = parsed.learned ?? [];
    } catch {
      // Fresh store.
    }
    if (this.embedder) {
      try {
        const raw = await readFile(this.embedFile, "utf8");
        const parsed = JSON.parse(raw) as Record<string, number[]>;
        this.embeddings = new Map(Object.entries(parsed));
      } catch {
        // No sidecar yet — vectors get backfilled on demand.
      }
    }
    this.loaded = true;
  }

  private async persist() {
    await mkdir(dirname(this.file), { recursive: true });
    const payload = JSON.stringify(
      { memories: this.memories, learned: this.learned },
      null,
      2,
    );
    await writeFile(this.file, payload, "utf8");
    if (this.embedder) await this.persistEmbeddings();
  }

  /** Write just the vector sidecar (compact — not pretty-printed). */
  private async persistEmbeddings() {
    if (!this.embedder) return;
    await mkdir(dirname(this.embedFile), { recursive: true });
    const obj: Record<string, number[]> = {};
    for (const [id, vec] of this.embeddings) obj[id] = vec;
    await writeFile(this.embedFile, JSON.stringify(obj), "utf8");
  }

  /** Best-effort embedding of one text; never throws (keyword fallback covers it). */
  private async tryEmbed(text: string): Promise<number[] | undefined> {
    if (!this.embedder) return undefined;
    try {
      const [vec] = await this.embedder.embed([text]);
      return vec && vec.length ? vec : undefined;
    } catch (err) {
      log.warn("embed failed; falling back to keyword for this item", err);
      return undefined;
    }
  }

  async add(memory: Memory): Promise<void> {
    await this.ensureLoaded();
    if (!memory.id) memory.id = randomUUID();
    this.memories.push(memory);

    if (this.embedder) {
      const vec = await this.tryEmbed(memory.content);
      if (vec) this.embeddings.set(memory.id, vec);
    }

    // Keep the store bounded; archive oldest beyond a cap.
    const CAP = 5000;
    if (this.memories.length > CAP) {
      const dropped = this.memories.slice(0, this.memories.length - CAP);
      this.memories = this.memories.slice(this.memories.length - CAP);
      for (const m of dropped) this.embeddings.delete(m.id);
    }
    await this.persist();
  }

  async recent(roomId: string, limit: number): Promise<Memory[]> {
    await this.ensureLoaded();
    return this.memories
      .filter((m) => m.roomId === roomId)
      .slice(-limit);
  }

  async search(roomId: string, query: string, limit: number): Promise<Memory[]> {
    await this.ensureLoaded();
    const inRoom = this.memories.filter((m) => m.roomId === roomId);

    if (this.embedder && inRoom.length) {
      const semantic = await this.semanticRank(inRoom, query, limit);
      if (semantic) return semantic;
      // Embedding the query failed — fall through to keyword retrieval.
    }

    const terms = tokenize(query);
    const now = Date.now();
    return inRoom
      .map((m) => {
        const overlap = keywordOverlap(terms, tokenize(m.content));
        const recency = recencyScore(now, m.createdAt);
        const importance = (m.importance ?? 0) * 0.1;
        return { m, score: overlap * 2 + recency + importance };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.m);
  }

  /**
   * Rank `inRoom` memories by embedding cosine similarity to `query`, blended
   * with the same recency/importance terms the keyword path uses. Returns null
   * if the query couldn't be embedded, so the caller can fall back.
   */
  private async semanticRank(
    inRoom: Memory[],
    query: string,
    limit: number,
  ): Promise<Memory[] | null> {
    // Backfill vectors for memories that predate the embedder, in one batch.
    const missing = inRoom.filter((m) => !this.embeddings.has(m.id));
    if (missing.length && this.embedder) {
      try {
        const vecs = await this.embedder.embed(missing.map((m) => m.content));
        missing.forEach((m, i) => {
          if (vecs[i]?.length) this.embeddings.set(m.id, vecs[i]);
        });
        await this.persistEmbeddings();
      } catch (err) {
        log.warn("embedding backfill failed", err);
      }
    }

    const qv = await this.tryEmbed(query);
    if (!qv) return null;

    const now = Date.now();
    return inRoom
      .map((m) => {
        const ev = this.embeddings.get(m.id);
        const sim = ev ? Math.max(0, dot(qv, ev)) : 0;
        const recency = recencyScore(now, m.createdAt);
        const importance = (m.importance ?? 0) * 0.1;
        return { m, score: sim * 2 + recency + importance };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.m);
  }

  async remember(fact: string, metadata?: Record<string, unknown>): Promise<void> {
    await this.ensureLoaded();
    const norm = fact.trim();
    if (!norm) return;
    if (this.learned.some((l) => l.fact.toLowerCase() === norm.toLowerCase())) return;
    this.learned.push({ fact: norm, metadata, at: Date.now() });
    const CAP = 500;
    if (this.learned.length > CAP) this.learned = this.learned.slice(-CAP);
    await this.persist();
  }

  async facts(limit: number): Promise<string[]> {
    await this.ensureLoaded();
    return this.learned.slice(-limit).map((l) => l.fact);
  }
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "is", "are", "was", "to", "of", "in",
  "on", "for", "with", "i", "you", "it", "this", "that", "my", "your",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gi, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function keywordOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  let hits = 0;
  for (const t of a) if (setB.has(t)) hits++;
  return hits / a.length;
}

/** Smoothly decays toward 0 as a memory ages. */
function recencyScore(now: number, createdAt: number): number {
  const ageHours = (now - createdAt) / 3_600_000;
  return 1 / (1 + ageHours);
}
