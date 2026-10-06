/**
 * The mouse, in the same shape as the keyboard (./keymap.ts): one entry point,
 * an explicit context, no React.
 *
 * Reading the mouse is what makes the app responsible for selection at all —
 * a terminal will not select text while an application is consuming the
 * events — so the two halves here are "what a click means" and "what a drag
 * paints". A press that never moved is a click; a press that moved is a
 * selection, and the release copies exactly the cells that were painted.
 */
import { isDrag } from "./selection.js";
import type { BoundedRange } from "./selection.js";
import type { MouseInfo } from "./keys.js";
import type { FrameHit } from "./frame.js";
import type { PickerState } from "./keymap.js";

/** A press in flight: where it started and which pane it may cover. In the
 *  transcript (`feed`) the row counts transcript rows, not screen rows. */
export type Drag = { row: number; col: number; moved: boolean; left: number; right: number; feed: boolean };

export type MouseCtx = {
  hit: FrameHit;
  picker: PickerState | null;
  /** Mutable across events, so it is a box the app holds, not state. */
  drag: { current: Drag | null };
  selection: BoundedRange | null;
  hasNote: boolean;

  setPicker: (p: PickerState | null) => void;
  setSelection: (r: BoundedRange | null) => void;
  clearNote: () => void;
  scrollBy: (delta: number) => void;
  /** The transcript row at the top of the screen, current even mid-event. */
  scrollTop: () => number;
  copySelection: (range: BoundedRange) => void;

  // what a plain click can reach
  openPicker: (which: "model" | "effort" | "skin") => void;
  freeze: () => void;
  copyLastReply: () => void;
  toggleTool: (id: string) => void;
  copyText: (text: string, label: string) => void;
  runCommand: (name: string) => void;
  moveCursorTo: (index: number) => void;
};

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** What a plain click (a press that never moved) does. */
function clickAt(row: number, col: number, ctx: MouseCtx): void {
  const L = ctx.hit;
  if (row < 0 || row >= L.rows || col < 0) return;
  if (L.sidebarOn && col >= L.contentW) {
    const sr = L.sidebarRegions[row];
    if (sr?.kind === "pick") ctx.openPicker(sr.action);
    else if (sr?.kind === "act") {
      if (sr.action === "select") ctx.freeze();
      else ctx.copyLastReply();
    }
    return;
  }
  if (col >= L.contentW) return;
  if (row < L.viewportRows) {
    const r = L.feedRegions[row];
    if (r?.kind === "tool") ctx.toggleTool(r.toolId);
    // A click on a name or on a code block copies it whole — the shortcut for
    // the times a drag would be fiddly.
    else if (r?.kind === "copy") ctx.copyText(r.text, r.label);
    return;
  }
  // the slash menu: click a command to run it
  if (L.menuTop >= 0) {
    const item = L.menuItems[row - L.menuTop];
    if (item) {
      ctx.runCommand(item.name);
      return;
    }
  }
  if (L.composerTop < 0) return;
  // The composer's text starts inside its frame: border, pad, prompt.
  const wl = L.composerWrap[row - L.composerTop];
  if (wl) ctx.moveCursorTo(wl.start + clamp(col - 4, 0, wl.text.length));
}

/**
 * An open picker takes the mouse whole: the wheel moves the highlight, a click
 * picks the row under the pointer, a click outside cancels. Returns false when
 * no picker is open and the event belongs to the frame instead.
 */
