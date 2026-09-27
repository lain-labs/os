/**
 * The small React hooks the TUI needs — terminal size, a spinner clock, the
 * chain's block height, and a preference that outlives the session.
 *
 * They live here rather than in App because none of them knows anything about
 * this app: each is a plain subscription with a cleanup.
 */
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
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
