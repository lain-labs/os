/** Autonomous chain watcher — lets Lain notice on-chain activity on her own. */
import { formatEther, parseEther } from "viem";

export interface PulseEvent {
  kind: "transfer";
  text: string;
}

export interface PulseOptions {
  intervalMs?: number; // poll cadence
  thresholdNative?: number; // "whale" transfer size
  minGapMs?: number; // min spacing between utterances
  nativeSymbol?: string;
}

interface RpcTx {
  hash?: string;
  from?: string;
  to?: string | null;
  value?: string;
}
interface RpcBlock {
  number?: string;
  transactions?: RpcTx[];
}

const short = (a?: string | null): string => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "a contract");

function trimNum(s: string): string {
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/**
 * Pure: return the first not-yet-seen transaction at/over the threshold, marking
 * everything it inspects as seen. Exposed for testing the detection logic.
 */
export function pickLargeTransfer(txs: RpcTx[], thresholdWei: bigint, seen: Set<string>): RpcTx | null {
  for (const tx of txs) {
    if (!tx.hash || seen.has(tx.hash)) continue;
    seen.add(tx.hash);
    let value = 0n;
    try {
      value = BigInt(tx.value ?? "0x0");
    } catch {
      value = 0n;
    }
    if (value >= thresholdWei) return tx;
  }
  return null;
}

export class ChainPulse {
  private timer: ReturnType<typeof setInterval> | null = null;
  private seen = new Set<string>();
  private lastUtter = 0;
  private readonly threshold: bigint;
  private readonly nativeSymbol: string;

  constructor(
    private readonly rpc: string,
    private readonly onEvent: (event: PulseEvent) => void,
    private readonly opts: PulseOptions = {},
  ) {
    this.threshold = parseEther(String(opts.thresholdNative ?? 10));
    this.nativeSymbol = opts.nativeSymbol ?? "native";
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs ?? 7000);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    const res = await fetch(this.rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const json = (await res.json()) as { result?: T };
    return json.result as T;
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    if (now - this.lastUtter < (this.opts.minGapMs ?? 25000)) return; // throttle
    try {
      const block = await this.call<RpcBlock>("eth_getBlockByNumber", ["latest", true]);
      if (this.seen.size > 8000) this.seen.clear();

      const tx = pickLargeTransfer(block.transactions ?? [], this.threshold, this.seen);
      if (tx) {
        this.lastUtter = now;
        const amount = trimNum(formatEther(BigInt(tx.value ?? "0x0")));
        this.onEvent({
          kind: "transfer",
          text: `a whale stirs in the wired — ${amount} ${this.nativeSymbol} from ${short(tx.from)} to ${short(tx.to)}.`,
        });
        return;
      }

      // Nothing notable: stay silent.
    } catch {
      /* RPC unreachable — stay silent */
    }
  }
}
