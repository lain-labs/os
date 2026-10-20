/**
 * Small text charts shared by the live boards (trench, stocks): sparklines,
 * progress bars, a gradient title, fixed-width cells and a wall clock.
 */
import { sp, type Line } from "./markdown.js";
import { lerpColor, type Theme } from "./theme.js";

const SPARK = "▁▂▃▄▅▆▇█";

/** A sparkline over the last `width` values; `minSpan` keeps tiny wiggles from filling the whole height. */
export function spark(values: number[], width: number, color: string, dim: string, minSpan = 0): Line {
  if (values.length < 2) return [sp("·".repeat(width), dim)];
  const tail = values.slice(-width);
  let lo = Math.min(...tail);
  let hi = Math.max(...tail);
  if (hi - lo < minSpan) {
    const mid = (hi + lo) / 2;
    lo = mid - minSpan / 2;
    hi = mid + minSpan / 2;
  }
  const chars = tail.map((v) => SPARK[hi === lo ? 3 : Math.round(((v - lo) / (hi - lo)) * (SPARK.length - 1))]!);
  return [sp(" ".repeat(width - chars.length), dim), sp(chars.join(""), color)];
}

export function bar(frac: number, width: number, on: string, off: string): Line {
  const f = Math.max(0, Math.min(1, frac));
  const full = Math.floor(f * width);
  const part = " ▏▎▍▌▋▊▉"[Math.floor((f * width - full) * 8)] ?? "";
  const rest = Math.max(0, width - full - (part.trim() ? 1 : 0));
  return [sp("█".repeat(full) + (part.trim() ? part : ""), on), sp("░".repeat(rest), off)];
}

export function gradient(text: string, c: Theme): Line {
  const chars = [...text];
  return chars.map((ch, i) => ({ t: ch, c: lerpColor(c.gradFrom, c.gradTo, chars.length > 1 ? i / (chars.length - 1) : 0), b: true }));
}

export function pad(s: string, n: number): string {
  const chars = [...s];
  return chars.length > n ? `${chars.slice(0, n - 1).join("")}…` : s + " ".repeat(n - chars.length);
}

/** Local HH:MM:SS of a unix-seconds time. */
export function clockOf(ts: number): string {
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * A journal line for a board: the engines lead their lines with 🟢/🟩/🟥/🟨,
 * which some terminals draw two cells wide and others one — enough to shove a
 * sidebar border. The board swaps them for single-width glyphs in colour.
 */
export function journalSpans(text: string, c: Theme): Line {
  const marks: [string, string, string][] = [
    ["🟢", "▲", c.ok],
    ["🟩", "✓", c.ok],
    ["🟥", "✕", c.err],
    ["🟨", "◐", c.warn],
  ];
  for (const [emoji, glyph, color] of marks) {
    if (text.startsWith(emoji)) return [{ t: glyph, c: color, b: true }, sp(text.slice(emoji.length), c.fg)];
  }
  return [sp(text, c.warn)];
}
