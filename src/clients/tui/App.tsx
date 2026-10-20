import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Static, Text, useApp, useStdin, useStdout } from "ink";
import { ModelTier, type AgentEvent, type IAgentRuntime } from "../../types.js";
import { buildRecap } from "../../memory/recap.js";
import { newRoomId, type SessionRecord } from "../../memory/sessions.js";
import { TASKS, TASK_ORDER, isTaskKind, type TaskKind } from "../../models/tasks.js";
import {
  CHAT_PROVIDER_CHOICES,
  chatProviderLabel,
  resolveChatProviderKind,
  SwitchableModelProvider,
} from "../../models/routing.js";
import {
  DEFAULT_THEME,
  GLYPH,
  THEME_ORDER,
  THEMES,
  isViewPref,
  loadCursor,
  loadEffort,
  loadFolded,
  loadPulse,
  loadSkin,
  loadView,
  saveCursor,
  saveEffort,
  saveFolded,
  savePulse,
  saveSkin,
  saveView,
} from "./theme.js";
import { blank, concat, fitLine, sp, terminalText, type Line } from "./markdown.js";
import { chromeLines, filterOptions, menuLines, pickerLines } from "./chrome.js";
import { acceptCompletion, completionsFor, runCommand as dispatchCommand, isSecretCommand, maskSecrets } from "./commands.js";
import { composeFrame, type ComposerWrap } from "./frame.js";
import {
  useBlink,
  useChainHeight,
  useOutputFlowing,
  usePersistedPref,
  usePolled,
  useSpin,
  useStdoutDimensions,
  useTicker,
} from "./hooks.js";
import { handleKey, type KeyCtx, type PickerState } from "./keymap.js";
import { handleMouse as handleMouse_, type Drag, type MouseCtx } from "./mouse.js";
import { localClipboard, osc52 } from "./clipboard.js";
import { feedToScreen, highlightSelection, selectionText, type BoundedRange } from "./selection.js";
import { cursorToWrap, wrapIndices } from "./editor.js";
import { InputHistory, loadInputHistory, saveInputHistory } from "./history.js";
import { ESC_TIMEOUT_MS, KeyReader, type KeyPress, type MouseInfo, type TuiKey } from "./keys.js";
import { ChainPulse } from "./pulse.js";
import { bannerLines, bootLines, spinnerChar, turnLines, turnText, welcomeLines, type FeedRegion, type Turn } from "./layout.js";
import { sidebarLines, type PanelId, type SidebarHit } from "./sidebar.js";
import { MASCOT_LINES, POKE_MS, mascotPose, type Poke } from "./mascot.js";
import { INTRO_MS, spinPose } from "./logo3d.js";
import { readPortfolio } from "./portfolio.js";
import type { ForgeService } from "../../plugins/forge/index.js";
import type { MetaMaskService } from "../../plugins/metamask/index.js";
import type { ScoutService } from "../../plugins/scout/index.js";
import type { RoutineService } from "../../plugins/skills/routines.js";
import type { TraderService } from "../../plugins/trader/index.js";
import type { TrenchService } from "../../plugins/trench/index.js";
import type { TrenchSnapshot } from "../../plugins/trench/engine.js";
import type { DeskSnapshot, StockDeskService } from "../../plugins/stocks/index.js";
import { boardLines } from "./trench.js";
import { stocksBoardLines } from "./stocks.js";
import { alertLine, type SentinelService } from "../../plugins/sentinel/index.js";

// ------------------------------------------------------------------ model

const EFFORTS = [
  { value: "low", label: "low", tokens: 512, desc: "terse · fast" },
  { value: "medium", label: "medium", tokens: 1024, desc: "balanced (default)" },
  { value: "high", label: "high", tokens: 2048, desc: "thorough" },
  { value: "max", label: "max", tokens: 4096, desc: "deepest · slowest" },
];
const effortTokens = (v: string) => EFFORTS.find((e) => e.value === v)?.tokens ?? 1024;

const CURSORS = [
  { value: "block-blink", label: "block · blink", desc: "fat, blinking (default)" },
  { value: "block-steady", label: "block · steady", desc: "fat, no blink" },
  { value: "line-blink", label: "line · blink", desc: "thin underline, blinking" },
  { value: "line-steady", label: "line · steady", desc: "thin underline, no blink" },
];

let _seq = 0;
const nextId = () => `t${++_seq}`;
const sysTurn = (text: string): Turn => ({
  id: nextId(),
  role: "sys",
  parts: [{ kind: "text", text }],
  at: Date.now(),
});
/** A notice from something running in the background, not from Lain. */
const pulseTurn = (text: string): Turn => ({
  id: nextId(),
  role: "pulse",
  parts: [{ kind: "text", text }],
  at: Date.now(),
});

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
function estimateTokens(history: Turn[], live: Turn | null): number {
  let chars = 0;
  const add = (t: Turn) => {
    for (const p of t.parts) {
      if (p.kind === "tool") chars += p.tool.name.length + (p.tool.summary?.length ?? 0);
      else chars += p.text.length;
    }
  };
  history.forEach(add);
  if (live) add(live);
  return Math.round(chars / 4);
}

/** The sidebar's code row: "codex/gpt-6.1-sol low", with ⚠ while that agent is out of quota. */
function sidebarCoder(forge: ForgeService): string {
  const p = forge.forgeProvider();
  if (p.selected === "none") return "none";
  const spent = p.spent.some((line) => line.startsWith(`${p.selected} `));
  return `${spent ? "⚠ " : ""}${forge.coderLabel().replace(" · ", " ")}`;
}

/** The sidebar's forge row: "idle", or the running job, its age and how many wait. */
function sidebarForge(forge: ForgeService): string {
  const active = forge.activeJob();
  const waiting = forge.queuedJobs().length;
  if (!active) return waiting ? `${waiting} queued` : "idle";
  const mins = active.startedAt ? Math.floor((Date.now() - active.startedAt) / 60_000) : 0;
  return `${active.id} ${active.agent} · ${mins}m${waiting ? ` +${waiting}` : ""}`;
}

function sidebarLastForge(forge: ForgeService): string {
  const last = forge
    .listJobs()
    .filter((job) => job.status === "ok" || job.status === "failed")
    .at(-1);
  if (!last) return "none";
  const summary = (last.summary ?? "").split("\n").map((line) => line.trim()).filter(Boolean).at(-1) ?? last.status;
  return `${last.status} · ${summary}`;
}

// ------------------------------------------------------------ components

/** Render one styled line into a single ink <Text>. */
function LineView({ line }: { line: Line }) {
  return (
    <Text wrap="truncate">
      {line.map((s, i) => (
        <Text key={i} color={s.c} bold={s.b} italic={s.i} underline={s.u} backgroundColor={s.bg}>
          {terminalText(s.t)}
        </Text>
      ))}
    </Text>
  );
}




/**
 * Single keyboard sink, mounted only when raw mode is available (a real TTY).
 *
 * ink's `useInput` is deliberately bypassed: it hands the handler a parsed
 * `Key` with the escape sequence already gone, so Home, End, Delete and
 * ctrl+←/→ are indistinguishable from nothing at all. We subscribe to the raw
 * stdin chunks ink emits and parse them ourselves (see ./keys.ts). Mouse
 * reporting is enabled here too: wheel events scroll the feed, and clicks
 * toggle tools / sidebar rows.
 */
