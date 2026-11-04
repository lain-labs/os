"use strict";

/**
 * Lain in pixels for the desktop pet — the same 16×16 sprite the TUI draws in
 * its sidebar (src/clients/tui/mascot.ts), in the wired skin: a black
 * silhouette of hair lit by a neon rim, the face washed pink to cyan, the halo
 * across her bangs and the X clip on it. She blinks, hops and glitches when
 * poked, and says a line.
 *
 * Pure: a pose in, a 16×16 grid of colours out. Loaded as a classic script by
 * pet.html (it sets `LainSprite`) and required by the tests.
 */

const W = 16;

const WIRED = { primary: "#ff5fa0", secondary: "#5fd0ff", panelBg: "#16131f" };

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
const BLINK = {
  8: "..rkffffffffkr..",
  9: "..rkfeeffeefkr..",
};

/** Eyes to her left. */
const LOOK = {
  8: "..rkffeeffeekr..",
  9: "..rkffiwffiwkr..",
};

/** What she says when poked. Short enough for the bubble. */
const LINES = [
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

/** How long a poke holds the stage: the hop, the glitch, the bubble. */
const POKE_MS = 4500;
/** How long a glint takes to cross the halo. */
const GLINT_MS = 900;

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function lerpColor(a, b, t) {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  const c = (i) => Math.round(A[i] + (B[i] - A[i]) * t).toString(16).padStart(2, "0");
  return `#${c(0)}${c(1)}${c(2)}`;
}

/** The colour of a pixel; the light runs across her from pink to cyan, as on the logo. */
function paint(key, x) {
  const g = lerpColor(WIRED.primary, WIRED.secondary, x / (W - 1));
  const black = lerpColor(WIRED.panelBg, "#000000", 0.6);
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
      return null;
  }
}

/** A small deterministic noise, so a glitch frame is the same frame on every redraw. */
function noise(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * The sprite as 16 rows of 16 colours (`null` is transparent). `frame` seeds
 * the glitch, which tears a row a pixel sideways and tints it; `glint` (0..1,
 * left to right) is where a flash on the halo is.
 */
function pixels(pose, frame = 0, glint) {
  const grid = SPRITE.map((row, y) => (pose === "blink" ? BLINK[y] : pose === "look" ? LOOK[y] : undefined) ?? row);
  return grid.map((row, y) => {
    const band = Math.floor(y / 2);
    const shift = pose === "glitch" && noise(frame * 7 + band) > 0.55 ? (noise(frame + band) > 0.5 ? 1 : -1) : 0;
    const tint = shift ? (shift > 0 ? WIRED.secondary : WIRED.primary) : null;
    const out = [];
    for (let x = 0; x < W; x++) {
      const key = row[x - shift];
      let c = paint(key ?? ".", x);
      if (c && glint !== undefined && (key === "o" || key === "x")) {
        const near = Math.max(0, 1 - Math.abs(x / (W - 1) - glint) * 5);
        c = lerpColor(c, "#ffffff", near * 0.85);
      }
      out.push(c && tint ? lerpColor(c, tint, 0.45) : c);
    }
    return out;
  });
}

/**
 * The pose for this moment: a poke first (a hop with a glint across the halo,
 * a glitch, then the bubble), otherwise standing, with a blink over it.
 */
function pose(now, poke, blinking) {
  const frame = Math.floor(now / 80);
  if (poke && now - poke.at < POKE_MS) {
    const t = now - poke.at;
    const p = t < 480 ? (Math.floor(t / 120) % 2 === 0 ? "hop" : "idle") : t < 760 ? "glitch" : blinking ? "blink" : "idle";
    return { pose: p, frame, ...(t < GLINT_MS ? { glint: t / GLINT_MS } : {}), ...(t >= 240 ? { say: poke.say } : {}) };
  }
  return { pose: blinking ? "blink" : "idle", frame };
}

const LainSprite = { W, LINES, POKE_MS, pixels, pose };

if (typeof module !== "undefined") module.exports = LainSprite;
else globalThis.LainSprite = LainSprite;
