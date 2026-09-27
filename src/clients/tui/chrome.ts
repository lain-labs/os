/**
 * The chrome around the transcript: everything that is drawn but is not the
 * conversation itself — the state line, the slash menu, the arrow-key picker,
 * the framed composer, the scrollbar thumb.
 *
 * Every function here is pure: state in, `Line[]` out. That is what lets the
 * app measure a frame's height before it paints it and map a mouse click back
 * to a row (see the offsets `chromeLines` returns).
 */
import { GLYPH, THEMES, type Theme } from "./theme.js";
import { blank, concat, fitLine, lineWidth, sp, truncateLine, type Line, type Span } from "./markdown.js";
import { spinnerChar } from "./layout.js";

export type PickerOption = { value: string; label: string; hint?: string };

/** What the picker's renderer needs. The callbacks live on the app's own
 *  `PickerState`, which extends this — a renderer has no business seeing them. */
export type PickerView = {
  title: string;
  kind: "skin" | "plain";
  options: PickerOption[];
  index: number;
};

export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** One vertical strip of the feed's scrollbar thumb (empty when not needed). */
export function scrollbarChar(i: number, viewport: number, maxScroll: number, scrollTop: number): string {
  if (maxScroll <= 0) return " ";
  const thumb = Math.max(1, Math.round((viewport * viewport) / (viewport + maxScroll)));
  const track = viewport - thumb;
  const pos = maxScroll ? Math.round((track * scrollTop) / maxScroll) : 0;
  return i >= pos && i < pos + thumb ? "█" : "░";
}

/** Left/right halves of one line, pushed to the two edges of `width`. */
export function spread(left: Line, right: Line, width: number): Line {
  const gap = width - lineWidth(left) - lineWidth(right);
  if (gap < 1) return truncateLine(left, width);
  return concat(left, blank(gap), right);
}

/** A rounded panel: `╭─ label ─╮`, the rows, `╰─ footer ─╯`. */
export function boxLines(theme: Theme, width: number, label: Line, rows: Line[], footer: string, accent?: string): Line[] {
  const c = theme;
  const border = accent ?? c.border;
  const labelW = lineWidth(label);
  const top: Line = labelW
    ? concat([sp("╭─ ", border)], label, [sp(` ${"─".repeat(Math.max(1, width - labelW - 5))}╮`, border)])
    : [sp(`╭${"─".repeat(Math.max(1, width - 2))}╮`, border)];
  const foot = footer ? ` ${footer} ` : "";
  const bottom: Line = concat(
    [sp(`╰${"─".repeat(Math.max(1, width - 3 - foot.length))}`, border)],
    foot ? [sp(foot, c.mutedDim)] : [],
    [sp("─╯", border)],
  );
  const body = rows.map((r) => concat([sp("│ ", border)], fitLine(r, Math.max(1, width - 4)), [sp(" │", border)]));
  return [top, ...body, bottom];
}

/**
 * Everything below the transcript: the state line, the slash menu or picker,
 * the composer in its own frame, and one line of keys. Returned as flat lines
 * plus the offset of the composer's first text row, which is what turns a mouse
 * click into a cursor position.
 */
