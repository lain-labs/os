/**
 * The `mm` binary of MetaMask Agent Wallet, driven headless.
 *
 * Every command runs with `--json` and answers with one envelope — `{ ok:
 * true, data, hint? }` on stdout, or `{ ok: false, error: { code, message,
 * hint } }` on stderr — optionally preceded by `{ _notice: … }` documents (an
 * MFA pause announces itself that way). Documents are pretty-printed and
 * simply concatenated, so the streams are split by brace depth rather than by
 * line, and both are read.
 *
 * The package is not a dependency of LainOS: its license forbids
 * redistribution, so the operator installs it (`npm install -g
 * @metamask/agent-wallet`) and this module only runs what is on the machine.
 *
 * What never goes through here: anything that would put a seed phrase or a
 * password on a command line (and from there into a transcript), the
 * interactive REPL, sign-in flows that wait on a terminal, wiping the local
 * session (`mm reset` deletes a bring-your-own-wallet seed), and installing
 * third-party `mm` plugins, whose consent screen belongs to the operator.
 */
import { spawn } from "node:child_process";

export interface MmError {
  code: string;
  message: string;
  hint?: string;
}

export interface MmResult {
  ok: boolean;
  data?: unknown;
  error?: MmError;
  /** The CLI's next-step hint on success (e.g. which command executes a quote). */
  hint?: string;
  /** `_notice` payloads emitted before the result (e.g. an MFA pause). */
  notices: unknown[];
  exitCode: number | null;
}

export interface MmRunOptions {
  timeoutMs?: number;
  /** Extra environment for this run only (e.g. MM_CLI_TOKEN). */
  env?: Record<string, string>;
}

export const INSTALL_HINT =
  "Install it on the host: `npm install -g @metamask/agent-wallet@latest` (Node.js 22.18+), " +
  "or point LAINOS_MM_BIN at the `mm` binary.";

const DEFAULT_TIMEOUT_MS = 180_000;
const STDOUT_CAP = 4_000_000;

/**
 * Split concatenated JSON objects; text between them is ignored. A document
 * only starts at `{` — every `mm` document is an object, and log lines on
 * stderr carry bare brackets ("[progress] …").
 */
export function parseJsonStream(text: string): unknown[] {
  const out: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      if (depth > 0) inString = true;
    } else if (ch === "{" || (ch === "[" && depth > 0)) {
      if (depth === 0) start = i;
      depth += 1;
    } else if ((ch === "}" || ch === "]") && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          out.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          // Not JSON after all (a brace in prose); skip it.
        }
        start = -1;
      }
    }
  }
  return out;
}

/** Turn one run's output into a result, whatever shape it arrived in. */
export function parseEnvelope(stdout: string, stderr: string, exitCode: number | null): MmResult {
  const notices: unknown[] = [];
  let envelope: { ok: boolean; data?: unknown; hint?: unknown; error?: Partial<MmError> } | undefined;
  // Successes and notices arrive on stdout, failures on stderr; the last
  // envelope seen is the result.
  for (const doc of [...parseJsonStream(stdout), ...parseJsonStream(stderr)]) {
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) continue;
    const rec = doc as Record<string, unknown>;
    if ("_notice" in rec) notices.push(rec._notice);
    else if (typeof rec.ok === "boolean") envelope = rec as typeof envelope;
  }
  if (envelope) {
    if (envelope.ok) {
      const hint = typeof envelope.hint === "string" && envelope.hint ? { hint: envelope.hint } : {};
      return { ok: true, data: envelope.data, ...hint, notices, exitCode };
    }
    const e = envelope.error ?? {};
    return {
      ok: false,
      error: {
        code: String(e.code ?? "MM_ERROR"),
        message: String(e.message ?? "mm reported a failure without a message."),
        ...(e.hint ? { hint: String(e.hint) } : {}),
      },
      notices,
      exitCode,
    };
  }
  const said = (stderr.trim() || stdout.trim()).slice(-800);
  return {
    ok: false,
    error: {
      code: "MM_NO_RESULT",
      message: said || `mm exited ${exitCode ?? "by signal"} without printing a result.`,
    },
    notices,
    exitCode,
  };
}

const SECRET_FLAGS = new Set(["--mnemonic", "--password", "--new", "--current", "--token"]);

/**
 * Why these arguments must not run through the agent, or null when they may.
 * The reason is written for the operator: it says what to do instead.
 */
export function refuseArgs(args: string[]): string | null {
  if (!args.length) {
    return "Name a command (e.g. ['wallet', 'balance']); `mm` with no arguments is an interactive shell.";
  }
  for (const arg of args) {
    const flag = arg.split("=")[0];
    if (SECRET_FLAGS.has(flag)) {
      return (
        `${flag} would put a secret on a command line and into my transcripts. ` +
        "Sign-in tokens go through metamask_login; a seed phrase or wallet password belongs in " +
        "MM_MNEMONIC / MM_PASSWORD in the host environment, or in `mm` run by the operator in a terminal."
      );
    }
  }
  const [topic, sub] = args;
  if (topic === "login") return "Sign-in goes through metamask_login (it handles the browser link and the CLI token).";
  if (topic === "reset") {
    return "`mm reset` wipes the local wallet state, including a bring-your-own-wallet seed. The operator runs it in a terminal if they mean it.";
  }
  if (topic === "wallet" && sub === "password") {
    return "Wallet passwords are set by the operator in a terminal (`mm wallet password set`), never through chat.";
  }
  if (topic === "plugins" && sub && !["inspect", "list"].includes(sub)) {
    return "Installing or updating `mm` plugins grants third-party code wallet permissions; the operator does that in a terminal, where the consent screen is.";
  }
  return null;
}

