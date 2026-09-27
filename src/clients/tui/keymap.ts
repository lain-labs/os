/**
 * The keyboard, as ordered layers.
 *
 * A keypress walks the layers in order and stops at the first one that claims
 * it. That order *is* the rule the TUI obeys: ctrl+c is answered before any
 * screen can swallow it, a picker owns the keyboard while it is open, and the
 * composer only ever sees what nothing above it wanted. It used to be one
 * 200-line function whose layers existed only as comments.
 *
 * A layer is pure with respect to this module: it reads `KeyCtx` and calls back
 * into the app. Nothing here holds state, imports React, or knows what a frame
 * looks like.
 */
import { editLine } from "./editor.js";
import { suggestionsFor } from "./commands.js";
import type { InputHistory } from "./history.js";
import type { TuiKey } from "./keys.js";
import type { PickerView } from "./chrome.js";

/** A picker is a modal keyboard state, which is why it is declared here: the
 *  renderer sees only the `PickerView` half, the keymap drives the callbacks. */
export type PickerState = PickerView & {
  onPick: (value: string) => void;
  onHighlight?: (value: string) => void;
  onCancel?: () => void;
};

export type KeyEvent = { input: string; key: TuiKey };

/** What a layer may read, and what it may do. Deliberately not "the app": a
 *  layer cannot reach a setter it has no business calling. */
export type KeyCtx = {
  value: string;
  cursor: number;
  acIndex: number;
  browsing: boolean;
  composerWidth: number;
  viewportRows: number;
  picker: PickerState | null;
  selectMode: boolean;
  quitArmed: boolean;
  hist: InputHistory;

  /** Replace the composer's text — an edit, which re-arms the slash menu. */
  edit: (value: string, cursor: number) => void;
  /** Put a remembered line in the composer, marking it as recalled. */
  recall: (value: string) => void;
  /** Send or run what has been typed, and remember it. */
  commit: (text: string) => void;
  clearComposer: () => void;
  setMenuIndex: (i: number) => void;
  setPicker: (p: PickerState | null) => void;
  setSelectMode: (on: boolean) => void;
  armQuit: () => void;
  disarmQuit: () => void;
  exit: () => void;
  copyLastReply: () => void;
  scrollBy: (delta: number) => void;
};

/** True when the layer claimed the key and nothing below it should run. */
type Layer = (ev: KeyEvent, ctx: KeyCtx) => boolean;

/**
 * ctrl+c, before anything else can swallow it: the first press clears the
 * composer and asks, the second leaves. One press must not end a session by
 * accident, and no screen — picker, selection mode — may be a room with no door.
 */
const quitLayer: Layer = ({ input, key }, ctx) => {
  if (key.ctrl && input === "c") {
    if (ctx.quitArmed) {
      ctx.exit();
      return true;
    }
    ctx.armQuit();
    ctx.setSelectMode(false);
    if (ctx.value) ctx.clearComposer();
    return true;
  }
  // Any other key answers "no" — and then goes on to do its own job.
  if (ctx.quitArmed) ctx.disarmQuit();
  return false;
};

/**
 * Selection mode owns the screen: any key that means "done" leaves it, and
 * nothing else is allowed to change the frame while it holds.
 */
const selectLayer: Layer = ({ input, key }, ctx) => {
  if (!ctx.selectMode) return false;
  if (key.escape || key.return || (key.ctrl && input === "s")) ctx.setSelectMode(false);
  return true;
};

/** An open picker captures everything. */
const pickerLayer: Layer = ({ key }, ctx) => {
  const picker = ctx.picker;
  if (!picker) return false;
  if (key.upArrow || key.downArrow) {
    const n = picker.options.length;
    const ni = key.upArrow ? (picker.index - 1 + n) % n : (picker.index + 1) % n;
    picker.onHighlight?.(picker.options[ni].value);
    ctx.setPicker({ ...picker, index: ni });
  } else if (key.return) {
    picker.onPick(picker.options[picker.index].value);
    ctx.setPicker(null);
  } else if (key.escape) {
    picker.onCancel?.();
    ctx.setPicker(null);
  }
  return true;
};

