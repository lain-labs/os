/**
 * The composer's input history — bash-style ↑/↓ recall of what was typed.
 *
 * The list is kept on disk next to the other TUI prefs, so the lines you sent
 * yesterday are still under ↑ tomorrow. Pure logic lives in
 * {@link InputHistory} so it can be driven without a terminal
 * (`npm run keys:smoke`).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** How many past inputs are remembered; the oldest fall off the front. */
export const HISTORY_LIMIT = 500;

const dataDir = () => process.env.LAINOS_DATA_DIR ?? "./data";
const historyPath = () => join(dataDir(), "tui-history.json");

/** Read the saved input history (empty on a first run or a mangled file). */
export function loadInputHistory(): string[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(historyPath(), "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.filter((x): x is string => typeof x === "string" && x.length > 0).slice(-HISTORY_LIMIT);
  } catch {
    return [];
  }
}

/** Persist the input history. Best-effort: a read-only data dir is not fatal. */
export function saveInputHistory(entries: readonly string[]): void {
  try {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(historyPath(), JSON.stringify(entries.slice(-HISTORY_LIMIT)));
  } catch {
    /* best-effort only */
  }
}

/**
 * A readline-style history cursor: {@link prev} walks back, {@link next} walks
 * forward and finally restores the draft that was being typed when the walk
 * started.
 */
export class InputHistory {
  private items: string[];
  /** Position in `items`, or null while the live draft is being edited. */
  private idx: number | null = null;
  private draft = "";

  constructor(items: readonly string[] = []) {
    this.items = items.slice(-HISTORY_LIMIT);
  }

  get entries(): readonly string[] {
    return this.items;
  }

  /** True while ↑/↓ are walking history rather than editing a fresh line. */
  get browsing(): boolean {
    return this.idx !== null;
  }

  /** Record a submitted line. Returns true when the stored list changed. */
  push(text: string): boolean {
    this.reset();
    if (!text) return false;
    if (this.items[this.items.length - 1] === text) return false; // no twins in a row
    this.items.push(text);
    if (this.items.length > HISTORY_LIMIT) this.items.splice(0, this.items.length - HISTORY_LIMIT);
    return true;
  }

  /** ↑ — the previous entry, or null when there is nothing to recall. */
  prev(current: string): string | null {
    if (!this.items.length) return null;
    if (this.idx === null) {
      this.draft = current;
      this.idx = this.items.length - 1;
    } else if (this.idx > 0) {
      this.idx -= 1;
    }
    return this.items[this.idx];
  }

  /** ↓ — the next entry, ending on the draft; null if not browsing. */
  next(): string | null {
    if (this.idx === null) return null;
    if (this.idx < this.items.length - 1) {
      this.idx += 1;
      return this.items[this.idx];
    }
    this.idx = null;
    return this.draft;
  }

  /** Stop browsing — any edit to the line does this. */
  reset(): void {
    this.idx = null;
    this.draft = "";
  }
}
