#!/usr/bin/env -S npx tsx
/**
 * Composer plumbing smoke test, all headless: the escape sequences a terminal
 * sends for home, end, delete and ctrl+←/→ must reach the line editor as the
 * right edits, nothing unknown may ever be typed into the input line, ↑/↓ must
 * walk the input history (which outlives the process), and the scrollback pager
 * must flatten the transcript into lines that fit. Run: npm run keys:smoke
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyReader, parseKey, type TuiKey } from "../src/clients/tui/keys.js";
import { editLine, type LineState } from "../src/clients/tui/editor.js";
import {
  HISTORY_LIMIT,
  InputHistory,
  loadInputHistory,
  saveInputHistory,
} from "../src/clients/tui/history.js";
import { highlightSelection, isDrag, ordered, rowRange, selectionText } from "../src/clients/tui/selection.js";
import { setTextPictographWidth, type Line } from "../src/clients/tui/markdown.js";
import { turnLines, type Turn } from "../src/clients/tui/layout.js";
import { THEMES, DEFAULT_THEME } from "../src/clients/tui/theme.js";
import { cursorToWrap, wrapIndices } from "../src/clients/tui/editor.js";

// A throwaway state dir: the history probe writes a real file.
process.env.LAINOS_DATA_DIR = mkdtempSync(join(tmpdir(), "lainos-keys-"));

const results: [string, boolean][] = [];
const check = (name: string, pass: boolean) => results.push([name, pass]);

/** Does the sequence raise exactly the expected flags (and type nothing)? */
const flags = (seq: string, want: Partial<TuiKey>, input = "") => {
  const { key, input: got } = parseKey(seq);
  const ok =
    got === input &&
    (Object.keys(key) as (keyof TuiKey)[]).every((k) => key[k] === (want[k] ?? false));
  return ok;
};

// ---------------------------------------------------------------- parser

check(
  "home variants        ",
  ["\x1b[H", "\x1bOH", "\x1b[1~", "\x1b[7~"].every((s) => flags(s, { home: true })),
);
check(
  "end variants         ",
  ["\x1b[F", "\x1bOF", "\x1b[4~", "\x1b[8~"].every((s) => flags(s, { end: true })),
);
check("delete key           ", flags("\x1b[3~", { delete: true }));
check("backspace ≠ delete   ", flags("\x7f", { backspace: true }));
check(
  "ctrl+left variants   ",
  ["\x1b[1;5D", "\x1b[5D", "\x1bOd"].every((s) => flags(s, { leftArrow: true, ctrl: true })) &&
    flags("\x1b\x1b[D", { leftArrow: true, meta: true }),
);
check(
  "ctrl+right variants  ",
  ["\x1b[1;5C", "\x1b[5C", "\x1bOc"].every((s) => flags(s, { rightArrow: true, ctrl: true })) &&
    flags("\x1b\x1b[C", { rightArrow: true, meta: true }),
);
check(
  "plain arrows         ",
  flags("\x1b[D", { leftArrow: true }) &&
    flags("\x1b[C", { rightArrow: true }) &&
    flags("\x1b[A", { upArrow: true }) &&
    flags("\x1b[B", { downArrow: true }),
);
check(
  "chords still work    ",
  flags("\x01", { ctrl: true }, "a") &&
    flags("\x05", { ctrl: true }, "e") &&
    flags("\x1bb", { meta: true }, "b") &&
    flags("\x1b\x7f", { backspace: true, meta: true }),
);
check(
  "return/tab/escape    ",
  flags("\r", { return: true }) &&
    flags("\t", { tab: true }) &&
    flags("\x1b", { escape: true, meta: true }),
);
check("ctrl+enter is newline ", flags("\n", { return: true, shift: true }));
check(
  "typing and paste     ",
  flags("x", {}, "x") && flags("A", { shift: true }, "A") && flags("hello", {}, "hello"),
);
// The old handler stripped the ESC and typed the rest: "[200~" in the line.
check(
  "no stray characters  ",
  ["\x1b[200~", "\x1b[201~", "\x1bOP", "\x1b[15~", "\x1b[2~"].every(
    (s) => parseKey(s).input === "",
  ),
);