/** `mm` sub-commands that move funds or sign a spend, by topic; the rest only read. */
const FUND_MOVES: Record<string, ReadonlySet<string> | "all"> = {
  transfer: "all",
  swap: new Set(["execute"]),
  bridge: "all",
  // Typed data is how permits and orders are signed: a spend without a transaction.
  wallet: new Set(["send-transaction", "sign-typed-data"]),
  perps: new Set(["open", "close", "modify", "deposit", "withdraw", "cancel"]),
  predict: new Set(["setup", "deposit", "place", "redeem", "cancel", "withdraw"]),
  earn: new Set(["supply", "withdraw"]),
};

/** Whether this `mm` command (arguments after `mm`) moves funds — what paper mode keeps off. */
export function movesFunds(args: string[]): boolean {
  const [topic = "", sub = ""] = args;
  const moves = FUND_MOVES[topic];
  return moves === "all" || Boolean(moves?.has(sub));
}

/**
 * Polling ids of the server-wallet job a run submitted: from its data (a run
 * without `--wait`, a swap's pending job), its notices, or the hint of a wait
 * that timed out. Arrays are not searched — those are listings (`requests
 * list`, `tx history`) of jobs this run did not submit.
 */
export function pollingIds(result: MmResult): string[] {
  const found = new Set<string>();
  const walk = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || Array.isArray(value) || depth > 6) return;
    for (const [k, v] of Object.entries(value)) {
      if (k === "pollingId" && typeof v === "string" && v) found.add(v);
      else walk(v, depth + 1);
    }
  };
  walk(result.data, 0);
  for (const n of result.notices) walk(n, 0);
  const text = `${result.error?.message ?? ""} ${result.error?.hint ?? ""}`;
  for (const m of text.matchAll(/requests watch\s+`?([A-Za-z0-9_.:-]{6,})/g)) found.add(m[1]);
  return [...found];
}

/** Did this run stop on an out-of-band approval (email link / MetaMask Mobile push)? */
export function awaitingApproval(result: MmResult): boolean {
  const notice = result.notices.some((n) => /awaiting_mfa|AWAITING_MFA/.test(JSON.stringify(n)));
  const code = result.error?.code ?? "";
  return notice || ["JOB_TIMEOUT", "RELAY_TIMEOUT", "AWAITING_MFA"].includes(code);
}

/**
 * The child gets the host environment minus LainOS's own secrets (model keys,
 * the chain signer, bot tokens) — `mm` needs none of them. Its own `MM_*`
 * variables pass through.
 */
export function childEnv(base: NodeJS.ProcessEnv, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (!k.startsWith("MM_") && /(KEY|TOKEN|SECRET|MNEMONIC|COOKIE|PASSWORD|_PK$|PRIVATE)/i.test(k)) continue;
    env[k] = v;
  }
  return { ...env, ...extra, NO_COLOR: "1" };
}

export class MmCli {
  constructor(
    readonly bin: string,
    private readonly baseEnv: NodeJS.ProcessEnv = process.env,
  ) {}

  /** Run one command headless; never throws. */
  run(args: string[], opts: MmRunOptions = {}): Promise<MmResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise((resolveRun) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      const finish = (result: MmResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveRun(result);
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(this.bin, [...args, "--json"], {
          env: childEnv(this.baseEnv, opts.env),
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        finish(notInstalled(this.bin, err));
        return;
      }
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 3_000).unref?.();
      }, timeoutMs);
      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdout.length < STDOUT_CAP) stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-64_000);
      });
      child.on("error", (err) => finish(notInstalled(this.bin, err)));
      child.on("close", (code) => {
        if (timedOut) {
          const partial = parseEnvelope(stdout, stderr, code);
          finish({
            ok: false,
            error: {
              code: "MM_TIMEOUT",
              message: `mm ${args.slice(0, 2).join(" ")} was still running after ${Math.round(timeoutMs / 1000)}s and was stopped.`,
              hint: "A submitted job may still complete — check metamask_requests before sending it again.",
            },
            notices: partial.notices,
            exitCode: code,
          });
          return;
        }
        finish(parseEnvelope(stdout, stderr, code));
      });
    });
  }
}

function notInstalled(bin: string, err: unknown): MmResult {
  const code = (err as NodeJS.ErrnoException)?.code;
  return {
    ok: false,
    error: {
      code: code === "ENOENT" ? "MM_NOT_INSTALLED" : "MM_SPAWN_FAILED",
      message:
        code === "ENOENT"
          ? `The MetaMask Agent Wallet CLI (${bin}) is not installed on this host.`
          : `Could not start ${bin}: ${err instanceof Error ? err.message : String(err)}`,
      hint: INSTALL_HINT,
    },
    notices: [],
    exitCode: null,
  };
}
