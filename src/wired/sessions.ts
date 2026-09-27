import { randomBytes, randomUUID } from "node:crypto";
import type { Address, Hex } from "viem";
import type { RunProof, Session } from "./types.js";

/**
 * In-memory session store (model B). Issues a seed/nonce per session, rate-limits
 * per address, and runs plausibility checks before a ticket is granted.
 *
 * Honest scope: these checks raise the bar (binding, rate-limit, timing) but a
 * determined bot can still satisfy them. The *unforgeable* guarantee is the
 * on-chain duel in WiredForge — this layer just gates entry and difficulty.
 */

export interface SessionConfig {
  ttlMs: number;
  fragmentsRequired: number;
  minRunMs: number; // a run faster than this is rejected as implausible
  rateLimitPerMin: number;
}

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  ttlMs: 10 * 60_000,
  fragmentsRequired: 3,
  minRunMs: 8_000,
  rateLimitPerMin: 5,
};

export interface ValidationResult {
  ok: boolean;
  reason?: string;
  session?: Session;
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly recent = new Map<string, number[]>(); // player -> timestamps
  private readonly cfg: SessionConfig;

  constructor(cfg: Partial<SessionConfig> = {}) {
    this.cfg = { ...DEFAULT_SESSION_CONFIG, ...cfg };
  }

  get config(): SessionConfig {
    return this.cfg;
  }

  /** Begin a session, or return an error when rate-limited. */
  start(player: Address, tier = 0): Session | { error: string } {
    const key = player.toLowerCase();
    const now = Date.now();
    const hits = (this.recent.get(key) ?? []).filter((t) => now - t < 60_000);
    if (hits.length >= this.cfg.rateLimitPerMin) {
      return { error: "rate limit: too many sessions, slow down" };
    }
    hits.push(now);
    this.recent.set(key, hits);

    const seed = `0x${randomBytes(32).toString("hex")}` as Hex;
    const nonce = BigInt(`0x${randomBytes(32).toString("hex")}`);
    const deadline = BigInt(Math.floor(now / 1000) + Math.floor(this.cfg.ttlMs / 1000));

    const session: Session = {
      id: randomUUID(),
      player,
      tier,
      seed,
      nonce,
      deadline,
      createdAt: now,
      ticketIssued: false,
    };
    this.sessions.set(session.id, session);
    this.prune();
    return session;
  }

  /** Validate a run report and, if ok, consume the session (one ticket each). */
  validate(id: string, player: Address, proof: RunProof): ValidationResult {
    const s = this.sessions.get(id);
    if (!s) return { ok: false, reason: "unknown session" };
    if (s.player.toLowerCase() !== player.toLowerCase()) {
      return { ok: false, reason: "wrong player for session" };
    }
    if (s.ticketIssued) return { ok: false, reason: "ticket already issued for this session" };
    if (Date.now() - s.createdAt > this.cfg.ttlMs) return { ok: false, reason: "session expired" };
    if (!proof || typeof proof.collected !== "number" || typeof proof.elapsedMs !== "number") {
      return { ok: false, reason: "malformed proof" };
    }
    if (proof.collected < this.cfg.fragmentsRequired) {
      return { ok: false, reason: `need ${this.cfg.fragmentsRequired} fragments, got ${proof.collected}` };
    }
    if (proof.elapsedMs < this.cfg.minRunMs) {
      return { ok: false, reason: "run too fast to be plausible" };
    }
    s.ticketIssued = true; // consume
    return { ok: true, session: s };
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (now - s.createdAt > this.cfg.ttlMs * 2) this.sessions.delete(id);
    }
  }
}
