import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useStdin, useStdout } from "ink";
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
  loadCursor,
  loadEffort,
  loadPulse,
  loadSkin,
  saveCursor,
  saveEffort,
  savePulse,
  saveSkin,
} from "./theme.js";
import { blank, concat, fitLine, sp, type Line } from "./markdown.js";
import { chromeLines, menuLines, pickerLines } from "./chrome.js";
import { runCommand as dispatchCommand, suggestionsFor } from "./commands.js";
import { composeFrame, type ComposerWrap } from "./frame.js";
import { useChainHeight, usePersistedPref, useSpin, useStdoutDimensions } from "./hooks.js";
import { handleKey, type KeyCtx, type PickerState } from "./keymap.js";
import { handleMouse as handleMouse_, type Drag, type MouseCtx } from "./mouse.js";
import { localClipboard, osc52 } from "./clipboard.js";
import { highlightSelection, selectionText, type BoundedRange } from "./selection.js";
import { cursorToWrap, wrapIndices } from "./editor.js";
import { InputHistory, loadInputHistory, saveInputHistory } from "./history.js";
import { ESC_TIMEOUT_MS, KeyReader, type KeyPress, type MouseInfo, type TuiKey } from "./keys.js";
import { ChainPulse } from "./pulse.js";
import {
  bannerLines,
  bootLines,
  sidebarLines,
  spinnerChar,
  turnLines,
  turnText,
  type FeedRegion,
  type SidebarRegion,
  type Turn,
} from "./layout.js";
import type { ForgeService } from "../../plugins/forge/index.js";
import type { ScoutService } from "../../plugins/scout/index.js";
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
      if (p.kind === "text") chars += p.text.length;
      else chars += p.tool.name.length + (p.tool.summary?.length ?? 0);
    }
  };
  history.forEach(add);
  if (live) add(live);
  return Math.round(chars / 4);
}

// ------------------------------------------------------------ components

