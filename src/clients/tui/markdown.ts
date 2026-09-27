/**
 * Markdown → terminal lines.
 *
 * The whole screen is drawn as a flat list of styled lines (see App.tsx), so
 * markdown never renders itself: it is parsed into the same `Line[]` model
 * (arrays of colour/style spans) that everything else uses. Pure — no ink, no
 * React — so the height of any reply can be measured exactly and the
 * scrollable transcript sliced precisely.
 *
 * Fenced code blocks are syntax-highlighted with highlight.js; the token class
 * of each scope is mapped onto the active skin instead of a foreign palette,
 * so a code block always matches the chosen theme.
 */
import { marked, type Token } from "marked";
import hljs from "highlight.js/lib/common";
import stringWidth from "string-width";
import type { Theme } from "./theme.js";

// ------------------------------------------------------------ measurement

/**
 * Columns, not characters. `⚙`, `⛓`, `⚠` and every emoji occupy two cells, and
 * ink measures the frame with this same library — count them as one and every
 * line holding one is a column too long, which ink then truncates: the frame
 * loses its right edge, and a line that wraps instead makes ink clear the whole
 * screen. So all of the layout maths goes through here.
 */
const ASCII = /^[\x20-\x7e]*$/;

export function textWidth(t: string): number {
  return ASCII.test(t) ? t.length : stringWidth(t);
}

const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

/** Split into grapheme clusters, so an emoji is never cut in half. */
function graphemes(t: string): string[] {
  if (!segmenter) return [...t];
  return [...segmenter.segment(t)].map((s) => s.segment);
}

/** The longest prefix of `t` that fits in `n` columns, and its width. */
export function fitToWidth(t: string, n: number): { text: string; width: number } {
  if (n <= 0) return { text: "", width: 0 };
  if (ASCII.test(t)) return t.length <= n ? { text: t, width: t.length } : { text: t.slice(0, n), width: n };
  let out = "";
  let w = 0;
  for (const g of graphemes(t)) {
    const gw = stringWidth(g);
    if (w + gw > n) break;
    out += g;
    w += gw;
  }
  return { text: out, width: w };
}

// --------------------------------------------------------------- span model

/** One styled run of text. `t` is always a plain string (no ANSI). */
export interface Span {
  t: string;
  c?: string;
  b?: boolean;
  i?: boolean;
  u?: boolean;
  bg?: string;
}
export type Line = Span[];

export const span = (t: string, o: Omit<Span, "t"> = {}): Span => ({ t, ...o });
export const sp = (t: string, c?: string): Span => ({ t, c });

/** A line of plain text (or a run of `n` spaces). */
export function plain(text: string, c?: string): Line {
  return [{ t: text, c }];
}
export function blank(n: number): Line {
  return [{ t: " ".repeat(Math.max(0, n)) }];
}

/** Visible width of a line, in terminal columns. */
export function lineWidth(l: Line): number {
  let w = 0;
  for (const s of l) w += textWidth(s.t);
  return w;
}

/** Keep only the first `n` columns of a line, respecting span boundaries. */
export function truncateLine(l: Line, n: number): Line {
  const out: Line = [];
  let left = n;
  for (const s of l) {
    if (left <= 0) break;
    const w = textWidth(s.t);
    if (w <= left) {
      out.push(s);
      left -= w;
    } else {
      const cut = fitToWidth(s.t, left);
      if (cut.text) out.push({ ...s, t: cut.text });
      break;
    }
  }
  return out;
}

/** Cut a line at column `at`, splitting the span that straddles it. */
export function splitLine(l: Line, at: number): [Line, Line] {
  const head: Line = [];
  const tail: Line = [];
  let used = 0;
  for (const s of l) {
    if (used >= at) {
      tail.push(s);
      continue;
    }
    const w = textWidth(s.t);
    if (used + w <= at) {
      head.push(s);
      used += w;
      continue;
    }
    const cut = fitToWidth(s.t, at - used);
    if (cut.text) head.push({ ...s, t: cut.text });
    const rest = s.t.slice(cut.text.length);
    if (rest) tail.push({ ...s, t: rest });
    used = at;
  }
  return [head, tail];
}

/** Right-pad a line with spaces out to `n` columns (never truncates). */
export function padLine(l: Line, n: number): Line {
  const w = lineWidth(l);
  return w >= n ? l : [...l, blank(n - w)[0]];
}

/** Truncate then pad to exactly `n` columns. */
export function fitLine(l: Line, n: number): Line {
  return padLine(truncateLine(l, n), n);
}

