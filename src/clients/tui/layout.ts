/**
 * Screen layout: the transcript feed (the welcome screen, banner, turns,
 * tools), flattened into the same styled-line model the whole TUI renders from
 * (see markdown.ts). Pure — no ink, no React — so the app can measure heights
 * exactly, slice the scrollable feed, and map mouse clicks to the exact tool
 * row they land on. The sidebar is its own module (sidebar.ts).
 */
import { BANNER, GLYPH, lerpColor, type Theme } from "./theme.js";
import { logo3dLines } from "./logo3d.js";
import { TASKS, type TaskKind } from "../../models/tasks.js";
import {
  blank,
  concat,
  fitLineBg,
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
export type Part =
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: ToolBlock }
  /** The model's chain of thought: one folded row until it is clicked open. */
  | { kind: "reasoning"; id: string; text: string };
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

/** What a click on a feed line does: unfold a tool or a thought, copy a block of text, or spin the logo. */
export type FeedRegion =
  | { kind: "fold"; id: string }
  | { kind: "copy"; text: string; label: string }
  | { kind: "logo" };

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

/**
 * The welcome screen, centred: the 3D logo turned to `pose`, a tagline, the
 * boot lines. The logo rows are a click target (it spins again). Under seven
 * rows there is no room to turn anything, and the flat masthead stands in.
 */
export function welcomeLines(
  theme: Theme,
  width: number,
  logoRows: number,
  pose: { yaw: number; pitch: number; glow: number },
): { lines: Line[]; regions: (FeedRegion | undefined)[] } {
  const c = theme;
  if (logoRows < 7) {
    const flat = [...bannerLines(theme, width), ...bootLines(theme, width)];
    return { lines: flat, regions: flat.map(() => undefined) };
  }
  const center = (l: Line): Line => concat(blank(Math.max(0, Math.floor((width - lineWidth(l)) / 2))), l);
  const logo = logo3dLines(theme, width, logoRows, pose.yaw, pose.pitch, pose.glow);
  const tagline = center([
    sp(`${GLYPH.spark} `, c.primary),
    sp("the wired remembers", c.fg),
    sp(`  ${GLYPH.dot}  `, c.mutedDim),
    sp("an autonomous agent", c.muted),
  ]);
  const tip = wrapSpans(
    [{ t: `${GLYPH.spark} the logo and Lain in the sidebar both answer a click · sidebar titles fold`, c: c.mutedDim }],
    Math.min(width, 80),
  );
  const boot = [...bootLines(theme, Math.min(width, 80)).slice(0, -1), ...tip].map(center);
  const lines = [...logo, blank(width), tagline, blank(width), ...boot];
  return { lines, regions: lines.map((_, i) => (i < logo.length ? { kind: "logo" as const } : undefined)) };
}

// ------------------------------------------------------------------ turns

