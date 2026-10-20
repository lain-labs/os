/**
 * The masthead in three dimensions: LΛIN as extruded voxel letters (the A
 * without its bar, as the Lain OS logo writes it) inside a tilted halo, turned
 * in space, lit, and drawn with a luminance ramp of ASCII characters — the
 * spinning logo a session opens with.
 *
 * Points are sampled on every exposed voxel face and round the halo, rotated,
 * projected with perspective into the cell grid and kept in a z-buffer (the
 * donut.c method). Pure: an angle and a size in, `Line[]` out; the app owns the
 * clock.
 */
import { lerpColor, type Theme } from "./theme.js";
import type { Line, Span } from "./markdown.js";

const GLYPHS: Record<string, string[]> = {
  L: ["X....", "X....", "X....", "X....", "X....", "X....", "XXXXX"],
  Λ: ["..X..", ".X.X.", ".X.X.", ".X.X.", "X...X", "X...X", "X...X"],
  I: ["XXX", ".X.", ".X.", ".X.", ".X.", ".X.", "XXX"],
  N: ["X...X", "XX..X", "X.X.X", "X..XX", "X...X", "X...X", "X...X"],
};
const WORD = "LΛIN";
const DEPTH = 2;
const RAMP = ".,-~:;=!*#$@";

type Vec = [number, number, number];
type Sample = { p: Vec; n: Vec; u: number };

/**
 * The halo: its radius, the height of its centre and how far it is tipped
 * toward the viewer, who sees it from a little above — so, as on the logo, its
 * far side runs behind the letters and its near side across them.
 */
const HALO_R = 14;
const HALO_Y = 1.4;
const HALO_TIP = 0.17;

/** The word as a voxel bitmap, one string per row. */
function bitmap(): string[] {
  const rows: string[] = [];
  for (let y = 0; y < 7; y++) rows.push(WORD.split("").map((ch) => GLYPHS[ch][y]).join("."));
  return rows;
}

let cached: { samples: Sample[]; w: number; h: number } | null = null;

/**
 * Points round the halo, already in the camera's frame: it does not turn with
 * the letters, so it stays the logo's clean ellipse while they spin inside it.
 * `a` is each point's angle; −π/2 is the point nearest the viewer.
 */
const halo: { p: Vec; a: number }[] = Array.from({ length: 900 }, (_, i) => {
  const a = (i / 900) * Math.PI * 2;
  const [x, z] = [HALO_R * Math.cos(a), HALO_R * Math.sin(a)];
  return { p: [x, HALO_Y + z * Math.sin(HALO_TIP), z * Math.cos(HALO_TIP)], a };
});

/** Points on every face a neighbour does not cover, centred on the origin. */
function surface(): { samples: Sample[]; w: number; h: number } {
  if (cached) return cached;
  const grid = bitmap();
  const h = grid.length;
  const w = grid[0].length;
  const solid = (x: number, y: number, z: number) => z >= 0 && z < DEPTH && grid[y]?.[x] === "X";
  const faces: { n: Vec; d: Vec; a: Vec; b: Vec }[] = [
    { n: [0, 0, -1], d: [0, 0, -1], a: [1, 0, 0], b: [0, 1, 0] },
    { n: [0, 0, 1], d: [0, 0, 1], a: [1, 0, 0], b: [0, 1, 0] },
    { n: [-1, 0, 0], d: [-1, 0, 0], a: [0, 0, 1], b: [0, 1, 0] },
    { n: [1, 0, 0], d: [1, 0, 0], a: [0, 0, 1], b: [0, 1, 0] },
    { n: [0, 1, 0], d: [0, -1, 0], a: [1, 0, 0], b: [0, 0, 1] },
    { n: [0, -1, 0], d: [0, 1, 0], a: [1, 0, 0], b: [0, 0, 1] },
  ];
  const steps = 6;
  const samples: Sample[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let z = 0; z < DEPTH; z++) {
        if (!solid(x, y, z)) continue;
        // The voxel's centre: x right, y up, z away from the viewer.
        const c: Vec = [x - w / 2 + 0.5, h / 2 - y - 0.5, z - DEPTH / 2 + 0.5];
        for (const f of faces) {
          // `d` is the neighbour's offset in grid space (y grows downward).
          if (solid(x + f.d[0], y + f.d[1], z + f.d[2])) continue;
          for (let i = 0; i < steps; i++) {
            for (let j = 0; j < steps; j++) {
              const s = (i + 0.5) / steps - 0.5;
              const t = (j + 0.5) / steps - 0.5;
              samples.push({
                p: [
                  c[0] + f.n[0] * 0.5 + f.a[0] * s + f.b[0] * t,
                  c[1] + f.n[1] * 0.5 + f.a[1] * s + f.b[1] * t,
                  c[2] + f.n[2] * 0.5 + f.a[2] * s + f.b[2] * t,
                ],
                n: f.n,
                u: (x + 0.5) / w,
              });
            }
          }
        }
      }
    }
  }
  cached = { samples, w, h };
  return cached;
}

/** Columns the logo wants at most — wider than this it only gets coarser. */
export const LOGO_MAX_W = 66;

/**
 * The logo turned by `yaw` (around the vertical axis) and `pitch`, drawn into
 * `rows` × `width` cells and centred. `glow` (0..1) brightens it toward white.
 */