// ---------------------------------------------------------------- reader

const reader = new KeyReader();
check("split escape buffers ", reader.feed("\x1b").length === 0 && reader.partial);
check("split escape resumes ", reader.feed("[3~").every((p) => p.key.delete) && !reader.partial);
check(
  "two keys in one chunk",
  (() => {
    const presses = reader.feed("\x1b[1;5D\x1b[3~");
    return presses.length === 2 && presses[0].key.leftArrow && presses[0].key.ctrl && presses[1].key.delete;
  })(),
);
check(
  "lone esc flushes     ",
  (() => {
    reader.feed("\x1b");
    const flushed = reader.flush();
    return flushed.length === 1 && flushed[0].key.escape;
  })(),
);

// ------------------------------------------------------- editor wiring

/** Feed a whole terminal transcript through reader → editor, as the TUI does. */
const drive = (start: string, chunks: string[], width?: number): LineState => {
  const r = new KeyReader();
  let state: LineState = { value: start, cursor: start.length };
  for (const chunk of chunks) {
    for (const { input, key } of r.feed(chunk)) {
      const next = editLine(state, input, key, width);
      if (next) state = next;
    }
  }
  return state;
};

check("home moves to start  ", drive("hello world", ["\x1b[H"]).cursor === 0);
check("end moves to end     ", drive("hello world", ["\x1b[H", "\x1b[F"]).cursor === 11);
check(
  "delete eats forward  ",
  (() => {
    const s = drive("hello", ["\x1b[H", "\x1b[3~"]);
    return s.value === "ello" && s.cursor === 0;
  })(),
);
check(
  "backspace unchanged  ",
  (() => {
    const s = drive("hello", ["\x7f"]);
    return s.value === "hell" && s.cursor === 4;
  })(),
);
check("ctrl+left one word   ", drive("hello world", ["\x1b[1;5D"]).cursor === 6);
check("ctrl+left two words  ", drive("hello world", ["\x1b[1;5D", "\x1b[1;5D"]).cursor === 0);
check("ctrl+right one word  ", drive("hello world", ["\x1b[H", "\x1b[1;5C"]).cursor === 5);
check(
  "home+type inserts    ",
  drive("world", ["\x1b[H", "hey "]).value === "hey world",
);
check("unknown seq is inert ", drive("hello", ["\x1bOP"]).value === "hello");

// -------------------------------------------------------- bracketed paste

check(
  "paste keeps newlines ",
  (() => {
    const s = drive("", ["\x1b[200~one\ntwo\x1b[201~"]);
    return s.value === "one\ntwo" && s.cursor === 7;
  })(),
);
check(
  "paste normalises CRLF",
  drive("", ["\x1b[200~a\r\nb\rc\x1b[201~"]).value === "a\nb\nc",
);
check(
  "paste survives chunks",
  // the fences, the body and even the terminator can be split across reads
  drive("", ["\x1b[200~one\n", "two", "\x1b[20", "1~"]).value === "one\ntwo",
);
check(
  "paste is never enter ",
  (() => {
    // A pasted CR is text; only a typed \r ends the line, and the paste's \r
    // must not smuggle one through.
    const { key } = parseKey("\r");
    const pasted = new KeyReader().feed("\x1b[200~a\rb\x1b[201~");
    return key.return && pasted.length === 1 && !pasted[0].key.return && pasted[0].key.paste === true;
  })(),
);
check(
  "paste blocks esc flush",
  (() => {
    const r = new KeyReader();
    r.feed("\x1b[200~half");
    return !r.partial && r.flush().length === 0;
  })(),
);

// ------------------------------------------------- multi-line composer

