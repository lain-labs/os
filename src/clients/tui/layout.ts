/**
 * Screen layout: the transcript feed (banner, boot line, turns, tools) and the
 * right-hand sidebar, both flattened into the same styled-line model the whole
 * TUI renders from (see markdown.ts). Pure — no ink, no React — so the app can
 * measure heights exactly, slice the scrollable feed, and map mouse clicks to
 * the exact tool / sidebar row they land on.
 */
import { THEMES, BANNER, CHAIN_ID, CHAIN_NAME, GLYPH, VERSION, lerpColor, type Theme } from "./theme.js";
import { TASKS, type TaskKind } from "../../models/tasks.js";
import {
  blank,
  concat,
  fitLine,
  lineWidth,
  mdToLines,
  sp,
  stableMarkdown,
  truncateLine,
  wrapSpans,
  type Line,
  type Span,
} from "./markdown.js";

// ------------------------------------------------------------------ turns

export interface ToolBlock {
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: "running" | "ok" | "fail";
  summary?: string;
}
export type Part = { kind: "text"; text: string } | { kind: "tool"; tool: ToolBlock };
export type Role = "you" | "lain" | "sys" | "pulse";
export type Turn = {
  id: string;
  role: Role;
  parts: Part[];
  model?: string;
  /** LainOS provider that answered: claude | codex | opencode | openrouter | anthropic … */
  provider?: string;
  /** Who ran the model upstream, when the provider is a gateway. */
  upstream?: string;
  /** What kind of work this turn was routed as (drawn as its emoji). */
  task?: TaskKind;
  /** True when a cheap task was lifted onto the main provider mid-turn. */
  escalated?: boolean;
  at?: number;
};

/** What a click on a feed line does: expand a tool, or copy a block of text. */
export type FeedRegion =
  | { kind: "tool"; toolId: string }
  | { kind: "copy"; text: string; label: string };

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const spinnerChar = (frame: number): string => SPIN[frame % SPIN.length];
// ---------------------------------------------------------------- banner

/**
 * The masthead. `compact` is the same identity in one row — used the moment a
 * conversation starts, because nine rows of ASCII art above every reply is a
 * hole in the middle of the screen, not a welcome.
 */
export function bannerLines(theme: Theme, width: number, compact = false): Line[] {
  const c = theme;
  const wide = width >= BANNER[0].length && !compact;
  const out: Line[] = [];
  if (compact) {
    const word = "LAIN OS";
    const letters = word.split("").map((ch, i) => ({
      t: ch,
      c: lerpColor(c.gradFrom, c.gradTo, i / (word.length - 1)),
      b: true,
    }));
    return [
      truncateLine(
        concat(letters, [sp(`  ${GLYPH.dot}  `, c.mutedDim)], [sp("the wired remembers", c.mutedDim)]),
        width,
      ),
      blank(width),
    ];
  }
  if (wide) {
    BANNER.forEach((row, i) => {
      out.push([{ t: row, c: lerpColor(c.gradFrom, c.gradTo, BANNER.length <= 1 ? 0 : i / (BANNER.length - 1)) }]);
    });
  } else {
    out.push([
      ..."LAIN OS".split("").map((ch, i) => ({
        t: ch,
        c: lerpColor(c.gradFrom, c.gradTo, 6 <= 1 ? 0 : i / 5),
      })),
    ]);
  }
  const tagline = "the wired remembers  ·  an autonomous agent";
  out.push(concat([sp(`${GLYPH.spark} `, c.mutedDim)], ...wrapSpans([{ t: tagline, c: c.gradFrom }], width)));
  out.push(blank(width));
  return out;
}

export function bootLines(theme: Theme, width: number): Line[] {
  const c = theme;
  const line1 = wrapSpans([{ t: "welcome to the wired. type to speak with Lain, or /help for commands.", c: c.fg }], width);
  const line2 = wrapSpans(
    [{ t: `${GLYPH.spark} tip: she reads the configured chain live — try “what's the latest block?”`, c: c.mutedDim }],
    width,
  );
  // Every launch is its own session now, so the way back to the last one has
  // to be on the first screen — otherwise a fresh start reads as a loss.
  const line3 = wrapSpans(
    [{ t: `${GLYPH.dot} /resume reopens an earlier session · /recap sums one up · /tasks says who answers what`, c: c.mutedDim }],
    width,
  );
  return [...line1, ...line2, ...line3, blank(width)];
}

