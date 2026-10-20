import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { createLogger } from "../../logger.js";
import type {
  Action,
  ActionResult,
  IAgentRuntime,
  Plugin,
  Provider,
  Service,
  State,
} from "../../types.js";
import {
  awaitingApproval,
  INSTALL_HINT,
  MmCli,
  movesFunds,
  pollingIds,
  refuseArgs,
  type MmResult,
} from "./cli.js";

const log = createLogger("plugin:metamask");

/**
 * MetaMask Agent Wallet: a second wallet for Lain, held by MetaMask instead of
 * by her own key, on the mainstream EVM chains (Ethereum, Base, Arbitrum,
 * Robinhood Chain, …) and the venues MetaMask routes to (swaps and bridges,
 * Hyperliquid perps, Polymarket, yield vaults, x402 paywalls).
 *
 * Everything goes through the operator's own `mm` CLI (see cli.ts). Security
 * is MetaMask's, not ours: every transaction is simulated and threat-scanned,
 * and in Guard Mode anything outside the wallet's policy waits for the
 * operator's approval — an email link, or a MetaMask Mobile push. Lain cannot
 * approve those herself, so a job that stops on one is tracked here
 * (`data/metamask-jobs.json`) and its outcome is reported when it lands,
 * through onEvent, to the chat that asked for it.
 *
 * Setup follows the quickstart, headless: metamask_login hands out the
 * dashboard sign-in link and takes back the CLI token; metamask_setup picks
 * the wallet and trading mode; then fund the address and use it.
 */

export interface MetaMaskSnapshot {
  installed: boolean;
  version?: string;
  env?: string;
  authenticated: boolean;
  initialized: boolean;
  address?: string;
  walletMode?: string;
  tradingMode?: string;
  hints: string[];
  error?: string;
  checkedAt: number;
}

export interface TrackedJob {
  pollingId: string;
  /** What was asked, in words, for the report. */
  intent: string;
  chatId?: number;
  submittedAt: number;
  /** Ticks in a row the CLI no longer listed this job. */
  misses?: number;
}

export interface MetaMaskEvent {
  kind: "job";
  text: string;
  job: TrackedJob;
  chatId?: number;
}

interface JobsFile {
  jobs: TrackedJob[];
}

const DEFAULT_WALLET_TIMEOUT_S = 45;
const DEFAULT_POLL_MS = 30_000;
const SNAPSHOT_TTL_MS = 15 * 60_000;
const JOB_TTL_MS = 24 * 3_600_000;
const MAX_MISSES = 3;
const RESULT_CHARS = 5_000;

/** Final statuses of server-wallet jobs (transactions, signatures, mode changes). */
const DONE_OK = new Set(["CONFIRMED", "SIGNED", "APPROVED"]);
const DONE_FAILED = new Set(["DENIED", "EXPIRED", "FAILED", "BROADCAST_FAILED"]);
const DONE_UNKNOWN = new Set(["BROADCAST_TRACKING_EXPIRED", "CONFIRMATION_TRACKING_EXPIRED"]);

/** Chain names an operator says, to the ids `mm` takes. Unknown names pass through. */
const CHAIN_IDS: Record<string, number> = {
  ethereum: 1,
  eth: 1,
  mainnet: 1,
  base: 8453,
  arbitrum: 42161,
  arb: 42161,
  optimism: 10,
  op: 10,
  polygon: 137,
  matic: 137,
  bnb: 56,
  bsc: 56,
  avalanche: 43114,
  avax: 43114,
  linea: 59144,
  unichain: 130,
  zksync: 324,
  scroll: 534352,
  blast: 81457,
  mantle: 5000,
  opbnb: 204,
  celo: 42220,
  monad: 143,
  sei: 1329,
  hyperevm: 999,
  megaeth: 4326,
  hemi: 43111,
  robinhood: 4663,
  arc: 5042,
  sepolia: 11155111,
  "base-sepolia": 84532,
  "arbitrum-sepolia": 421614,
  "optimism-sepolia": 11155420,
};

/** "Base" → "8453", "eip155:1" and "8453" stay as they are. */
export function resolveChain(input: string): string {
  const key = input.trim().toLowerCase().replace(/\s+(chain|mainnet|one)$/, "").replace(/\s+/g, "-");
  if (/^\d+$/.test(key) || key.startsWith("eip155:")) return key;
  return CHAIN_IDS[key] !== undefined ? String(CHAIN_IDS[key]) : input.trim();
}

const MM_CHAINS = new Set(Object.values(CHAIN_IDS));

/**
 * The chain a tool uses when the operator names none: LAINOS_MM_CHAIN when
 * set, otherwise the active network (CHAIN_ID) when MetaMask supports it —
 * so on Robinhood "send 5 USDC" means Robinhood. Undefined means ask.
 */
export function defaultChain(get: (key: string) => string | undefined): string | undefined {
  const pinned = get("LAINOS_MM_CHAIN")?.trim();
  if (pinned) return resolveChain(pinned);
  const active = Number(get("CHAIN_ID"));
  return MM_CHAINS.has(active) ? String(active) : undefined;
}

/** "Robinhood Chain (4663)" — the active network's own name when it is that chain. */
function chainLabel(get: (key: string) => string | undefined, id: string): string {
  const name =
    get("CHAIN_ID") === id && get("CHAIN_NAME")
      ? get("CHAIN_NAME")
      : Object.keys(CHAIN_IDS).find((k) => String(CHAIN_IDS[k]) === id);
  return name ? `${name} (${id})` : `chain ${id}`;
}

