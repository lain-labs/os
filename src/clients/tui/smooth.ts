/**
 * Flicker-free frames on top of ink 5.
 *
 * ink repaints by erasing every line of the last frame and then writing the
 * new one. A desktop terminal draws fast enough to show the screen between
 * the two — a full-window frame blanks and refills on every keystroke, every
 * spinner tick and every cursor blink, and a native selection over it is
 * wiped each time. Two changes, both invisible to a terminal that ignores them:
 *
 * - the erase-then-write becomes an overwrite: the cursor goes back up to the
 *   frame's first row and each line is written over the old one, cleared only
 *   to its end, and whatever is left below the new frame is cleared last;
 * - everything written in one tick goes inside a synchronized update
 *   (DEC mode 2026), so a terminal that supports it shows the frame whole.
 */

// ansi-escapes' eraseLines(n): "clear line, up" n-1 times, clear line, column 1.
const ERASE_LINES = /^((?:\x1b\[2K\x1b\[1A)*)\x1b\[2K\x1b\[G/;

/** ink's `eraseLines(n) + frame` rewritten as an in-place overwrite; anything else as is. */
export function overwriteFrame(chunk: string): string {
  const m = ERASE_LINES.exec(chunk);
  if (!m) return chunk;
  const frame = chunk.slice(m[0].length);
  if (!frame) return chunk; // a bare clear (before <Static> output) stays a clear
  const up = m[1].length / "\x1b[2K\x1b[1A".length;
  return `${up ? `\x1b[${up}A` : ""}\r${frame.replace(/\n/g, "\x1b[K\n")}\x1b[J`;
}

const BEGIN_SYNC = "\x1b[?2026h";
const END_SYNC = "\x1b[?2026l";

/** Route a terminal stream's writes through {@link overwriteFrame}, one synchronized update per tick. */
export function smoothFrames(stream: NodeJS.WriteStream): void {
  const write = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
  let open = false;
  stream.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (!open) {
      open = true;
      write(BEGIN_SYNC);
      queueMicrotask(() => {
        open = false;
        write(END_SYNC);
      });
    }
    return write(typeof chunk === "string" ? overwriteFrame(chunk) : chunk, ...rest);
  }) as typeof stream.write;
}
