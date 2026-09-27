/** Tiny leveled logger with a Lain-flavoured prefix. */

const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  green: "\x1b[32m",
};

type Level = "debug" | "info" | "warn" | "error" | "agent";

const LEVEL_STYLE: Record<Level, string> = {
  debug: COLORS.dim,
  info: COLORS.cyan,
  warn: COLORS.yellow,
  error: COLORS.red,
  agent: COLORS.magenta,
};

const enabledDebug = process.env.LAINOS_DEBUG === "1";

export interface LogRecord {
  level: Level;
  scope: string;
  msg: string;
  ts: number;
}

// When the TUI owns the screen, console output would corrupt the render. We
// mute the console and let subscribers (the TUI's log panel) consume records.
let muted = false;
const subscribers = new Set<(record: LogRecord) => void>();

/** Silence (or unsilence) direct console output — used while the TUI renders. */
export function setLogMuted(value: boolean): void {
  muted = value;
}

/** Subscribe to every log record (returns an unsubscribe fn). */
export function onLog(fn: (record: LogRecord) => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function emit(level: Level, scope: string, msg: string, extra?: unknown) {
  if (level === "debug" && !enabledDebug) return;

  for (const fn of subscribers) {
    try {
      fn({ level, scope, msg, ts: Date.now() });
    } catch {
      /* a broken subscriber must never break logging */
    }
  }
  if (muted) return;

  const style = LEVEL_STYLE[level];
  const tag = `${style}[lainos:${scope}]${COLORS.reset}`;
  const line = `${tag} ${msg}`;
  if (extra !== undefined) {
    // eslint-disable-next-line no-console
    console.log(line, extra);
  } else {
    // eslint-disable-next-line no-console
    console.log(line);
  }
}

export function createLogger(scope: string) {
  return {
    debug: (msg: string, extra?: unknown) => emit("debug", scope, msg, extra),
    info: (msg: string, extra?: unknown) => emit("info", scope, msg, extra),
    warn: (msg: string, extra?: unknown) => emit("warn", scope, msg, extra),
    error: (msg: string, extra?: unknown) => emit("error", scope, msg, extra),
    agent: (msg: string) =>
      emit("agent", scope, `${COLORS.green}${msg}${COLORS.reset}`),
  };
}

export type Logger = ReturnType<typeof createLogger>;
