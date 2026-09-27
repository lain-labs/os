/**
 * Raw key-sequence parser for the TUI composer.
 *
 * ink's `useInput` throws the escape sequence away before we can see it: Home,
 * End and the real Delete key all reach the handler as an empty `input`, and
 * ink's `key.delete` is set by plain Backspace (\x7f) too — so those keys were
 * either dead or wrong in the input line. The composer therefore parses the raw
 * stdin chunks itself and hands the editor a {@link TuiKey}: ink's `Key` plus
 * `home`/`end`, with `backspace` and `delete` finally meaning two different
 * keys, and with modifiers (ctrl+←/→) preserved.
 *
 * Only `type Key` is imported here — this module stays pure so it can be tested
 * without a terminal (`npm run keys:smoke`).
 */
import type { Key } from "ink";

/** ink's `Key` plus the keys ink cannot report. */
export interface TuiKey extends Key {
  /** Home (\x1b[H, \x1bOH, \x1b[1~, \x1b[7~). */
  home: boolean;
  /** End (\x1b[F, \x1bOF, \x1b[4~, \x1b[8~). */
  end: boolean;
  /** A mouse event, 1-based terminal coordinates. Set on mouse presses. */
  mouse?: MouseInfo;
  /**
   * The text came from a bracketed paste, not from typing. It is inserted
   * verbatim (newlines and all) and never treated as Enter — pasting three
   * lines into the composer must not fire three messages.
   */
  paste?: boolean;
}

/** Decoded SGR/xterm mouse event (see {@link parseKey}). */
export interface MouseInfo {
  /** 1-based column. */
  x: number;
  /** 1-based row. */
  y: number;
  /** Raw xterm button byte (wheel bits + modifiers). */
  b: number;
  action: "press" | "release";
  /** Wheel direction, or null for button events. */
  wheel: "up" | "down" | null;
  /** The pointer moved with a button held (mode 1002) — i.e. a drag. */
  motion: boolean;
  /** 0 left, 1 middle, 2 right. Meaningless for wheel events. */
  button: number;
}

export interface KeyPress {
  /** Printable text (or the letter of a ctrl/alt chord); "" for named keys. */
  input: string;
  key: TuiKey;
}

/** A bare ESC is indistinguishable from the head of a longer sequence, so the
 *  reader waits this long for the tail before calling it the Escape key. */
export const ESC_TIMEOUT_MS = 30;

type Flags = { -readonly [K in Exclude<keyof TuiKey, "mouse" | "paste">]: boolean };

const BLANK: TuiKey = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageUp: false,
  pageDown: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  home: false,
  end: false,
};

const mk = (over: Partial<TuiKey> = {}): TuiKey => ({ ...BLANK, ...over });
const named = (over: Partial<TuiKey>): KeyPress => ({ input: "", key: mk(over) });
/** An unrecognised escape sequence: consumed, but never typed into the line. */
const ignored = (): KeyPress => ({ input: "", key: mk() });

/** Key names → the `TuiKey` flag they raise. Names with no flag are ignored. */
const FLAG: Record<string, Exclude<keyof TuiKey, "mouse" | "paste">> = {
  up: "upArrow",
  down: "downArrow",
  left: "leftArrow",
  right: "rightArrow",
  home: "home",
  end: "end",
  pageup: "pageUp",
  pagedown: "pageDown",
  delete: "delete",
};

/** Final letter of a CSI/SS3 sequence → key name (xterm, vt, rxvt). */
const LETTER: Record<string, string> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  E: "clear",
  F: "end",
  H: "home",
  a: "up",
  b: "down",
  c: "right",
  d: "left",
  e: "clear",
};

/** `\x1b[<n>~` numbers → key name (vt220 and the rxvt ^/$ modifier variants). */
const TILDE: Record<string, string> = {
  "1": "home",
  "2": "insert",
  "3": "delete",
  "4": "end",
  "5": "pageup",
  "6": "pagedown",
  "7": "home",
  "8": "end",
};

