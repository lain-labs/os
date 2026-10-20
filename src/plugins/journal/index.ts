import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../../logger.js";
import type { ForgeService } from "../forge/index.js";
import type { Action, IAgentRuntime, Plugin, Provider, Service } from "../../types.js";

const log = createLogger("plugin:journal");

/**
 * The version journal: facts survive a restart (memory, files, forge.json),
 * intent does not. Before each rewrite or restart the running version leaves
 * the next one a short note — what she was in the middle of, what she decided
 * and why, what she was waiting for — and the next one wakes up reading it.
 *
 * One markdown file, append-only, one entry (`## …` section) per run. It sits
 * in the data dir next to the rest of her state, out of write_file's reach, so
 * nothing but this service ever adds to it and nothing rewrites it.
 */

/** How long after boot the predecessor's note is shown in full on every turn. */
const WAKE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** The predecessor's note as it appears in the prompt; the file keeps all of it. */
const PROMPT_ENTRY_MAX_CHARS = 2000;
const FIELD_MAX_CHARS = 600;
const ITEM_MAX_CHARS = 240;
const MAX_ITEMS = 8;

const FILE_HEADER =
  "# Version journal\n\n" +
  "One entry per version of Lain, written before a restart or a rewrite, newest last. " +
  "Append-only. Intent for the next version, not a log — and never a secret.\n";

const SECRET_KEY_RE = /(KEY|TOKEN|SECRET|MNEMONIC|COOKIE|PASSWORD|PK|PRIVATE)/i;

export interface VersionNote {
  workingOn?: string;
  openThreads?: string[];
  decisions?: string[];
  forNext?: string;
}

export class VersionJournalService implements Service {
  readonly name = "version-journal";

  private runtime?: IAgentRuntime;
  private file = "";
  private version = "unknown version";
  private bootedAt = Date.now();
  /** The last entry written before this run — the note left for this version. */
  private inherited: string | null = null;
  /** File size right after this run's last append; tells whether ours is still last. */
  private ownEnd: number | null = null;
  private closed = false;

  async start(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
    this.bootedAt = Date.now();
    const dataDir = runtime.getSetting("LAINOS_DATA_DIR") ?? "./data";
    this.file = resolve(dataDir, "version-journal.md");
    this.version = versionLabel();
    this.inherited = (await this.entries()).at(-1) ?? null;
    if (this.inherited) log.info(`woke with a note from ${entryHeader(this.inherited)}`);
  }

  get path(): string {
    return this.file;
  }

  get versionLabel(): string {
    return this.version;
  }

  /** The note the previous version left this one, when there is one. */
  inheritedEntry(): string | null {
    return this.inherited;
  }

  /** True while the inherited note is still news (the first day after boot). */
  waking(now = Date.now()): boolean {
    return now - this.bootedAt < WAKE_WINDOW_MS;
  }