export function chromeLines(args: {
  theme: Theme;
  width: number;
  status: "idle" | "thinking" | "streaming";
  spin: number;
  elapsed: number;
  provider: string;
  model: string;
  block: number | null;
  tokens: number;
  room: string;
  effort: string;
  sidebarOn: boolean;
  queued: string | null;
  quitArmed: boolean;
  menuLines: Line[];
  pickerLines: Line[];
  composerWrap: { text: string; start: number; end: number }[];
  cursorLine: number;
  cursorCol: number;
  blinkOn: boolean;
  blinkEnabled: boolean;
  cursorStyle: "block" | "line";
  busy: boolean;
  hint: string;
}): { lines: Line[]; composerOffset: number; menuOffset: number; pickerOffset: number } {
  const c = args.theme;
  const W = args.width;
  const out: Line[] = [];

  // --- state line. The sidebar already carries the session facts, so they are
  // repeated down here only when the terminal is too narrow to show it.
  const state: Line = args.busy
    ? concat(
        [sp(`${spinnerChar(args.spin)} `, c.warn)],
        [sp(args.status === "thinking" ? "reaching into the wired" : "answering", c.warn)],
        [sp(`  ${Math.round(args.elapsed / 1000)}s`, c.mutedDim)],
      )
    : concat([sp("● ", c.ok)], [sp("ready", c.mutedDim)]);
  const facts: Line = args.quitArmed
    ? concat([sp("⌃C ", c.err)], [sp("again to leave the wired", c.warn)])
    : args.queued
    ? concat(
        [sp("↵ queued ", args.theme.warn)],
        [sp(args.queued.length > 28 ? `${args.queued.slice(0, 27)}…` : args.queued, c.mutedDim)],
      )
    : args.sidebarOn
    ? []
    : concat(
        [sp(args.provider, c.primary)],
        [sp(` ${GLYPH.dot} `, c.mutedDim)],
        [sp(args.model, c.secondary)],
        [sp(`  ${GLYPH.chain} `, c.mutedDim)],
        [sp(args.block === null ? "—" : args.block.toLocaleString("en-US"), c.fg)],
        [sp("  ◷ ", c.mutedDim)],
        [sp(fmtTokens(args.tokens), c.fg)],
        [sp(`  ${args.effort}`, c.secondary)],
        [sp(`  ${args.room}`, c.mutedDim)],
      );
  out.push(fitLine(spread(state, facts, W), W));

  let menuOffset = -1;
  if (args.menuLines.length) {
    menuOffset = out.length + MENU_HEADER_ROWS;
    out.push(...args.menuLines);
  }
  if (args.pickerLines.length) {
    // A picker owns the keyboard; drawing a composer under it would lie.
    const pickerOffset = out.length + PICKER_HEADER_ROWS;
    out.push(...args.pickerLines);
    return { lines: out, composerOffset: -1, menuOffset, pickerOffset };
  }
  out.push(blank(W));

  // --- the composer, framed. A frame is what tells you it can hold more than
  // one line before you have typed the second one.
  const textW = Math.max(4, W - 6);
  const rows: Line[] = args.composerWrap.map((wl, li) => {
    const first = li === 0;
    const row: Span[] = [sp(first ? `${GLYPH.you} ` : "  ", args.busy ? c.mutedDim : c.primary)];
    if (li === args.cursorLine) {
      const before = wl.text.slice(0, args.cursorCol);
      const at = wl.text.slice(args.cursorCol, args.cursorCol + 1) || " ";
      const after = wl.text.slice(args.cursorCol + 1);
      const show = !args.blinkEnabled || args.blinkOn;
      const cursor: Span =
        args.cursorStyle === "line"
          ? { t: at, c: show ? c.primary : c.fg, u: show }
          : show
            ? { t: at, c: "#0b0b12", bg: c.primary }
            : { t: at, c: c.fg };
      row.push(sp(before, c.fg), cursor, sp(after, c.fg));
    } else {
      row.push(sp(wl.text, c.fg));
    }
    if (first && wl.text.length === 0 && !args.busy) row.push(sp(" ask lain…", c.mutedDim));
    return truncateLine(row, textW);
  });
  const lines = args.composerWrap.length;
  const box = boxLines(
    c,
    W,
    args.busy ? [sp("lain is answering — type ahead", c.mutedDim)] : [],
    rows,
    lines > 1 ? `${lines} lines` : "",
    args.busy ? c.mutedDim : c.border,
  );
  // The first text row sits one line below the panel's top border.
  const composerOffset = out.length + 1;
  out.push(...box);
  out.push(concat([sp("  ", c.mutedDim)], truncateLine([sp(args.hint, c.mutedDim)], W - 2)));
  return { lines: out, composerOffset, menuOffset, pickerOffset: -1 };
}

/** Rows the menu and the picker draw before their first option — a click on
 *  screen row N is option N minus these. */
export const MENU_HEADER_ROWS = 1; // the blank margin
export const PICKER_HEADER_ROWS = 2; // the blank margin + the titled border

/** The slash-command autocomplete menu, margin + one row per command. */
export function menuLines(
  items: readonly { name: string; desc: string }[],
  index: number,
  theme: Theme,
  width: number,
): Line[] {
  const c = theme;
  const out: Line[] = [blank(width)];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const on = i === index;
    out.push(
      concat(
        [sp(on ? "❯ " : "  ", on ? c.primary : c.mutedDim)],
        [{ t: it.name.padEnd(10), c: on ? c.primary : c.secondary, b: on }],
        [sp(it.desc, c.mutedDim)],
      ),
    );
  }
  return out;
}

/** The bordered arrow-key picker (skin/effort/cursor/model). */
export function pickerLines(state: PickerView, theme: Theme, width: number): Line[] {
  const c = theme;
  const out: Line[] = [blank(width)];
  const title = ` ${state.title}  ↑↓ or click · enter select · esc cancel `;
  out.push(truncateLine([{ t: `╭─${title}${"─".repeat(Math.max(0, width - title.length - 3))}╮`, c: c.border }], width));
  for (let i = 0; i < state.options.length; i++) {
    const opt = state.options[i];
    const on = i === state.index;
    const th = state.kind === "skin" ? THEMES[opt.value] : undefined;
    const row: Span[] = [
      sp(on ? " ❯ " : "   ", on ? c.primary : c.mutedDim),
      { t: opt.label.padEnd(11), c: on ? c.primary : c.fg, b: on },
    ];
    if (th) {
      for (const col of [th.primary, th.secondary, th.ok, th.warn, th.err]) row.push(sp(GLYPH.swatch, col));
      row.push(sp(`  ${th.label}`, c.mutedDim));
    } else if (opt.hint) {
      row.push(sp(opt.hint, c.mutedDim));
    }
    // Inside the frame, like the composer's rows — an open-sided list under a
    // closed border reads as two different widgets.
    out.push(concat([sp("│", c.border)], fitLine(concat(row), Math.max(1, width - 2)), [sp("│", c.border)]));
  }
  out.push([{ t: `╰${"─".repeat(Math.max(1, width - 2))}╯`, c: c.border }]);
  return out;
}