/** Truncate then pad to exactly `n` columns with `bg` on the pad. */
export function fitLineBg(l: Line, n: number, bg: string): Line {
  const t = truncateLine(l, n);
  const w = lineWidth(t);
  if (w >= n) return t;
  return [...t, ...blank(n - w).map((s) => ({ ...s, bg }))];
}

export const concat = (...ls: Line[]): Line => ls.flat();

// --------------------------------------------------------------- code colours

/** hljs scope → skin colour. Falls back to the code foreground. */
function scopeColor(scope: string | undefined, c: Theme): string | undefined {
  if (!scope) return undefined;
  const s = scope.split(".")[0];
  switch (s) {
    case "keyword":
    case "meta":
      return c.primary;
    case "string":
    case "regexp":
    case "addition":
      return c.ok;
    case "number":
    case "literal":
    case "bullet":
      return c.warn;
    case "comment":
    case "doctag":
    case "quote":
      return c.mutedDim;
    case "function":
    case "title":
    case "class":
    case "type":
    case "built_in":
    case "property":
    case "name":
      return c.secondary;
    case "attr":
    case "attribute":
    case "variable":
    case "template-variable":
    case "selector-id":
    case "selector-class":
      return c.warn;
    default:
      return undefined;
  }
}

interface HlNode {
  children?: (string | HlNode)[];
  scope?: string;
}

/** Recursively walk highlight.js's emitter token tree into our spans. */
function hlToSpans(node: HlNode, theme: Theme, inherit: Partial<Span> = {}): Span[] {
  const out: Span[] = [];
  const style = { ...inherit };
  const col = scopeColor(node.scope, theme);
  if (col) style.c = col;
  if (node.scope === "emphasis") style.i = true;
  if (node.scope === "strong") style.b = true;
  if (node.children) {
    for (const child of node.children) {
      if (typeof child === "string") out.push(span(child, style));
      else out.push(...hlToSpans(child, theme, style));
    }
  }
  return out;
}

/** Syntax-highlight `code` into lines (one per source line). Unknown language
 *  → plain code-coloured text. Every returned span carries the panel bg. */
export function highlightCode(code: string, lang: string | undefined, theme: Theme): Line[] {
  const panelBg = theme.panelBg ?? "#101018";
  const codeFg = theme.codeFg ?? theme.fg;
  let flat: Span[] = [{ t: code, c: codeFg }];
  try {
    if (lang && hljs.getLanguage(lang)) {
      const res = hljs.highlight(code, { language: lang, ignoreIllegals: true });
      const root = (res as unknown as { _emitter?: { root: HlNode } })._emitter?.root;
      if (root) flat = hlToSpans(root, theme);
    }
  } catch {
    flat = [{ t: code, c: codeFg }];
  }

  // Split the flat span stream at newlines, preserving each token's style.
  const lines: Line[] = [[]];
  for (const s of flat) {
    const parts = s.t.split("\n");
    parts.forEach((p, i) => {
      if (i > 0) lines.push([]);
      if (p.length) lines[lines.length - 1].push({ ...s, t: p });
    });
  }
  if (lines.length === 1 && !lines[0].length) lines[0].push(span("", { c: codeFg }));
  return lines.map((l) => l.map((s) => ({ ...s, bg: s.bg ?? panelBg })));
}

// ------------------------------------------------------------------- wrap

/** Word-wrap spans to `width`, carrying each span's style onto its wraps. */
export function wrapSpans(spans: Span[], width: number): Line[] {
  const w = Math.max(4, width);
  const out: Line[] = [];
  let line: Line = [];
  let used = 0;
  let pendingSpace = false;
  const flush = () => {
    if (line.length) out.push(line);
    line = [];
    used = 0;
    pendingSpace = false;
  };
  const addWord = (s: Span) => {
    const sw = textWidth(s.t);
    // A single monster token (an address, a base64 blob) is cut to fit.
    if (sw > w) {
      flush();
      let rest = s.t;
      while (rest) {
        const cut = fitToWidth(rest, w);
        if (!cut.text) break;
        out.push([{ ...s, t: cut.text }]);
        rest = rest.slice(cut.text.length);
      }
      return;
    }
    const need = sw + (pendingSpace || used > 0 ? 1 : 0);
    if (used > 0 && used + need > w) flush();
    if (used > 0) {
      line.push(span(" "));
      used += 1;
    }
    line.push(s);
    used += sw;
    pendingSpace = false;
  };
  for (const s of spans) {
    for (const piece of s.t.split(/(\s+)/)) {
      if (!piece) continue;
      if (/^\s+$/.test(piece)) {
        if (used > 0) pendingSpace = true;
      } else {
        addWord({ ...s, t: piece });
      }
    }
  }
  flush();
  if (!out.length) out.push([{ t: " " }]);
  return out;
}

// ------------------------------------------------------------- markdown

