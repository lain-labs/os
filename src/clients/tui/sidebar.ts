/**
 * The right-hand column as a stack of small windows: Lain herself, the
 * wallet, the chain, the forge, the session, the keys. Each has a title bar; a
 * click on it folds the window down to that bar or opens it again. When the
 * column is too short for every open window, the least important fold first.
 *
 * Pure, like the rest of the frame: data in, exactly `rows` lines and the hit
 * map beside them out.
 */
import { CHAIN_ID, CHAIN_NAME, GLYPH, type Theme } from "./theme.js";
import { blank, concat, fitLine, lineWidth, sp, truncateLine, wrapSpans, type Line, type Span } from "./markdown.js";
import { spinnerChar } from "./layout.js";
import { MASCOT_W, mascotLines, type MascotPose } from "./mascot.js";
import { spark } from "./charts.js";
import { fmtAmount, fmtSigned, fmtUsd, type PortfolioView } from "./portfolio.js";

export type PanelId = "lain" | "wallet" | "chain" | "forge" | "session" | "keys";
export const PANEL_ORDER: readonly PanelId[] = ["lain", "wallet", "chain", "forge", "session", "keys"];
/** Who gives way first when the column runs out of rows. */
const YIELD_ORDER: readonly PanelId[] = ["keys", "session", "forge", "chain", "wallet", "lain"];

/** A clickable sidebar row: open a picker, run a command or one of the copy
 *  actions, fold a window, or poke Lain. The actions have keys too, but an
 *  editor that hosts the terminal may eat those (VS Code keeps ctrl+s for
 *  itself), and a click it cannot take. */
export type SidebarRegion =
  | { kind: "pick"; action: "agent" | "model" | "effort" | "skin" }
  | { kind: "act"; action: "select" | "copy" }
  | { kind: "cmd"; command: string }
  /** `open` is how the window is drawn now — it may have folded itself for room. */
  | { kind: "fold"; panel: PanelId; open: boolean }
  | { kind: "mascot" };

/** What a row does when clicked; a row split in two (the sprite beside its text) says where. */
export type SidebarHit = SidebarRegion | { kind: "cols"; at: number; left?: SidebarRegion; right?: SidebarRegion };

/** The target under sidebar column `col` (0 is the divider) of a row's hit. */
export function sidebarTarget(hit: SidebarHit | undefined, col: number): SidebarRegion | undefined {
  if (hit?.kind !== "cols") return hit;
  return col < hit.at ? hit.left : hit.right;
}

export interface SidebarData {
  provider: string;
  model: string;
  /** The forge's coding agent: "codex/gpt-6.1-sol low", or "none". */
  coder: string;
  /** What the forge is doing: "idle", "job14 · 3m", "job14 · 3m +2". */
  forge: string;
  /** The newest completed forge result, or "none". */
  lastForge: string;
  block: number | null;
  tokens: number;
  room: string;
  /** Session id for the current room, once it has one (first turn creates it). */
  session?: string;
  effort: string;
  skinLabel: string;
  watches: number;
  wishes: number;
  topics: number;
  skills: number;
  status: "idle" | "thinking" | "streaming";
  /** How long she has been at the current answer, ms. */
  elapsed: number;
  spin: number;
  pulse: boolean;
  /** Her pose; `poked` once she has been clicked this session (the "poke me" hint goes). */
  mascot: { pose: MascotPose; frame: number; say?: string; glint?: number; poked: boolean };
  /** null until the first reading lands. */
  portfolio: PortfolioView | null;
  /** The equity just moved, and which way — the value flashes. */
  flash?: "up" | "down";
  /** Windows folded by hand, and the one opened last (it folds last). */
  folded: ReadonlySet<PanelId>;
  pinned?: PanelId;
}

type Row = { line: Line; hit?: SidebarHit };
/**
 * One window. `summary` rides in the title bar while it is folded; `status`
 * always does. `indent` overrides the usual indent of its rows.
 */
type Panel = { icon: string; color: string; title: string; summary: Line; status?: Line; rows: Row[]; indent?: number };

/** Columns a window's rows sit in from the divider, and the margin they keep on the right. */
const INDENT = 2;
const MARGIN = 1;

/** `label ……… value`, the value against the right edge; a value too long for that follows the label. */
function kv(theme: Theme, width: number, label: string, value: Line, labelColor = theme.muted): Line {
  const head: Line = [sp(label, labelColor)];
  const gap = width - lineWidth(head) - lineWidth(value);
  if (gap >= 1) return concat(head, blank(gap), value);
  return truncateLine(concat(head, [sp(" ")], value), width);
}

const signColor = (theme: Theme, n: number | null) => (n === null || n === 0 ? theme.muted : n > 0 ? theme.ok : theme.err);