export function logo3dLines(theme: Theme, width: number, rows: number, yaw: number, pitch: number, glow = 0): Line[] {
  const { samples, w } = surface();
  const cols = Math.min(width, LOGO_MAX_W);
  const k2 = 60;
  // A cell is about twice as tall as it is wide, so x is drawn twice as wide;
  // the halo is the widest thing in the scene.
  const span = Math.max(w, HALO_R * 2 + 1);
  const k1 = Math.min(((cols - 2) * k2) / (span * 2 * 1.04), ((rows - 1) * k2) / 9.6);
  const cx = width / 2;
  const cy = rows / 2;
  const zbuf = new Float32Array(width * rows);
  const lum = new Float32Array(width * rows);
  const hue = new Float32Array(width * rows);
  // The halo's cells: 1 its near side, 2 its far side (dimmer); and the glint on them.
  const ring = new Uint8Array(width * rows);
  const shine = new Float32Array(width * rows);
  const [cyw, syw, cp, spt] = [Math.cos(yaw), Math.sin(yaw), Math.cos(pitch), Math.sin(pitch)];
  const rot = (v: Vec): Vec => {
    const x1 = v[0] * cyw + v[2] * syw;
    const z1 = -v[0] * syw + v[2] * cyw;
    return [x1, v[1] * cp - z1 * spt, v[1] * spt + z1 * cp];
  };
  // Light from the upper left, a little in front of the letters.
  const light: Vec = [-0.35, 0.45, -0.82];
  const ll = Math.hypot(...light);
  for (const s of samples) {
    const n = rot(s.n);
    if (n[2] > 0.02) continue; // faces turned away from the viewer
    const p = rot(s.p);
    const ooz = 1 / (p[2] + k2);
    const sx = Math.floor(cx + k1 * ooz * p[0] * 2);
    const sy = Math.floor(cy - k1 * ooz * p[1]);
    if (sx < 0 || sx >= width || sy < 0 || sy >= rows) continue;
    const i = sy * width + sx;
    if (ooz <= zbuf[i]) continue;
    zbuf[i] = ooz;
    const l = (n[0] * light[0] + n[1] * light[1] + n[2] * light[2]) / ll;
    lum[i] = Math.max(0, Math.min(1, 0.18 + 0.82 * l));
    hue[i] = s.u;
  }
  // A glint rides the halo as the letters turn, so the ring seems to turn too.
  const glintAt = -Math.PI / 2 + (yaw - REST_YAW);
  for (const { p, a } of halo) {
    const ooz = 1 / (p[2] + k2);
    const sx = Math.floor(cx + k1 * ooz * p[0] * 2);
    const sy = Math.floor(cy - k1 * ooz * p[1]);
    if (sx < 0 || sx >= width || sy < 0 || sy >= rows) continue;
    const i = sy * width + sx;
    if (ooz <= zbuf[i]) continue;
    zbuf[i] = ooz;
    ring[i] = p[2] < 0 ? 1 : 2;
    const d = Math.abs(Math.atan2(Math.sin(a - glintAt), Math.cos(a - glintAt)));
    shine[i] = Math.max(0, 1 - d / 0.45);
  }
  const out: Line[] = [];
  for (let y = 0; y < rows; y++) {
    const line: Span[] = [];
    let run = "";
    const flush = () => {
      if (run) line.push({ t: run });
      run = "";
    };
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!zbuf[i]) {
        run += " ";
        continue;
      }
      flush();
      if (ring[i]) {
        // The halo glows in the gradient across the screen, its far side dimmer.
        const base = lerpColor(theme.gradFrom, theme.gradTo, x / Math.max(1, width - 1));
        const near = ring[i] === 1;
        const lit = lerpColor(near ? lerpColor(base, "#ffffff", 0.2) : lerpColor(base, theme.mutedDim, 0.4), "#ffffff", shine[i] * 0.8);
        line.push({ t: near ? "=" : "-", c: glow ? lerpColor(lit, "#ffffff", glow) : lit, b: near });
        continue;
      }
      const l = lum[i];
      const ch = RAMP[Math.min(RAMP.length - 1, Math.floor(l * RAMP.length))];
      const base = lerpColor(theme.gradFrom, theme.gradTo, hue[i]);
      // Shade toward the dim end in the dark, toward white where the light hits.
      const shaded = l < 0.5 ? lerpColor(theme.mutedDim, base, 0.35 + l * 1.3) : lerpColor(base, "#ffffff", (l - 0.5) * 0.5);
      line.push({ t: ch, c: glow ? lerpColor(shaded, "#ffffff", glow) : shaded, b: l > 0.7 });
    }
    flush();
    out.push(line);
  }
  return out;
}

/** How long the opening spin runs, ms. */
export const INTRO_MS = 2600;
/** Where the spin comes to rest: turned a little, so the extrusion shows. */
const REST_YAW = -0.26;
const REST_PITCH = 0.16;

/**
 * The pose `t` ms into a spin of `turns` full turns: fast at first, then
 * easing into the resting angle. Past the end it is the rest pose.
 */
export function spinPose(t: number, turns = 1.5, duration = INTRO_MS): { yaw: number; pitch: number; glow: number } {
  const p = Math.max(0, Math.min(1, t / duration));
  const ease = 1 - (1 - p) ** 3;
  const left = 1 - ease;
  return {
    yaw: REST_YAW - left * turns * Math.PI * 2,
    pitch: REST_PITCH + Math.sin(p * Math.PI * 2) * 0.18 * left,
    // A flash as it lands.
    glow: p > 0.82 && p < 1 ? Math.sin(((p - 0.82) / 0.18) * Math.PI) * 0.35 : 0,
  };
}