// ------------------------------------------------------------------ turns

/** Wall-clock hh:mm for a turn's header. */
function clock(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Every visible character of a turn, as plain text — what a copy yields. */
export function turnText(turn: Turn): string {
  const out: string[] = [];
  for (const part of turn.parts) {
    if (part.kind === "text") {
      if (part.text.trim()) out.push(part.text.trimEnd());
    } else {
      const args = fmtArgs(part.tool.input);
      out.push(`${GLYPH.tool} ${part.tool.name}${args ? `  ${args}` : ""}`);
      if (part.tool.summary) out.push(part.tool.summary);
    }
  }
  return out.join("\n").trim();
}

function turnHeader(turn: Turn, theme: Theme, width: number): Line {
  const c = theme;
  const meta =
    turn.role === "you"
      ? { label: `${GLYPH.you} you`, color: c.secondary }
      : turn.role === "lain"
        ? { label: `${GLYPH.lain} lain`, color: c.primary }
        : turn.role === "pulse"
          ? { label: `${GLYPH.spark} wired`, color: c.muted }
          : { label: `${GLYPH.dot} sys`, color: c.mutedDim };
  const head: Line = [{ t: meta.label, c: meta.color, b: true }];
  if (turn.role === "lain" && turn.task) {
    const spec = TASKS[turn.task];
    head.push(sp(` · ${spec.emoji} ${spec.label}${turn.escalated ? "↑" : ""}`, c.mutedDim));
  }
  // Provenance, left to right: what kind of work, through which provider, on
  // which model, run by whom. A model id alone is not an answer — an alias
  // like `openrouter/free` resolves to a different model per call and says
  // nothing about who replied.
  if (turn.role === "lain") {
    if (turn.provider) head.push(sp(` · ${turn.provider}`, c.mutedDim));
    if (turn.model) head.push(sp(` · ${turn.model}`, c.mutedDim));
    if (turn.upstream) head.push(sp(` ← ${turn.upstream}`, c.mutedDim));
  }
  // The time sits hard right, so the eye reads speaker on one edge and clock on
  // the other instead of hunting through the sentence.
  const time = turn.at ? clock(turn.at) : "";
  if (!time) return head;
  const pad = width - lineWidth(head) - time.length;
  if (pad < 2) return head;
  return concat(head, blank(pad), [sp(time, c.mutedDim)]);
}

function fmtArgs(input: Record<string, unknown>): string {
  return Object.entries(input)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("  ");
}

/** One tool call, collapsed to a single line or expanded with its I/O. */
function toolLines(tool: ToolBlock, theme: Theme, width: number, spin: string): { lines: Line[]; region: FeedRegion } {
  const c = theme;
  const statusColor = tool.status === "running" ? c.warn : tool.status === "ok" ? c.ok : c.err;
  const statusGlyph = tool.status === "running" ? spin : tool.status === "ok" ? GLYPH.ok : GLYPH.fail;
  const marker = GLYPH.expand;
  const args = fmtArgs(tool.input);
  const header: Line = concat(
    [sp(`${marker} `, c.mutedDim)],
    [sp(`${statusGlyph} `, statusColor)],
    [sp(tool.name, c.secondary)],
    args ? [sp(`  ${args}`, c.mutedDim)] : [],
  );
  const lines: Line[] = [truncateLine(header, width)];
  const region: FeedRegion = { kind: "tool", toolId: tool.id };
  return { lines, region };
}

/** Expand a tool into its full input/result view. */
function expandedToolLines(tool: ToolBlock, theme: Theme, width: number): { header: Line; details: Line[] } {
  const c = theme;
  const statusColor = tool.status === "running" ? c.warn : tool.status === "ok" ? c.ok : c.err;
  const statusGlyph = tool.status === "running" ? GLYPH.dots : tool.status === "ok" ? GLYPH.ok : GLYPH.fail;
  const args = fmtArgs(tool.input);
  const header: Line = concat(
    [sp(`${GLYPH.collapse} `, c.mutedDim)],
    [sp(`${statusGlyph} `, statusColor)],
    [sp(tool.name, c.secondary)],
    args ? [sp(`  ${args}`, c.mutedDim)] : [],
  );
  const details: Line[] = [];
  const indent = 2;
  const pushLabel = (label: string) => details.push(concat(blank(indent), [sp(`─ ${label} ─`, c.mutedDim)]));
  const pushBody = (text: string, color: string) => {
    for (const l of wrapSpans([{ t: text, c: color }], width - indent - 2)) {
      details.push(concat(blank(indent + 2), l));
    }
  };
  if (args) {
    pushLabel("input");
    pushBody(args, c.fg);
  }
  if (tool.summary) {
    pushLabel("result");
    pushBody(tool.summary, tool.status === "ok" ? c.ok : c.fg);
  }
  return { header, details };
}

/** Flat text body for you/sys/pulse turns (plain, wrapped). */
function plainBody(text: string, theme: Theme, width: number, color: string): Line[] {
  return wrapSpans([{ t: text, c: color }], width);
}

/**
 * Render one turn into lines, tagging every line that belongs to a tool so a
 * click can expand/collapse it. `expanded` holds the tool ids shown in full.
 */
export function turnLines(
  turn: Turn,
  expanded: ReadonlySet<string>,
  theme: Theme,
  width: number,
  spin: string,
): { lines: Line[]; regions: (FeedRegion | undefined)[] } {
  const c = theme;
  const whole = turnText(turn);
  const lines: Line[] = [truncateLine(turnHeader(turn, theme, width), width)];
  // Clicking the name copies everything under it — the reply you actually want,
  // without dragging a mouse across a frame the app repaints under you.
  const regions: (FeedRegion | undefined)[] = [
    whole ? { kind: "copy", text: whole, label: turn.role === "lain" ? "lain's reply" : `the ${turn.role} line` } : undefined,
  ];
  for (const part of turn.parts) {
    if (part.kind === "tool") {
      const block = part.tool;
      if (expanded.has(block.id)) {
        const tool = expandedToolLines(block, theme, width);
        // The expanded header keeps the tool region; the detail rows don't.
        lines.push(truncateLine(tool.header, width));
        regions.push({ kind: "tool", toolId: block.id });
        lines.push(...tool.details);
        regions.push(...tool.details.map(() => undefined));
      } else {
        const tool = toolLines(block, theme, width, spin);
        lines.push(...tool.lines);
        regions.push(tool.region);
      }
    } else if (part.text.trim()) {
      // Code blocks report themselves line by line, so a click anywhere inside
      // one copies exactly the code — not the prose around it.
      const marks: (string | undefined)[] = [];
      const body =
        turn.role === "lain"
          ? stableMarkdown(part.text)
            ? mdToLines(part.text.trimEnd(), theme, width, marks)
            : wrapSpans([{ t: part.text, c: c.fg }], width)
          : plainBody(part.text.trimEnd(), theme, width, turn.role === "pulse" ? c.muted : turn.role === "sys" ? c.mutedDim : c.fg);
      lines.push(...body);
      regions.push(
        ...body.map((_, i) => {
          const code = marks[i];
          return code ? ({ kind: "copy", text: code, label: "the code block" } as FeedRegion) : undefined;
        }),
      );
    }
  }
  // One blank row between speakers: the transcript reads as a conversation
  // rather than one long paragraph with names sprinkled through it.
  lines.push(blank(width));
  regions.push(undefined);
  return { lines, regions };
}

// --------------------------------------------------------------- sidebar

/** A clickable sidebar row: open a picker, or run one of the copy actions.
 *  The actions have keys too, but an editor that hosts the terminal may eat
 *  those (VS Code keeps ctrl+s for itself), and a click it cannot take. */
export type SidebarRegion =
  | { kind: "pick"; action: "model" | "effort" | "skin" }
  | { kind: "act"; action: "select" | "copy" };

export interface SidebarData {
  provider: string;
  model: string;
  block: number | null;
  tokens: number;
  room: string;
  /** Session id for the current room, once it has one (first turn creates it). */
  session?: string;
  effort: string;
  skinLabel: string;
  watches: number;
  wishes: number;
  topics: number;
  skills: number;
}

/** The right sidebar as exactly `rows` lines (clickable rows carry regions). */
export function sidebarLines(
  theme: Theme,
  sidebarW: number,
  rows: number,
  data: SidebarData,
): { lines: Line[]; regions: (SidebarRegion | undefined)[] } {
  const c = theme;
  const inner = Math.max(4, sidebarW - 2);
  const box = (l: Line): Line => concat([sp("│", c.border)], fitLine(l, inner), [sp("│", c.border)]);
  const pickRow = (
    label: string,
    value: string,
    valColor: string,
    action: "model" | "effort" | "skin",
  ): { line: Line; region?: SidebarRegion } => ({
    line: box(concat([sp(`${label} `, c.mutedDim)], [sp(value, valColor)])),
    region: { kind: "pick", action },
  });
  const infoRow = (label: string, value: string): { line: Line; region?: SidebarRegion } => ({
    line: box(concat([sp(`${label} `, c.mutedDim)], [sp(value, c.fg)])),
  });
  const gap: { line: Line; region?: SidebarRegion } = { line: box(blank(inner)) };
  const hintRow = (label: string, value: string): { line: Line; region?: SidebarRegion } => ({
    line: box(concat([sp(`${label} `, c.mutedDim)], [sp(value, c.muted)])),
  });
  const actRow = (
    label: string,
    value: string,
    action: "select" | "copy",
  ): { line: Line; region?: SidebarRegion } => ({
    line: box(concat([sp(`${label} `, c.secondary)], [sp(value, c.muted)])),
    region: { kind: "act", action },
  });

  const rowsList: { line: Line; region?: SidebarRegion }[] = [
    { line: [{ t: `╭─ session ${"─".repeat(Math.max(0, inner - 10))}╮`, c: c.border }] },
    pickRow("model", data.provider, c.primary, "model"),
    pickRow("effort", data.effort, c.secondary, "effort"),
    pickRow("skin", data.skinLabel, c.primary, "skin"),
    gap,
    infoRow("chain", CHAIN_ID ? `${CHAIN_NAME} ${CHAIN_ID}` : CHAIN_NAME),
    infoRow("height", data.block === null ? "—" : data.block.toLocaleString("en-US")),
    infoRow("session", data.session ?? "new"),
    infoRow("room", data.room),
    infoRow("tokens", data.tokens >= 1000 ? `${(data.tokens / 1000).toFixed(1)}k` : String(data.tokens)),
    gap,
    infoRow("watches", String(data.watches)),
    infoRow("wishes", String(data.wishes)),
    infoRow("topics", String(data.topics)),
    infoRow("skills", String(data.skills)),
    gap,
    hintRow("alt+↵", "new line"),
    hintRow("drag", "select · copies"),
    actRow("freeze", "frame · ctrl+s", "select"),
    actRow("copy", "last · ctrl+y", "copy"),
    hintRow("click", "name → copy it"),
    hintRow("click", "tool → expand"),
    hintRow("wheel", "scroll · pgup page"),
    hintRow("ctrl+c", "twice to leave"),
  ];

  // Fill to `rows`, pushing the bottom border to the last screen row.
  const padGaps = Math.max(0, rows - rowsList.length - 1);
  const head = rowsList[0];
  const tail = rowsList.slice(1);
  const spaced: typeof rowsList = [];
  for (let i = 0; i < padGaps; i++) spaced.push(gap);
  const all = [head, ...tail, ...spaced, { line: [{ t: `╰${"─".repeat(Math.max(1, inner))}╯`, c: c.border }] }].slice(0, rows);

  const lines: Line[] = all.map((r) => r.line);
  const regions: (SidebarRegion | undefined)[] = all.map((r) => r.region);
  while (lines.length < rows) {
    lines.push(blank(sidebarW));
    regions.push(undefined);
  }
  return { lines, regions };
}