function pctLine(theme: Theme, pct: number | null): Line {
  if (pct === null || !Number.isFinite(pct)) return [];
  const arrow = pct > 0 ? "▲" : pct < 0 ? "▼" : "•";
  return [sp(`${arrow} ${Math.abs(pct).toFixed(2)}%`, signColor(theme, pct))];
}

function lainPanel(theme: Theme, inner: number, d: SidebarData): Panel {
  const c = theme;
  const status: Line =
    d.status === "idle"
      ? [sp("● ", c.ok), sp("ready", c.muted)]
      : [sp(`${spinnerChar(d.spin)} `, c.warn), sp(`${d.status === "thinking" ? "thinking" : "answering"} ${Math.round(d.elapsed / 1000)}s`, c.warn)];
  const sprite = mascotLines(theme, d.mascot.pose, d.mascot.frame, d.mascot.glint);
  // The sprite sits at the left, one column in so the halo has room to reach
  // past her head; the text column gets what is left after a gap.
  const indent = 1;
  const textW = Math.max(4, inner - indent - MASCOT_W - 1 - MARGIN);
  // A narrow column keeps the values and drops their labels.
  const labelled = (label: string, value: string): Line =>
    label.length + 1 + value.length <= textW ? [sp(`${label} `, c.mutedDim), sp(value, c.fg)] : [sp(value, c.fg)];
  const right: { line: Line; hit?: SidebarRegion }[] = d.mascot.say
    ? bubble(theme, textW, d.mascot.say)
    : [
        { line: [] },
        { line: [{ t: d.provider, c: c.primary, b: true }], hit: { kind: "pick", action: "agent" } },
        { line: [sp(d.model, c.secondary)], hit: { kind: "pick", action: "model" } },
        { line: labelled("effort", d.effort), hit: { kind: "pick", action: "effort" } },
        { line: [] },
        { line: labelled("skin", d.skinLabel), hit: { kind: "pick", action: "skin" } },
        { line: d.mascot.poked ? [] : [{ t: "◂ poke me", c: c.mutedDim, i: true }] },
      ];
  const split = 1 + indent + MASCOT_W + 1;
  const rows: Row[] = sprite.map((s, i) => {
    const r = right[i];
    const pointer = d.mascot.say && i === 2 && textW >= 16 ? sp("◂", c.border) : sp(" ");
    return {
      line: concat(s, [pointer], fitLine(r?.line ?? [], textW)),
      hit: { kind: "cols", at: split, left: { kind: "mascot" }, right: r?.hit },
    };
  });
  return { icon: "◆", color: c.primary, title: "lain", summary: [], status, rows, indent };
}

/**
 * What she says, as rows for the column beside the sprite: in a bubble when the
 * column is wide enough to hold one, in quotes when a frame would leave the
 * words no room.
 */
function bubble(theme: Theme, width: number, text: string): { line: Line }[] {
  const c = theme;
  if (width < 16) {
    return [{ line: [] }, ...wrapSpans([{ t: `“${text}”`, c: c.fg, i: true }], width).slice(0, 7).map((line) => ({ line }))];
  }
  const innerW = Math.max(2, width - 4);
  const body = wrapSpans([{ t: text, c: c.fg, i: true }], innerW).slice(0, 5);
  return [
    { line: [sp(`╭${"─".repeat(width - 2)}╮`, c.border)] },
    ...body.map((l) => ({ line: concat([sp("│ ", c.border)], fitLine(l, innerW), [sp(" │", c.border)]) })),
    { line: [sp(`╰${"─".repeat(width - 2)}╯`, c.border)] },
  ];
}