function InputCapture({ onKey, mouse }: { onKey: (input: string, key: TuiKey) => void; mouse: boolean }) {
  const { setRawMode, internal_eventEmitter, internal_exitOnCtrlC } = useStdin();
  const { stdout } = useStdout();
  const sink = useRef(onKey);
  useEffect(() => {
    sink.current = onKey;
  });

  // Mouse reporting is what makes the wheel scroll and tool rows clickable —
  // and it is also what stops the terminal from selecting text, because the
  // drag is delivered here instead. So it is a switch, not a setting: select
  // mode hands the mouse back to the terminal for as long as it is on.
  useEffect(() => {
    if (!mouse) return;
    // xterm buttons (1000) + motion while a button is held (1002) + SGR
    // coordinates (1006): the wheel, exact click cells, and the drag that the
    // terminal can no longer make into a selection — so the app makes it.
    stdout?.write("\x1b[?1000h\x1b[?1002h\x1b[?1006h");
    return () => {
      stdout?.write("\x1b[?1006l\x1b[?1002l\x1b[?1000l");
    };
  }, [mouse, stdout]);

  useEffect(() => {
    setRawMode(true);
    const reader = new KeyReader();
    let escTimer: ReturnType<typeof setTimeout> | undefined;
    const emit = (presses: KeyPress[]) => {
      for (const { input, key } of presses) {
        // ink's own handler exits on ctrl+c; don't also type it into the line.
        if (internal_exitOnCtrlC && key.ctrl && input === "c") continue;
        sink.current(input, key);
      }
    };
    const onData = (chunk: unknown) => {
      if (escTimer) clearTimeout(escTimer);
      emit(reader.feed(String(chunk)));
      // A sequence split across chunks waits for its tail — but a bare ESC (the
      // Escape key) looks exactly like such a head, so it fires on a timer.
      if (reader.partial) escTimer = setTimeout(() => emit(reader.flush()), ESC_TIMEOUT_MS);
    };
    // Kitty keyboard protocol (level 1, progressive): terminals that support it
    // send shift+enter as \x1b[13;2u instead of an ordinary \r. Bracketed paste
    // (?2004) fences pasted text, so a pasted paragraph is text and not a burst
    // of Enter presses that would fire it off line by line.
    stdout?.write("\x1b[>1u\x1b[?2004h");
    internal_eventEmitter.on("input", onData);
    return () => {
      if (escTimer) clearTimeout(escTimer);
      internal_eventEmitter.removeListener("input", onData);
      stdout?.write("\x1b[?2004l\x1b[<1u");
      setRawMode(false);
    };
  }, [internal_eventEmitter, internal_exitOnCtrlC, setRawMode, stdout]);

  return null;
}

// ------------------------------------------------------------------ app

