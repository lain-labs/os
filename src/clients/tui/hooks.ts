/**
 * The small React hooks the TUI needs — terminal size, a spinner clock, the
 * chain's block height, and a preference that outlives the session.
 *
 * They live here rather than in App because none of them knows anything about
 * this app: each is a plain subscription with a cleanup.
 */
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useStdout } from "ink";

/**
 * A `useState` that is written back to disk whenever it changes.
 *
 * `load` runs once (lazily, on mount); `save` runs on every change, read from a
 * ref so passing an inline arrow does not re-fire the effect.
 */
export function usePersistedPref<T>(load: () => T, save: (value: T) => void): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(load);
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    saveRef.current(value);
  }, [value]);
  return [value, setValue];
}

/** Terminal size that tracks window resizes. */
export function useStdoutDimensions(): { width: number; rows: number } {
  const { stdout } = useStdout();
  const [size, setSize] = useState(() => ({
    width: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  }));
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setSize({ width: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);
  return size;
}

/** Advance a frame counter while `active` — drives spinner glyphs. */
export function useSpin(active: boolean): number {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setFrame((f) => f + 1), 90);
    return () => clearInterval(id);
  }, [active]);
  return frame;
}

/** Re-render every `ms` while `active` — the clock for animations that run on time, not on a counter. */
export function useTicker(active: boolean, ms: number): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((t) => t + 1), ms);
    return () => clearInterval(id);
  }, [active, ms]);
}

/**
 * True for `holdMs` once every `everyMs` while `active` — an eye blink. Two
 * renders per blink, where a fast clock would have spent dozens.
 */
export function useBlink(active: boolean, everyMs: number, holdMs: number): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!active) return;
    let hold: ReturnType<typeof setTimeout> | undefined;
    const id = setInterval(() => {
      setOn(true);
      hold = setTimeout(() => setOn(false), holdMs);
    }, everyMs);
    return () => {
      clearInterval(id);
      if (hold) clearTimeout(hold);
      setOn(false);
    };
  }, [active, everyMs, holdMs]);
  return on;
}

/**
 * A value read now, every `everyMs`, and again shortly after `bump` changes —
 * but never sooner than `minGapMs` after the last read (a bump inside the gap
 * reads once the gap is over), so a busy conversation cannot hammer whatever
 * `read` asks.
 */
export function usePolled<T>(read: () => Promise<T>, bump: unknown, everyMs: number, minGapMs: number): T | null {
  const [value, setValue] = useState<T | null>(null);
  const readRef = useRef(read);
  readRef.current = read;
  const lastRef = useRef(0);
  const busyRef = useRef(false);
  const trailRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aliveRef = useRef(true);
  const pull = useCallback(() => {
    const wait = lastRef.current + minGapMs - Date.now();
    if (busyRef.current || wait > 0) {
      if (!trailRef.current) {
        trailRef.current = setTimeout(() => {
          trailRef.current = null;
          pull();
        }, Math.max(wait, 1000));
      }
      return;
    }
    busyRef.current = true;
    lastRef.current = Date.now();
    void readRef
      .current()
      .then((v) => aliveRef.current && setValue(v))
      .catch(() => undefined)
      .finally(() => {
        busyRef.current = false;
      });
  }, [minGapMs]);
  useEffect(() => {
    aliveRef.current = true;
    pull();
    const id = setInterval(pull, everyMs);
    return () => {
      aliveRef.current = false;
      clearInterval(id);
      if (trailRef.current) clearTimeout(trailRef.current);
      trailRef.current = null;
    };
  }, [everyMs, pull]);
  useEffect(() => {
    const id = setTimeout(pull, 1500);
    return () => clearTimeout(id);
  }, [bump, pull]);
  return value;
}

/**
 * The chain's head, polled for the header.
 *
 * Deliberately its own poller and not a reading off `ChainPulse`: the pulse is
 * opt-in and throttles itself between utterances, so the height would freeze —
 * or vanish — the moment someone turned whale notices off.
 */
export function useChainHeight(rpc: string): number | null {
  const [block, setBlock] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch(rpc, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
        });
        const j = (await res.json()) as { result?: string };
        if (alive && typeof j.result === "string") setBlock(parseInt(j.result, 16));
      } catch {
        /* offline — keep last height */
      }
    };
    void poll();
    const t = setInterval(() => void poll(), 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [rpc]);
  return block;
}

/** Bytes queued for the terminal past which drawing pauses. */
const OUTPUT_BACKLOG_LIMIT = 256 * 1024;

/**
 * False while the terminal has stopped reading what we write.
 *
 * A phone that puts its ssh client in the background stops draining the
 * connection; the pty fills, and a blocking write to it froze the whole
 * process — the agent mid-tool included — until the app came back to the
 * screen. The launcher makes stdout non-blocking (scripts/tui.ts), so writes
 * queue in memory instead; this is what stops that queue from growing a frame
 * per spinner tick for as long as the phone is away.
 */
export function useOutputFlowing(stdout: NodeJS.WriteStream | undefined): boolean {
  const [flowing, setFlowing] = useState(true);
  useEffect(() => {
    if (!stdout) return;
    const check = () => setFlowing((stdout.writableLength ?? 0) < OUTPUT_BACKLOG_LIMIT);
    const t = setInterval(check, 250);
    stdout.on("drain", check);
    return () => {
      clearInterval(t);
      stdout.off("drain", check);
    };
  }, [stdout]);
  return flowing;
}
