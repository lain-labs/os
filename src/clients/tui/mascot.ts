/**
 * Lain, in pixels, drawn the way the Lain OS logo draws her: a black silhouette
 * of hair lit by a neon rim, the face washed in the skin's gradient, the halo
 * across her bangs, wider than her head, and the X clip on it. A 16×16 sprite
 * drawn two pixels to a cell with half blocks, so it costs eight rows of the
 * sidebar. It blinks, looks aside while she thinks (a glint runs along the
 * halo), glitches while she answers, and hops when it is clicked.
 *
 * Pure: a pose and a theme in, `Line[]` out. The app owns the clock.
 */
import { lerpColor, type Theme } from "./theme.js";
import type { Line, Span } from "./markdown.js";

/** What the sprite is doing this frame. */
export type MascotPose = "idle" | "blink" | "look" | "glitch" | "hop";

export const MASCOT_W = 16;
/** Rows of the sprite itself; the panel keeps one more for the hop. */
export const MASCOT_ROWS = 8;

// k: hair, a silhouette · K: its sheen · r: the rim light · o: the halo
// x: the clip · f/F: face, lit → shade · n: the neck · e: lash · i: iris
// w: shine · m: mouth · d: the hoodie · D: its rim
const SPRITE = [
  "......rrrr......",
  "....rrkkkkrr....",
  "...rkkKkkkkkr...",
  "..rkKkkkkkkkkr..",
  "o.rkkkkkkkxkxr.o",
  ".ooooooooooxooo.",
  "..rkkkkkkkxkxr..",
  "..rkffffffffkr..",
  "..rkfeeffeefkr..",
  "..rkfiwffiwfkr..",
  "..rkffffffffkr..",
  "..rkkfffmffkkr..",
  "..rkkkFffFkkkr..",
  "..r.rkknnkkr.r..",
  "...DddddddddD...",
  "..DddddddddddD..",
];

/** Eyes shut: the eye rows become face, the lower one a lash line. */
const BLINK: Record<number, string> = {
  8: "..rkffffffffkr..",
  9: "..rkfeeffeefkr..",
};

/** Eyes to her left — what she does while she is thinking. */
const LOOK: Record<number, string> = {
  8: "..rkffeeffeekr..",
  9: "..rkffiwffiwkr..",
};

/**
 * The colour of a pixel. The light runs across her from the skin's primary to
 * its secondary — pink to cyan on the wired skin, as on the logo.
 */
function paint(theme: Theme, key: string, x: number): string | undefined {
  const g = lerpColor(theme.primary, theme.secondary, x / (MASCOT_W - 1));
  const black = lerpColor(theme.panelBg, "#000000", 0.6);
  const face = lerpColor(g, "#ffffff", 0.25);
  switch (key) {
    case "k":
    case "d":
      return black;
    case "K":
      return lerpColor(black, g, 0.22);
    case "r":
      return lerpColor(g, black, 0.15);
    case "D":
      return lerpColor(g, black, 0.45);
    case "o":
      return lerpColor(g, "#ffffff", 0.2);
    case "x":
      return lerpColor(g, "#ffffff", 0.7);
    case "f":
      return face;
    case "F":
      return lerpColor(g, black, 0.25);
    case "n":
      return lerpColor(g, black, 0.75);
    case "e":
      return lerpColor(black, g, 0.12);
    case "i":
      return lerpColor(g, black, 0.35);
    case "w":
      return "#ffffff";
    case "m":
      return lerpColor(face, black, 0.3);
    default:
      return undefined;
  }
}

