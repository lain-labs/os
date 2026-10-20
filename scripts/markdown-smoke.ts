#!/usr/bin/env -S npx tsx
/**
 * Markdown renderer smoke test (pure, headless): fenced code blocks highlight
 * into bordered panels, headings/lists/tables/blockquotes collapse into lines,
 * every line stays within `width`, and measurement agrees with rendering.
 * Run: npm run markdown:smoke
 */
import { THEMES } from "../src/clients/tui/theme.js";
import { turnLines } from "../src/clients/tui/layout.js";
import stringWidth from "string-width";
import {
  fitToWidth,
  hasOpenFence,
  highlightCode,
  lineWidth,
  mdToLines,
  textWidth,
  truncateLine,
  wrapSpans,
  setTextPictographWidth,
  terminalText,
} from "../src/clients/tui/markdown.js";

const results: [string, boolean][] = [];
const check = (name: string, pass: boolean) => results.push([name, pass]);

const theme = THEMES.wired;
const W = 60;
const md = [
  "# Hello",
  "",
  "some **bold** text with `inline code` and [a link](https://example.com).",
  "",
  "- first",
  "- second",
  "",
  "> a quiet quote",
  "",
  "| a | b |",
  "|---|---|",
  "| 1 | 2 |",
  "",
  "```js",
  "const x = 1;",
  "if (x) console.log(x);",
  "```",
].join("\n");

const lines = mdToLines(md, theme, W);
const text = lines.map((l) => l.map((s) => s.t).join("")).join("\n");

check("parses a heading       ", text.includes("Hello"));
check("bold is flagged        ", lines.some((l) => l.some((s) => s.b && s.t.includes("bold"))));
check("inline code on bg      ", lines.some((l) => l.some((s) => s.bg && s.t === "code")));
check("link shown underlined  ", lines.some((l) => l.some((s) => s.u && s.t === "link")));
check("bullets present        ", text.includes("• first") && text.includes("• second"));
check("quote has gutter       ", text.includes("▍") && text.includes("a quiet quote"));
check("table rows render      ", lines.some((l) => l.some((s) => s.t === "│") && /[12]/.test(l.map((x) => x.t).join(""))));
check("code fence is a panel  ", text.includes("╭ js ") && text.includes("╰") && text.includes("const x = 1"));
check("syntax highlighted     ", lines.some((l) => l.some((s) => s.c === theme.primary && s.t.includes("const"))));
check("all lines fit width    ", lines.every((l) => lineWidth(l) <= W));
check("empty md has one line  ", mdToLines("", theme, W).length === 1);

const hl = highlightCode("fn main() { println!(\"hi\"); }", "rust", theme);
check("highlight splits lines ", hl.length >= 1 && hl.every((l) => l.every((s) => s.bg)));
check("open fence detected    ", hasOpenFence("```\ncode") && !hasOpenFence("```\ncode\n```"));
check(
  "long token hard-wraps   ",
  (() => {
    const l = mdToLines(`\`\`\`\n${"a".repeat(200)}\n\`\`\``, theme, 30);
    return l.length >= 3 && l.every((x) => lineWidth(x) <= 30);
  })(),
);

// ------------------------------------------------- columns, not characters
// ⚙ ⛓ ⚠ and every emoji take two cells. Counting them as one makes the line a
// column too long, ink truncates the frame's right edge, and a line that wraps
// instead makes ink clear the terminal — scrollback and all — on every repaint.
// Text-style pictographs take what the terminal measured; emoji are always two.
setTextPictographWidth(1);
check("text pictographs: one  ", textWidth("⚠") === 1 && textWidth("⚠\uFE0F ok") === 4 && textWidth("🔥") === 2);
check("no VS16 reaches the tty", terminalText("⚠\uFE0F hi") === "⚠ hi");
setTextPictographWidth(2);
check("wide glyphs cost two   ", textWidth("⚙") === 2 && textWidth("⛓ 12345") === 8);
check(
  "agrees with ink's ruler",
  ["⚙ tool", "◆ lain · opencode", "chain pulses", "🌐 ok", "plain ascii"].every(
    (t) => textWidth(t) === stringWidth(t),
  ),
);
check(
  "truncate counts columns",
  (() => {
    const line = truncateLine([{ t: "⚙⚙⚙⚙" }], 5);
    return lineWidth(line) === 4 && line[0].t === "⚙⚙";
  })(),
);
check("emoji never split      ", fitToWidth("👩‍💻x", 2).text === "👩‍💻");
check(
  "wrap counts columns    ",
  wrapSpans([{ t: "⚙⚙ ⚙⚙ ⚙⚙" }], 5).every((l) => lineWidth(l) <= 5),
);

// A list item's text carries its own inline tokens; a model's reply is full of them.
const asText = (md: string) => mdToLines(md, theme, 120).map((l) => l.map((sp) => sp.t).join(""));
const item = mdToLines("- **BSKCAT**: 7 wallets", theme, 120)[0];
check("bold inside a list item ", asText("- **BSKCAT**: 7 wallets")[0] === "• BSKCAT: 7 wallets" && item.some((sp) => sp.b && sp.t === "BSKCAT:".slice(0, 6)));
check("no space before a comma ", asText("made **578 buys**, and more")[0] === "made 578 buys, and more");

// A system message (/help, /skills) keeps its lines and their indent (under the body's own two columns).
const sysText = turnLines({ id: "s", role: "sys", parts: [{ kind: "text", text: "Tools (2):\n· a — one\n  last change: edit" }] }, new Set(), theme, 80, "")
  .lines.map((l) => l.map((sp) => sp.t).join(""));
check("sys lines stay lines    ", sysText.some((l) => l.trimEnd() === "  Tools (2):") && sysText.some((l) => l.trimEnd() === "  · a — one") && sysText.some((l) => l.trimEnd() === "    last change: edit"));

let ok = true;
for (const [name, pass] of results) {
  console.log(`${name}: ${pass ? "PASS" : "FAIL"}`);
  ok &&= pass;
}
console.log(ok ? "MARKDOWN PROBE OK" : "MARKDOWN PROBE FAILED");
process.exit(ok ? 0 : 1);