const shifted = drive("ab", ["\x1b[13;2u", "c"]);
check("shift+enter newline  ", shifted.value === "ab\nc" && shifted.cursor === 4);
check("lf types a newline   ", drive("ab", ["\n"]).value === "ab\n");
// The three ways a terminal can report a modified Enter, plus the one chord
// that needs no protocol at all. A composer nobody can break a line in is a
// single-line composer, whatever the help says.
check("alt+enter newline    ", drive("ab", ["\x1b\r"]).value === "ab\n");
check("modifyOtherKeys enter", drive("ab", ["\x1b[27;2;13~"]).value === "ab\n");
check("kitty ctrl+enter     ", drive("ab", ["\x1b[13;5u"]).value === "ab\n");
check("bare kitty enter sends", parseKey("\x1b[13u").key.return && !parseKey("\x1b[13u").key.shift);
check(
  "hard newline wraps    ",
  (() => {
    const lines = wrapIndices("hello\nworld", 20);
    return lines.length === 2 && lines[0].text === "hello" && lines[1].text === "world";
  })(),
);
check(
  "newline breaks fold   ",
  (() => {
    // without the newline the two words would share one row at width 20.
    const joined = wrapIndices("hello world", 20);
    return joined.length === 1 && wrapIndices("hello\nworld", 20).length === 2;
  })(),
);
check(
  "↑ walks over the newline",
  (() => {
    const s = drive("a\nbc", ["\x1b[A"], 20);
    return s.value === "a\nbc" && s.cursor === 1;
  })(),
);
check(
  "backspace joins lines ",
  (() => {
    const s = drive("a\nb", ["\x1b[D", "\x7f"]);
    return s.value === "ab" && s.cursor === 1;
  })(),
);
check(
  "cursor maps past newline",
  (() => {
    const w = wrapIndices("ab\ncd", 20);
    return w[1].start === 3 && w[1].end === 5;
  })(),
);

// ------------------------------------------------- the composer is verbatim
//
// The wrapper used to rebuild each row out of non-space tokens joined by a
// single space. That reflowed what had been typed: a trailing space belonged
// to no row, so the caret would not move when you pressed space (it appeared
// only once the next letter made it part of a word), and several spaces in a
// row collapsed into one, sliding the caret out of step with the cursor.

check(
  "a trailing space stays ",
  (() => {
    const lines = wrapIndices("a ", 20);
    return lines.length === 1 && lines[0].text === "a " && lines[0].end === 2;
  })(),
);
check(
  "caret moves on space  ",
  cursorToWrap("a ", 2, 20).col === 2 && cursorToWrap("a   ", 4, 20).col === 4,
);
check("several spaces survive", wrapIndices("a   b", 20)[0].text === "a   b");
check(
  "rows are exact slices ",
  (() => {
    const value = "one two   three four five six seven eight nine ten eleven twelve";
    const lines = wrapIndices(value, 16);
    const verbatim = lines.every((l) => l.text === value.slice(l.start, l.end));
    const partitions = lines.map((l) => l.text).join("") === value;
    const fits = lines.every((l) => l.text.length <= 16);
    return verbatim && partitions && fits;
  })(),
);
check(
  "long word breaks hard ",
  (() => {
    const lines = wrapIndices("x".repeat(9), 4);
    return lines.map((l) => l.text).join("") === "x".repeat(9) && lines[0].text.length === 4;
  })(),
);
check(
  "full row hands over   ",
  (() => {
    // The caret past the last column of a full row belongs to the next row —
    // otherwise it is drawn outside the frame and the chrome truncates it away.
    const value = "abcd";
    return cursorToWrap(value, 4, 4).line === 1 && cursorToWrap(value, 4, 4).col === 0;
  })(),
);
check(
  "break keeps its space ",
  (() => {
    // The space that ends a row stays *on* that row, so the caret has
    // somewhere to stand right after you press it — the whole bug.
    const value = "hello world";
    const rows = wrapIndices(value, 8);
    const at = cursorToWrap(value, 6, 8);
    return (
      rows[0].text === "hello " && rows[1].text === "world" && at.line === 0 && at.col === 6
    );
  })(),
);
check(
  "no room = space leads  ",
  (() => {
    // …and when it does not fit, it leads the next row rather than vanishing.
    const rows = wrapIndices("hello world", 5);
    return rows[0].text === "hello" && rows[1].text === " worl" && rows[2].text === "d";
  })(),
);