const CSI_RE = /^\x1b(\[|O)(?:(\d+)(?:;(\d+))?)?([~^$]|[A-Za-z])$/;

/**
 * A key reported as "code point + modifiers" rather than as a control byte.
 *
 * This is how a terminal answers once the kitty keyboard protocol is on (which
 * the TUI asks for, to tell shift+enter from enter): `CSI <code>;<mods>u`, and
 * xterm's older modifyOtherKeys says the same thing as `CSI 27;<mods>;<code>~`.
 * **Every** chord arrives that way there — ctrl+c included, which is why it has
 * to be decoded rather than skipped: an unknown sequence is swallowed, and a
 * swallowed ctrl+c is an app nobody can leave.
 *
 * Modifier bits are xterm's, minus one: 1 shift, 2 alt, 4 ctrl, 8 super.
 */
function keyFromCode(code: number, bits: number, meta: boolean): KeyPress {
  const ctrl = !!(bits & 4);
  const alt = !!(bits & 2) || meta;
  const shift = !!(bits & 1);
  switch (code) {
    case 13: // enter — with any modifier it is the newline key
      return ctrl || alt || shift ? named({ return: true, shift: true, meta: alt }) : named({ return: true });
    case 9:
      return named({ tab: true, shift, meta: alt });
    case 27:
      return named({ escape: true, meta: true });
    case 8:
    case 127:
      return named({ backspace: true, meta: alt });
  }
  if (code < 32) return ignored();
  const ch = String.fromCodePoint(code);
  // ctrl chords are reported the way ink does it: the bare lowercase letter.
  if (ctrl) return { input: ch.toLowerCase(), key: mk({ ctrl: true, meta: alt }) };
  if (alt) return { input: ch, key: mk({ meta: true, shift }) };
  return { input: shift ? ch.toUpperCase() : ch, key: mk({ shift }) };
}

// CSI <code>[:alternates] [;<mods>[:<event>]] [;<text>] u  — kitty's own shape.
const CSI_U_RE = /^\x1b\[(\d+)(?::[\d:]*)?(?:;(\d+)(?::(\d+))?)?(?:;[\d:]*)?u$/;
// CSI 27;<mods>;<code>~ — xterm modifyOtherKeys says the same thing.
const MOD_OTHER_RE = /^\x1b\[27;(\d+)(?::\d+)?;(\d+)~$/;

/** Decode a CSI/SS3 sequence, or null if it is not one we know. */
function parseCsi(seq: string): KeyPress | null {
  // alt/meta arrives as an extra leading ESC (\x1b\x1b[D = alt+left).
  let s = seq;
  let meta = false;
  while (s.startsWith("\x1b\x1b")) {
    s = s.slice(1);
    meta = true;
  }
  const csiU = CSI_U_RE.exec(s);
  const modOther = csiU ? null : MOD_OTHER_RE.exec(s);
  if (csiU || modOther) {
    const event = Number(csiU?.[3] ?? 1);
    if (event === 3) return ignored(); // a key *release*: never an action
    const code = Number(csiU ? csiU[1] : modOther![2]);
    const bits = Number((csiU ? csiU[2] : modOther![1]) ?? 1) - 1;
    return keyFromCode(code, bits, meta);
  }
  const m = CSI_RE.exec(s);
  if (!m) return null;
  const [, intro, num, mod, final] = m;

  let name: string | undefined;
  // Modifier bitmask, xterm style: 1 shift, 2 alt, 4 ctrl, 8 meta.
  let bits: number;
  if (final === "~" || final === "^" || final === "$") {
    name = TILDE[num ?? ""];
    bits = Number(mod ?? 1) - 1;
    if (final === "^") bits |= 4; // rxvt: \x1b[3^ = ctrl+delete
    if (final === "$") bits |= 1; // rxvt: \x1b[3$ = shift+delete
  } else {
    name = LETTER[final];
    // xterm sends \x1b[1;5D for ctrl+left; some terminals drop the "1;" and
    // send \x1b[5D, so a lone number in front of a letter is the modifier.
    bits = Number(mod ?? num ?? 1) - 1;
    if (/[a-z]/.test(final)) bits |= intro === "O" ? 4 : 1; // rxvt Od / [d
  }
  if (!name) return ignored();

  const key: Flags = {
    ...BLANK,
    ctrl: !!(bits & 4),
    shift: !!(bits & 1),
    meta: meta || !!(bits & 10),
  };
  const flag = FLAG[name];
  if (!flag) return { input: "", key }; // insert, clear — nothing to type
  key[flag] = true;
  return { input: "", key };
}

/** Build the KeyPress for a decoded mouse event (1-based coordinates).
 *  Bit 5 (32) is xterm's motion flag, bit 6 (64) marks the wheel, and the low
 *  two bits are the button — a drag is a motion report with a button held. */
function mousePress(b: number, x: number, y: number, action: "press" | "release"): KeyPress {
  const wheel = b & 64 ? (b & 1 ? "down" : "up") : null;
  return {
    input: "",
    key: { ...BLANK, mouse: { x, y, b, action, wheel, motion: !!(b & 32), button: b & 3 } },
  };
}

/** Decode SGR (\x1b[<b;x;yM) and legacy xterm (\x1b[M...) mouse reports. */
function parseMouse(seq: string): KeyPress | null {
  const sgr = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(seq);
  if (sgr) {
    return mousePress(Number(sgr[1]), Number(sgr[2]), Number(sgr[3]), sgr[4] === "M" ? "press" : "release");
  }
  const legacy = /^\x1b\[M(.{3})/.exec(seq);
  if (legacy) {
    const cb = legacy[1].charCodeAt(0) - 32;
    const x = legacy[1].charCodeAt(1) - 32;
    const y = legacy[1].charCodeAt(2) - 32;
    return mousePress(cb & ~32, x, y, cb & 32 ? "release" : "press");
  }
  return null;
}

/**
 * Turn one key sequence (or one pasted chunk) into a keypress. Sequences we do
 * not recognise are swallowed rather than typed, so an exotic terminal never
 * sprays `[3;5~` into the input line.
 */
export function parseKey(seq: string): KeyPress {
  // Plain Enter submits (\r); Ctrl+Enter / Ctrl+J send \n — treat that as
  // "return with shift", i.e. a literal newline, so every terminal can make a
  // second line even without the kitty keyboard protocol.
  if (seq === "\r") return named({ return: true });
  if (seq === "\n") return named({ return: true, shift: true });
  // alt+enter: the one newline chord almost every terminal can send, including
  // the ones (VS Code, Terminal.app) that give shift+enter no sequence at all.
  if (seq === "\x1b\r" || seq === "\x1b\n") return named({ return: true, shift: true, meta: true });
  if (seq === "\t") return named({ tab: true });
  if (seq === "\x1b[Z") return named({ tab: true, shift: true });
  if (seq === "\x7f" || seq === "\b") return named({ backspace: true });
  if (seq === "\x1b\x7f" || seq === "\x1b\b") return named({ backspace: true, meta: true });
  // ink reports Escape with meta set as well; the picker relies on `escape`.
  if (seq === "\x1b" || seq === "\x1b\x1b") return named({ escape: true, meta: true });

  const csi = parseCsi(seq);
  if (csi) return csi;

  const mouse = parseMouse(seq);
  if (mouse) return mouse;

  // alt/meta + character: alt+b, alt+f, alt+d …
  if (/^\x1b[^\x1b[O]$/.test(seq)) {
    const ch = seq[1];
    return { input: ch, key: mk({ meta: true, shift: /[A-Z]/.test(ch) }) };
  }
  // Anything else that still starts with ESC is an unknown sequence.
  if (seq.startsWith("\x1b")) return ignored();

  // ctrl + letter (\x01…\x1a) — reported the way ink does, as the bare letter.
  if (seq.length === 1 && seq >= "\x01" && seq <= "\x1a") {
    return { input: String.fromCharCode(seq.charCodeAt(0) + 96), key: mk({ ctrl: true }) };
  }
  if (seq.length === 1 && seq < " ") return ignored(); // other control bytes

  // Printable text: a single character, or a whole pasted chunk.
  return { input: seq, key: mk({ shift: seq.length === 1 && /[A-Z]/.test(seq) }) };
}

/**
 * Take the escape sequence starting at `i`, or null when the chunk ends before
 * the sequence does (the tail is still in flight on a slow link).
 */
function escapeAt(data: string, i: number): string | null {
  let j = i;
  while (data[j] === "\x1b") j++; // \x1b\x1b… = alt prefix
  if (j >= data.length) return null; // a lone ESC: the key, or a prefix
  if (data[j] === "[") {
    // Legacy xterm mouse report \x1b[M followed by exactly three bytes.
    if (data[j + 1] === "M") {
      return j + 5 <= data.length ? data.slice(i, j + 5) : null;
    }
    j++;
    // `<` (SGR mouse), `?` (DEC modes) and `:` (kitty's sub-parameters) are
    // also part of a CSI head.
    while (j < data.length && /[\d;?<:]/.test(data[j])) j++;
    return j < data.length ? data.slice(i, j + 1) : null;
  }
  if (data[j] === "O") return j + 1 < data.length ? data.slice(i, j + 2) : null;
  return data.slice(i, j + 1); // ESC + one character
}

/** Bracketed paste (DEC 2004): the terminal fences pasted text with these. */
export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";

/** A pasted block: inserted literally, never read as Enter or as a chord. */
const pastePress = (text: string): KeyPress => ({
  // CR and CRLF both mean "next line" in pasted text; the composer stores \n.
  input: text.replace(/\r\n?/g, "\n"),
  key: mk({ paste: true }),
});

/** Longest suffix of `s` that is a prefix of `needle` (a terminator split
 *  across two chunks must not be pasted as literal text). */
function danglingHead(s: string, needle: string): number {
  const max = Math.min(s.length, needle.length - 1);
  for (let k = max; k > 0; k--) if (s.endsWith(needle.slice(0, k))) return k;
  return 0;
}

/**
 * Stateful stdin → keypress reader. A multi-byte sequence normally arrives in
 * one chunk, but over ssh it can be split; the tail is kept in `partial` until
 * the next chunk (or until {@link flush} gives up on it).
 *
 * Bracketed paste is decoded here rather than in {@link parseKey}: a paste can
 * span any number of chunks, and everything between the fences — escape
 * sequences included — is text, not keys.
 */
export class KeyReader {
  private buffer = "";
  private pasting = false;
  private pasted = "";

  /** True while an unfinished escape sequence is being held back. A paste in
   *  flight does not count: it ends on its terminator, never on a timer. */
  get partial(): boolean {
    return this.buffer.length > 0 && !this.pasting;
  }

  feed(chunk: string): KeyPress[] {
    const data = this.buffer + chunk;
    this.buffer = "";
    const out: KeyPress[] = [];
    let i = 0;
    while (i < data.length) {
      if (this.pasting) {
        const rest = data.slice(i);
        const end = rest.indexOf(PASTE_END);
        if (end === -1) {
          const keep = danglingHead(rest, PASTE_END);
          this.pasted += rest.slice(0, rest.length - keep);
          this.buffer = rest.slice(rest.length - keep);
          break;
        }
        this.pasted += rest.slice(0, end);
        out.push(pastePress(this.pasted));
        this.pasted = "";
        this.pasting = false;
        i += end + PASTE_END.length;
        continue;
      }
      if (data[i] !== "\x1b") {
        // A run of plain bytes is one keypress — that is also how typing ahead
        // (or a paste from a terminal without bracketed paste) arrives.
        let j = data.indexOf("\x1b", i);
        if (j === -1) j = data.length;
        out.push(parseKey(data.slice(i, j)));
        i = j;
        continue;
      }
      const seq = escapeAt(data, i);
      if (seq === null) {
        this.buffer = data.slice(i);
        break;
      }
      i += seq.length;
      if (seq === PASTE_START) {
        this.pasting = true;
        continue;
      }
      out.push(parseKey(seq));
    }
    return out;
  }

  /** Emit whatever is held back — a lone ESC is the Escape key after all. */
  flush(): KeyPress[] {
    if (this.pasting) return []; // the paste ends at its terminator, not here
    const rest = this.buffer;
    this.buffer = "";
    return rest ? [parseKey(rest)] : [];
  }
}
