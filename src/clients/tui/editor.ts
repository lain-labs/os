/** A tiny readline-style line editor: pure transforms over {value, cursor}.
 *
 * The composer renders the value soft-wrapped across several rows. When a
 * `width` is given, ↑/↓ walk the visual lines and home/end jump to the start/
 * end of the visual line (ctrl+a/ctrl+e stay buffer-wide, readline style).
 * Without a `width` the whole buffer is one line, so every transform collapses
 * to the classic single-line behaviour the smoke tests pin down. */
import type { TuiKey } from "./keys.js";

/** One wrapped display line plus its source range in the flat string. */
export interface WrappedLine {
  text: string;
  /** Flat index of the first character of the line. */
  start: number;
  /** Flat index just past the last character of the line. */
  end: number;
}

/**
 * Soft-wrap `value` onto `width` columns, **verbatim**.
 *
 * The invariant every caller depends on: `text === value.slice(start, end)`,
 * and the lines partition the string. The first version of this rebuilt each
 * row out of `/\S+/` tokens joined by single spaces, which quietly reflowed
 * what you typed — a trailing space belonged to no row at all (so the caret
 * refused to move when you pressed space, and the space only appeared once the
 * next letter made it part of a word), and a run of several spaces collapsed
 * into one, dragging the caret out of step with the real cursor for the rest
 * of the line. A composer must draw exactly the characters it holds.
 *
 * Breaks prefer the position just after the last space that fits, so words
 * stay whole and the space stays visible at the end of the row it belongs to;
 * a word longer than the width is cut hard. Hard newlines start a fresh row,
 * so alt+enter stays visible.
 */
export function wrapIndices(value: string, width: number): WrappedLine[] {
  const w = Math.max(4, width);
  const out: WrappedLine[] = [];
  let offset = 0;

  for (const logical of value.split("\n")) {
    if (logical.length === 0) {
      out.push({ text: "", start: offset, end: offset });
      offset += 1;
      continue;
    }
    let pos = 0;
    while (pos < logical.length) {
      const remaining = logical.length - pos;
      if (remaining <= w) {
        out.push({
          text: logical.slice(pos),
          start: offset + pos,
          end: offset + logical.length,
        });
        pos = logical.length;
        break;
      }
      // Break just after the last space inside the window; a space at the very
      // edge is a legal break too, which is what keeps whole words together.
      let cut = -1;
      for (let i = pos + w - 1; i > pos; i--) {
        if (logical[i] === " ") {
          cut = i + 1;
          break;
        }
      }
      const stop = cut > pos ? cut : pos + w;
      out.push({ text: logical.slice(pos, stop), start: offset + pos, end: offset + stop });
      pos = stop;
    }
    offset += logical.length + 1;
  }

  if (!out.length) out.push({ text: "", start: 0, end: 0 });
  // A last row filled to the very edge leaves the caret nowhere to stand, so
  // it gets the next row — the same thing a terminal does at column 80.
  const last = out[out.length - 1];
  if (last.end - last.start === w) {
    out.push({ text: "", start: last.end, end: last.end });
  }
  return out;
}

/** Map a flat cursor index to (line, col) in the wrapped layout. */
export function cursorToWrap(value: string, cursor: number, width: number): { line: number; col: number } {
  const w = Math.max(4, width);
  const lines = wrapIndices(value, w);
  for (let i = 0; i < lines.length; i++) {
    const { start, end } = lines[i];
    if (cursor < start) return { line: i, col: 0 };
    if (cursor < end) return { line: i, col: cursor - start };
    if (cursor === end) {
      // A boundary belongs to two rows. It reads as the end of this one —
      // that is where a trailing space puts the caret — unless this row is
      // full to the edge and the text simply continues on the next.
      const next = lines[i + 1];
      if (next && next.start === cursor && end - start >= w) return { line: i + 1, col: 0 };
      return { line: i, col: cursor - start };
    }
  }
  const tail = lines[lines.length - 1];
  return { line: lines.length - 1, col: tail.end - tail.start };
}

export interface LineState {
  value: string;
  cursor: number;
}

/** Index of the start of the word at/just before `cursor`. */
export function wordLeft(value: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && /\s/.test(value[i - 1])) i--;
  while (i > 0 && /\S/.test(value[i - 1])) i--;
  return i;
}

/** Index just past the word at/after `cursor`. */
export function wordRight(value: string, cursor: number): number {
  const n = value.length;
  let i = cursor;
  while (i < n && /\s/.test(value[i])) i++;
  while (i < n && /\S/.test(value[i])) i++;
  return i;
}