function pickerMouse(m: MouseInfo, ctx: MouseCtx): boolean {
  const picker = ctx.picker;
  if (!picker) return false;
  const L = ctx.hit;
  const row = m.y - 1;
  const col = m.x - 1;
  // The picker may be a window onto a longer list: a row is an option only
  // while it is one of the rows drawn.
  const shown = L.pickerTop >= 0 ? row - L.pickerTop : -1;
  const idx = shown >= 0 && shown < L.pickerCount ? L.pickerStart + shown : -1;
  const n = picker.options.length;

  if (m.wheel) {
    const ni = m.wheel === "down" ? (picker.index + 1) % n : (picker.index - 1 + n) % n;
    picker.onHighlight?.(picker.options[ni].value);
    ctx.setPicker({ ...picker, index: ni });
    return true;
  }
  if (m.motion) return true;
  if (m.action === "press") {
    // Highlight on the way down (a skin previews itself), commit on the way up
    // — the same shape as every other button on a screen.
    if (idx >= 0 && idx < n && idx !== picker.index) {
      picker.onHighlight?.(picker.options[idx].value);
      ctx.setPicker({ ...picker, index: idx });
    }
    ctx.drag.current = { row, col, moved: false, left: 0, right: L.width, feed: false };
    return true;
  }
  const started = ctx.drag.current;
  ctx.drag.current = null;
  if (!started) return true;
  if (idx >= 0 && idx < n) {
    picker.onPick(picker.options[idx].value);
    ctx.setPicker(null);
  } else if (started.row === row && started.col === col) {
    picker.onCancel?.();
    ctx.setPicker(null);
  }
  return true;
}

export function handleMouse(m: MouseInfo, ctx: MouseCtx): void {
  if (pickerMouse(m, ctx)) return;

  const L = ctx.hit;
  const col = m.x - 1;
  const row = m.y - 1;

  if (m.wheel) {
    ctx.scrollBy(m.wheel === "down" ? 3 : -3);
    // The wheel under a held button carries a transcript selection along.
    const d = ctx.drag.current;
    if (d?.feed) extend(d, row, col, ctx);
    return;
  }

  // Only the left button draws a selection; a right-click is left alone.
  if (m.button !== 0) return;

  if (m.action === "press" && !m.motion) {
    const inSidebar = L.sidebarOn && col >= L.contentW;
    const feed = !inSidebar && row < L.viewportRows;
    ctx.drag.current = {
      row: feed ? ctx.scrollTop() + row : row,
      col,
      moved: false,
      feed,
      left: inSidebar ? L.contentW : 0,
      // The transcript's last column is the scrollbar's, not text: a copy
      // that included it pasted a column of █ and ░ down the right edge.
      right: inSidebar ? L.width : Math.max(1, L.contentW - 1),
    };
    if (ctx.selection) ctx.setSelection(null);
    if (ctx.hasNote) ctx.clearNote();
    return;
  }

  if (m.motion) {
    const d = ctx.drag.current;
    if (!d) return;
    if (d.feed) {
      // Held against the top row or below the transcript, the feed scrolls a
      // line per move, so a selection can run past what one screen shows.
      if (row <= 0) ctx.scrollBy(-1);
      else if (row >= L.viewportRows) ctx.scrollBy(1);
      extend(d, row, col, ctx);
      return;
    }
    if (row !== d.row || col !== d.col) d.moved = true;
    if (d.moved) ctx.setSelection({ a: { row: d.row, col: d.col }, b: { row, col }, left: d.left, right: d.right });
    return;
  }

  const d = ctx.drag.current;
  ctx.drag.current = null;
  if (!d) return;
  if (d.feed && !d.moved) {
    clickAt(d.row - ctx.scrollTop(), d.col, ctx);
    return;
  }
  const range = ctx.selection;
  if (d.moved && range && isDrag(range)) {
    ctx.copySelection(range);
    return;
  }
  clickAt(d.row, d.col, ctx);
}

/** Move a transcript drag's free end to the screen cell under the pointer. */
function extend(d: Drag, row: number, col: number, ctx: MouseCtx): void {
  const at = ctx.scrollTop() + clamp(row, 0, ctx.hit.viewportRows - 1);
  if (at !== d.row || col !== d.col) d.moved = true;
  if (!d.moved) return;
  ctx.setSelection({ a: { row: d.row, col: d.col }, b: { row: at, col }, left: d.left, right: d.right, feed: true });
}