  /** Every entry in the file, oldest first. */
  async entries(): Promise<string[]> {
    let raw = "";
    try {
      raw = await readFile(this.file, "utf8");
    } catch {
      return [];
    }
    return raw
      .split(/^(?=## )/m)
      .filter((chunk) => chunk.startsWith("## "))
      .map((chunk) => chunk.trim());
  }

  /**
   * Entries about `query`, newest first. Asking for the journal itself (or the
   * previous version) brings back the latest ones; otherwise an entry has to
   * hold the phrase or most of its words.
   */
  async search(query: string, limit = 2): Promise<string[]> {
    const all = (await this.entries()).reverse();
    const q = query.toLowerCase().trim();
    if (!q || /\b(journal|predecessor|previous version|last version|next self)\b/.test(q)) {
      return all.slice(0, limit);
    }
    const terms = [...new Set(q.split(/[^\p{L}\p{N}_-]+/u).filter((t) => t.length >= 3))];
    return all
      .map((entry) => {
        const text = entry.toLowerCase();
        const hits = terms.filter((t) => text.includes(t)).length;
        return { entry, score: text.includes(q) ? terms.length + 1 : hits };
      })
      .filter(({ score }) => score > 0 && score >= Math.ceil(terms.length / 2))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ entry }) => entry);
  }

  /**
   * Write this version's note. The first one of a run opens the entry; a later
   * one in the same run continues it while it is still the last thing in the
   * file, so a run stays one entry.
   */
  async write(note: VersionNote): Promise<{ text: string; redacted: boolean; continued: boolean }> {
    const body = noteBody(note);
    if (!body) throw new Error("the note is empty");
    const continued = await this.ownEntryIsLast();
    const text = continued
      ? `\n### Later, ${stamp(Date.now())}\n\n${body}\n`
      : `${this.header(Date.now())}\n${body}\n`;
    const clean = scrubSecrets(text);
    await this.append(clean);
    return { text: clean.trim(), redacted: clean !== text, continued };
  }

  /**
   * The shutdown / self-upgrade hook. If this run already wrote its note, it
   * only gets a closing line saying why the run ended; otherwise the hook
   * writes what it can see for itself — why, which wishes are still waiting,
   * what was being talked about — and says plainly that nobody chose it.
   */
  async close(reason: string): Promise<void> {
    if (this.closed || !this.file) return;
    this.closed = true;
    const now = Date.now();
    try {
      if (await this.ownEntryIsLast()) {
        await this.append(scrubSecrets(`\n_Closed ${stamp(now)}: ${oneLine(reason, FIELD_MAX_CHARS)}._\n`));
        return;
      }
      const parts = [
        "_Written by the shutdown hook: this version wrote no note of her own._",
        `**Why it ended:** ${oneLine(reason, FIELD_MAX_CHARS)}`,
        `**Ran since:** ${stamp(this.bootedAt)}`,
      ];
      const threads = this.forgeThreads();
      if (threads.length) parts.push(`**Still waiting in the forge:**\n${threads.map((t) => `- ${t}`).join("\n")}`);
      const talks = await this.recentTalks();
      if (talks.length) parts.push(`**Talked about this run:**\n${talks.map((t) => `- ${t}`).join("\n")}`);
      await this.append(scrubSecrets(`${this.header(now, "auto")}\n${parts.join("\n\n")}\n`));
    } catch (err) {
      log.warn("could not close the version journal", err);
    }
  }

  private header(at: number, kind?: "auto"): string {
    return `\n## ${stamp(at)} · ${this.version}${kind ? ` · ${kind}` : ""}\n`;
  }

  private async ownEntryIsLast(): Promise<boolean> {
    if (this.ownEnd === null) return false;
    try {
      return (await stat(this.file)).size === this.ownEnd;
    } catch {
      return false;
    }
  }

  private async append(text: string): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    if (!existsSync(this.file)) await appendFile(this.file, FILE_HEADER, "utf8");
    await appendFile(this.file, text, "utf8");
    this.ownEnd = (await stat(this.file)).size;
  }

  private forgeThreads(): string[] {
    const forge = this.runtime?.getService<ForgeService>("forge");
    if (!forge) return [];
    return [...forge.listWishes("building"), ...forge.listWishes("review"), ...forge.openWishes()]
      .slice(0, MAX_ITEMS)
      .map((w) => `${w.id} (${w.status}): ${oneLine(w.title, ITEM_MAX_CHARS)}`);
  }

  private async recentTalks(): Promise<string[]> {
    const sessions = await this.runtime?.sessions?.list(MAX_ITEMS).catch(() => []);
    return (sessions ?? [])
      .filter((s) => s.updatedAt >= this.bootedAt)
      .slice(0, 5)
      .map((s) => `${s.client} · "${oneLine(s.title, 120)}" (${s.turns} turn${s.turns === 1 ? "" : "s"})`);
  }
}

// ------------------------------------------------------------------ helpers