/** Scroll the feed with the keyboard. */
const scrollLayer: Layer = ({ key }, ctx) => {
  const page = Math.max(1, ctx.viewportRows - 2);
  const by = key.pageUp ? page : key.pageDown ? -page : key.ctrl && key.upArrow ? 1 : key.ctrl && key.downArrow ? -1 : 0;
  if (!by) return false;
  ctx.scrollBy(by);
  return true;
};

/** The two keys that get text back out of the frame. */
const clipboardLayer: Layer = ({ input, key }, ctx) => {
  if (key.ctrl && input === "s") {
    ctx.setSelectMode(true);
    return true;
  }
  if (key.ctrl && input === "y") {
    ctx.copyLastReply();
    return true;
  }
  return false;
};

/** The slash menu is "open" only while actively typing a command — not when a
 *  command was just recalled from history (browsing). */
function menuItems(ctx: KeyCtx): readonly { name: string; desc: string }[] {
  return ctx.browsing ? [] : suggestionsFor(ctx.value);
}

/** Menu open → arrows (and Tab) pick a command, Enter runs it. Everything else
 *  (shift+enter included) falls through to the composer. */
const menuLayer: Layer = ({ key }, ctx) => {
  const items = menuItems(ctx);
  if (!items.length) return false;
  const idx = Math.min(ctx.acIndex, items.length - 1);
  if (key.upArrow) {
    ctx.setMenuIndex((idx - 1 + items.length) % items.length);
    return true;
  }
  if (key.downArrow || key.tab) {
    ctx.setMenuIndex((idx + (key.shift ? items.length - 1 : 1)) % items.length);
    return true;
  }
  if (key.return && !key.shift) {
    ctx.commit(items[idx].name);
    return true;
  }
  return false;
};

/** The composer: history, Enter, and line editing. The last layer, so it
 *  always claims the key. */
const composerLayer: Layer = ({ input, key }, ctx) => {
  const open = menuItems(ctx).length > 0;

  if (!open) {
    // ↑/↓ move a visual line first, then walk history.
    if (key.upArrow || key.downArrow) {
      if (!ctx.browsing) {
        const edited = editLine({ value: ctx.value, cursor: ctx.cursor }, input, key, ctx.composerWidth);
        if (edited) {
          ctx.edit(edited.value, edited.cursor);
          return true;
        }
      }
      const v = key.upArrow ? ctx.hist.prev(ctx.value) : ctx.hist.next();
      if (v !== null) ctx.recall(v);
      return true;
    }
    if (key.return && !key.shift) {
      // A trailing backslash turns Enter into a line break. Every terminal can
      // type a backslash; not every terminal can say "shift+enter".
      if (ctx.cursor === ctx.value.length && ctx.value.endsWith("\\")) {
        const next = `${ctx.value.slice(0, -1)}\n`;
        ctx.edit(next, next.length);
        return true;
      }
      ctx.commit(ctx.value.trim());
      return true;
    }
    // shift/alt/ctrl+enter falls through to editLine → a new line.
  }

  // Any edit exits history-browsing, which re-arms the menu.
  const edited = editLine({ value: ctx.value, cursor: ctx.cursor }, input, key, ctx.composerWidth);
  if (edited) ctx.edit(edited.value, edited.cursor);
  return true;
};

/** The order is the rule. */
export const KEY_LAYERS: readonly Layer[] = [
  quitLayer,
  selectLayer,
  pickerLayer,
  scrollLayer,
  clipboardLayer,
  menuLayer,
  composerLayer,
];

export function handleKey(ev: KeyEvent, ctx: KeyCtx): void {
  for (const layer of KEY_LAYERS) if (layer(ev, ctx)) return;
}