type BlockTok = Token & { tokens?: Token[]; items?: Token[]; ordered?: boolean; start?: number; depth?: number; lang?: string; text?: string };

/** Render inline markdown tokens into one span stream. */
function inlineToSpans(tokens: Token[] | undefined, theme: Theme): Span[] {
  const c = theme;
  const out: Span[] = [];
  for (const tok of tokens ?? []) {
    const kids = (tok as { tokens?: Token[] }).tokens;
    switch (tok.type) {
      case "text":
        out.push(span((tok as { text: string }).text, { c: c.fg }));
        break;
      case "space":
        out.push(span(tok.raw));
        break;
      case "strong":
        out.push(...inlineToSpans(kids, theme).map((s) => ({ ...s, b: true })));
        break;
      case "em":
        out.push(...inlineToSpans(kids, theme).map((s) => ({ ...s, i: true })));
        break;
      case "del":
        out.push(...inlineToSpans(kids, theme).map((s) => ({ ...s, u: true, c: c.mutedDim })));
        break;
      case "codespan":
        out.push(span((tok as { text: string }).text, { c: c.codeFg ?? c.fg, bg: c.panelBg ?? "#101018" }));
        break;
      case "link": {
        const href = (tok as { href: string }).href;
        const text = (tok as { text: string }).text;
        const inner = inlineToSpans(kids, theme);
        out.push(...inner.map((s) => ({ ...s, u: true, c: c.secondary })));
        if (!kids || kids.length !== 1 || kids[0].type !== "text" || text !== href) {
          out.push(span(` (${href})`, { c: c.mutedDim }));
        }
        break;
      }
      case "br":
        out.push(span(" "));
        break;
      default:
        out.push(span(tok.raw, { c: c.fg }));
    }
  }
  if (!out.length) out.push(span(""));
  return out;
}

/** A bordered panel for fenced code. Interior width is the block minus edges. */
function codeBlockToLines(code: string, lang: string | undefined, theme: Theme, width: number): Line[] {
  const c = theme;
  const inner = Math.max(4, width - 2);
  const border = c.border ?? c.mutedDim;
  const panelBg = c.panelBg ?? "#101018";
  const label = lang ? ` ${lang} ` : " code ";
  const header = `╭${label}${"─".repeat(Math.max(1, width - label.length - 2))}╮`;
  const hl = highlightCode(code.trimEnd(), lang, theme);
  const body = hl.map((l) =>
    concat([sp("│", border)], fitLineBg(l, inner, panelBg), [sp("│", border)]),
  );
  return [
    [{ t: header, c: border, bg: panelBg }],
    ...body,
    [{ t: `╰${"─".repeat(inner)}╯`, c: border, bg: panelBg }],
  ];
}

/** List block → bullet/numbered lines with nested indentation. */
function listToLines(tok: BlockTok, theme: Theme, width: number, depth: number): Line[] {
  const c = theme;
  const out: Line[] = [];
  let n = tok.start ?? 1;
  for (const item of tok.items ?? []) {
    const marker = tok.ordered ? `${n}.` : "•";
    n++;
    const indent = "  ".repeat(depth);
    const prefix = concat([sp(indent, c.mutedDim)], [sp(`${marker} `, c.primary)]);
    const avail = Math.max(4, width - lineWidth(prefix));
    const body = wrapSpans(inlineToSpans((item as { tokens?: Token[] }).tokens, theme), avail);
    if (!body.length) {
      out.push(prefix);
      continue;
    }
    body.forEach((l, i) => out.push(i === 0 ? concat(prefix, l) : concat(blank(lineWidth(prefix)), l)));
  }
  return out;
}

/** GFM table → aligned ASCII columns (one row per line). */
function tableToLines(tok: BlockTok, theme: Theme, width: number): Line[] {
  const c = theme;
  const header = (tok as { header?: Token[] }).header ?? [];
  const rows = (tok as { rows?: Token[][] }).rows ?? [];
  const cell = (t: Token): Line => {
    const kids = (t as { tokens?: Token[] }).tokens;
    const text = (t as { text?: string }).text ?? "";
    return kids?.length ? inlineToSpans(kids, theme) : [{ t: text, c: c.fg }];
  };
  const headerCells = header.map(cell);
  const rowCells = rows.map((r) => r.map(cell));
  const cols = headerCells.length;

  const sep = " │ ";
  const sepW = sep.length;
  const pad = 2;
  const baseCol = Math.max(4, Math.floor((width - sepW * Math.max(0, cols - 1) - pad * cols) / Math.max(1, cols)));
  const widths = Array.from({ length: cols }, (_, i) =>
    i === cols - 1 ? Math.max(4, width - sepW * Math.max(0, cols - 1) - pad * cols - baseCol * (cols - 1)) : baseCol,
  );

  const renderRow = (cells: Line[], bold: boolean): Line => {
    let row: Line = [];
    cells.forEach((cl, i) => {
      const fitted = fitLine(bold ? cl.map((s) => ({ ...s, b: true })) : cl, widths[i]);
      row = [...row, ...fitted];
      if (i < cells.length - 1) row.push(sp(sep, c.mutedDim));
    });
    return row;
  };

  const out: Line[] = [];
  out.push(renderRow(headerCells, true));
  out.push([{ t: "─".repeat(width), c: c.mutedDim }]);
  for (const r of rowCells) out.push(renderRow(r, false));
  return out;
}