function walletPanel(theme: Theme, inner: number, d: SidebarData): Panel {
  const c = theme;
  const p = d.portfolio;
  const w = inner - INDENT - MARGIN;
  const open: SidebarRegion = { kind: "cmd", command: "/paper" };
  const title = !p || p.mode === "none" ? "wallet" : p.mode === "paper" ? `paper · ${p.wallet}` : `live · ${p.wallet}`;
  if (!p) return { icon: "◈", color: c.secondary, title, summary: [], rows: [{ line: [sp("reading the books…", c.mutedDim)] }] };
  const rows: Row[] = [];
  if (p.note) {
    for (const l of wrapSpans([{ t: p.note, c: c.mutedDim }], w)) rows.push({ line: l, hit: open });
  }
  if (p.equity !== null && Number.isFinite(p.equity)) {
    const value = `${fmtAmount(p.equity)} ${p.symbol}`;
    const flashed: Line = d.flash
      ? [{ t: ` ${value} `, c: "#0b0b12", bg: d.flash === "up" ? c.ok : c.err, b: true }]
      : [{ t: value, c: c.fg, b: true }];
    rows.push({ line: kv(c, w, "equity", flashed), hit: open });
  }
  if (p.pnl !== null && Number.isFinite(p.pnl)) {
    rows.push({
      line: kv(c, w, "P&L", concat([sp(`${fmtSigned(p.pnl)} ${p.symbol}`, signColor(c, p.pnl))], [sp("  ")], pctLine(c, p.pnlPct))),
      hit: open,
    });
  }
  if (p.series.length > 1) {
    const first = p.series[0];
    const last = p.series.at(-1)!;
    const color = last > first ? c.ok : last < first ? c.err : c.mutedDim;
    rows.push({ line: spark(p.series, w, color, c.mutedDim, Math.abs(last) * 0.0005), hit: open });
  }
  for (const b of p.balances) {
    const value: Line = concat(
      [sp(fmtAmount(b.amount), c.fg)],
      b.usd !== null ? [sp(`  ${fmtUsd(b.usd)}`, c.mutedDim)] : [],
    );
    rows.push({ line: kv(c, w, b.symbol, value, c.secondary), hit: open });
  }
  if (p.positions > 0) {
    rows.push({
      line: kv(c, w, "positions", [sp(`${p.positions} · ${fmtAmount(p.positionsValue)} ${p.symbol}`, c.fg)]),
      hit: open,
    });
  }
  if (p.stocks && (p.stocks.on || p.stocks.open > 0)) {
    rows.push({
      line: kv(c, w, "stocks", concat([sp(fmtUsd(p.stocks.equityUsd), c.fg), sp("  ")], pctLine(c, p.stocks.pnlPct))),
      hit: { kind: "cmd", command: "/stocks" },
    });
  }
  if (p.trench && (p.trench.on || p.trench.open > 0)) {
    rows.push({
      line: kv(c, w, "trench", [sp(`${p.trench.on ? "on" : "off"} · ${p.trench.open} open`, p.trench.on ? c.ok : c.muted)]),
      hit: { kind: "cmd", command: "/trench" },
    });
  }
  return { icon: "◈", color: c.secondary, title, summary: pctLine(c, p.pnlPct), rows };
}

function chainPanel(theme: Theme, inner: number, d: SidebarData): Panel {
  const c = theme;
  const w = inner - INDENT - MARGIN;
  const height = d.block === null ? "—" : d.block.toLocaleString("en-US");
  return {
    icon: "⬡",
    color: c.ok,
    title: "chain",
    summary: [sp(height, c.mutedDim)],
    rows: [
      { line: kv(c, w, CHAIN_NAME, [sp(CHAIN_ID ? String(CHAIN_ID) : "", c.mutedDim)], c.fg) },
      { line: kv(c, w, "block", [sp(height, c.fg)]) },
      {
        line: kv(c, w, "whale pulse", [sp(d.pulse ? "on" : "off", d.pulse ? c.ok : c.muted)]),
        hit: { kind: "cmd", command: "/pulse" },
      },
    ],
  };
}

function forgePanel(theme: Theme, inner: number, d: SidebarData): Panel {
  const c = theme;
  const w = inner - INDENT - MARGIN;
  const busy = d.forge !== "idle" && d.forge !== "—";
  const [lastStatus, ...lastRest] = d.lastForge.split(" · ");
  const pair = (a: string, av: number, b: string, bv: number): Line =>
    concat([sp(`${a} `, c.muted), sp(String(av), c.fg)], blank(Math.max(1, Math.floor(w / 2) - a.length - String(av).length - 1)), [
      sp(`${b} `, c.muted),
      sp(String(bv), c.fg),
    ]);
  return {
    icon: "✦",
    color: c.warn,
    title: "forge",
    summary: [sp(d.forge, busy ? c.secondary : c.mutedDim)],
    rows: [
      { line: kv(c, w, "code", [sp(d.coder, d.coder === "none" ? c.muted : c.primary)]), hit: { kind: "cmd", command: "/coder" } },
      { line: kv(c, w, "job", [sp(d.forge, busy ? c.secondary : c.fg)]), hit: { kind: "cmd", command: "/jobs" } },
      {
        line: truncateLine(
          concat(
            [sp("last ", c.muted)],
            [sp(lastStatus, lastStatus === "ok" ? c.ok : lastStatus === "failed" ? c.err : c.fg)],
            lastRest.length ? [sp(` · ${lastRest.join(" · ")}`, c.mutedDim)] : [],
          ),
          w,
        ),
        hit: { kind: "cmd", command: "/jobs" },
      },
      { line: pair("wishes", d.wishes, "watches", d.watches) },
      { line: pair("topics", d.topics, "skills", d.skills) },
    ],
  };
}