/** Render one styled line into a single ink <Text>. */
function LineView({ line }: { line: Line }) {
  return (
    <Text wrap="truncate">
      {line.map((s, i) => (
        <Text key={i} color={s.c} bold={s.b} italic={s.i} underline={s.u} backgroundColor={s.bg}>
          {s.t}
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

export function App({ runtime }: { runtime: IAgentRuntime }) {
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
  // which tool calls are expanded in the feed (click to toggle)
  const [expandedTools, setExpandedTools] = useState<ReadonlySet<string>>(new Set());
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

  const suggestions = useMemo(() => suggestionsFor(value), [value]);
  const menuItems = browsing ? [] : suggestions;
  const acIdx = menuItems.length ? Math.min(acIndex, menuItems.length - 1) : 0;
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
      void localClipboard(body);
      pushHistory(
        sysTurn(
          `copied ${what} (${body.length} chars).` +
            " if your terminal blocks OSC 52, drag over the text instead — or ctrl+s to freeze the frame.",
        ),
      );
    },
    [pushHistory, stdout],
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

  // The live chat model is a SwitchableModelProvider, so /model re-routes
  // replies mid-session. The choice is persisted for the next boot.
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

  const openModelPicker = useCallback(() => {
    const current = switchable?.state();
    setPicker({
      title: current
        ? `chat model — now ${chatProviderLabel(current.kind)} ${GLYPH.dot} ${current.model}`
        : "chat model",
      kind: "plain",
      options: CHAT_PROVIDER_CHOICES.map((p) => ({ value: p.name, label: p.name, hint: `  ${p.desc}` })),
      index: Math.max(
        0,
        CHAT_PROVIDER_CHOICES.findIndex((p) => p.kind === current?.kind),
      ),
      onPick: (v) => switchProvider(v),
    });
  }, [switchable, switchProvider]);

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
      copyOut,
      lastReply,
      // The flat feed is rebuilt from history, so a clear is just state.
      clear: () => {
        setLive(null);
        setHistory([]);
      },
      freeze: () => setSelectMode(true),
      togglePulse: () => {
        const next = !pulseOn;
        setPulseOn(next);
        pushHistory(
          sysTurn(next ? "pulse on — i'll murmur when the chain moves." : "pulse off — the wired goes quiet."),
        );
      },
      openPicker: (which: "skin" | "effort" | "cursor" | "model") => {
        if (which === "skin") openSkinPicker();
        else if (which === "effort") openEffortPicker();
        else if (which === "cursor") openCursorPicker();
        else openModelPicker();
      },
      switchProvider,
      newSession,
      resumeSession,
      recapSession,
      listSessions,
      taskRoutes,
      exit,
    }),
    [copyOut, exit, history, lastReply, listSessions, model, newSession, openCursorPicker, openEffortPicker, openModelPicker, openSkinPicker, provider, pulseOn, pushHistory, recapSession, resumeSession, runtime, switchProvider, switchable, taskRoutes],
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
          parts: acc.parts.map((p) =>
            p.kind === "tool" ? { kind: "tool", tool: { ...p.tool } } : { kind: "text", text: p.text },
          ),
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

  const sidebarOn = width >= 100;
  const sidebarW = sidebarOn ? 28 : 0;
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
  const feed = useMemo(() => {
    // The masthead shrinks to one line once there is a conversation to read.
    const bn = bannerLines(theme, feedW, history.length > 0 || live !== null);
    const lines: Line[] = [...bn];
    const regions: (FeedRegion | undefined)[] = bn.map(() => undefined);
    const push = (ls: Line[], rs: (FeedRegion | undefined)[]) => {
      lines.push(...ls);
      regions.push(...rs);
    };
    if (!history.length && !live) {
      const bt = bootLines(theme, feedW);
      push(bt, bt.map(() => undefined));
    }
    for (const t of history) {
      const tl = turnLines(t, expandedTools, theme, feedW, spinnerChar(spin));
      push(tl.lines, tl.regions);
    }
    if (live) {
      const tl = turnLines(live, expandedTools, theme, feedW, spinnerChar(spin));
      push(tl.lines, tl.regions);
    }
    return { lines, regions };
  }, [expandedTools, feedW, history, live, spin, theme]);

  const watches = runtime.getService<SentinelService>("sentinel")?.listWatches()?.length ?? 0;
  const wishes = runtime.getService<ForgeService>("forge")?.listWishes()?.length ?? 0;
  const topics = runtime.getService<ScoutService>("scout")?.listTopics()?.length ?? 0;
  const skills = runtime.actions.length;
  const sidebar = sidebarOn
    ? sidebarLines(theme, sidebarW, frameRows, {
        provider,
        model,
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
    : { lines: Array.from({ length: frameRows }, () => blank(sidebarW)), regions: [] as (SidebarRegion | undefined)[] };

  // ---- chrome (state line + menus/picker + framed composer + key hints)
  const composerWrap = useMemo(() => wrapIndices(value, composerWidth), [value, composerWidth]);
  const cursorPos = useMemo(() => cursorToWrap(value, cursor, composerWidth), [value, cursor, composerWidth]);
  const menu = !picker && menuItems.length ? menuLines(menuItems, acIdx, theme, feedW) : [];
  const pickerRows = picker ? pickerLines(picker, theme, feedW) : [];
  const hint = copiedNote
    ? `✓ ${copiedNote} — drag anywhere to select, click to clear`
    : picker
      ? ""
      : menuItems.length
        ? "↑↓ or click · tab next · enter run · esc keep typing"
        : busy
          ? "type ahead — she answers first · drag to select · ctrl+y copy her last reply"
          : value.includes("\n")
            ? "↵ send · alt+↵ another line · ctrl+u wipe · drag to select"
            : "↵ send · alt+↵ new line · ↑ history · / commands · drag to select · ctrl+y copy";

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
  const topPad = Math.max(0, viewportRows - feed.lines.length);
  const view = useMemo(
    () => ({
      lines: topPad ? [...Array.from({ length: topPad }, () => blank(feedW)), ...feed.lines] : feed.lines,
      regions: topPad
        ? [...Array.from({ length: topPad }, () => undefined as FeedRegion | undefined), ...feed.regions]
        : feed.regions,
    }),
    [feedW, feed, topPad],
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
    menuItems,
  });

  const feedRef = useRef(view);
  const layoutRef = useRef(composed.hit);

  const scrollBy = useCallback((delta: number) => {
    setScrollTop((prev) => {
      const max = Math.max(0, feedRef.current.lines.length - layoutRef.current.viewportRows);
      const next = clamp(prev + delta, 0, max);
      atBottomRef.current = next >= max;
      return next;
    });
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
  const display =
    selection && !selectMode
      ? highlightSelection(frame, selection, theme.border, selection.right, selection.left)
      : frame;

  // ------------------------------------------------------------- handlers

  const toggleTool = useCallback((id: string) => {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** Copy whatever the drag covered, straight off the painted frame. */
  const copySelection = useCallback(
    (range: Selection) => {
      const text = selectionText(displayRef.current, range, range.right, range.left);
      if (!text.trim()) return;
      osc52(text, (s) => void stdout?.write(s));
      void localClipboard(text);
      setCopiedNote(`${text.length} chars copied`);
    },
    [stdout],
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
    copySelection,
    openPicker: (which) => {
      if (which === "skin") openSkinPicker();
      else if (which === "effort") openEffortPicker();
      else openModelPicker();
    },
    freeze: () => setSelectMode(true),
    copyLastReply: () => copyOut(lastReply(), "lain's last reply"),
    toggleTool,
    copyText: copyOut,
    runCommand,
    moveCursorTo: (index) => {
      setCursor(index);
      setBrowsing(false);
    },
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
    composerWidth,
    viewportRows,
    picker,
    selectMode,
    quitArmed,
    hist,
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
      // Remembered for the next ↑ — and for the next run of the TUI.
      if (hist.push(text)) saveInputHistory(hist.entries);
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

  return (
    <Box flexDirection="column">
      {display.map((line, i) => (
        <LineView key={i} line={line} />
      ))}
      {isRawModeSupported ? <InputCapture onKey={onKey} mouse={!selectMode} /> : null}
    </Box>
  );
}
