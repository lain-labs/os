/**
 * Selecting text with the mouse, inside the app's own frame.
 *
 * A terminal cannot do this for us: the moment the TUI turns mouse reporting on
 * — which is what makes the wheel scroll and the sidebar clickable — the drag
 * is delivered to the app instead of the terminal, and the terminal's own
 * selection stops working everywhere. So the drag is ours: press, move, release
 * over the rendered frame, which is nothing but styled lines (see markdown.ts),
 * and the cells between the two points are the selection.
 *
 * Pure — no ink, no terminal — so `npm run keys:smoke` can pin it headless.
 */
import { splitLine, type Line } from "./markdown.js";

/** A cell of the rendered frame: 0-based row and column. */
export interface Cell {
  row: number;
  col: number;
}

export interface Range {
  a: Cell;
  b: Cell;
}

/** A range plus the pane it was dragged inside — the transcript or the sidebar.
 *  A drag never spans both, so the bounds travel with the range. */
export type BoundedRange = Range & { left: number; right: number };

/** The same range with `a` first in reading order (a drag may go upwards). */
export function ordered(r: Range): Range {
  const back = r.b.row < r.a.row || (r.b.row === r.a.row && r.b.col < r.a.col);
  return back ? { a: r.b, b: r.a } : r;
}

/**
 * The `[from, to)` columns of `row` covered by the range, or null.
 *
 * `left`/`width` are the pane the drag started in — the transcript or the
 * sidebar. A selection spanning rows takes each row whole, and without that
 * limit "whole" would mean the sidebar's text too, pasted into the middle of a
 * copied reply.
 */
export function rowRange(r: Range, row: number, width: number, left = 0): [number, number] | null {
  const { a, b } = ordered(r);
  if (row < a.row || row > b.row) return null;
  // The end cell is inclusive: dragging over one character selects it.
  const from = row === a.row ? Math.min(Math.max(left, a.col), width) : left;
  const to = row === b.row ? Math.min(width, Math.max(left, b.col + 1)) : width;
  return to > from ? [from, to] : null;
}

/** True when the range covers more than the single cell it started on. */
export function isDrag(r: Range): boolean {
  return r.a.row !== r.b.row || r.a.col !== r.b.col;
}

function sliceRow(line: Line, from: number, to: number): Line {
  const [, rest] = splitLine(line, from);
  const [mid] = splitLine(rest, to - from);
  return mid;
}

/** The selected text: one line per row, trailing frame padding removed. */
export function selectionText(lines: Line[], r: Range, width: number, left = 0): string {
  const { a, b } = ordered(r);
  const out: string[] = [];
  for (let row = a.row; row <= Math.min(b.row, lines.length - 1); row++) {
    const span = rowRange(r, row, width, left);
    const line = lines[row];
    if (!span || !line) continue;
    out.push(
      sliceRow(line, span[0], span[1])
        .map((s) => s.t)
        .join("")
        .replace(/\s+$/, ""),
    );
  }
  return out.join("\n");
}

/** `lines` with the selected cells repainted onto `bg`. */
export function highlightSelection(lines: Line[], r: Range, bg: string, width: number, left = 0): Line[] {
  const { a, b } = ordered(r);
  return lines.map((line, row) => {
    if (row < a.row || row > b.row) return line;
    const span = rowRange(r, row, width, left);
    if (!span) return line;
    const [head, rest] = splitLine(line, span[0]);
    const [mid, tail] = splitLine(rest, span[1] - span[0]);
    return [...head, ...mid.map((s) => ({ ...s, bg })), ...tail];
  });
}