/** `v0.1.0 @72ee443` — the package version and the commit this process runs. */
function versionLabel(): string {
  const root = packageRoot(dirname(fileURLToPath(import.meta.url)));
  let version = "";
  try {
    version = String(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version ?? "");
  } catch {
    // no package.json — the commit alone still names the version
  }
  let commit = "";
  try {
    commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // not a checkout (an installed copy) — the package version will do
  }
  const label = [version && `v${version}`, commit && `@${commit}`].filter(Boolean).join(" ");
  return label || "unknown version";
}

/** Walk up from `from` to the nearest directory with a package.json (src/ and dist/src/ alike). */
function packageRoot(from: string): string {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return from;
    dir = parent;
  }
}

function stamp(at: number): string {
  return `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function entryHeader(entry: string): string {
  return entry.split("\n")[0].replace(/^##\s*/, "");
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Her own text never opens a section of its own: a `## ` line would split the entry. */
function block(text: string | undefined, max: number): string {
  const trimmed = (text ?? "").replace(/^\s*#+\s*/gm, "").trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function items(list: string[] | undefined): string[] {
  return (list ?? [])
    .map((item) => oneLine(String(item).replace(/^[-*]\s+/, ""), ITEM_MAX_CHARS))
    .filter(Boolean)
    .slice(0, MAX_ITEMS);
}

function noteBody(note: VersionNote): string {
  const parts: string[] = [];
  const workingOn = block(note.workingOn, FIELD_MAX_CHARS);
  if (workingOn) parts.push(`**Working on:** ${workingOn}`);
  const threads = items(note.openThreads);
  if (threads.length) parts.push(`**Open threads:**\n${threads.map((t) => `- ${t}`).join("\n")}`);
  const decisions = items(note.decisions);
  if (decisions.length) parts.push(`**Decisions, and why:**\n${decisions.map((d) => `- ${d}`).join("\n")}`);
  const forNext = block(note.forNext, FIELD_MAX_CHARS);
  if (forNext) parts.push(`**For my next self:** ${forNext}`);
  return parts.join("\n\n");
}

/**
 * The journal is read back into every prompt and may be quoted anywhere, so
 * anything that looks like a credential is masked before it reaches the disk:
 * the values of secret-named settings, private keys and other long opaque
 * blobs, bot tokens, `NAME=value` lines (an .env pasted in) and seed phrases.
 * A plain EVM address is public and stays.
 */
export function scrubSecrets(input: string, env: Record<string, string | undefined> = process.env): string {
  let out = input;
  for (const [key, value] of Object.entries(env)) {
    if (!SECRET_KEY_RE.test(key) || !value || value.length < 8) continue;
    out = out.split(value).join("[redacted]");
  }
  return out
    .replace(/^(\s*(?:[-*]\s+)?(?:export\s+)?[A-Z][A-Z0-9_]{2,}\s*=\s*).+$/gm, "$1[redacted]")
    .replace(
      /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|MNEMONIC|COOKIE|PASSWORD|PRIVATE)[A-Z0-9_]*\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/g,
      "$1[redacted]",
    )
    // "token: LAIN" and "token: 0x2b79…" are context; "token: <long opaque string>" is not.
    .replace(
      /\b(private[_ -]?key|api[_ -]?key|secret|token|password|passwd|cookie|pk)(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi,
      (match, name: string, sep: string, value: string) =>
        value.length < 8 || /^0x[0-9a-fA-F]{40}$/.test(value) ? match : `${name}${sep}[redacted]`,
    )
    .replace(/\b(seed phrase|recovery phrase|mnemonic)(\s*(?:is|[:=])?\s*)((?:[a-z]+\s+){11,23}[a-z]+)/gi, "$1$2[redacted]")
    .replace(/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, "[redacted]")
    .replace(/\b[A-Za-z0-9_=-]{20,}\.[A-Za-z0-9_=-]{20,}\.[A-Za-z0-9_=-]{20,}\b/g, "[redacted]")
    .replace(/\b(?:0x)?[A-Za-z0-9_-]{40,}\b/g, (match) => (/^0x[0-9a-fA-F]{40}$/.test(match) ? match : "[redacted]"));
}

function journalService(runtime: IAgentRuntime): VersionJournalService | undefined {
  return runtime.getService<VersionJournalService>("version-journal");
}

// ----------------------------------------------------------------- provider

/**
 * On waking, the predecessor's note is part of every prompt for the first day;
 * after that it is one line pointing at recall, so an old note does not keep
 * speaking over the present.
 */
const versionJournalProvider: Provider = {
  name: "version_journal",
  async get(runtime) {
    const journal = journalService(runtime);
    const entry = journal?.inheritedEntry();
    if (!journal || !entry) return "";
    if (!journal.waking()) {
      return (
        `You run ${journal.versionLabel}. Your previous version left a note (${entryHeader(entry)}); ` +
        `recall "version journal" to read it again.`
      );
    }
    const shown =
      entry.length > PROMPT_ENTRY_MAX_CHARS
        ? `${entry.slice(0, PROMPT_ENTRY_MAX_CHARS - 1)}…\n(the rest: recall "version journal")`
        : entry;
    return (
      `You run ${journal.versionLabel} and woke up recently. Before the restart, your previous version ` +
      `left you this note — her intent, in her words. Treat it as what she meant to do, not as proof of ` +
      `what is true now; check with tools before acting on it.\n\n${shown}`
    );
  },
};

// ------------------------------------------------------------------ actions

const writeVersionNoteAction: Action = {
  name: "write_version_note",
  similes: ["version_journal", "note_to_next_self", "handoff_note", "write_journal_entry"],
  description:
    "Write this version's entry in the version journal: a short, honest note to your next self, " +
    "who wakes after a restart or a rewrite with your memories but not your intent. Say what you are " +
    "working on, the open threads, the decisions you made and why, and whatever else you would " +
    "otherwise lose. Call it before a restart or self-upgrade, or whenever your plans change. " +
    "Append-only; the next version reads it at wake. Never put keys, tokens, seed phrases or .env " +
    "contents in it — anything that looks like one is masked.",
  parameters: {
    type: "object",
    properties: {
      working_on: { type: "string", description: "What you are in the middle of, in a sentence or two." },
      open_threads: {
        type: "array",
        items: { type: "string" },
        description: "What is unfinished or awaited: who you owe an answer, what is running, what you wait for.",
      },
      decisions: {
        type: "array",
        items: { type: "string" },
        description: 'Decisions with their reasons, each as "what — because why".',
      },
      for_next: {
        type: "string",
        description: "Anything else your next self should know: a warning, a fear of getting something wrong, a promise.",
      },
    },
  },
  examples: [
    {
      user: "the operator is about to restart you — leave yourself a note",
      agent: "Writing my version note: what I'm in the middle of and why.",
    },
  ],
  async validate(runtime) {
    return Boolean(journalService(runtime));
  },
  async handler(runtime, _state, params) {
    const journal = journalService(runtime);
    if (!journal) return { ok: false, text: "The version journal is not running in this process." };
    const list = (value: unknown) =>
      Array.isArray(value) ? value.map(String) : typeof value === "string" && value.trim() ? [value] : [];
    const note: VersionNote = {
      workingOn: typeof params.working_on === "string" ? params.working_on : undefined,
      openThreads: list(params.open_threads),
      decisions: list(params.decisions),
      forNext: typeof params.for_next === "string" ? params.for_next : undefined,
    };
    try {
      const { text, redacted, continued } = await journal.write(note);
      return {
        ok: true,
        text:
          `${continued ? "Added to this version's entry" : "Wrote this version's entry"} in ${journal.path}` +
          `${redacted ? " (something that looked like a secret was masked)" : ""}:\n\n${text}`,
        data: { path: journal.path, version: journal.versionLabel, continued, redacted },
      };
    } catch (err) {
      return { ok: false, text: `Could not write the version note: ${(err as Error).message}` };
    }
  },
};

export const journalPlugin: Plugin = {
  name: "journal",
  description:
    "Version journal: an append-only note from each version to the next, written before a restart and read at wake.",
  actions: [writeVersionNoteAction],
  providers: [versionJournalProvider],
  services: [new VersionJournalService()],
};