/** Wall-clock hh:mm for a turn's header. */
function clock(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Every character of a turn's reply, as plain text — what a copy yields (thoughts stay out). */
export function turnText(turn: Turn): string {
  const out: string[] = [];
  for (const part of turn.parts) {
    if (part.kind === "text") {
      if (part.text.trim()) out.push(part.text.trimEnd());
    } else if (part.kind === "tool") {
      const args = fmtArgs(part.tool.input);
      out.push(`${GLYPH.tool} ${part.tool.name}${args ? `  ${args}` : ""}`);
      if (part.tool.summary) out.push(part.tool.summary);
    }
  }
  return out.join("\n").trim();
}

function turnHeader(turn: Turn, theme: Theme, width: number): Line {
  const c = theme;
  // The speaker is a badge: a block of colour the eye finds while scrolling,
  // where a coloured word among words had to be read to be found.
  const dark = "#0b0b12";
  const meta =
    turn.role === "you"
      ? { label: `${GLYPH.you} you`, color: dark, bg: c.secondary }
      : turn.role === "lain"
        ? { label: `${GLYPH.lain} lain`, color: dark, bg: c.primary }
        : turn.role === "pulse"
          ? { label: `${GLYPH.spark} wired`, color: c.warn, bg: c.surface }
          : { label: `${GLYPH.dot} sys`, color: c.muted, bg: c.surface };
  const head: Line = [{ t: ` ${meta.label} `, c: meta.color, bg: meta.bg, b: true }];
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
  const region: FeedRegion = { kind: "fold", id: tool.id };
  return { lines, region };
}

/**
 * The model's thought: folded to one row by default — it is how she got there,
 * not what she said — and unfolded in place, dimmed, when clicked.
 */
function reasoningLines(text: string, open: boolean, theme: Theme, width: number): { header: Line; details: Line[] } {
  const c = theme;
  const indent = 2;
  const body = text
    .trim()
    .split("\n")
    .flatMap((raw): Line[] => (raw.trim() ? wrapSpans([{ t: raw.trim(), c: c.muted, i: true }], width - indent) : [[{ t: " " }]]));
  const header: Line = concat(
    [sp(`${open ? GLYPH.collapse : GLYPH.expand} `, c.mutedDim)],
    [{ t: "thinking", c: c.muted, i: true }],
    open ? [] : [sp(`  ${GLYPH.dot} ${body.length} line${body.length === 1 ? "" : "s"}`, c.mutedDim)],
  );
  return { header, details: open ? body.map((l) => concat(blank(indent), l)) : [] };
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

/** Signed amounts and on/off switches in a notice, picked out in colour. */
const ACCENTS = /((?<![\w.])[+−]\d[\d,]*(?:\.\d+)?%?|(?<=^|[\s(])-\d[\d,]*(?:\.\d+)?%?|\b(?:ON|OFF)\b)/;

function accentSpans(text: string, theme: Theme, color: string): Span[] {
  // One capturing group, so split() puts the accents at the odd indices.
  return text
    .split(ACCENTS)
    .map((t, i): Span => {
      if (i % 2 === 0) return { t, c: color };
      if (t === "ON") return { t, c: theme.ok, b: true };
      if (t === "OFF") return { t, c: theme.warn, b: true };
      return { t, c: /^[-−]/.test(t) ? theme.err : theme.ok, b: true };
    })
    .filter((span) => span.t);
}

/** Flat text body for you/sys/pulse turns (plain, wrapped). Notices get their numbers coloured. */
function plainBody(text: string, theme: Theme, width: number, color: string, accents = false): Line[] {
  // Each source line wraps on its own, under its own indent: a list from
  // /help or /skills must not run together into one paragraph.
  return text.split("\n").flatMap((raw) => {
    if (!raw.trim()) return [[{ t: " " }]];
    const indent = raw.match(/^\s*/)![0].replace(/\t/g, "  ");
    const pad = indent.length < width / 2 ? indent : "";
    const spans = accents ? accentSpans(raw.trim(), theme, color) : [{ t: raw.trim(), c: color }];
    return wrapSpans(spans, width - pad.length).map((l) => (pad ? [{ t: pad }, ...l] : l));
  });
}

/** Columns every turn's body sits in from the left edge, under its badge. */
const BODY_INDENT = 2;

/**
 * Render one turn into lines, tagging every line that belongs to a tool or a
 * thought so a click can expand/collapse it. `expanded` holds the ids shown in full.
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
  // The body is laid out narrower and shifted right, so the badges make a
  // column of their own down the left edge.
  const w = Math.max(8, width - BODY_INDENT);
  const indent = (ls: Line[]): Line[] => ls.map((l) => concat(blank(BODY_INDENT), l));
  for (const part of turn.parts) {
    if (part.kind === "reasoning") {
      if (!part.text.trim()) continue;
      const thought = reasoningLines(part.text, expanded.has(part.id), theme, w);
      lines.push(...indent([truncateLine(thought.header, w)]));
      regions.push({ kind: "fold", id: part.id });
      lines.push(...indent(thought.details));
      regions.push(...thought.details.map(() => undefined));
    } else if (part.kind === "tool") {
      const block = part.tool;
      if (expanded.has(block.id)) {
        const tool = expandedToolLines(block, theme, w);
        // The expanded header keeps the tool region; the detail rows don't.
        lines.push(...indent([truncateLine(tool.header, w)]));
        regions.push({ kind: "fold", id: block.id });
        lines.push(...indent(tool.details));
        regions.push(...tool.details.map(() => undefined));
      } else {
        const tool = toolLines(block, theme, w, spin);
        lines.push(...indent(tool.lines));
        regions.push(tool.region);
      }
    } else if (part.text.trim()) {
      // Code blocks report themselves line by line, so a click anywhere inside
      // one copies exactly the code — not the prose around it.
      const marks: (string | undefined)[] = [];
      const notice = lerpColor(c.fg, c.muted, 0.35);
      const body =
        turn.role === "lain"
          ? stableMarkdown(part.text)
            ? mdToLines(part.text.trimEnd(), theme, w, marks)
            : wrapSpans([{ t: part.text, c: c.fg }], w)
          : turn.role === "you"
            ? // Your own words on a raised strip: where you spoke is visible at a glance.
              plainBody(part.text.trimEnd(), theme, w, c.fg).map((l) => fitLineBg(l, w, c.surface).map((s) => ({ ...s, bg: s.bg ?? c.surface })))
            : plainBody(part.text.trimEnd(), theme, w, turn.role === "pulse" ? c.muted : notice, true);
      lines.push(...indent(body));
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
