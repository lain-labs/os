/**
 * Sessions — the index over the conversation memory.
 *
 * `memory.json` already keeps every message forever, keyed by room, which is
 * storage, not a session: nothing there says when a conversation started, what
 * it was about, which models answered it, or how to get back into it. This is
 * that index. One record per room, written as turns happen, so *every* surface
 * that talks to Lain (the TUI, the REPL, the HTTP bridge, Telegram) leaves a
 * session behind without asking to.
 *
 * Deliberately dependency-free and file-backed like {@link FileMemoryStore}:
 * one JSON file, human-readable, safe to delete.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../logger.js";

const log = createLogger("sessions");

export interface SessionRecap {
  text: string;
  at: number;
  /** Model that wrote it — a recap is provenance like any other answer. */
  model: string;
}

export interface SessionRecord {
  /** Short stable handle an operator types: `s-mf3k2x`. */
  id: string;
  /** Memory room this session's messages live in. */
  roomId: string;
  /** Which surface it happened on: tui | cli | http | tg | … */
  client: string;
  /** First thing the operator said, clipped — the only honest auto-title. */
  title: string;
  createdAt: number;
  updatedAt: number;
  turns: number;
  /** model id → turns answered by it. */
  models: Record<string, number>;
  /** task kind → turns of that kind. */
  tasks: Record<string, number>;
  /** tool name → times called. */
  tools: Record<string, number>;
  recap?: SessionRecap;
}

/** What one finished turn contributes to its session. */
export interface TurnRecord {
  roomId: string;
  client?: string;
  userText?: string;
  model?: string;
  task?: string;
  tools?: string[];
}

const DEFAULT_LIMIT = 300;

/** Room id for a fresh session on a surface: `tui-mf3k2x`. */
export function newRoomId(client: string): string {
  return `${client}-${Date.now().toString(36)}${Math.floor(Math.random() * 36 ** 2)
    .toString(36)
    .padStart(2, "0")}`;
}

/** The surface a room belongs to, read off its own id. */
export function clientOfRoom(roomId: string): string {
  if (roomId.startsWith("tg-")) return "tg";
  const dash = roomId.indexOf("-");
  return dash > 0 ? roomId.slice(0, dash) : roomId;
}

function clip(text: string, n: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
}

export class SessionStore {
  private sessions: SessionRecord[] = [];
  private loaded = false;
  private readonly file: string;
  private readonly limit: number;
  /** Writes are serialised: several surfaces record turns into one file. */
  private writes: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string, limit = DEFAULT_LIMIT) {
    this.file = join(dataDir, "sessions.json");
    this.limit = limit;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as {
        sessions?: SessionRecord[];
      };
      this.sessions = parsed.sessions ?? [];
    } catch {
      // Fresh store.
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    // Only the index is capped — the messages themselves stay in memory.json,
    // so trimming here loses a title, never a conversation.
    if (this.sessions.length > this.limit) {
      this.sessions = [...this.sessions]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, this.limit);
    }
    const body = `${JSON.stringify({ version: 1, sessions: this.sessions }, null, 2)}\n`;
    this.writes = this.writes
      .then(async () => {
        await mkdir(join(this.file, ".."), { recursive: true });
        await writeFile(this.file, body, "utf8");
      })
      .catch((err) => log.warn("could not write sessions.json", err));
    await this.writes;
  }

  /** Start (or adopt) the session for a room. */
  async open(opts: { roomId: string; client?: string; title?: string }): Promise<SessionRecord> {
    await this.ensureLoaded();
    const existing = this.sessions.find((s) => s.roomId === opts.roomId);
    if (existing) return existing;
    const now = Date.now();
    const record: SessionRecord = {
      id: `s-${now.toString(36)}`,
      roomId: opts.roomId,
      client: opts.client ?? clientOfRoom(opts.roomId),
      title: opts.title ? clip(opts.title, 60) : "",
      createdAt: now,
      updatedAt: now,
      turns: 0,
      models: {},
      tasks: {},
      tools: {},
    };
    this.sessions.push(record);
    await this.persist();
    return record;
  }

  /** Fold one finished turn into its session, creating the record if needed. */
  async record(turn: TurnRecord): Promise<SessionRecord> {
    const session = await this.open({ roomId: turn.roomId, client: turn.client });
    session.updatedAt = Date.now();
    session.turns += 1;
    if (!session.title && turn.userText) session.title = clip(turn.userText, 60);
    if (turn.model) session.models[turn.model] = (session.models[turn.model] ?? 0) + 1;
    if (turn.task) session.tasks[turn.task] = (session.tasks[turn.task] ?? 0) + 1;
    for (const tool of turn.tools ?? []) session.tools[tool] = (session.tools[tool] ?? 0) + 1;
    await this.persist();
    return session;
  }

  /**
   * Newest first. `client` narrows to one surface (the TUI lists its own).
   *
   * Two sessions touched in the same millisecond are ordered by which was
   * written last — a wall clock is not fine enough to say "newest" on its own,
   * and `/resume 1` must always mean the one you were just in.
   */
  async list(limit = 20, opts?: { client?: string }): Promise<SessionRecord[]> {
    await this.ensureLoaded();
    return this.sessions
      .map((session, index) => ({ session, index }))
      .filter(({ session }) => (opts?.client ? session.client === opts.client : true))
      .sort(
        (a, b) =>
          b.session.updatedAt - a.session.updatedAt ||
          b.session.createdAt - a.session.createdAt ||
          b.index - a.index,
      )
      .slice(0, limit)
      .map(({ session }) => session);
  }

  /**
   * Find a session by id, by room, or by its position in the recent list
   * (`1` is the most recent) — the three ways an operator refers to one.
   */
  async resolve(ref: string, opts?: { client?: string }): Promise<SessionRecord | undefined> {
    await this.ensureLoaded();
    const key = ref.trim();
    if (!key) return undefined;
    const byId = this.sessions.find((s) => s.id === key || s.roomId === key);
    if (byId) return byId;
    if (/^\d+$/.test(key)) {
      const list = await this.list(50, opts);
      return list[Number(key) - 1];
    }
    return undefined;
  }

  async setRecap(id: string, recap: SessionRecap): Promise<void> {
    await this.ensureLoaded();
    const session = this.sessions.find((s) => s.id === id);
    if (!session) return;
    session.recap = recap;
    await this.persist();
  }
}