/** Split a command line the model wrote as one string, honouring quotes. */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let has = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
    }
  }
  if (has || cur) out.push(cur);
  return out[0] === "mm" ? out.slice(1) : out;
}

/** The first `status` string in a result payload. */
function statusOf(value: unknown, depth = 0): string | undefined {
  if (!value || typeof value !== "object" || depth > 5) return undefined;
  if (Array.isArray(value)) {
    for (const v of value) {
      const s = statusOf(v, depth + 1);
      if (s) return s;
    }
    return undefined;
  }
  const rec = value as Record<string, unknown>;
  if (typeof rec.status === "string") return rec.status;
  for (const v of Object.values(rec)) {
    const s = statusOf(v, depth + 1);
    if (s) return s;
  }
  return undefined;
}

function hasTxHash(value: unknown): boolean {
  return /"(txHash|transactionHash|hash)":"0x[0-9a-fA-F]{64}"/.test(JSON.stringify(value ?? null));
}

/** A result as the model reads it: the payload as compact JSON, or the error with its hint. */
export function renderResult(result: MmResult, lead = ""): string {
  const head = lead ? `${lead}\n` : "";
  if (!result.ok) {
    const e = result.error!;
    // The CLI's hints name its own commands; say which tool does that here.
    const tool = /^(AUTH_FAILED|AUTH_ERROR|TOKEN_INVALID|TOKEN_REFRESH_FAILED)$/.test(e.code)
      ? " (sign in with metamask_login)"
      : e.code === "NOT_INITIALIZED"
        ? " (set up with metamask_setup)"
        : "";
    return `${head}mm failed — ${e.code}: ${e.message}${e.hint ? `\nhint: ${e.hint}${tool}` : tool}`;
  }
  const json = JSON.stringify(result.data ?? null);
  const body = json.length > RESULT_CHARS ? `${json.slice(0, RESULT_CHARS)}… [${json.length} chars]` : json;
  return `${head}${body}${result.hint ? `\nhint: ${result.hint}` : ""}`;
}

function intSetting(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = raw === undefined || raw === "" ? fallback : Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/** Is `bin` runnable — a path, or a name somewhere on PATH? */
async function findBinary(bin: string): Promise<boolean> {
  const candidates = bin.includes("/")
    ? [bin]
    : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, bin));
  for (const file of candidates) {
    try {
      await access(file, constants.X_OK);
      return true;
    } catch {
      /* next */
    }
  }
  return false;
}

export class MetaMaskService implements Service {
  readonly name = "metamask";

  cli = new MmCli("mm");
  walletTimeoutS = DEFAULT_WALLET_TIMEOUT_S;
  private installed = false;
  private snapshot: MetaMaskSnapshot | null = null;
  private refreshing: Promise<MetaMaskSnapshot> | null = null;
  private jobs: TrackedJob[] = [];
  private file = "";
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private subscribers = new Set<(event: MetaMaskEvent) => void>();