/** Heading → bold, coloured by depth. */
function headingToLines(tok: BlockTok, theme: Theme, width: number): Line[] {
  const c = theme;
  const col = (tok.depth ?? 1) <= 2 ? c.primary : (tok.depth ?? 1) <= 4 ? c.secondary : c.muted;
  const spans = inlineToSpans((tok as { tokens?: Token[] }).tokens, theme).map((s) => ({
    ...s,
    b: true,
    c: s.c === c.fg ? col : s.c,
  }));
  return wrapSpans(spans, width);
}

/** Render block tokens (from marked.lexer) into styled lines. `marks`, when
 *  given, is filled in lockstep with the lines: the source text of the code
 *  block a line belongs to, or undefined. That is what makes a fenced block
 *  clickable — the click lands on a row, and the row knows its code. */
function tokensToLines(tokens: Token[], theme: Theme, width: number, marks?: (string | undefined)[]): Line[] {
  const w = Math.max(8, width);
  const c = theme;
  const out: Line[] = [];
  for (const tok of tokens) {
    const before = out.length;
    switch (tok.type) {
      case "space":
        break;
      case "heading":
        out.push(...headingToLines(tok as BlockTok, theme, w));
        break;
      case "paragraph":
        out.push(...wrapSpans(inlineToSpans((tok as { tokens?: Token[] }).tokens, theme), w));
        break;
      case "code":
        out.push(...codeBlockToLines((tok as { text?: string }).text ?? "", (tok as { lang?: string }).lang, theme, w));
        break;
      case "blockquote":
        out.push(...quoteToLines((tok as { tokens?: Token[] }).tokens, theme, w));
        break;
      case "list":
        out.push(...listToLines(tok as BlockTok, theme, w, 0));
        break;
      case "table":
        out.push(...tableToLines(tok as BlockTok, theme, w));
        break;
      case "hr":
        out.push([{ t: "─".repeat(w), c: c.mutedDim }]);
        break;
      case "html":
        out.push(...wrapSpans([span((tok as { text?: string }).text ?? "", { c: c.mutedDim })], w));
        break;
      default:
        out.push(...wrapSpans([span(tok.raw, { c: c.fg })], w));
    }
    if (marks) {
      const code = tok.type === "code" ? ((tok as { text?: string }).text ?? "") : undefined;
      for (let i = before; i < out.length; i++) marks.push(code);
    }
  }
  if (!out.length) out.push(blank(w));
  if (marks) while (marks.length < out.length) marks.push(undefined);
  return out;
}

/** Blockquote → indented muted lines with a left gutter, nesting supported. */
function quoteToLines(tokens: Token[] | undefined, theme: Theme, width: number): Line[] {
  const c = theme;
  const inner = Math.max(4, width - 2);
  return tokensToLines(tokens ?? [], theme, inner).map((l) =>
    concat([sp("▍ ", c.muted)], l.map((s) => ({ ...s, c: s.c === c.fg ? c.muted : s.c }))),
  );
}

/** Does the text hold an *open* fenced code block? (odd number of ```) */
export function hasOpenFence(md: string): boolean {
  const re = /^\s*```/gm;
  let count = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) count++;
  return count % 2 === 1;
}

/** When true, the markdown isn't parseable yet (open fence) — render plain. */
export function stableMarkdown(md: string): boolean {
  return !hasOpenFence(md);
}

/**
 * Render a markdown string into styled lines no wider than `width`.
 * Line counts are theme-independent (only colours vary), so measurement can
 * use any skin.
 */
export function mdToLines(md: string, theme: Theme, width: number, marks?: (string | undefined)[]): Line[] {
  const c = theme;
  let toks: Token[];
  try {
    toks = marked.lexer(md, { gfm: true });
  } catch {
    const lines = wrapSpans([span(md, { c: c.fg })], width);
    if (marks) for (const _ of lines) marks.push(undefined);
    return lines;
  }
  return tokensToLines(toks, theme, width, marks);
}