/**
 * Apply one keypress to the line. Returns the new state, or null if the key is
 * not an editing key (so the caller can treat it as submit/navigation/etc).
 *
 * Supports: ← →, home/end (visual line when `width` is given), ctrl+← → and
 * alt+b/alt+f (word move), ↑↓ (visual line walk, or null at the first/last
 * line so the caller can fall back to input history), backspace, delete
 * (forward), ctrl+w / alt+⌫ (delete word back), alt+d / alt+del (delete word
 * fwd), ctrl+u (kill to start), ctrl+k (kill to end), shift+enter (insert a
 * literal newline), and printable insert (incl. paste).
 */
export function editLine(s: LineState, input: string, key: TuiKey, width?: number): LineState | null {
  const { value, cursor } = s;
  const byWord = key.ctrl || key.meta;

  // A bracketed paste is text, whatever it contains — several lines of it stay
  // several lines instead of firing several messages.
  if (key.paste) {
    return { value: value.slice(0, cursor) + input + value.slice(cursor), cursor: cursor + input.length };
  }

  // shift+enter (and its alt+enter / ctrl+j stand-ins) breaks the line.
  if (key.return && key.shift) {
    return { value: value.slice(0, cursor) + "\n" + value.slice(cursor), cursor: cursor + 1 };
  }

  // --- movement ---
  if (key.ctrl && input === "a") return { value, cursor: 0 };
  if (key.ctrl && input === "e") return { value, cursor: value.length };
  if (key.home) {
    if (width !== undefined && width > 0) {
      const at = cursorToWrap(value, cursor, width);
      const lines = wrapIndices(value, width);
      const line = lines[at.line];
      return { value, cursor: line?.start ?? 0 };
    }
    return { value, cursor: 0 };
  }
  if (key.end) {
    if (width !== undefined && width > 0) {
      const at = cursorToWrap(value, cursor, width);
      const lines = wrapIndices(value, width);
      const line = lines[at.line];
      return { value, cursor: line?.end ?? value.length };
    }
    return { value, cursor: value.length };
  }
  if (key.leftArrow) {
    return { value, cursor: byWord ? wordLeft(value, cursor) : Math.max(0, cursor - 1) };
  }
  if (key.rightArrow) {
    return { value, cursor: byWord ? wordRight(value, cursor) : Math.min(value.length, cursor + 1) };
  }
  if (key.meta && input === "b") return { value, cursor: wordLeft(value, cursor) };
  if (key.meta && input === "f") return { value, cursor: wordRight(value, cursor) };

  // ↑↓ walk the visual lines when the composer is multi-line; on the first/
  // last line return null so the caller falls back to input history.
  if ((key.upArrow || key.downArrow) && width !== undefined && width > 0) {
    const lines = wrapIndices(value, width);
    if (lines.length > 1) {
      const at = cursorToWrap(value, cursor, width);
      const target = key.upArrow ? at.line - 1 : at.line + 1;
      if (target < 0 || target >= lines.length) return null;
      const line = lines[target];
      return { value, cursor: Math.min(line.start + at.col, line.end) };
    }
    return null;
  }

  // --- deletion ---
  if (key.meta && key.backspace) {
    const w = wordLeft(value, cursor);
    return { value: value.slice(0, w) + value.slice(cursor), cursor: w };
  }
  if (key.ctrl && input === "w") {
    const w = wordLeft(value, cursor);
    return { value: value.slice(0, w) + value.slice(cursor), cursor: w };
  }
  if ((key.meta && input === "d") || (byWord && key.delete)) {
    const e = wordRight(value, cursor);
    return { value: value.slice(0, cursor) + value.slice(e), cursor };
  }
  if (key.ctrl && input === "u") return { value: value.slice(cursor), cursor: 0 };
  if (key.ctrl && input === "k") return { value: value.slice(0, cursor), cursor };
  // Delete eats the character under the cursor, backspace the one behind it.
  if (key.delete) return { value: value.slice(0, cursor) + value.slice(cursor + 1), cursor };
  if (key.backspace) {
    if (cursor > 0) {
      // A newline is a single cell in the flat string; delete it like a char.
      return { value: value.slice(0, cursor - 1) + value.slice(cursor), cursor: cursor - 1 };
    }
    return { value, cursor };
  }

  // --- printable insert (also handles pasted chunks) ---
  if (
    input &&
    !key.ctrl &&
    !key.meta &&
    !key.return &&
    !key.tab &&
    !key.escape &&
    !key.upArrow &&
    !key.downArrow
  ) {
    return { value: value.slice(0, cursor) + input + value.slice(cursor), cursor: cursor + input.length };
  }

  return null;
}