/** A small deterministic noise, so a glitch frame is the same frame on every redraw. */
function noise(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * The sprite as `MASCOT_ROWS + 1` lines of `MASCOT_W` cells. Standing, it
 * leaves the top row empty; a hop spends it. `frame` seeds the glitch; `glint`
 * (0..1, left to right) is where a flash on the halo is.
 */
export function mascotLines(theme: Theme, pose: MascotPose, frame = 0, glint?: number): Line[] {
  const grid = SPRITE.map((row, y) => (pose === "blink" ? BLINK[y] : pose === "look" ? LOOK[y] : undefined) ?? row);
  const color = (key: string | undefined, x: number): string | undefined => {
    const c = paint(theme, key ?? ".", x);
    if (!c || glint === undefined || (key !== "o" && key !== "x")) return c;
    const near = Math.max(0, 1 - Math.abs(x / (MASCOT_W - 1) - glint) * 5);
    return lerpColor(c, "#ffffff", near * 0.85);
  };
  const rows: Line[] = [];
  for (let r = 0; r < MASCOT_ROWS; r++) {
    const top = grid[r * 2];
    const bottom = grid[r * 2 + 1];
    // A glitch tears a row sideways and splits its colour, a cell or two.
    const shift = pose === "glitch" && noise(frame * 7 + r) > 0.55 ? (noise(frame + r) > 0.5 ? 1 : -1) : 0;
    const tint = pose === "glitch" && shift ? (shift > 0 ? theme.secondary : theme.primary) : null;
    const line: Span[] = [];
    for (let x = 0; x < MASCOT_W; x++) {
      const sx = x - shift;
      const up = color(top[sx], x);
      const down = color(bottom[sx], x);
      const fg = (c: string | undefined) => (c && tint ? lerpColor(c, tint, 0.45) : c);
      if (!up && !down) line.push({ t: " " });
      else if (up && down) line.push({ t: "▀", c: fg(up), bg: fg(down) });
      else if (up) line.push({ t: "▀", c: fg(up) });
      else line.push({ t: "▄", c: fg(down) });
    }
    rows.push(line);
  }
  const empty: Line = [{ t: " ".repeat(MASCOT_W) }];
  return pose === "hop" ? [...rows, empty] : [empty, ...rows];
}

/** What she says when poked. Short enough for a bubble beside the sprite. */
export const MASCOT_LINES = [
  "present day. present time.",
  "the wired is listening.",
  "you poked me.",
  "no matter where you go, everyone's connected.",
  "i'm watching the chain.",
  "close the world, open the next.",
  "let's all love lain.",
  "did you check the P&L?",
  "who are you, really?",
  "i was never only here.",
];

/** A click on her: when it landed and what she answers. */
export type Poke = { at: number; say: string };
/** How long a poke holds the stage: the hop, the glitch, the bubble. */
export const POKE_MS = 4500;

/** How long a glint takes to cross the halo, and how often one starts while she thinks. */
const GLINT_MS = 900;
const GLINT_EVERY_MS = 1600;

/**
 * The pose for this moment. A poke comes first (a hop with a glint across the
 * halo, a glitch, then the bubble), then what she is doing — eyes aside and the
 * halo glinting while she thinks, a flicker now and then while she answers —
 * and a blink over whatever is left.
 */
export function mascotPose(
  now: number,
  status: "idle" | "thinking" | "streaming",
  poke: Poke | null,
  blinking: boolean,
): { pose: MascotPose; frame: number; say?: string; glint?: number } {
  const frame = Math.floor(now / 80);
  if (poke && now - poke.at < POKE_MS) {
    const t = now - poke.at;
    const pose: MascotPose = t < 480 ? (Math.floor(t / 120) % 2 === 0 ? "hop" : "idle") : t < 760 ? "glitch" : blinking ? "blink" : "idle";
    return { pose, frame, ...(t < GLINT_MS ? { glint: t / GLINT_MS } : {}), ...(t >= 240 ? { say: poke.say } : {}) };
  }
  if (status === "thinking") {
    const t = now % GLINT_EVERY_MS;
    return {
      pose: blinking ? "blink" : Math.floor(now / 900) % 2 ? "look" : "idle",
      frame,
      ...(t < GLINT_MS ? { glint: t / GLINT_MS } : {}),
    };
  }
  if (status === "streaming") return { pose: now % 2600 < 240 ? "glitch" : blinking ? "blink" : "idle", frame };
  return { pose: blinking ? "blink" : "idle", frame };
}