// ------------------------------------------------------- input history

const hist = new InputHistory();
hist.push("one");
hist.push("two");
hist.push("three");
check(
  "↑ walks back         ",
  hist.prev("draft") === "three" && hist.prev("") === "two" && hist.prev("") === "one",
);
check("↑ stops at the oldest", hist.prev("") === "one");
check(
  "↓ ends on the draft  ",
  hist.next() === "two" && hist.next() === "three" && hist.next() === "draft" && hist.next() === null,
);
check("↑ on empty history   ", new InputHistory().prev("") === null);
check(
  "no twins in a row    ",
  (() => {
    const h = new InputHistory(["a"]);
    return !h.push("a") && h.push("b") && h.entries.join() === "a,b";
  })(),
);
check(
  "capped at the limit  ",
  (() => {
    const h = new InputHistory();
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) h.push(`m${i}`);
    return h.entries.length === HISTORY_LIMIT && h.entries[0] === "m20";
  })(),
);
check(
  "survives a restart   ",
  (() => {
    saveInputHistory(hist.entries);
    const reloaded = new InputHistory(loadInputHistory());
    return reloaded.entries.join() === "one,two,three" && reloaded.prev("") === "three";
  })(),
);

// --------------------------------------------------------- mouse parsing

const mouse = (seq: string) => parseKey(seq).key.mouse;
const mouseOk = (m: { x: number; y: number; action: string; wheel: string | null } | undefined, want: { x: number; y: number; action: "press" | "release"; wheel: "up" | "down" | null }) =>
  !!m && m.x === want.x && m.y === want.y && m.action === want.action && m.wheel === want.wheel;

check("sgr click decodes    ", mouseOk(mouse("\x1b[<0;10;20M"), { x: 10, y: 20, action: "press", wheel: null }));
check("sgr release decodes  ", mouseOk(mouse("\x1b[<0;10;20m"), { x: 10, y: 20, action: "release", wheel: null }));
check("sgr wheel up         ", mouseOk(mouse("\x1b[<64;10;20M"), { x: 10, y: 20, action: "press", wheel: "up" }));
check("sgr wheel down       ", mouseOk(mouse("\x1b[<65;10;20M"), { x: 10, y: 20, action: "press", wheel: "down" }));
// Legacy xterm: each byte is (32 + coord). "0" = 48 → x 16, "4" = 52 → y 20.
check("legacy click decodes ", mouseOk(mouse("\x1b[M0\x30\x34"), { x: 16, y: 20, action: "press", wheel: null }));
check("mouse is inert text  ", (() => {
  const { key } = parseKey("\x1b[<0;10;20M");
  return key.mouse !== undefined && !key.return && !key.leftArrow;
})());

// --------------------------------------------------- transcript pager

const turns: Turn[] = [
  { id: "t1", role: "you", parts: [{ kind: "text" as const, text: "first question" }] },
  {
    id: "t2",
    role: "lain",
    model: "stub",
    parts: [
      { kind: "text" as const, text: "word ".repeat(40).trim() },
      {
        kind: "tool" as const,
        tool: { id: "c1", name: "get_balance", status: "ok" as const, summary: "12 ETH", input: { address: "0xbeef" } },
      },
    ],
  },
];
/** A styled line as the terminal would print it, minus the colours. */
const plain = (l: Line): string => l.map((s) => s.t).join("");

// The same renderer the app paints with, flattened back to plain text.
const theme = THEMES[DEFAULT_THEME];
const flat = turns.flatMap((t) => turnLines(t, new Set(["c1"]), theme, 40, "⠋").lines.map(plain));
check(
  "labels every speaker ",
  flat[0] === "▸ you" && flat.some((l) => l.startsWith("◆ lain · stub")),
);
check("keeps the turn order ", flat.indexOf("  first question") < flat.findIndex((l) => l.startsWith("◆ lain")));
check("wraps to the width   ", flat.every((l) => [...l].length <= 40) && flat.length > 8);
check("renders tool calls   ", flat.some((l) => l.includes("get_balance") && l.includes("address=0xbeef")));

