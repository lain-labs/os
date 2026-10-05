/** Visual language for the LainOS TUI — selectable skins. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Theme {
  name: string;
  label: string;
  primary: string; // lain / prompt accent
  secondary: string; // you / tool / model accent
  ok: string;
  warn: string;
  err: string;
  muted: string;
  mutedDim: string;
  fg: string;
  gradFrom: string; // banner gradient ends
  gradTo: string;
  codeFg: string; // fenced code foreground
  panelBg: string; // code blocks / inline code background
  border: string; // code panel and sidebar borders
}

export const THEMES: Record<string, Theme> = {
  wired: {
    name: "wired", label: "Wired — Lain pink/cyan",
    primary: "#ff5fa0", secondary: "#5fd0ff", ok: "#5fffaf", warn: "#ffd86b", err: "#ff6b6b",
    muted: "#8a93a6", mutedDim: "#535b6e", fg: "#e8e8f2", gradFrom: "#ff5fa0", gradTo: "#5fd0ff",
    codeFg: "#c8d0e6", panelBg: "#16131f", border: "#3a3550",
  },
  matrix: {
    name: "matrix", label: "Matrix — green phosphor",
    primary: "#39ff14", secondary: "#2bd46a", ok: "#8bff9e", warn: "#c8ff5f", err: "#ff5f5f",
    muted: "#4f9f6a", mutedDim: "#2c5d3f", fg: "#c8ffcf", gradFrom: "#064a25", gradTo: "#39ff14",
    codeFg: "#b8ffc0", panelBg: "#06120a", border: "#1c4a2a",
  },
  synthwave: {
    name: "synthwave", label: "Synthwave — 80s neon",
    primary: "#ff2e97", secondary: "#00e5ff", ok: "#51f7c5", warn: "#ffd166", err: "#ff5d73",
    muted: "#9a8cc0", mutedDim: "#574a7a", fg: "#f3e9ff", gradFrom: "#ff2e97", gradTo: "#7a5cff",
    codeFg: "#e6dcff", panelBg: "#1a0e33", border: "#4a2f77",
  },
  amber: {
    name: "amber", label: "Amber — CRT terminal",
    primary: "#ffb000", secondary: "#ffcf6b", ok: "#d6ff5f", warn: "#ffd000", err: "#ff6a00",
    muted: "#b07a2a", mutedDim: "#6e4d1a", fg: "#ffd591", gradFrom: "#6e3100", gradTo: "#ffb000",
    codeFg: "#ffd591", panelBg: "#1c1204", border: "#6e4d1a",
  },
  ice: {
    name: "ice", label: "Ice — cold blue",
    primary: "#6fd3ff", secondary: "#aef0ff", ok: "#79ffd1", warn: "#ffe08a", err: "#ff8b94",
    muted: "#7e93b0", mutedDim: "#46566f", fg: "#e6f4ff", gradFrom: "#1f6feb", gradTo: "#aef0ff",
    codeFg: "#dcebff", panelBg: "#0e1a2e", border: "#24405f",
  },
  crimson: {
    name: "crimson", label: "Crimson — blood red",
    primary: "#ff3b4e", secondary: "#ff8a5c", ok: "#6fffb0", warn: "#ffcf5f", err: "#ff2d2d",
    muted: "#b07a85", mutedDim: "#5e2b33", fg: "#ffd9de", gradFrom: "#4a0a12", gradTo: "#ff3b4e",
    codeFg: "#ffd9de", panelBg: "#1d0a10", border: "#5e2b33",
  },
  mono: {
    name: "mono", label: "Mono — minimal monochrome",
    primary: "#ffffff", secondary: "#aab3c0", ok: "#a8e6a3", warn: "#e6d6a3", err: "#e6a3a3",
    muted: "#8a93a6", mutedDim: "#474e5c", fg: "#e8e8f2", gradFrom: "#6a7280", gradTo: "#ffffff",
    codeFg: "#d6dae2", panelBg: "#15181f", border: "#3a404b",
  },
};

export const THEME_ORDER = ["wired", "matrix", "synthwave", "amber", "ice", "crimson", "mono"];
export const DEFAULT_THEME = "wired";

export const GLYPH = {
  you: "▸", lain: "◆", tool: "⚙", ok: "✓", fail: "✕", chain: "⛓", spark: "✶", dot: "·", swatch: "██",
  expand: "▸", collapse: "▾", dots: "…",
};

export const VERSION = "0.1.0";
export const CHAIN_ID = Number(process.env.CHAIN_ID) || undefined;
export const CHAIN_NAME = process.env.CHAIN_NAME || "no chain configured";

/** "LAIN OS" in the ANSI Shadow figure font. */
export const BANNER = [
  "██╗      █████╗ ██╗███╗   ██╗    ██████╗ ███████╗",
  "██║     ██╔══██╗██║████╗  ██║   ██╔═══██╗██╔════╝",
  "██║     ███████║██║██╔██╗ ██║   ██║   ██║███████╗",
  "██║     ██╔══██║██║██║╚██╗██║   ██║   ██║╚════██║",
  "███████╗██║  ██║██║██║ ╚████║   ╚██████╔╝███████║",
  "╚══════╝╚═╝  ╚═╝╚═╝╚═╝  ╚═══╝    ╚═════╝ ╚══════╝",
];

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r: number, g: number, b: number): string {
  const h = (x: number) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** Linear interpolate between two hex colours (t in [0,1]). */
export function lerpColor(a: string, b: string, t: number): string {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  return rgbToHex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
}

// ----------------------------------------------------- skin persistence

interface Prefs {
  skin?: string;
  effort?: string;
  cursor?: string; // "block-blink" | "block-steady" | "line-blink" | "line-steady"
  pulse?: boolean; // ambient chain-watcher murmurs on/off
  view?: string; // "auto" | "scroll" | "full"
}

function prefsPath(): string {
  return join(process.env.LAINOS_DATA_DIR ?? "./data", "tui-prefs.json");
}

function readPrefs(): Prefs {
  try {
    return JSON.parse(readFileSync(prefsPath(), "utf8")) as Prefs;
  } catch {
    return {};
  }
}

function writePrefs(prefs: Prefs): void {
  try {
    mkdirSync(process.env.LAINOS_DATA_DIR ?? "./data", { recursive: true });
    writeFileSync(prefsPath(), JSON.stringify(prefs, null, 2));
  } catch {
    /* best-effort only */
  }
}

/** The skin to start in: env override → saved preference → default. */
export function loadSkin(): string {
  const env = process.env.LAINOS_TUI_SKIN;
  if (env && THEMES[env]) return env;
  const saved = readPrefs().skin;
  return saved && THEMES[saved] ? saved : DEFAULT_THEME;
}

/** Persist the chosen skin, keeping other prefs intact. */
export function saveSkin(skin: string): void {
  writePrefs({ ...readPrefs(), skin });
}

/** The effort level to start in: env override → saved preference → "medium". */
export function loadEffort(): string {
  return process.env.LAINOS_TUI_EFFORT ?? readPrefs().effort ?? "medium";
}

/** Persist the chosen effort, keeping other prefs intact. */
export function saveEffort(effort: string): void {
  writePrefs({ ...readPrefs(), effort });
}

/** Whether the ambient chain pulse is on: env override → saved → on. */
export function loadPulse(): boolean {
  const env = process.env.LAINOS_TUI_PULSE;
  if (env !== undefined) return env !== "0" && env !== "off";
  return readPrefs().pulse ?? true;
}

/** Persist the pulse toggle, keeping other prefs intact. */
export function savePulse(pulse: boolean): void {
  writePrefs({ ...readPrefs(), pulse });
}

/** Cursor style+blink, e.g. "block-blink". env override → saved → default. */
export function loadCursor(): string {
  return process.env.LAINOS_TUI_CURSOR ?? readPrefs().cursor ?? "block-blink";
}

/** Persist the chosen cursor style, keeping other prefs intact. */
export function saveCursor(cursor: string): void {
  writePrefs({ ...readPrefs(), cursor });
}

/**
 * How the transcript is drawn. "full" owns the whole screen (in-app scroll,
 * sidebar, mouse); "scroll" prints finished turns into the terminal's own
 * scrollback, so the terminal scrolls and selects them natively — what a phone
 * needs; "auto" picks scroll below 100 columns. env override → saved → auto.
 */
export type ViewPref = "auto" | "scroll" | "full";
const VIEWS: readonly ViewPref[] = ["auto", "scroll", "full"];
export const isViewPref = (v: unknown): v is ViewPref => VIEWS.includes(v as ViewPref);

export function loadView(): ViewPref {
  const env = process.env.LAINOS_TUI_VIEW;
  if (isViewPref(env)) return env;
  const saved = readPrefs().view;
  return isViewPref(saved) ? saved : "auto";
}

export function saveView(view: ViewPref): void {
  writePrefs({ ...readPrefs(), view });
}