function sessionPanel(theme: Theme, inner: number, d: SidebarData): Panel {
  const c = theme;
  const w = inner - INDENT - MARGIN;
  return {
    icon: "◷",
    color: c.secondary,
    title: "session",
    summary: [sp(`${fmtTokens(d.tokens)} tok`, c.mutedDim)],
    rows: [
      { line: kv(c, w, "id", [sp(d.session ?? "new", c.fg)]), hit: { kind: "cmd", command: "/sessions" } },
      { line: kv(c, w, "room", [sp(d.room, c.fg)]) },
      { line: kv(c, w, "tokens", [sp(fmtTokens(d.tokens), c.fg)]) },
    ],
  };
}

function keysPanel(theme: Theme, inner: number): Panel {
  const c = theme;
  const w = inner - INDENT - MARGIN;
  const hint = (key: string, what: string): Row => ({ line: kv(c, w, key, [sp(what, c.muted)], c.fg) });
  const act = (key: string, what: string, action: "select" | "copy"): Row => ({
    line: kv(c, w, key, [sp(what, c.secondary)], c.fg),
    hit: { kind: "act", action },
  });
  return {
    icon: "⌥",
    color: c.muted,
    title: "keys",
    summary: [sp("click to open", c.mutedDim)],
    rows: [
      hint("alt+↵", "new line"),
      hint("drag", "select · copies"),
      act("ctrl+s", "freeze frame", "select"),
      act("ctrl+y", "copy last reply", "copy"),
      hint("click name", "copy the turn"),
      hint("click tool", "expand it"),
      hint("wheel", "scroll · pgup page"),
      hint("ctrl+c", "twice to leave"),
    ],
  };
}

const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** The window's title bar: a fold caret, its glyph and name, a summary at the right edge. */
function titleBar(theme: Theme, inner: number, panel: Panel, open: boolean): Line {
  const c = theme;
  const left: Line = [
    sp(open ? " ▾ " : " ▸ ", c.mutedDim),
    { t: `${panel.icon} `, c: panel.color, b: true },
    { t: panel.title, c: c.fg, b: true },
  ];
  const right = concat(panel.status ?? [], open ? [] : panel.summary, [sp(" ")]);
  const gap = inner - lineWidth(left) - lineWidth(right);
  const line = gap >= 2 ? concat(left, blank(gap), right) : truncateLine(left, inner);
  return fitLine(line, inner).map((s) => ({ ...s, bg: theme.surface }));
}

/** The right sidebar as exactly `rows` lines, each with what a click on it does. */
export function sidebarLines(
  theme: Theme,
  sidebarW: number,
  rows: number,
  data: SidebarData,
): { lines: Line[]; regions: (SidebarHit | undefined)[] } {
  const c = theme;
  const inner = Math.max(8, sidebarW - 1);
  const build: Record<PanelId, () => Panel> = {
    lain: () => lainPanel(theme, inner, data),
    wallet: () => walletPanel(theme, inner, data),
    chain: () => chainPanel(theme, inner, data),
    forge: () => forgePanel(theme, inner, data),
    session: () => sessionPanel(theme, inner, data),
    keys: () => keysPanel(theme, inner),
  };
  const panels = Object.fromEntries(PANEL_ORDER.map((id) => [id, build[id]()])) as Record<PanelId, Panel>;

  // Open what was left open, then fold the least important until it all fits.
  const open = new Set(PANEL_ORDER.filter((id) => !data.folded.has(id)));
  const height = () => PANEL_ORDER.reduce((n, id) => n + (open.has(id) ? panels[id].rows.length + 2 : 1), 0);
  for (const id of YIELD_ORDER) {
    if (height() <= rows) break;
    if (id !== data.pinned) open.delete(id);
  }
  if (height() > rows && data.pinned) open.delete(data.pinned);

  const divider: Span = sp("│", c.border);
  const out: Row[] = [];
  for (const id of PANEL_ORDER) {
    const panel = panels[id];
    const isOpen = open.has(id);
    out.push({ line: titleBar(theme, inner, panel, isOpen), hit: { kind: "fold", panel: id, open: isOpen } });
    if (!isOpen) continue;
    const indent = panel.indent ?? INDENT;
    for (const r of panel.rows) out.push({ line: concat(blank(indent), fitLine(r.line, inner - indent)), hit: r.hit });
    out.push({ line: blank(inner) });
  }
  const shown = out.slice(0, rows);
  while (shown.length < rows) shown.push({ line: blank(inner) });
  return {
    lines: shown.map((r) => concat([divider], fitLine(r.line, inner))),
    regions: shown.map((r) => r.hit),
  };
}