// ------------------------------- kitty keyboard protocol (CSI u chords)
// The TUI asks for this protocol so it can tell shift+enter from enter. In it
// EVERY chord arrives as a code point plus modifiers — and an undecoded ctrl+c
// is an app with no way out.

check("csi-u ctrl+c         ", flags("\x1b[99;5u", { ctrl: true }, "c"));
check("csi-u ctrl+u         ", flags("\x1b[117;5u", { ctrl: true }, "u"));
check("csi-u alt+b          ", flags("\x1b[98;3u", { meta: true }, "b"));
check("csi-u escape         ", flags("\x1b[27u", { escape: true, meta: true }));
check("csi-u backspace      ", flags("\x1b[127u", { backspace: true }));
check("csi-u plain enter    ", flags("\x1b[13u", { return: true }));
check("csi-u key release    ", parseKey("\x1b[99;5:3u").input === "" && !parseKey("\x1b[99;5:3u").key.ctrl);
check(
  "csi-u with alternates",
  flags("\x1b[99:99;5u", { ctrl: true }, "c") &&
    (() => {
      // …and the reader must not cut the sequence at the colon
      const r = new KeyReader();
      const [press] = r.feed("\x1b[99:99;5u");
      return !!press && press.key.ctrl && press.input === "c";
    })(),
);
check("modifyOtherKeys ctrl+c", flags("\x1b[27;5;99~", { ctrl: true }, "c"));

// ------------------------------------------------- mouse text selection
// The terminal cannot select text while the app reads the mouse, so the drag
// is the app's: these are the cells it turns into a string.

const frame: Line[] = [
  [{ t: "hello world" }, { t: "   " }],
  [{ t: "second line" }, { t: "  " }],
];
const W = 14;

check(
  "upward drag flips    ",
  (() => {
    const r = ordered({ a: { row: 1, col: 3 }, b: { row: 0, col: 1 } });
    return r.a.row === 0 && r.a.col === 1 && r.b.row === 1 && r.b.col === 3;
  })(),
);
check(
  "end cell is included ",
  (() => {
    const span = rowRange({ a: { row: 0, col: 0 }, b: { row: 0, col: 4 } }, 0, W);
    return !!span && span[0] === 0 && span[1] === 5;
  })(),
);
check("one cell is no drag  ", !isDrag({ a: { row: 2, col: 2 }, b: { row: 2, col: 2 } }));
check(
  "selects inside a row ",
  selectionText(frame, { a: { row: 0, col: 6 }, b: { row: 0, col: 10 } }, W) === "world",
);
check(
  "selects across rows  ",
  // trailing frame padding is not part of what you dragged over
  selectionText(frame, { a: { row: 0, col: 0 }, b: { row: 1, col: 13 } }, W) === "hello world\nsecond line",
);
check(
  "highlights only that ",
  (() => {
    const out = highlightSelection(frame, { a: { row: 0, col: 6 }, b: { row: 0, col: 10 } }, "#333", W);
    const painted = out[0].filter((sp) => sp.bg).map((sp) => sp.t).join("");
    return painted === "world" && out[1].every((sp) => !sp.bg);
  })(),
);
check(
  "wide glyphs stay whole",
  (() => {
    // ⚙ is two columns wide in a terminal that draws it so: column 3 is the
    // "t", and dragging over the glyph takes all of it, never half a character
    setTextPictographWidth(2);
    const line: Line[] = [[{ t: "⚙ tool ok" }]];
    return (
      selectionText(line, { a: { row: 0, col: 3 }, b: { row: 0, col: 6 } }, 12) === "tool" &&
      selectionText(line, { a: { row: 0, col: 0 }, b: { row: 0, col: 1 } }, 12) === "⚙"
    );
  })(),
);

let ok = true;
for (const [name, pass] of results) {
  console.log(`${name}: ${pass ? "PASS" : "FAIL"}`);
  ok &&= pass;
}
console.log(ok ? "KEYS PROBE OK" : "KEYS PROBE FAILED");
process.exit(ok ? 0 : 1);
