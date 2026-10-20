/**
 * Trend paper's books on disk, under <data>/trend-paper:
 *   - state.json   the virtual balances and where each book has read to,
 *                  written whole and renamed into place;
 *   - trades.jsonl one line per fill (and per signal the liquidity filter
 *                  turned away): time, asset, action, price, EMA, volume,
 *                  reason, balance after.
 * state.json is the commit point: it counts the journal lines it covers, and
 * lines past that count — written by a check that died before its state was
 * saved — are cut on the next load, so a restart never books a fill twice.
 */
import { mkdir, open, readFile, rename, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MODE, type AssetId } from "./config.js";
import type { Book, Decision } from "./strategy.js";

export interface AssetState {
  book: Book;
  /** Close time (ms) of the first bar the paper book read, and its close — what holding since would have made. */
  startedAt: number;
  startPx: number;
  /** Open time of the last bar read. */
  lastBar: number;
  /** [close time ms, book value in the quote coin, close] after every bar read. */
  marks: [number, number, number][];
  liquidity: number | null;
  error: string;
}

export interface TrendPaperState {
  version: 1;
  mode: typeof MODE;
  capital: Record<AssetId, number>;
  assets: Partial<Record<AssetId, AssetState>>;
  lastReportAt: number | null;
  journalLines: number;
}

/** A journal line. */
export interface JournalEntry {
  time: string;
  asset: AssetId;
  mode: typeof MODE;
  action: Decision["action"];
  price: number;
  ema: number;
  volume: number;
  median_volume: number;
  liquidity: number | null;
  reason: string;
  /** Quote coin spent (buy) or received after costs (sells). */
  quote: number;
  tokens: number;
  fee: number;
  balance_after: Record<string, number>;
}

export class Ledger {
  constructor(readonly dir: string) {}

  get statePath(): string {
    return join(this.dir, "state.json");
  }

  get journalPath(): string {
    return join(this.dir, "trades.jsonl");
  }

  async load(capital: Record<AssetId, number>): Promise<TrendPaperState> {
    let state: TrendPaperState;
    try {
      state = JSON.parse(await readFile(this.statePath, "utf8")) as TrendPaperState;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`trend-paper: state.json is unreadable, refusing to start over (${(err as Error).message})`);
      return { version: 1, mode: MODE, capital: { ...capital }, assets: {}, lastReportAt: null, journalLines: 0 };
    }
    if (state.version !== 1 || state.mode !== MODE) throw new Error("trend-paper: state.json is not a paper book this version knows");
    await this.trimJournal(state.journalLines);
    return state;
  }

  /** Journal lines first, then the state that counts them. */
  async commit(state: TrendPaperState, entries: JournalEntry[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    if (entries.length) {
      const handle = await open(this.journalPath, "a");
      try {
        await handle.writeFile(entries.map((e) => `${JSON.stringify(e)}\n`).join(""));
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    state.journalLines += entries.length;
    const tmp = `${this.statePath}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 1), "utf8");
    await rename(tmp, this.statePath);
  }

  async journal(): Promise<JournalEntry[]> {
    const text = await readFile(this.journalPath, "utf8").catch(() => "");
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as JournalEntry);
  }

  private async trimJournal(lines: number): Promise<void> {
    const text = await readFile(this.journalPath, "utf8").catch(() => null);
    if (text === null) return;
    const kept = text.split("\n").slice(0, lines);
    const body = lines ? `${kept.join("\n")}\n` : "";
    if (body.length < text.length) await truncate(this.journalPath, Buffer.byteLength(body));
  }
}