export function App({ runtime, copyToClipboard = localClipboard }: {
  runtime: IAgentRuntime;
  copyToClipboard?: typeof localClipboard;
}) {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const { stdout } = useStdout();
  const { width, rows } = useStdoutDimensions();

  const character = runtime.character;
  const provider = runtime.model.name;
  const model = runtime.model.modelFor(character.modelTier ?? ModelTier.LARGE);
  const rpc = process.env.CHAIN_RPC_URL ?? "";
  const block = useChainHeight(rpc);

  const [skin, setSkin] = usePersistedPref(loadSkin, saveSkin);
  const [previewSkin, setPreviewSkin] = useState<string | null>(null);
  const theme = THEMES[previewSkin ?? skin] ?? THEMES[DEFAULT_THEME];

  const [effort, setEffort] = usePersistedPref(loadEffort, saveEffort);
  useEffect(() => {
    runtime.maxTokens = effortTokens(effort);
  }, [effort, runtime]);

  const [cursorPref, setCursorPref] = usePersistedPref(loadCursor, saveCursor);

  // Scroll view: finished turns are printed once into the terminal's own
  // scrollback and only the live turn + composer are redrawn, so the terminal
  // scrolls and selects them natively — a phone cannot drive the full-screen
  // view's mouse selection, and its repaints made native selection shake.
  // "auto" decides once, at launch: a phone rotating past 100 columns should
  // not flip the whole layout under the reader.
  const [viewPref, setViewPref] = usePersistedPref(loadView, saveView);
  const [narrowAtLaunch] = useState(() => (stdout?.columns ?? 80) < 100);
  const scrollView = viewPref === "scroll" || (viewPref === "auto" && narrowAtLaunch);
  // Nothing is drawn while the terminal is not reading (a phone that put the
  // ssh client in the background): the agent keeps working, the screen catches
  // up on return. See useOutputFlowing.
  const flowing = useOutputFlowing(stdout);
  const cursorStyle: "block" | "line" = cursorPref.startsWith("line") ? "line" : "block";
  const blinkEnabled = cursorPref.endsWith("blink");

  // A launch is a session: a fresh room, saved from its first turn, with every
  // earlier one still on disk behind /resume. The room used to be the constant
  // "tui", which made every run since the first one the same conversation.
  const [room, setRoom] = useState(() => newRoomId("tui"));
  const [history, setHistory] = useState<Turn[]>(() => []);
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [live, setLive] = useState<Turn | null>(null);
  const [status, setStatus] = useState<"idle" | "thinking" | "streaming">("idle");
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const busy = status !== "idle";

  // Terminal/window title (OSC 0) — without it the tab shows the launcher
  // command ("npm lainos"). Tracks activity so the tab shows when she is busy.
  useEffect(() => {
    stdout?.write(`\x1b]0;${busy ? "Lain OS ✦ thinking…" : "Lain OS · the wired"}\x07`);
  }, [busy, stdout]);

  // input line + ui
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [acIndex, setAcIndex] = useState(0);
  const [blink, setBlink] = useState(true);
  const [picker, setPicker] = useState<PickerState | null>(null);
  // true while walking history — suppresses the slash menu so ↑/↓ stay on history
  const [browsing, setBrowsing] = useState(false);
  // a live board (trench, stocks), drawn in place of the transcript while open
  const [board, setBoard] = useState<"trench" | "stocks" | null>(null);
  const [boardSnap, setBoardSnap] = useState<
    { kind: "trench"; snap: TrenchSnapshot } | { kind: "stocks"; snap: DeskSnapshot } | null
  >(null);
  const [boardFrame, setBoardFrame] = useState(0);
  // which tool calls and thoughts are unfolded in the feed (click to toggle)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // selection mode: the frame is frozen and the mouse belongs to the terminal
  const [selectMode, setSelectMode] = useState(false);
  const frozenRef = useRef<Line[] | null>(null);
  // a message typed while she was still answering, waiting for its turn
  const [queued, setQueued] = useState<string | null>(null);
  // ctrl+c once asks, twice leaves — a stray ctrl+c should not end the session
  const [quitArmed, setQuitArmed] = useState(false);
  const quitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // the mouse selection drawn over the frame, and the drag that is making it
  // `left`/`right` pin it to the pane the drag began in — transcript or sidebar
  type Selection = BoundedRange;
  const [selection, setSelection] = useState<Selection | null>(null);
  const selectionRef = useRef<Selection | null>(null);
  selectionRef.current = selection;
  const dragRef = useRef<Drag | null>(null);
  const [copiedNote, setCopiedNote] = useState<string | null>(null);
  // the frame as it was last painted — what a selection is read out of
  const displayRef = useRef<Line[]>([]);

  // input history (shell-style ↑/↓), remembered across runs
  const histRef = useRef<InputHistory | null>(null);
  histRef.current ??= new InputHistory(loadInputHistory());
  const hist = histRef.current;

  const tokens = useMemo(() => estimateTokens(history, live), [history, live]);
  const [pulseOn, setPulseOn] = usePersistedPref(loadPulse, savePulse);

  // The sidebar's windows: folded by a click on the title bar, remembered across
  // runs. The one opened last is the last to fold itself for room.
  const [folded, setFolded] = usePersistedPref(loadFolded, saveFolded);
  const foldedSet = useMemo(() => new Set(folded as PanelId[]), [folded]);
  const [pinnedPanel, setPinnedPanel] = useState<PanelId | undefined>(undefined);
  // A click goes by what the window shows: one that folded itself for room
  // opens, and is the one that stays open while others fold instead.
  const togglePanel = useCallback(
    (panel: PanelId, open: boolean) => {
      setFolded((prev) => [...prev.filter((p) => p !== panel), ...(open ? [panel] : [])]);
      setPinnedPanel(open ? undefined : panel);
    },
    [setFolded],
  );

  // The masthead's logo spins when the welcome screen appears and when clicked;
  // Lain in the sidebar hops and says something when poked.
  const [logoSpin, setLogoSpin] = useState(() => ({ at: Date.now(), turns: 1.5, ms: INTRO_MS }));
  const spinLogo = useCallback(() => setLogoSpin({ at: Date.now(), turns: 1, ms: 1800 }), []);
  const [poke, setPoke] = useState<Poke | null>(null);
  const pokeMascot = useCallback(() => {
    setPoke((prev) => {
      const pool = MASCOT_LINES.filter((l) => l !== prev?.say);
      return { at: Date.now(), say: pool[Math.floor(Math.random() * pool.length)] };
    });
  }, []);

  // Balances and P&L for the wallet window: once a minute, and shortly after
  // each new turn (a trade, a /paper), never more than every 15 seconds.
  const portfolio = usePolled(() => readPortfolio(runtime), history.length, 60_000, 15_000);
  const [equityFlash, setEquityFlash] = useState<"up" | "down" | undefined>(undefined);
  const lastEquityRef = useRef<number | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const eq = portfolio?.equity;
    if (eq === null || eq === undefined || !Number.isFinite(eq)) return;
    const prev = lastEquityRef.current;
    lastEquityRef.current = eq;
    if (prev === null || Math.abs(eq - prev) < 1e-12) return;
    setEquityFlash(eq > prev ? "up" : "down");
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setEquityFlash(undefined), 1800);
  }, [portfolio]);
  useEffect(
    () => () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    },
    [],
  );

  const completion = useMemo(() => completionsFor(value, runtime, cursor), [value, runtime, cursor]);
  const menuItems = browsing ? [] : completion.items;
  const acIdx = menuItems.length ? Math.min(acIndex, menuItems.length - 1) : 0;
  // first visible row of the menu / picker when they are taller than the screen
  const menuStartRef = useRef(0);
  const pickerStartRef = useRef(0);
  const pushHistory = useCallback((t: Turn) => setHistory((h) => [...h, t]), []);

  /**
   * Put `text` on the clipboard and say so. OSC 52 goes out immediately (it is
   * the only route that survives ssh and tmux); a local helper is tried in the
   * background for the terminals that refuse OSC 52 without telling anyone.
   */
  const copyOut = useCallback(
    (text: string, what: string) => {
      const body = text.trim();
      if (!body) {
        pushHistory(sysTurn(`nothing to copy — ${what} is empty.`));
        return;
      }
      osc52(body, (s) => void stdout?.write(s));
      void copyToClipboard(body);
      pushHistory(
        sysTurn(
          `copied ${what} (${body.length} chars).` +
            " if your terminal blocks OSC 52, drag over the text instead — or ctrl+s to freeze the frame.",
        ),
      );
    },
    [copyToClipboard, pushHistory, stdout],
  );

  const lastReply = useCallback((): string => {
    const turn = [...history].reverse().find((t) => t.role === "lain");
    return turn ? turnText(turn) : "";
  }, [history]);

  // Blink only around actual typing. A permanent 530ms repaint wipes mouse
  // selection in the terminal, making copy/paste impossible; once the keyboard
  // has been idle for a spell the cursor goes solid and repaints stop.
  const [blinkAlive, setBlinkAlive] = useState(true);
  const blinkIdleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!blinkEnabled || !blinkAlive || selectMode) {
      setBlink(true);
      return;
    }
    const id = setInterval(() => setBlink((b) => !b), 530);
    return () => clearInterval(id);
  }, [blinkEnabled, blinkAlive, selectMode]);
  useEffect(() => {
    blinkIdleRef.current = setTimeout(() => setBlinkAlive(false), 10_000);
    return () => {
      if (blinkIdleRef.current) clearTimeout(blinkIdleRef.current);
    };
  }, []);

  useEffect(
    () => () => {
      if (quitTimerRef.current) clearTimeout(quitTimerRef.current);
    },
    [],
  );

  // Chain watcher — Lain notices whale transfers and otherwise stays silent.
  useEffect(() => {
    if (!pulseOn || !rpc) return;
    const pulse = new ChainPulse(rpc, (ev) => pushHistory(pulseTurn(ev.text)), {
      nativeSymbol: process.env.CHAIN_NATIVE_SYMBOL || "native",
    });
    pulse.start();
    return () => pulse.stop();
  }, [pulseOn, pushHistory, rpc]);

  // Sentinel alerts (background balance watches) surface live in the feed.
  useEffect(() => {
    const sentinel = runtime.getService<SentinelService>("sentinel");
    if (!sentinel?.onAlert) return;
    return sentinel.onAlert((alert) => pushHistory(pulseTurn(alertLine(alert))));
  }, [pushHistory, runtime]);

  // Forge progress (wishes being built) appears live too.
  useEffect(() => {
    const forge = runtime.getService<ForgeService>("forge");
    if (!forge?.onEvent) return;
    return forge.onEvent((ev) => pushHistory(pulseTurn(ev.text)));
  }, [pushHistory, runtime]);

  // Research digests from the scout land in the feed as well.
  useEffect(() => {
    const scout = runtime.getService<ScoutService>("scout");
    if (!scout?.onEvent) return;
    return scout.onEvent((ev) => pushHistory(pulseTurn(ev.text)));
  }, [pushHistory, runtime]);

  // MetaMask Agent Wallet jobs that waited on an approval report how they ended.
  useEffect(() => {
    const metamask = runtime.getService<MetaMaskService>("metamask");
    if (!metamask?.onEvent) return;
    return metamask.onEvent((ev) => pushHistory(pulseTurn(ev.text)));
  }, [pushHistory, runtime]);

  // The take-profit loop's sells — on paper here, unless this process trades for real.
  useEffect(() => {
    const trader = runtime.getService<TraderService>("trader");
    if (!trader?.onEvent) return;
    return trader.onEvent((ev) => pushHistory(pulseTurn(ev.text)));
  }, [pushHistory, runtime]);

  // Paper trenching: every entry and exit the moment it happens.
  useEffect(() => {
    const trench = runtime.getService<TrenchService>("trench");
    if (!trench?.onEvent) return;
    return trench.onEvent((ev) => {
      if (ev.kind !== "tick") pushHistory(pulseTurn(ev.text));
    });
  }, [pushHistory, runtime]);

  // While the board is open: a fresh snapshot on every scan and every event,
  // and a redraw twice a second so the tape drips and LIVE blinks.
  useEffect(() => {
    if (!board) return;
    let alive = true;
    const offs: (() => void)[] = [];
    if (board === "trench") {
      const trench = runtime.getService<TrenchService>("trench");
      if (!trench) return;
      const pull = () => void trench.snapshot().then((snap) => alive && setBoardSnap({ kind: "trench", snap }));
      pull();
      offs.push(trench.onEvent(pull));
    } else {
      const desk = runtime.getService<StockDeskService>("stocks");
      if (!desk) return;
      const pull = () => void desk.snapshot().then((snap) => alive && setBoardSnap({ kind: "stocks", snap }));
      pull();
      offs.push(desk.onEvent(pull));
      // Someone is watching: the desk scans even with auto-trading off.
      offs.push(desk.watch());
    }
    const timer = setInterval(() => setBoardFrame((f) => f + 1), 500);
    return () => {
      alive = false;
      for (const off of offs) off();
      clearInterval(timer);
      setBoardSnap(null);
    };
  }, [board, runtime]);

  // The stock desk's fills land in the feed as well.
  useEffect(() => {
    const desk = runtime.getService<StockDeskService>("stocks");
    if (!desk?.onEvent) return;
    return desk.onEvent((ev) => {
      if (ev.kind !== "tick") pushHistory(pulseTurn(ev.text));
    });
  }, [pushHistory, runtime]);

  // Routine reports (self-written skills on a schedule) too, when routines run in this process.
  useEffect(() => {
    const routines = runtime.getService<RoutineService>("routines");
    if (!routines?.onEvent) return;
    return routines.onEvent((ev) => pushHistory(pulseTurn(ev.text)));
  }, [pushHistory, runtime]);

  const openSkinPicker = useCallback(() => {
    setPicker({
      title: "pick a skin",
      kind: "skin",
      options: THEME_ORDER.map((n) => ({ value: n, label: n })),
      index: Math.max(0, THEME_ORDER.indexOf(skin)),
      onHighlight: (v) => setPreviewSkin(v),
      onPick: (v) => {
        setPreviewSkin(null);
        if (v !== skin) setSkin(v);
      },
      onCancel: () => setPreviewSkin(null),
    });
  }, [skin]);

  const openEffortPicker = useCallback(() => {
    setPicker({
      title: "set effort (reply depth)",
      kind: "plain",
      options: EFFORTS.map((e) => ({ value: e.value, label: e.label, hint: `  ${e.desc} · ~${e.tokens} tok` })),
      index: Math.max(0, EFFORTS.findIndex((e) => e.value === effort)),
      onPick: (v) => setEffort(v),
    });
  }, [effort]);

  const openCursorPicker = useCallback(() => {
    setPicker({
      title: "cursor",
      kind: "plain",
      options: CURSORS.map((cu) => ({ value: cu.value, label: cu.label, hint: `  ${cu.desc}` })),
      index: Math.max(0, CURSORS.findIndex((cu) => cu.value === cursorPref)),
      onPick: (v) => setCursorPref(v),
    });
  }, [cursorPref]);

  // The live chat model is a SwitchableModelProvider, so /agent re-routes
  // replies mid-session and /model picks the model inside the agent. Both
  // choices are persisted for the next boot.
  const switchable = useMemo(
    () => (runtime.model instanceof SwitchableModelProvider ? runtime.model : undefined),
    [runtime],
  );

  const switchProvider = useCallback(
    (name: string): void => {
      if (!switchable) {
        pushHistory(sysTurn("this session's model provider is fixed — nothing to switch."));
        return;
      }
      const kind = resolveChatProviderKind(name);
      if (!kind) {
        pushHistory(
          sysTurn(`unknown provider "${name}" — try: ${CHAT_PROVIDER_CHOICES.map((p) => p.name).join(" · ")}`),
        );
        return;
      }
      // A missing key or CLI must fail visibly, not drop the chat on a mock.
      const result = switchable.switchTo(kind);
      if (typeof result === "string") {
        pushHistory(sysTurn(result));
        return;
      }
      pushHistory(
        sysTurn(
          `replies now go through ${chatProviderLabel(result.kind)} ${GLYPH.dot} ${result.model}` +
            (result.overridden
              ? `  (env default ${result.envKind}; saved — the daemon adopts it on restart)`
              : "  (back to the env default)"),
        ),
      );
    },
    [pushHistory, switchable],
  );

  const openAgentPicker = useCallback(() => {
    const current = switchable?.state();
    setPicker({
      title: current
        ? `agent — now ${chatProviderLabel(current.kind)} ${GLYPH.dot} ${current.model}`
        : "agent",
      kind: "plain",
      options: CHAT_PROVIDER_CHOICES.map((p) => ({ value: p.name, label: p.name, hint: `  ${p.desc}` })),
      index: Math.max(
        0,
        CHAT_PROVIDER_CHOICES.findIndex((p) => p.kind === current?.kind),
      ),
      onPick: (v) => switchProvider(v),
    });
  }, [switchable, switchProvider]);

  /** Pin a model inside the current agent (null = the agent's own default) and say so. */
  const applyModel = useCallback(
    (id: string | null) => {
      if (!switchable) return;
      const result = switchable.setModel(id);
      if (typeof result === "string") {
        pushHistory(sysTurn(result));
        return;
      }
      pushHistory(
        sysTurn(
          `${chatProviderLabel(result.kind)} now answers on ${result.model}` +
            (result.pinned ? "  (saved for this agent)" : "  (the agent's own default)"),
        ),
      );
    },
    [pushHistory, switchable],
  );

  /**
   * /model: the models the current agent can run, searchable — or, with an
   * argument, straight to the one it names (the exact id, or the only match).
   * Only OpenCode's list is the whole truth; any other agent takes an id it
   * doesn't list as typed, and says so on the next reply if it can't run it.
   */
  const switchModel = useCallback(
    async (query?: string) => {
      if (!switchable) {
        pushHistory(sysTurn(`this session's model is fixed — ${provider} ${GLYPH.dot} ${model}`));
        return;
      }
      const current = switchable.state();
      const label = chatProviderLabel(current.kind);
      const want = query?.trim();
      if (want === "default") return applyModel(null);
      const models = await switchable.models();
      const listed = models.map((m) => ({ value: m.id, label: m.id, ...(m.free ? { hint: "  free" } : {}) }));
      if (want) {
        const matches = filterOptions(listed, want);
        if (models.some((m) => m.id === want)) return applyModel(want);
        if (matches.length === 1) return applyModel(matches[0].value);
        if (!matches.length) {
          if (current.kind !== "opencode") return applyModel(want);
          pushHistory(sysTurn(`no ${label} model matches "${want}" — /model lists them all`));
          return;
        }
      }
      if (!models.length) {
        pushHistory(
          sysTurn(
            `${label} ${GLYPH.dot} ${current.model} — it has no list to pick from; ` +
              "/model <id> pins one, /model default returns to its own",
          ),
        );
        return;
      }
      const all = [{ value: "default", label: "default", hint: "  the agent's own default (.env)" }, ...listed];
      const options = want ? filterOptions(all, want) : all;
      setPicker({
        title: `${label} model — now ${current.model}`,
        kind: "plain",
        all,
        query: want ?? "",
        options,
        index: want ? 0 : Math.max(0, options.findIndex((o) => o.value === (current.pinned ?? "default"))),
        onPick: (v) => applyModel(v === "default" ? null : v),
      });
    },
    [applyModel, model, provider, pushHistory, switchable],
  );

  // ------------------------------------------------------------- sessions
  //
  // A session is a room plus what the index knows about it. The index is
  // written by the runtime as turns happen, so everything here only reads —
  // which is why /resume can reach a conversation from another surface, and
  // another week.

  const sessions = runtime.sessions;

  /** A session list is read by *when*, so that is what its left column says. */
  const ago = useCallback((at: number): string => {
    const mins = Math.round((Date.now() - at) / 60_000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }, []);

  const taskGlyphs = useCallback(
    (record: SessionRecord): string =>
      Object.keys(record.tasks)
        .filter(isTaskKind)
        .map((k) => TASKS[k].emoji)
        .join(""),
    [],
  );

  /** Put a stored conversation back on screen, exactly as the store kept it. */
  const restore = useCallback(
    async (record: SessionRecord) => {
      const mems = await runtime.memory.recent(record.roomId, 200);
      const turns: Turn[] = mems
        .filter((m) => m.role !== "system")
        .map((m) => {
          const task = m.metadata?.task;
          return {
            id: nextId(),
            role: m.role === "agent" ? ("lain" as const) : ("you" as const),
            parts: [{ kind: "text" as const, text: m.content }],
            at: m.createdAt,
            model: typeof m.metadata?.model === "string" ? m.metadata.model : undefined,
            provider: typeof m.metadata?.provider === "string" ? m.metadata.provider : undefined,
            upstream: typeof m.metadata?.upstream === "string" ? m.metadata.upstream : undefined,
            task: isTaskKind(task) ? task : undefined,
            escalated: Boolean(m.metadata?.escalatedFrom),
          };
        });
      setRoom(record.roomId);
      setSessionId(record.id);
      setLive(null);
      setHistory([
        ...turns,
        sysTurn(
          `resumed ${record.id} · ${record.turns} turn${record.turns === 1 ? "" : "s"} · ` +
            `last touched ${ago(record.updatedAt)}` +
            (record.recap ? `\n\n${record.recap.text}` : ""),
        ),
      ]);
    },
    [ago, runtime],
  );

  // A new session shows the masthead again — an empty screen under the banner
  // *is* the announcement, and a notice line would only push it away. What
  // happened to the old one is on the boot lines and in the sidebar's row.
  const newSession = useCallback(() => {
    setRoom(newRoomId("tui"));
    setSessionId(undefined);
    setLive(null);
    setHistory([]);
    setLogoSpin({ at: Date.now(), turns: 1.5, ms: INTRO_MS });
  }, []);

  const resumeSession = useCallback(
    (ref?: string) => {
      if (!sessions) {
        pushHistory(sysTurn("this build keeps no session index — nothing to resume."));
        return;
      }
      void (async () => {
        if (ref) {
          const record = await sessions.resolve(ref, { client: "tui" });
          if (!record) {
            pushHistory(sysTurn(`no session "${ref}" — /sessions lists them.`));
            return;
          }
          await restore(record);
          return;
        }
        const list = (await sessions.list(10, { client: "tui" })).filter((r) => r.roomId !== room);
        if (!list.length) {
          pushHistory(sysTurn("no earlier sessions here yet — this is the first one."));
          return;
        }
        setPicker({
          title: "resume a session",
          kind: "plain",
          options: list.map((r) => ({
            value: r.id,
            label: r.id,
            hint: `  ${ago(r.updatedAt).padEnd(9)} ${String(r.turns).padStart(3)} turns ${taskGlyphs(r)}  ${r.title || "—"}`,
          })),
          index: 0,
          onPick: (value) => {
            const record = list.find((r) => r.id === value);
            if (record) void restore(record);
          },
        });
      })();
    },
    [ago, pushHistory, restore, room, sessions, taskGlyphs],
  );

  const recapSession = useCallback(
    (ref?: string) => {
      if (!sessions) {
        pushHistory(sysTurn("this build keeps no session index — nothing to recap."));
        return;
      }
      void (async () => {
        const record = ref
          ? await sessions.resolve(ref, { client: "tui" })
          : await sessions.resolve(room);
        if (!record) {
          pushHistory(
            sysTurn(
              ref ? `no session "${ref}" — /sessions lists them.` : "nothing said in this session yet.",
            ),
          );
          return;
        }
        pushHistory(sysTurn(`recapping ${record.id} — ${record.turns} turns…`));
        const result = await buildRecap(runtime, record);
        if (result.summarised && result.model) {
          await sessions.setRecap(record.id, {
            text: result.text,
            at: Date.now(),
            model: result.model,
          });
        }
        pushHistory(
          sysTurn(result.model ? `${result.text}\n\n— ${result.model}` : result.text),
        );
      })();
    },
    [pushHistory, room, runtime, sessions],
  );

  const listSessions = useCallback(() => {
    if (!sessions) {
      pushHistory(sysTurn("this build keeps no session index."));
      return;
    }
    void (async () => {
      const list = await sessions.list(10);
      if (!list.length) {
        pushHistory(sysTurn("no sessions recorded yet."));
        return;
      }
      const rows = list.map((r, i) => {
        const here = r.roomId === room ? "❯" : " ";
        return (
          `  ${here} ${String(i + 1).padStart(2)}  ${r.id.padEnd(10)} ${r.client.padEnd(4)} ` +
          `${ago(r.updatedAt).padEnd(9)} ${String(r.turns).padStart(3)} turns ${taskGlyphs(r).padEnd(6)} ${r.title || "—"}`
        );
      });
      pushHistory(
        sysTurn(`sessions (newest first) — /resume <n> · /recap <n>\n${rows.join("\n")}`),
      );
    })();
  }, [ago, pushHistory, room, sessions, taskGlyphs]);

  const taskRoutes = useCallback(
    (task?: string, route?: string) => {
      if (!switchable) {
        pushHistory(sysTurn("this session's model provider is fixed — nothing to route."));
        return;
      }
      const row = (r: { emoji: string; task: string; provider: string; model: string; source: string; error?: string }) =>
        `  ${r.emoji} ${r.task.padEnd(10)} ${r.provider}${r.model ? ` · ${r.model}` : ""}` +
        `  (${r.source})${r.error ? `  ⚠ ${r.error}` : ""}`;
      if (!task) {
        pushHistory(
          sysTurn(
            `who answers what — /tasks <kind> <provider[:model]>\n` +
              `${switchable.taskRoutes().map(row).join("\n")}`,
          ),
        );
        return;
      }
      const kind = task.trim().toLowerCase();
      if (!isTaskKind(kind)) {
        pushHistory(sysTurn(`unknown kind "${task}" — one of: ${TASK_ORDER.join(" · ")}`));
        return;
      }
      if (!route) {
        pushHistory(
          sysTurn(
            `${row(switchable.taskRouteState(kind))}\n` +
              `  ${TASKS[kind].desc}. change it: /tasks ${kind} openrouter:openrouter/free`,
          ),
        );
        return;
      }
      const clearing = ["default", "none", "base"].includes(route.trim().toLowerCase());
      const result = switchable.setTaskRoute(kind, clearing ? null : route.trim());
      if (typeof result === "string") {
        pushHistory(sysTurn(result));
        return;
      }
      pushHistory(
        sysTurn(
          `${row(result)}` +
            (result.critical && !clearing
              ? "\n  ⚠ this kind acts on the world (money/code) — trust that model."
              : ""),
        ),
      );
    },
    [pushHistory, switchable],
  );

  /** What a slash command may reach — see ./commands.ts, where the bodies live. */
  const commandCtx = useMemo(
    () => ({
      runtime,
      history,
      provider,
      model,
      switchable: Boolean(switchable),
      say: (text: string) => pushHistory(sysTurn(text)),
      reply: (text: string) => pushHistory({ id: nextId(), role: "lain", parts: [{ kind: "text", text }], at: Date.now() }),
      copyOut,
      lastReply,
      // The flat feed is rebuilt from history, so a clear is just state.
      clear: () => {
        // The scroll view's turns live in the terminal's scrollback, so a wipe
        // has to reach the terminal itself.
        if (scrollView) stdout?.write("\x1b[2J\x1b[3J\x1b[H");
        setLive(null);
        setHistory([]);
        setLogoSpin({ at: Date.now(), turns: 1.5, ms: INTRO_MS });
      },
      freeze: () =>
        scrollView
          ? pushHistory(sysTurn("scroll view: the terminal already selects natively — long-press or drag over the text."))
          : setSelectMode(true),
      setView: (v?: string) => {
        const next = v?.trim().toLowerCase();
        if (!next) {
          pushHistory(sysTurn(`view: ${viewPref}${viewPref === "auto" ? ` (${scrollView ? "scroll" : "full"})` : ""} — /view scroll | full | auto`));
          return;
        }
        if (!isViewPref(next)) {
          pushHistory(sysTurn(`unknown view "${v}" — /view scroll | full | auto`));
          return;
        }
        setSelectMode(false);
        setSelection(null);
        setViewPref(next);
      },
      togglePulse: () => {
        const next = !pulseOn;
        setPulseOn(next);
        pushHistory(
          sysTurn(next ? "pulse on — i'll murmur when the chain moves." : "pulse off — the wired goes quiet."),
        );
      },
      openPicker: (which: "skin" | "effort" | "cursor" | "agent") => {
        if (which === "skin") openSkinPicker();
        else if (which === "effort") openEffortPicker();
        else if (which === "cursor") openCursorPicker();
        else openAgentPicker();
      },
      switchModel: (query?: string) => void switchModel(query),
      openBoard: (kind: "trench" | "stocks" | null) => {
        if (kind && scrollView) {
          pushHistory(sysTurn(`the live ${kind} board needs the full-screen view — /view full (or /${kind} status for text)`));
          return;
        }
        setBoard(kind);
      },
      choose: (title: string, options: { value: string; label: string; hint?: string }[], onPick: (value: string) => void, index = 0) =>
        setPicker({ title, kind: "plain", options, index, onPick }),
      switchProvider,
      newSession,
      resumeSession,
      recapSession,
      listSessions,
      taskRoutes,
      exit,
    }),
    [copyOut, exit, history, lastReply, listSessions, model, newSession, openCursorPicker, openAgentPicker, openEffortPicker, openSkinPicker, provider, pulseOn, pushHistory, recapSession, resumeSession, runtime, scrollView, setViewPref, stdout, switchModel, switchProvider, switchable, taskRoutes, viewPref],
  );

  const command = useCallback((text: string) => dispatchCommand(text, commandCtx), [commandCtx]);

  /** Run a slash command as if it had been typed and entered. */
  const runCommand = useCallback(
    (name: string) => {
      if (hist.push(name)) saveInputHistory(hist.entries);
      setBrowsing(false);
      setValue("");
      setCursor(0);
      setAcIndex(0);
      command(name);
    },
    [command, hist],
  );

  const send = useCallback(
    async (text: string) => {
      pushHistory({ id: nextId(), role: "you", parts: [{ kind: "text", text }], at: Date.now() });
      const acc: Turn = { id: nextId(), role: "lain", parts: [], at: Date.now() };
      const flush = () =>
        setLive({
          id: acc.id,
          role: acc.role,
          at: acc.at,
          task: acc.task,
          escalated: acc.escalated,
          model: acc.model,
          provider: acc.provider,
          upstream: acc.upstream,
          parts: acc.parts.map((p) => (p.kind === "tool" ? { kind: "tool", tool: { ...p.tool } } : { ...p })),
        });

      setStatus("thinking");
      setStartedAt(Date.now());
      flush();
      try {
        const result = await runtime.handleMessageStream({ roomId: room, userId: "user", text }, (ev: AgentEvent) => {
          if (ev.type === "thinking") {
            setStatus("thinking");
          } else if (ev.type === "task") {
            // The stamp appears while she is still thinking, so the operator
            // sees which model is about to be spent before a word arrives.
            acc.task = ev.kind;
            if (ev.escalated) acc.escalated = true;
            flush();
          } else if (ev.type === "reasoning") {
            // Folded by default: the thought is there to open, not to read past.
            const last = acc.parts.at(-1);
            if (last && last.kind === "reasoning") last.text += ev.delta;
            else acc.parts.push({ kind: "reasoning", id: `${acc.id}-thought-${acc.parts.length}`, text: ev.delta });
            flush();
          } else if (ev.type === "text") {
            setStatus("streaming");
            const last = acc.parts.at(-1);
            if (last && last.kind === "text") last.text += ev.delta;
            else acc.parts.push({ kind: "text", text: ev.delta });
            flush();
          } else if (ev.type === "tool") {
            acc.parts.push({ kind: "tool", tool: { id: ev.id, name: ev.name, input: ev.input, status: "running" } });
            flush();
          } else if (ev.type === "tool_result") {
            for (const p of acc.parts) {
              if (p.kind === "tool" && p.tool.id === ev.id) {
                p.tool.status = ev.ok ? "ok" : "fail";
                p.tool.summary = ev.summary;
              }
            }
            flush();
          }
        });
        acc.model = result.model;
        acc.provider = result.provider;
        acc.upstream = result.upstream;
        acc.task = result.task;
        acc.escalated = Boolean(result.escalatedFrom);
        if (result.choices) {
          // The options come from a tool, not from streamed text: print them,
          // then let the arrows answer. Esc leaves the composer for a free reply.
          const c = result.choices;
          acc.parts.push({ kind: "text", text: result.text });
          setPicker({
            title: c.question.length > 60 ? `${c.question.slice(0, 59)}…` : c.question,
            kind: "plain",
            options: c.options.map((o, i) => ({
              value: `${i + 1}. ${o.label}`,
              label: `${i + 1}. ${o.label}${i === c.recommended ? " ★" : ""}`,
              hint: o.detail ? `  ${o.detail}` : undefined,
            })),
            index: c.recommended ?? 0,
            onPick: (v) => setQueued(v),
          });
        }
        // The index gets its record on the first turn — pick the id up so the
        // sidebar stops saying "new".
        void runtime.sessions?.resolve(room).then((r) => setSessionId(r?.id));
      } catch (err) {
        acc.parts.push({ kind: "text", text: `⚠ ${(err as Error).message}` });
      } finally {
        pushHistory(acc);
        setLive(null);
        setStatus("idle");
        setStartedAt(null);
      }
    },
    [pushHistory, room, runtime],
  );

  // The queued message goes out the moment she finishes, in the order it was
  // typed — nothing is dropped just because she was mid-sentence.
  useEffect(() => {
    if (busy || !queued) return;
    const text = queued;
    setQueued(null);
    void send(text);
  }, [busy, queued, send]);

  // ---------------------------------------------------------- layout math

  const sidebarOn = !scrollView && width >= 100;
  const sidebarW = sidebarOn ? (width >= 150 ? 36 : 30) : 0;
  const contentW = sidebarOn ? width - sidebarW : width;
  // the composer's text area: the gutter, the panel's two borders, its padding
  // and the prompt
  // The composer's drawable text is `contentW - 9` cells (the frame, the ▸
  // prefix and the truncation the chrome applies), and the caret needs one
  // more to stand past the last character — wrap one column short of that.
  const composerWidth = Math.max(4, contentW - 10);
  // One row is deliberately left to the terminal. ink clears the whole screen —
  // scrollback included — whenever a frame is as tall as the window, and a
  // screen that is wiped several times a second cannot be selected or copied.
  const frameRows = Math.max(8, rows - 1);

  const spin = useSpin(busy);
  const feedW = Math.max(8, contentW - 1);

  // The clock for the animations that run on time: the logo's spin and a poke.
  // Neither runs while the frame is frozen or nobody is reading the terminal.
  const now = Date.now();
  const welcome = !scrollView && history.length === 0 && live === null;
  const spinning = welcome && now - logoSpin.at < logoSpin.ms + 120;
  const poked = poke !== null && now - poke.at < POKE_MS;
  useTicker(!selectMode && flowing && (spinning || poked), 50);
  // She blinks only while someone is around (the same window the caret blinks
  // in), so an idle screen stays still and selectable.
  const blinking = useBlink(!selectMode && flowing && (blinkAlive || busy), 4700, 170);
  const logoT = spinning ? now - logoSpin.at : logoSpin.ms;
  const logoRows = Math.min(13, Math.floor((frameRows - 8) * 0.5));

  const feed = useMemo(() => {
    // The scroll view prints turns into the terminal's scrollback instead.
    if (scrollView) return { lines: [] as Line[], regions: [] as (FeedRegion | undefined)[] };
    // An empty session is the welcome screen: the logo turning in space.
    if (!history.length && !live) return welcomeLines(theme, feedW, logoRows, spinPose(logoT, logoSpin.turns, logoSpin.ms));
    // The masthead shrinks to one line once there is a conversation to read.
    const bn = bannerLines(theme, feedW, true);
    const lines: Line[] = [...bn];
    const regions: (FeedRegion | undefined)[] = bn.map(() => undefined);
    const push = (ls: Line[], rs: (FeedRegion | undefined)[]) => {
      lines.push(...ls);
      regions.push(...rs);
    };
    for (const t of history) {
      const tl = turnLines(t, expanded, theme, feedW, spinnerChar(spin));
      push(tl.lines, tl.regions);
    }
    if (live) {
      const tl = turnLines(live, expanded, theme, feedW, spinnerChar(spin));
      push(tl.lines, tl.regions);
    }
    return { lines, regions };
  }, [expanded, feedW, history, live, logoRows, logoSpin, logoT, scrollView, spin, theme]);

  const watches = runtime.getService<SentinelService>("sentinel")?.listWatches()?.length ?? 0;
  const forgeSvc = runtime.getService<ForgeService>("forge");
  const wishes = forgeSvc?.listWishes()?.length ?? 0;
  const coder = forgeSvc ? sidebarCoder(forgeSvc) : "none";
  const forgeNow = forgeSvc ? sidebarForge(forgeSvc) : "—";
  const lastForge = forgeSvc ? sidebarLastForge(forgeSvc) : "—";
  const topics = runtime.getService<ScoutService>("scout")?.listTopics()?.length ?? 0;
  const skills = runtime.actions.length;
  const sidebar = sidebarOn
    ? sidebarLines(theme, sidebarW, frameRows, {
        status,
        elapsed: startedAt ? Date.now() - startedAt : 0,
        spin,
        pulse: pulseOn,
        mascot: { ...mascotPose(now, status, poke, blinking), poked: poke !== null },
        portfolio,
        flash: equityFlash,
        folded: foldedSet,
        pinned: pinnedPanel,
        provider,
        model,
        coder,
        forge: forgeNow,
        lastForge,
        block,
        tokens,
        room,
        session: sessionId,
        effort,
        skinLabel: theme.name,
        watches,
        wishes,
        topics,
        skills,
      })
    : { lines: Array.from({ length: frameRows }, () => blank(sidebarW)), regions: [] as (SidebarHit | undefined)[] };

  // ---- chrome (state line + menus/picker + framed composer + key hints)
  // A token typed after /metamask is drawn masked; same length, so the wrap and cursor match.
  const composerText = useMemo(() => maskSecrets(value), [value]);
  const composerWrap = useMemo(() => wrapIndices(composerText, composerWidth), [composerText, composerWidth]);
  const cursorPos = useMemo(() => cursorToWrap(composerText, cursor, composerWidth), [composerText, cursor, composerWidth]);
  // A menu or picker taller than the screen would push the frame past the
  // terminal's last row, and the terminal scrolls on every repaint — the list
  // flickers. So each gets the rows the rest of the frame leaves (minus one for
  // the transcript) and shows a window of itself that follows the highlight.
  // State line, then either the picker alone or menu + blank + composer + hint.
  const listRows = frameRows - 1 - (picker ? 1 : 1 + 1 + composerWrap.length + 2 + 1);
  const menuWin =
    !picker && menuItems.length ? menuLines(menuItems, acIdx, theme, feedW, listRows, menuStartRef.current) : null;
  const pickerWin = picker ? pickerLines(picker, theme, feedW, listRows, pickerStartRef.current) : null;
  menuStartRef.current = menuWin?.start ?? 0;
  pickerStartRef.current = pickerWin?.start ?? 0;
  const menu = menuWin?.lines ?? [];
  const pickerRows = pickerWin?.lines ?? [];
  const hint = copiedNote
    ? `✓ ${copiedNote} — drag anywhere to select, click to clear`
    : picker
      ? ""
      : menuItems.length
        ? completion.kind === "arg"
          ? `↑↓${scrollView ? "" : " or click"} · tab complete · enter sends the line as typed`
          : `↑↓${scrollView ? "" : " or click"} · tab complete · enter run · esc keep typing`
        : busy
          ? `type ahead — she answers first${scrollView ? "" : " · drag to select"} · ctrl+y copy her last reply`
          : value.includes("\n")
            ? `↵ send · alt+↵ another line · ctrl+u wipe${scrollView ? "" : " · drag to select"}`
            : `↵ send · alt+↵ new line · ↑ history · / commands${scrollView ? "" : " · drag to select"} · ctrl+y copy`;

  const chrome = chromeLines({
    theme,
    // the same right-hand gutter the transcript keeps, so no panel border ever
    // sits flush against the sidebar's
    width: feedW,
    status,
    spin,
    elapsed: startedAt ? Date.now() - startedAt : 0,
    provider,
    model,
    block,
    tokens,
    room,
    effort,
    sidebarOn,
    queued,
    quitArmed,
    menuLines: menu,
    pickerLines: pickerRows,
    composerWrap: composerWrap as { text: string; start: number; end: number }[],
    cursorLine: cursorPos.line,
    cursorCol: cursorPos.col,
    blinkOn: blink,
    blinkEnabled,
    cursorStyle,
    busy,
    hint,
  });

  const viewportRows = Math.max(1, frameRows - chrome.lines.length);

  // ---- the transcript sits at the *bottom* of its viewport: a short
  // conversation belongs next to the composer, not stranded under the banner.
  // The welcome screen is the exception: it stands in the middle, like a title card.
  const topPad = Math.max(0, welcome ? Math.floor((viewportRows - feed.lines.length) / 2) : viewportRows - feed.lines.length);
  // The trench board replaces the transcript outright: one screen, no scroll.
  const boardOn = board !== null && !scrollView && boardSnap !== null && boardSnap.kind === board;
  const view = useMemo(
    () =>
      boardOn
        ? {
            lines:
              boardSnap!.kind === "trench"
                ? boardLines(boardSnap!.snap, theme, feedW, viewportRows, Date.now(), boardFrame)
                : stocksBoardLines(boardSnap!.snap, theme, feedW, viewportRows, Date.now(), boardFrame),
            regions: Array.from({ length: viewportRows }, () => undefined as FeedRegion | undefined),
          }
        : {
            lines: topPad ? [...Array.from({ length: topPad }, () => blank(feedW)), ...feed.lines] : feed.lines,
            regions: topPad
              ? [...Array.from({ length: topPad }, () => undefined as FeedRegion | undefined), ...feed.regions]
              : feed.regions,
          },
    [boardOn, boardSnap, boardFrame, feedW, feed, theme, topPad, viewportRows],
  );

  // ---- scrolling (in-app; the terminal's own scrollback is not used)
  const maxScroll = Math.max(0, view.lines.length - viewportRows);
  const [scrollTop, setScrollTop] = useState(0);
  const atBottomRef = useRef(true);
  const feedLenRef = useRef(0);
  useEffect(() => {
    const n = history.length + (live ? 1 : 0);
    const newContent = feedLenRef.current !== n;
    if (newContent) {
      feedLenRef.current = n;
      atBottomRef.current = true;
    }
    if (atBottomRef.current) {
      setScrollTop(Math.max(0, view.lines.length - viewportRows));
    }
  }, [view.lines.length, viewportRows, history.length, live]);

  // ---- assemble the frame: feed slice + scrollbar, chrome, sidebar merge
  const composed = composeFrame({
    theme,
    width,
    contentW,
    sidebarW,
    sidebarOn,
    frameRows,
    viewportRows,
    scrollTop,
    maxScroll,
    view,
    chrome,
    sidebar,
    composerWrap: composerWrap as ComposerWrap,
    // A click on a command runs it; on an argument, it goes into the line like Tab.
    menuItems: (menuWin ? menuItems.slice(menuWin.start, menuWin.start + menuWin.count) : []).map((it) =>
      completion.kind === "arg" ? { ...it, fill: acceptCompletion(value, completion, it) } : it,
    ),
    pickerStart: pickerWin?.start ?? 0,
    pickerCount: pickerWin?.count ?? 0,
    // A frozen frame is selected by the terminal itself, which would copy the
    // scrollbar's column along with the text.
    scrollbar: !selectMode,
  });

  const feedRef = useRef(view);
  const layoutRef = useRef(composed.hit);

  // The mouse reads the scroll position between renders (a drag scrolls and
  // extends in one event), so it is kept in a ref as well as in state.
  const scrollTopRef = useRef(scrollTop);
  scrollTopRef.current = scrollTop;
  const scrollBy = useCallback((delta: number) => {
    const max = Math.max(0, feedRef.current.lines.length - layoutRef.current.viewportRows);
    const next = clamp(scrollTopRef.current + delta, 0, max);
    atBottomRef.current = next >= max;
    scrollTopRef.current = next;
    setScrollTop(next);
  }, []);

  feedRef.current = view;
  layoutRef.current = composed.hit;
  const all = composed.lines;

  // ---- selection mode: the frame stops moving, so the terminal's own mouse
  // selection has something stable to grab. Nothing is written while it holds
  // (ink skips a frame identical to the last one), which is the whole point —
  // a repaint under a drag is what made copying impossible.
  if (selectMode && !frozenRef.current) frozenRef.current = all;
  if (!selectMode && frozenRef.current) frozenRef.current = null;
  const selectBar = fitLine(
    concat(
      [sp("◼ selection", theme.warn)],
      [sp("  esc back · drag to select · copy with the terminal (ctrl+shift+c)", theme.mutedDim)],
    ),
    width,
  );
  const frame =
    selectMode && frozenRef.current
      ? [...frozenRef.current.slice(0, Math.max(0, frameRows - 1)), selectBar]
      : all;
  // The drag is read back off the painted frame, so remember it unhighlighted.
  displayRef.current = frame;
  const onScreen = selection?.feed ? feedToScreen(selection, scrollTop, viewportRows) : selection;
  const display =
    onScreen && !selectMode
      ? highlightSelection(frame, onScreen, theme.border, onScreen.right, onScreen.left)
      : frame;

  // ------------------------------------------------------------- handlers

  const toggleFold = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** Copy whatever the drag covered, straight off the painted frame. */
  const copySelection = useCallback(
    (range: Selection) => {
      // A transcript selection is read off the whole transcript — it may reach
      // well past the screen — and a sidebar one off the painted frame.
      const text = range.feed
        ? selectionText(feedRef.current.lines, range, range.right, range.left)
        : selectionText(displayRef.current, range, range.right, range.left);
      if (!text.trim()) return;
      osc52(text, (s) => void stdout?.write(s));
      void copyToClipboard(text);
      setCopiedNote(`${text.length} chars copied`);
    },
    [copyToClipboard, stdout],
  );

  /** The same latest-ref shape as the keyboard's context, for the same reason. */
  const mouseCtxRef = useRef<MouseCtx | null>(null);
  mouseCtxRef.current = {
    hit: layoutRef.current,
    picker,
    drag: dragRef,
    selection: selectionRef.current,
    hasNote: Boolean(copiedNote),
    setPicker,
    setSelection,
    clearNote: () => setCopiedNote(null),
    scrollBy,
    scrollTop: () => scrollTopRef.current,
    copySelection,
    openPicker: (which) => {
      if (which === "skin") openSkinPicker();
      else if (which === "effort") openEffortPicker();
      else if (which === "agent") openAgentPicker();
      else void switchModel();
    },
    freeze: () => setSelectMode(true),
    copyLastReply: () => copyOut(lastReply(), "lain's last reply"),
    toggleFold,
    copyText: copyOut,
    runCommand,
    fillComposer: (line) => {
      setBrowsing(false);
      setValue(line);
      setCursor(line.length);
      setAcIndex(0);
    },
    moveCursorTo: (index) => {
      setCursor(index);
      setBrowsing(false);
    },
    togglePanel,
    pokeMascot,
    spinLogo,
  };

  const handleMouse = useCallback((m: MouseInfo) => handleMouse_(m, mouseCtxRef.current!), []);

  /** The newest state, read fresh on every keypress. `InputCapture` already
   *  keeps the handler in a ref, so a dependency array here would only be a
   *  hand-maintained way to go stale. */
  const keyCtxRef = useRef<KeyCtx | null>(null);
  keyCtxRef.current = {
    value,
    cursor,
    acIndex,
    browsing,
    completion,
    composerWidth,
    viewportRows,
    picker,
    selectMode,
    quitArmed,
    hist,
    board: boardOn,
    closeBoard: () => setBoard(null),
    edit: (v, c) => {
      setBrowsing(false);
      setValue(v);
      setCursor(c);
      setAcIndex(0);
    },
    recall: (v) => {
      setBrowsing(true);
      setValue(v);
      setCursor(v.length);
    },
    commit: (text) => {
      // Remembered for the next ↑ — and for the next run of the TUI. A secret never is.
      if (!isSecretCommand(text) && hist.push(text)) saveInputHistory(hist.entries);
      // Anything but the board's own command answers in the transcript, so the board steps aside for it.
      if (!text.startsWith(`/${board ?? "-"}`)) setBoard(null);
      setBrowsing(false);
      setValue("");
      setCursor(0);
      setAcIndex(0);
      if (text.startsWith("/")) command(text);
      // A message sent while she is still answering waits its turn instead of
      // vanishing — the line clears, so it has to go somewhere real.
      else if (text && busy) setQueued(text);
      else if (text) send(text);
    },
    clearComposer: () => {
      setValue("");
      setCursor(0);
      setBrowsing(false);
      setAcIndex(0);
    },
    setMenuIndex: setAcIndex,
    setPicker,
    setSelectMode,
    armQuit: () => {
      if (quitTimerRef.current) clearTimeout(quitTimerRef.current);
      setQuitArmed(true);
      quitTimerRef.current = setTimeout(() => setQuitArmed(false), 3000);
    },
    disarmQuit: () => {
      if (quitTimerRef.current) clearTimeout(quitTimerRef.current);
      setQuitArmed(false);
    },
    exit,
    copyLastReply: () => copyOut(lastReply(), "lain's last reply"),
    scrollBy,
  };

  const onKey = useCallback(
    (input: string, key: TuiKey) => {
      if (!key.mouse) {
        // The frame is about to change under it, so a keypress ends the drag's
        // selection rather than leaving a stale highlight behind.
        if (selectionRef.current) setSelection(null);
        if (copiedNote) setCopiedNote(null);
      }
      setBlink(true);
      setBlinkAlive(true);
      if (blinkIdleRef.current) clearTimeout(blinkIdleRef.current);
      blinkIdleRef.current = setTimeout(() => setBlinkAlive(false), 10_000);

      if (key.mouse) {
        if (!selectMode) handleMouse(key.mouse);
        return;
      }
      handleKey({ input, key }, keyCtxRef.current!);
    },
    [copiedNote, handleMouse, selectMode],
  );

  // ---- scroll view: what has already been printed, and what is still live
  // A history that is not an extension of the last one (/new, /wipe, /resume)
  // starts a fresh print run — ink's <Static> only ever appends.
  const lastHistoryRef = useRef<Turn[]>(history);
  const printEpochRef = useRef(0);
  {
    const prev = lastHistoryRef.current;
    if (history !== prev && (history.length < prev.length || (prev.length > 0 && history[0] !== prev[0]))) {
      printEpochRef.current += 1;
    }
    lastHistoryRef.current = history;
  }
  type PrintItem = { key: string; turn?: Turn };
  const printItems: PrintItem[] = scrollView
    ? [{ key: `banner-${printEpochRef.current}` }, ...history.map((t) => ({ key: t.id, turn: t }))]
    : [];
  const nothingOpen = useMemo(() => new Set<string>(), []);
  const printLines = (item: PrintItem): Line[] =>
    item.turn
      ? turnLines(item.turn, nothingOpen, theme, feedW, "").lines
      : history.length
        ? bannerLines(theme, feedW, true)
        : [...bannerLines(theme, feedW, false), ...bootLines(theme, feedW)];
  // The live turn is redrawn until it is done, then printed for good. Capped so
  // the redrawn area stays shorter than the window: ink wipes the screen and
  // reprints everything it ever printed when it is not.
  const liveLines = scrollView && live ? turnLines(live, expanded, theme, feedW, spinnerChar(spin)).lines : [];
  const liveRoom = Math.max(0, frameRows - chrome.lines.length);
  const scrollDisplay = scrollView ? [...liveLines.slice(-liveRoom), ...chrome.lines] : [];

  // ---- while the terminal is not reading, keep showing what it last got, so
  // ink has nothing new to write (it skips an identical frame).
  const shownRef = useRef<{ lines: Line[]; items: PrintItem[] }>({ lines: [], items: [] });
  if (flowing || !shownRef.current.lines.length) {
    shownRef.current = { lines: scrollView ? scrollDisplay : display, items: printItems };
  }
  const shown = shownRef.current;

  // Lines are measured by our own width table (markdown.ts), which counts a
  // text-style pictograph like ⚠ as the one cell terminals draw; ink's measure
  // says two and would truncate a full-width line. The slack keeps ink out of it.
  const slack = width + 8;
  return (
    <Box flexDirection="column" width={slack}>
      {scrollView ? (
        <Static key={`print-${printEpochRef.current}`} items={shown.items}>
          {(item) => (
            <Box key={item.key} flexDirection="column" width={slack}>
              {printLines(item).map((line, i) => (
                <LineView key={i} line={line} />
              ))}
            </Box>
          )}
        </Static>
      ) : null}
      {shown.lines.map((line, i) => (
        <LineView key={i} line={line} />
      ))}
      {isRawModeSupported ? <InputCapture onKey={onKey} mouse={!selectMode && !scrollView} /> : null}
    </Box>
  );
}