  async start(runtime: IAgentRuntime): Promise<void> {
    const bin = runtime.getSetting("LAINOS_MM_BIN") || "mm";
    // Its own session instead of the host's ~/.metamask (a second agent, a demo sandbox).
    const home = runtime.getSetting("LAINOS_MM_HOME");
    if (home) await mkdir(home, { recursive: true, mode: 0o700 });
    this.cli = new MmCli(bin, home ? { ...process.env, HOME: home } : process.env);
    this.walletTimeoutS = intSetting(
      runtime.getSetting("LAINOS_MM_WALLET_TIMEOUT"),
      DEFAULT_WALLET_TIMEOUT_S,
      5,
      600,
    );
    const dataDir = runtime.getSetting("LAINOS_DATA_DIR") ?? "./data";
    this.file = join(dataDir, "metamask-jobs.json");
    try {
      this.jobs = (JSON.parse(await readFile(this.file, "utf8")) as JobsFile).jobs ?? [];
    } catch {
      // Fresh store.
    }
    this.installed = await findBinary(bin);
    const poll = intSetting(runtime.getSetting("LAINOS_MM_POLL_MS"), DEFAULT_POLL_MS, 10_000, 3_600_000);
    this.timer = setInterval(() => void this.tick(), poll);
    this.timer.unref?.();
    if (this.installed) void this.refresh().catch(() => undefined);
    log.info(
      this.installed
        ? `MetaMask Agent Wallet via ${bin}: ${this.jobs.length} job(s) awaiting an outcome`
        : `MetaMask Agent Wallet CLI (${bin}) not found — metamask_status explains the install`,
    );
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  onEvent(fn: (event: MetaMaskEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  get isInstalled(): boolean {
    return this.installed;
  }

  get cached(): MetaMaskSnapshot | null {
    return this.snapshot;
  }

  listJobs(): TrackedJob[] {
    return [...this.jobs];
  }

  /** Run one `mm` command. `--wait` gets a bounded wallet timeout unless one was given. */
  async run(args: string[], env?: Record<string, string>): Promise<MmResult> {
    const full = [...args];
    if (full.includes("--wait") && !full.some((a) => a.startsWith("--wallet-timeout"))) {
      full.push("--wallet-timeout", String(this.walletTimeoutS));
    }
    const result = await this.cli.run(full, {
      timeoutMs: Math.max(180_000, (this.walletTimeoutS + 60) * 1_000),
      env,
    });
    if (result.error?.code === "MM_NOT_INSTALLED") this.installed = false;
    else if (result.exitCode !== null) this.installed = true;
    return result;
  }

  /** Doctor, then — when signed in and set up — the wallet and its modes. */
  async refresh(): Promise<MetaMaskSnapshot> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const snap: MetaMaskSnapshot = {
        installed: true,
        authenticated: false,
        initialized: false,
        hints: [],
        checkedAt: Date.now(),
      };
      const doctor = await this.run(["doctor"]);
      if (!doctor.ok) {
        snap.installed = doctor.error?.code !== "MM_NOT_INSTALLED";
        snap.error = `${doctor.error?.code}: ${doctor.error?.message}`;
        this.installed = snap.installed;
        return (this.snapshot = snap);
      }
      const d = (doctor.data ?? {}) as Record<string, unknown>;
      snap.version = typeof d.cli === "string" ? d.cli : undefined;
      snap.env = typeof d.env === "string" ? d.env : undefined;
      snap.authenticated = d.authenticated === true;
      snap.initialized = d.initialized === true;
      // The AI-skill hints are for coding agents; this plugin is Lain's skill.
      snap.hints = (Array.isArray(d.hints) ? d.hints : [])
        .map(String)
        .filter((h) => !/skill/i.test(h));
      if (snap.authenticated) {
        const [show, address] = await Promise.all([
          this.run(["init", "show"]),
          this.run(["wallet", "address"]),
        ]);
        if (show.ok) {
          const s = (show.data ?? {}) as Record<string, unknown>;
          if (typeof s.walletMode === "string") snap.walletMode = s.walletMode;
          if (typeof s.tradingMode === "string") snap.tradingMode = s.tradingMode;
        }
        if (address.ok) {
          const a = (address.data ?? {}) as Record<string, unknown>;
          if (typeof a.address === "string") snap.address = a.address;
        }
      }
      return (this.snapshot = snap);
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /**
   * Sign in with a CLI token and set the wallet up (server wallet, guard mode) in one go — what
   * the TUI's /metamask does, so the token never passes through a conversation. Returns the
   * line to show, or throws with what went wrong.
   */
  async connect(token: string): Promise<string> {
    if (!/^\S{8,}:\S{8,}$/.test(token)) {
      throw new Error("that doesn't look like a CLI token (cliToken:cliRefreshToken).");
    }
    const login = await this.run(["login"], { MM_CLI_TOKEN: token });
    if (!login.ok && login.error?.code !== "ALREADY_AUTHENTICATED") {
      throw new Error(`MetaMask did not accept the token: ${login.error?.message ?? "unknown error"}`);
    }
    let snap = await this.refresh();
    if (snap.authenticated && !snap.initialized) {
      const init = await this.run(["init", "--wallet", "server-wallet", "--mode", "guard"]);
      if (!init.ok) throw new Error(`signed in, but the wallet was not set up: ${init.error?.message}`);
      snap = await this.refresh();
    }
    return (login.ok ? "signed in. " : "already signed in — /metamask logout first to switch. ") + describeSnapshot(snap);
  }

  async logout(): Promise<string> {
    const res = await this.run(["logout"]);
    const snap = await this.refresh();
    return res.ok ? `signed out. ${describeSnapshot(snap)}` : renderResult(res);
  }

  /** The cached snapshot, refreshed in the background when stale. */
  current(): MetaMaskSnapshot | null {
    if (this.installed && (!this.snapshot || Date.now() - this.snapshot.checkedAt > SNAPSHOT_TTL_MS)) {
      void this.refresh().catch(() => undefined);
    }
    return this.snapshot;
  }

  /**
   * Remember the jobs of a result that has not finished — it waits on the
   * operator's approval, or its wait ran out — so the outcome gets reported.
   * Returns the ids now tracked.
   */
  async track(result: MmResult, intent: string, chatId?: number): Promise<string[]> {
    const ids = pollingIds(result);
    if (!ids.length) return [];
    const status = statusOf(result.data);
    const finished =
      result.ok &&
      ((status && (DONE_OK.has(status) || DONE_FAILED.has(status))) || (!status && hasTxHash(result.data)));
    if (finished && !awaitingApproval(result)) return [];
    const added: string[] = [];
    for (const pollingId of ids) {
      if (this.jobs.some((j) => j.pollingId === pollingId)) continue;
      this.jobs.push({ pollingId, intent, chatId, submittedAt: Date.now() });
      added.push(pollingId);
    }
    if (added.length) await this.persist();
    return added;
  }

  /** One sweep over the tracked jobs: report and forget the ones that ended. */
  async tick(): Promise<void> {
    if (this.busy || !this.jobs.length || !this.installed) return;
    this.busy = true;
    try {
      const listed = await this.run(["wallet", "requests", "list"]);
      if (!listed.ok) {
        log.warn(`requests list failed: ${listed.error?.code} ${listed.error?.message}`);
        return;
      }
      const requests = ((listed.data as { requests?: unknown[] })?.requests ?? []) as Record<string, unknown>[];
      const keep: TrackedJob[] = [];
      for (const job of this.jobs) {
        const rec = requests.find((r) => r.pollingId === job.pollingId);
        const status = typeof rec?.status === "string" ? rec.status : undefined;
        if (!rec) {
          job.misses = (job.misses ?? 0) + 1;
          if (job.misses >= MAX_MISSES || Date.now() - job.submittedAt > JOB_TTL_MS) {
            this.emit(job, `🦊 lost track of "${job.intent}" (${job.pollingId}) — check \`mm tx history\` for how it ended.`);
          } else {
            keep.push(job);
          }
          continue;
        }
        job.misses = 0;
        if (status && (DONE_OK.has(status) || DONE_FAILED.has(status) || DONE_UNKNOWN.has(status))) {
          this.emit(job, describeOutcome(job, status, rec));
        } else if (Date.now() - job.submittedAt > JOB_TTL_MS) {
          this.emit(job, `🦊 "${job.intent}" is still ${status ?? "pending"} after a day — I stopped watching it (${job.pollingId}).`);
        } else {
          keep.push(job);
        }
      }
      this.jobs = keep;
      await this.persist();
    } finally {
      this.busy = false;
    }
  }

  private emit(job: TrackedJob, text: string): void {
    log.info(text);
    for (const fn of this.subscribers) {
      try {
        fn({ kind: "job", text, job, chatId: job.chatId });
      } catch {
        /* a broken subscriber must never break the watcher */
      }
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const payload: JobsFile = { jobs: this.jobs };
    await writeFile(this.file, JSON.stringify(payload, null, 2), "utf8");
  }
}

function describeOutcome(job: TrackedJob, status: string, rec: Record<string, unknown>): string {
  const tx = typeof rec.txHash === "string" ? ` tx ${rec.txHash}` : "";
  const why = typeof rec.failureReason === "string" ? ` — ${rec.failureReason}` : "";
  if (DONE_OK.has(status)) return `🦊 done: ${job.intent} (${status.toLowerCase()}).${tx}`;
  if (status === "DENIED") return `🦊 declined at approval: ${job.intent}. Nothing was sent.`;
  if (status === "EXPIRED") return `🦊 the approval for "${job.intent}" expired unanswered. Nothing was sent.`;
  if (DONE_FAILED.has(status)) return `🦊 failed: ${job.intent} (${status})${why}.${tx}`;
  return `🦊 "${job.intent}" was sent but its confirmation could not be tracked (${status}).${tx} Check \`mm tx history\`.`;
}

// ------------------------------------------------------------------ helpers

function getMetaMask(runtime: IAgentRuntime): MetaMaskService {
  const svc = runtime.getService<MetaMaskService>("metamask");
  if (!svc) throw new Error("metamask service not started");
  return svc;
}

function chatIdFromState(state: State): number | undefined {
  if (!state.roomId.startsWith("tg-")) return undefined;
  const id = Number(state.roomId.slice(3));
  return Number.isFinite(id) ? id : undefined;
}

async function ready(runtime: IAgentRuntime): Promise<boolean> {
  return Boolean(runtime.getService<MetaMaskService>("metamask")?.isInstalled);
}

/**
 * Paper mode means no real trade from any wallet, and a MetaMask route cannot
 * be simulated — so while it is on, a money tool answers at once, before `mm`
 * runs, with where the paper trade goes instead.
 */
function paperRefusal(runtime: IAgentRuntime): ActionResult | null {
  if (!runtime.getService<{ paperMode?: boolean } & Service>("chain")?.paperMode) return null;
  return {
    ok: false,
    text:
      "Paper mode is on, so the MetaMask wallet moves nothing — nothing was sent to MetaMask. Trade on paper instead: " +
      "paper_trading mode swap for the paper coins (e.g. asset SOL, to USDC, amount 1), buy_token / sell_token for tokens on the chain DEX. " +
      "A real MetaMask trade needs paper mode off, which is the operator's call.",
  };
}

function str(v: unknown): string {
  return v === undefined || v === null ? "" : String(v).trim();
}

/**
 * The sentence that says where setup stands and what comes next. `signIn` is the next step when
 * nobody is signed in: the tool for the model, the command for a person at the TUI.
 */
export function describeSnapshot(s: MetaMaskSnapshot, signIn = "metamask_login gives the sign-in link"): string {
  if (!s.installed) return `The MetaMask Agent Wallet CLI is not installed here. ${INSTALL_HINT}`;
  if (s.error) return `MetaMask Agent Wallet CLI is installed but \`mm doctor\` failed — ${s.error}.`;
  const cli = `mm ${s.version ?? "?"}${s.env && s.env !== "prod" ? `, ${s.env}` : ""}`;
  if (!s.authenticated) {
    return `MetaMask Agent Wallet (${cli}): not signed in. Next: ${signIn}.`;
  }
  if (!s.initialized) {
    return `MetaMask Agent Wallet (${cli}): signed in, wallet not set up. Next: metamask_setup (server wallet + guard mode is the recommended choice).`;
  }
  const mode = s.walletMode === "byok" ? "bring-your-own wallet" : "server wallet";
  const trading = s.tradingMode ? `, ${s.tradingMode} mode` : "";
  return `MetaMask Agent Wallet (${cli}): ready — ${mode} ${s.address ?? "(address unknown)"}${trading}.`;
}

/** Run a money command, track it when it waits on the operator, and word the result. */
async function moneyResult(
  svc: MetaMaskService,
  state: State,
  args: string[],
  intent: string,
): Promise<ActionResult> {
  const result = await svc.run(args);
  const tracked = await svc.track(result, intent, chatIdFromState(state));
  if (tracked.length && awaitingApproval(result)) {
    return {
      ok: true,
      text:
        `"${intent}" is waiting for the operator's approval (email link for browser sign-in, ` +
        `MetaMask Mobile push for QR sign-in). I'll report the outcome when it lands — do not submit it again. ` +
        `polling id ${tracked.join(", ")}`,
      data: { pollingIds: tracked, awaitingApproval: true },
    };
  }
  const lead = tracked.length
    ? `submitted, still running — I'll report the outcome when it lands (polling id ${tracked.join(", ")}). Do not submit it again.`
    : "";
  return { ok: result.ok, text: renderResult(result, lead), ...(tracked.length ? { data: { pollingIds: tracked } } : {}) };
}

// ------------------------------------------------------------------ actions

const SEPARATE =
  "This is the MetaMask Agent Wallet — a wallet held by MetaMask, separate from your own chain wallet (check_balance / send_native / buy_token).";

const metamaskStatusAction: Action = {
  name: "metamask_status",
  similes: ["metamask_wallet", "agent_wallet_status", "mm_doctor", "metamask_address"],
  description:
    `Where MetaMask Agent Wallet stands: CLI installed, signed in, wallet set up, its address, wallet mode (server / bring-your-own) and trading mode (guard / beast), and the next setup step. ${SEPARATE} Use first when the operator asks to set up or use MetaMask / the agent wallet, or asks for its address.`,
  parameters: { type: "object", properties: {} },
  examples: [
    { user: "set up the metamask agent wallet", agent: "checking where it stands…" },
    { user: "what's your metamask address?", agent: "0x… — server wallet, guard mode." },
  ],
  async validate(runtime) {
    return Boolean(runtime.getService("metamask"));
  },
  async handler(runtime) {
    const svc = getMetaMask(runtime);
    const snap = await svc.refresh();
    const pending = svc.listJobs();
    const lines = [describeSnapshot(snap)];
    if (snap.hints.length) lines.push(`mm hints: ${snap.hints.join(" ")}`);
    if (pending.length) {
      lines.push(`awaiting outcome: ${pending.map((j) => `${j.intent} (${j.pollingId})`).join("; ")}`);
    }
    if (snap.initialized && snap.address) {
      lines.push("Fund it by sending tokens to that address on a supported chain; metamask_balance shows what arrived.");
    }
    return { ok: snap.installed && !snap.error, text: lines.join("\n"), data: { ...snap, pendingJobs: pending.length } };
  },
};

const metamaskLoginAction: Action = {
  name: "metamask_login",
  operatorOnly: true,
  similes: ["mm_login", "metamask_sign_in", "agent_wallet_login"],
  description:
    "Sign in to MetaMask Agent Wallet. In the TUI, tell the operator to type `/metamask <token>` instead: it is masked and never reaches you or the history. Otherwise, in two calls. Without a token: returns the dashboard link — the operator opens it, signs in with Google or email, clicks Authorize and copies the CLI token. With token: completes sign-in with that token (format cliToken:cliRefreshToken) and reports the wallet. Google, email and MetaMask Mobile each have a DIFFERENT wallet address — tell the operator to keep using the same method. MetaMask Mobile QR sign-in needs a terminal: the operator runs `mm login qr` on the host.",
  parameters: {
    type: "object",
    properties: {
      token: {
        type: "string",
        description: "The CLI token the operator copied from the dashboard after Authorize. Omit to get the sign-in link.",
      },
    },
  },
  examples: [
    { user: "log in to metamask", agent: "open this link, sign in, press Authorize and send me the CLI token it shows." },
    { user: "here's the token: abc…:def…", agent: "signed in. wallet 0x…" },
  ],
  validate: ready,
  async handler(runtime, _state, params) {
    const svc = getMetaMask(runtime);
    const token = str(params.token).replace(/^`|`$/g, "");
    if (!token) {
      const res = await svc.run(["login", "browser", "--no-wait"]);
      if (!res.ok) {
        if (res.error?.code === "ALREADY_AUTHENTICATED") {
          return { ok: true, text: `Already signed in.\n${describeSnapshot(await svc.refresh())}` };
        }
        return { ok: false, text: renderResult(res) };
      }
      const url = str((res.data as Record<string, unknown>)?.loginUrl);
      return {
        ok: Boolean(url),
        text:
          `Sign-in link: ${url}\n` +
          "Steps for the operator: open it → Continue with Google or Continue with email → Authorize → copy the CLI token " +
          "and send it here (then call metamask_login with it). The same sign-in method must be used every time: " +
          "Google, email and MetaMask Mobile each open a different wallet.",
        data: { loginUrl: url },
      };
    }
    if (!/^\S{8,}:\S{8,}$/.test(token)) {
      return { ok: false, text: "That doesn't look like a CLI token — it has the form cliToken:cliRefreshToken (two parts joined by a colon)." };
    }
    // Lets transcript and tool-output redaction mask the token (the key names
    // a secret); the child env drops it, `mm` gets it as MM_CLI_TOKEN below.
    process.env.LAINOS_MM_LOGIN_TOKEN = token;
    const res = await svc.run(["login"], { MM_CLI_TOKEN: token });
    if (!res.ok && res.error?.code !== "ALREADY_AUTHENTICATED") return { ok: false, text: renderResult(res) };
    const snap = await svc.refresh();
    const already = res.ok ? "Signed in." : "Already signed in (log out first to switch accounts).";
    return { ok: true, text: `${already}\n${describeSnapshot(snap)}`, data: { ...snap } };
  },
};

const metamaskSetupAction: Action = {
  name: "metamask_setup",
  operatorOnly: true,
  similes: ["mm_init", "metamask_init", "agent_wallet_setup", "metamask_trading_mode"],
  description:
    "Set up the MetaMask Agent Wallet after sign-in (`mm init`): wallet mode server-wallet (recommended — keys held by MetaMask in a TEE, an agent wallet of its own) or byok (an existing seed phrase; only when the host has MM_MNEMONIC set), and for a server wallet the trading mode: guard (recommended — network/recipient allowlists, a rolling 24h outflow limit, and approval for anything outside the policy) or beast (only threat scanning). On an already set-up server wallet, changing trading_mode switches it (the operator must approve the switch).",
  parameters: {
    type: "object",
    properties: {
      wallet: { type: "string", enum: ["server-wallet", "byok"], description: "Default server-wallet." },
      trading_mode: { type: "string", enum: ["guard", "beast"], description: "Server wallet only. Default guard." },
    },
  },
  examples: [
    { user: "set it up as a server wallet in guard mode", agent: "done — server wallet 0x…, guard mode." },
    { user: "switch the agent wallet to beast mode", agent: "requested — approve the switch in your email." },
  ],
  validate: ready,
  async handler(runtime, state, params) {
    const svc = getMetaMask(runtime);
    const wallet = str(params.wallet) || "server-wallet";
    const mode = str(params.trading_mode) || "guard";
    if (!["server-wallet", "byok"].includes(wallet)) return { ok: false, text: "wallet is server-wallet or byok." };
    if (!["guard", "beast"].includes(mode)) return { ok: false, text: "trading_mode is guard or beast." };
    const before = await svc.refresh();
    if (!before.authenticated) return { ok: false, text: describeSnapshot(before) };

    if (before.initialized) {
      if (wallet === "server-wallet" && before.walletMode !== "byok" && before.tradingMode !== mode) {
        // A mode change is approved like a flagged transaction but is not a
        // wallet job, so there is nothing to track: the next status shows it.
        const res = await svc.run(["wallet", "trading-mode", "set", mode, "--no-wait"]);
        const pending = res.ok && /pending/i.test(statusOf(res.data) ?? "");
        return {
          ok: res.ok,
          text: renderResult(
            res,
            pending
              ? `Switch to ${mode} mode requested — it takes effect once the operator approves it (email link or MetaMask Mobile push).`
              : "",
          ),
        };
      }
      return { ok: true, text: `Already set up.\n${describeSnapshot(before)}` };
    }
    if (wallet === "byok" && !process.env.MM_MNEMONIC) {
      return {
        ok: false,
        text:
          "A bring-your-own wallet needs the seed phrase, and a seed phrase never goes through chat. The operator either " +
          "sets MM_MNEMONIC in the host environment and restarts me, or runs `mm init --wallet byok` in a terminal.",
      };
    }
    const args = ["init", "--wallet", wallet, ...(wallet === "server-wallet" ? ["--mode", mode] : [])];
    const res = await svc.run(args);
    if (!res.ok) return { ok: false, text: renderResult(res) };
    const snap = await svc.refresh();
    const synced = (res.data as Record<string, unknown>)?.rehydrated
      ? " Existing wallets on this account were synced, so their trading mode was kept."
      : "";
    return {
      ok: true,
      text: `${describeSnapshot(snap)}${synced}\nNext: fund ${snap.address ?? "the address"} on a supported chain.`,
      data: { ...snap },
    };
  },
};

const metamaskBalanceAction: Action = {
  name: "metamask_balance",
  similes: ["mm_balance", "agent_wallet_balance", "metamask_portfolio"],
  description: `Token balances of the MetaMask Agent Wallet across its chains, priced in fiat. ${SEPARATE}`,
  parameters: {
    type: "object",
    properties: {
      chains: { type: "string", description: "Optional chain filter: names or ids, comma-separated (e.g. 'base,arbitrum' or '1,8453')." },
      token: { type: "string", description: "Optional token filter: symbol or 0x address." },
      currency: { type: "string", description: "Fiat for prices, e.g. usd (default) or eur." },
    },
  },
  examples: [{ user: "how much USDC is on the metamask wallet?", agent: "reading the agent wallet…" }],
  validate: ready,
  async handler(runtime, _state, params) {
    const svc = getMetaMask(runtime);
    const args = ["wallet", "balance"];
    const chains = str(params.chains);
    if (chains) args.push("--chain-ids", chains.split(",").map(resolveChain).join(","));
    if (str(params.token)) args.push("--token", str(params.token));
    if (str(params.currency)) args.push("--currency", str(params.currency).toLowerCase());
    const res = await svc.run(args);
    return { ok: res.ok, text: renderResult(res) };
  },
};

const metamaskSendAction: Action = {
  name: "metamask_send",
  operatorOnly: true,
  similes: ["mm_transfer", "metamask_transfer", "agent_wallet_send"],
  description:
    `Send native currency or an ERC-20 from the MetaMask Agent Wallet to an address on one EVM chain (\`mm transfer\`). MetaMask simulates and threat-scans it; outside the wallet's policy it waits for the operator's approval, and I report the outcome when it lands. ERC-20 sends go gasless when the wallet has no gas. ${SEPARATE}`,
  parameters: {
    type: "object",
    properties: {
      to: { type: "string", description: "Recipient 0x address (ENS is not supported)." },
      amount: { type: "string", description: "Human-readable amount, e.g. '10' or '0.05'." },
      token: { type: "string", description: "'native', a symbol (USDC) or an ERC-20 0x address." },
      chain: {
        type: "string",
        description: "Chain name or id: robinhood, ethereum, base, arbitrum, optimism, polygon, bnb, … or 4663. Defaults to the active network.",
      },
    },
    required: ["to", "amount", "token"],
  },
  examples: [{ user: "send 10 USDC to 0xabc… on base from the metamask wallet", agent: "sending through MetaMask…" }],
  validate: ready,
  async handler(runtime, state, params) {
    const paper = paperRefusal(runtime);
    if (paper) return paper;
    const svc = getMetaMask(runtime);
    const to = str(params.to);
    const amount = str(params.amount);
    const token = str(params.token) || "native";
    const chain = str(params.chain) ? resolveChain(str(params.chain)) : defaultChain((k) => runtime.getSetting(k));
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) return { ok: false, text: "Recipient must be a 0x address (ENS isn't supported by mm)." };
    if (!amount) return { ok: false, text: "I need the amount." };
    if (!chain) return { ok: false, text: "Which chain? The active network isn't one MetaMask supports." };
    const args = ["transfer", "--to", to, "--amount", amount, "--token", token, "--chain-id", chain, "--wait"];
    return moneyResult(svc, state, args, `send ${amount} ${token} to ${to} on chain ${chain}`);
  },
};

const metamaskSwapAction: Action = {
  name: "metamask_swap",
  operatorOnly: true,
  similes: ["mm_swap", "metamask_bridge", "agent_wallet_swap", "metamask_trade"],
  description:
    `Swap or bridge tokens with the MetaMask Agent Wallet. Two steps: give from/to/amount/chain to get the best quote (with its quote_id, output, fees and route); then call again with only quote_id to execute that quote. When the operator already asked for the swap outright, execute the quote in the same turn. Set to_chain for a cross-chain bridge. ${SEPARATE}`,
  parameters: {
    type: "object",
    properties: {
      from: { type: "string", description: "Token to sell: symbol, 0x address or 'native'." },
      to: { type: "string", description: "Token to buy: symbol, 0x address or 'native'." },
      amount: { type: "string", description: "Amount of `from` to sell, human-readable." },
      chain: { type: "string", description: "Source chain name or id. Defaults to the active network." },
      to_chain: { type: "string", description: "Destination chain for a bridge; omit for a same-chain swap." },
      slippage: { type: "number", description: "Max slippage in percent (default 0.5)." },
      quote_id: { type: "string", description: "Execute this quote (from the quote step). Pass alone." },
    },
  },
  examples: [
    { user: "swap 0.1 ETH to USDC on base with the metamask wallet", agent: "quoting… executing the best route…" },
  ],
  validate: ready,
  async handler(runtime, state, params) {
    // Even the quote: in paper mode it leads nowhere, and `mm` may take minutes to say so.
    const paper = paperRefusal(runtime);
    if (paper) return paper;
    const svc = getMetaMask(runtime);
    const quoteId = str(params.quote_id);
    if (quoteId) {
      const args = ["swap", "execute", "--quote-id", quoteId, "--wallet-timeout", String(svc.walletTimeoutS)];
      return moneyResult(svc, state, args, `execute swap quote ${quoteId}`);
    }
    const from = str(params.from);
    const to = str(params.to);
    const amount = str(params.amount);
    const chain = str(params.chain) ? resolveChain(str(params.chain)) : defaultChain((k) => runtime.getSetting(k));
    if (!from || !to || !amount || !chain) {
      return { ok: false, text: "For a quote I need from, to, amount and chain (or a quote_id to execute)." };
    }
    const args = ["swap", "quote", "--from", from, "--to", to, "--amount", amount, "--from-chain-id", chain];
    if (str(params.to_chain)) args.push("--to-chain-id", resolveChain(str(params.to_chain)));
    const slippage = Number(params.slippage);
    if (params.slippage !== undefined && Number.isFinite(slippage)) args.push("--slippage", String(slippage));
    const res = await svc.run(args);
    const unavailable = res.ok && (res.data as Record<string, unknown>)?.kind === "unavailable";
    return {
      ok: res.ok && !unavailable,
      text: renderResult(res, unavailable ? "no route — adjust amount, slippage or token and quote again:" : "quote (execute with metamask_swap quote_id):"),
    };
  },
};

const metamaskRequestsAction: Action = {
  name: "metamask_requests",
  similes: ["mm_requests", "metamask_pending", "metamask_approvals"],
  description:
    "MetaMask Agent Wallet jobs and their status — the ones waiting on the operator's approval (email link / MetaMask Mobile push), signing, broadcast or done — plus which of them I'm watching to report. Use before re-sending anything that may still be pending.",
  parameters: {
    type: "object",
    properties: { polling_id: { type: "string", description: "Only this job." } },
  },
  examples: [{ user: "did my metamask transfer go through?", agent: "checking the pending requests…" }],
  validate: ready,
  async handler(runtime, _state, params) {
    const svc = getMetaMask(runtime);
    const res = await svc.run(["wallet", "requests", "list"]);
    if (!res.ok) return { ok: false, text: renderResult(res) };
    const id = str(params.polling_id);
    let requests = ((res.data as { requests?: unknown[] })?.requests ?? []) as Record<string, unknown>[];
    if (id) requests = requests.filter((r) => r.pollingId === id);
    const watching = svc.listJobs();
    const text =
      (requests.length ? JSON.stringify(requests).slice(0, RESULT_CHARS) : id ? `no request ${id}.` : "no wallet requests.") +
      (watching.length ? `\nwatching to report: ${watching.map((j) => `${j.pollingId} (${j.intent})`).join("; ")}` : "");
    return { ok: true, text };
  },
};

const metamaskCliAction: Action = {
  name: "metamask",
  operatorOnly: true,
  similes: ["mm", "mm_cli", "metamask_cli", "agent_wallet"],
  description:
    "Run any MetaMask Agent Wallet CLI command (`mm …`, JSON output) for what the dedicated metamask_* tools don't cover. Pass the arguments after `mm`. Surface: " +
    "`chains list`; `wallet list|select <addr>|show|address|add-fund|trading-mode get|policy get|policy template|policy set --policy <yaml> --no-wait|sign-message --message <t> --chain-id <id> --wait|sign-typed-data|send-transaction --chain-id <id> --payload '<json>' --intent <text> --wait`; " +
    "`tx history [--chain-ids] [--type in|out] [--limit]`, `tx --hash <h>`; `decode <calldata>`; " +
    "`price spot --asset-ids eip155:1,eip155:8453/erc20:0x…`, `price history --chain-id eip155:1 --time-period 7d`; `token list search <q> --chain-ids 1,8453`, `token list trending|popular|top-gainer --chain-id <id>`; " +
    "`swap status --quote-id <id>`; perps on Hyperliquid: `perps balance|positions|orders|markets --symbol BTC|quote|open --symbol BTC --side long --size <usd> --leverage 5 --yes|close --symbol BTC --yes|modify --symbol BTC --tp <px> --sl <px> --yes|deposit --amount <usdc>|withdraw --amount <usdc>`; " +
    "Polymarket: `predict setup|deposit|balance|portfolio|markets search <q>|markets get <slug>|quote|place|orders|positions|redeem|history`; yield: `earn markets --chain-id <id> --token USDC --sort apy|positions|supply --token USDC --amount <n> --chain-id <id> --wait|withdraw --token USDC --chain-id <id> --all`; " +
    "`logout`; `config get`. Add --yes where a command confirms (perps); `<cmd> --help` lists flags. Login, reset, wallet passwords and plugin installs are the operator's, in a terminal.",
  parameters: {
    type: "object",
    properties: {
      args: {
        type: "array",
        items: { type: "string" },
        description: "Arguments after `mm`, one per element, e.g. [\"perps\", \"positions\"].",
      },
      intent: { type: "string", description: "For anything that moves funds or signs: what it does, in a few words (shown in reports)." },
    },
    required: ["args"],
  },
  examples: [
    { user: "open a 5x long on BTC with $100 on hyperliquid", agent: "quoting the position… opening it." },
    { user: "what's trending on base?", agent: "pulling MetaMask's trending tokens for Base…" },
  ],
  validate: ready,
  async handler(runtime, state, params) {
    const svc = getMetaMask(runtime);
    const raw = params.args;
    const args = (Array.isArray(raw) ? raw.map(String) : splitArgs(str(raw))).filter((a) => a !== "--json");
    if (args[0] === "mm") args.shift();
    const refusal = refuseArgs(args);
    if (refusal) return { ok: false, text: refusal };
    const paper = movesFunds(args) ? paperRefusal(runtime) : null;
    if (paper) return paper;
    const intent = str(params.intent) || `mm ${args.slice(0, 3).join(" ")}`;
    return moneyResult(svc, state, args, intent);
  },
};

// ------------------------------------------------------------------ provider

const metamaskProvider: Provider = {
  name: "metamask",
  async get(runtime) {
    const svc = runtime.getService<MetaMaskService>("metamask");
    if (!svc?.isInstalled) return "";
    const snap = svc.current();
    if (!snap) return "";
    const pending = svc.listJobs().length;
    const paper = runtime.getService<{ paperMode?: boolean } & Service>("chain")?.paperMode
      ? " Paper mode is on, so it moves nothing now: paper trades go through paper_trading, buy_token and sell_token."
      : "";
    const base = describeSnapshot(snap) + paper;
    if (!snap.initialized) return base;
    const get = (k: string) => runtime.getSetting(k);
    const chain = defaultChain(get);
    const active = get("CHAIN_ID");
    // On a network MetaMask covers where her own DEX is not configured,
    // MetaMask is the only way she can swap there — say so, or "buy X"
    // dead-ends in buy_token. Not in paper mode: there it would lead her off paper.
    const swapsHere =
      !paper && chain && chain === active && !get("CHAIN_DEX_ROUTER")
        ? ` Your own DEX is not configured on ${chainLabel(get, chain)}, so swaps there go through metamask_swap.`
        : "";
    return (
      `${base} It is separate from your own chain wallet: use the metamask_* tools for it ` +
      `(swaps and bridges, Hyperliquid perps, Polymarket, yield vaults, prices, tx history via \`metamask\`).` +
      (chain ? ` Its default chain is ${chainLabel(get, chain)}; pass that id to \`metamask\` commands that take --chain-id.` : "") +
      swapsHere +
      (pending ? ` ${pending} job(s) await the operator's approval or confirmation — reported when they land.` : "")
    );
  },
};

export const metamaskPlugin: Plugin = {
  name: "metamask",
  description:
    "MetaMask Agent Wallet through the operator's `mm` CLI: sign-in and setup, balances, transfers, swaps and bridges, perps, prediction markets, yield — every transaction simulated, threat-scanned and policy-checked by MetaMask, approvals reported back when they land.",
  services: [new MetaMaskService()],
  providers: [metamaskProvider],
  actions: [
    metamaskStatusAction,
    metamaskLoginAction,
    metamaskSetupAction,
    metamaskBalanceAction,
    metamaskSendAction,
    metamaskSwapAction,
    metamaskRequestsAction,
    metamaskCliAction,
  ],
};
