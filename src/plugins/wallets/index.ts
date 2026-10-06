/**
 * The wallets plugin: analytics over a list of addresses.
 *
 *   wallets_snapshot — native balance and every token each wallet holds, with
 *                      totals; saved as JSON + CSV in the workspace and, on
 *                      request, sent to the operator's Telegram with explorer
 *                      links. Long scans can run in the background.
 *
 * The background half — following the same list for every change — is the
 * sentinel's `watch_wallets`; both read lists the same way (lists.ts) and the
 * chain the same way (chainread.ts), on any known network, not only the
 * active one.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isAddress, type Address } from "viem";
import { createLogger } from "../../logger.js";
import type { Action, IAgentRuntime, Plugin, Provider } from "../../types.js";
import { currentProfile, findNetwork, networkClient, slug, type NetworkProfile } from "../chain/networks.js";
import { walletsFromParams } from "../sentinel/index.js";
import { safePath, workspaceRoot } from "../system/index.js";
import { sendToOperator } from "../telegram/index.js";
import { rpcWalletSource } from "./chainread.js";
import { formatSnapshot, snapshotCsv, snapshotJson, takeSnapshot, TokenCache, type Snapshot } from "./snapshot.js";

export * from "./lists.js";
export * from "./chainread.js";
export * from "./snapshot.js";
export * from "./watch.js";

const log = createLogger("plugin:wallets");

/**
 * Discovery look-back. On a 0.1 s-block L2 two days are ~1.7M blocks — about
 * two minutes for the LAIN top-100 on the public RPC (a few of them are bots
 * receiving a quarter-million transfers a week). Anything longer runs in the
 * background on its own; the cache makes every later run quick.
 */
const DEFAULT_DAYS = 2;
/** Longer look-backs than this never block a turn. */
const INLINE_MAX_DAYS = 2;

/** Resolve token symbols against a profile's registry; addresses pass through. */
export function resolveTokens(profile: NetworkProfile, raw: unknown): { tokens: Address[]; unknown: string[] } {
  const registry = new Map<string, Address>();
  for (const entry of (profile.tokens ?? "").split(",")) {
    const [sym, addr] = entry.split(":").map((p) => p?.trim());
    if (sym && addr && isAddress(addr)) registry.set(sym.toUpperCase(), addr as Address);
  }
  const list = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" && raw ? raw.split(",") : [];
  const tokens: Address[] = [];
  const unknown: string[] = [];
  for (const t of list.map((x) => x.trim()).filter(Boolean)) {
    if (isAddress(t)) tokens.push(t as Address);
    else if (registry.has(t.toUpperCase())) tokens.push(registry.get(t.toUpperCase())!);
    else unknown.push(t);
  }
  return { tokens, unknown };
}

function registryTokens(profile: NetworkProfile): Address[] {
  return resolveTokens(profile, (profile.tokens ?? "").split(",").map((e) => e.split(":")[0])).tokens;
}

/** Blocks per day, estimated from the head and a block a day back — chains differ by 100×. */
async function blocksPerDay(profile: NetworkProfile): Promise<bigint> {
  const client = networkClient(profile);
  const head = await client.getBlock();
  const probe = head.number > 100_000n ? head.number - 100_000n : 0n;
  const back = await client.getBlock({ blockNumber: probe });
  const secs = Number(head.timestamp - back.timestamp);
  if (secs <= 0) return 86_400n;
  return BigInt(Math.max(1, Math.round((Number(head.number - back.number) * 86_400) / secs)));
}

export interface SnapshotJob {
  id: string;
  title: string;
  network: string;
  startedAt: number;
  status: "running" | "done" | "failed";
  progress?: string;
  result?: string;
  files?: string[];
}

const jobs: SnapshotJob[] = [];

export function snapshotJobs(): SnapshotJob[] {
  return [...jobs];
}

export interface RunInput {
  runtime: IAgentRuntime;
  profile: NetworkProfile;
  params: Record<string, unknown>;
  title: string;
  job?: SnapshotJob;
}

export async function runSnapshot(input: RunInput): Promise<{ snapshot: Snapshot; files: string[]; telegram?: string; summary: string }> {
  const { runtime, profile, params, title, job } = input;
  const { wallets, error } = await walletsFromParams(params);
  if (error) throw new Error(error);
  if (!wallets.length) throw new Error("no wallets: give addresses or a file of them");

  const source = rpcWalletSource(profile);
  let fromBlock: bigint;
  if (params.from_block !== undefined && params.from_block !== "") {
    fromBlock = BigInt(Math.max(0, Math.floor(Number(params.from_block))));
  } else {
    const days = params.days !== undefined ? Number(params.days) : DEFAULT_DAYS;
    const head = await source.head();
    const span = BigInt(Math.round(Math.max(0.01, days) * Number(await blocksPerDay(profile))));
    fromBlock = head > span ? head - span : 0n;
  }

  const extra = resolveTokens(profile, params.tokens);
  const focus = params.focus ? resolveTokens(profile, [String(params.focus)]).tokens[0] : registryTokens(profile)[0];
  const cache = await new TokenCache(join(runtime.getSetting("LAINOS_DATA_DIR") || "./data", "wallets-cache.json")).load();

  const snapshot = await takeSnapshot({
    profile,
    wallets,
    source,
    fromBlock,
    extraTokens: [...registryTokens(profile), ...extra.tokens, ...(focus ? [focus] : [])],
    cache,
    onProgress: (msg) => {
      if (job) job.progress = msg;
      log.info(`${title}: ${msg}`);
    },
  });
  if (extra.unknown.length) snapshot.notes.push(`unknown token symbols on ${profile.name}: ${extra.unknown.join(", ")} — pass their 0x addresses.`);

  const report = formatSnapshot(snapshot, { focus, title });
  const stamp = snapshot.takenAt.replace(/[:.]/g, "-").slice(0, 19);
  const prefix = slug(String(params.out ?? title)) || "wallets";
  const dir = join(workspaceRoot(), "exports");
  await mkdir(dir, { recursive: true });
  const base = join(dir, `${prefix}-${profile.name}-${stamp}`);
  await writeFile(`${base}.json`, snapshotJson(snapshot), "utf8");
  await writeFile(`${base}.csv`, snapshotCsv(snapshot), "utf8");
  const files = [`exports/${prefix}-${profile.name}-${stamp}.json`, `exports/${prefix}-${profile.name}-${stamp}.csv`];

  let telegram: string | undefined;
  if (params.telegram === true) {
    try {
      const chat = await sendToOperator((k) => runtime.getSetting(k), report.html, { html: true });
      telegram = `sent to Telegram (chat ${chat}, ${report.html.length} chars)`;
    } catch (err) {
      telegram = `Telegram delivery FAILED: ${(err as Error).message}`;
    }
  }

  const lines = report.text.split("\n");
  const summary = [
    ...lines.slice(0, 32),
    ...(lines.length > 32 ? [`…${lines.length - 32} more lines in the files`] : []),
    "",
    `files: ${files.join(", ")}`,
    ...(telegram ? [telegram] : []),
  ].join("\n");
  return { snapshot, files, telegram, summary };
}

export const walletsSnapshotAction: Action = {
  name: "wallets_snapshot",
  similes: ["holders_portfolio", "wallets_portfolio", "portfolio_snapshot", "holders_analytics", "wallet_analytics"],
  description:
    "Portfolio snapshot of a list of wallets on any known network: native balance and EVERY ERC20 each one holds (tokens discovered from the chain, " +
    "no explorer needed), with totals and 'most held' across the list. Reads `addresses` and/or a workspace `file` (CSV/JSON/one per line; order = rank) " +
    "with optional `labels`. Saves JSON + CSV to exports/. telegram: true sends the report to the operator with explorer links on every address. " +
    "First run on a list scans `days` back (default 2, ~2 min per 100 wallets on Robinhood); later runs only scan new blocks. Longer look-backs (days > 2, or from_block: 0 = full history) run in the background automatically — " +
    "it reports to Telegram when done. Use this instead of hand-written scripts for holder or wallet analytics.",
  parameters: {
    type: "object",
    properties: {
      addresses: { type: "array", items: { type: "string" } },
      file: { type: "string", description: "Workspace path of the list, e.g. exports/lain-holders-analytics.csv." },
      labels: { type: "object", additionalProperties: { type: "string" }, description: "{ \"0x…\": \"pool\" }" },
      network: { type: "string", description: "Network profile (list_networks). Default: the active chain." },
      days: { type: "number", description: "Token discovery look-back in days. Default 2; more runs in the background automatically." },
      from_block: { type: "number", description: "Discover from this block instead (0 = whole history; slow → background)." },
      tokens: { type: "array", items: { type: "string" }, description: "Tokens to always read (symbols from the network's registry, or 0x)." },
      focus: { type: "string", description: "Token listed first on every line (default: the network's first registry token, e.g. LAIN)." },
      title: { type: "string", description: "Report title, e.g. 'LAIN top-100'." },
      telegram: { type: "boolean", description: "Send the report to the operator's Telegram." },
      background: { type: "boolean", description: "Return at once and run in the background; implies telegram." },
    },
  },
  examples: [
    { user: "пришли в тг, какие токены и сколько эфира у топ-100 холдеров", agent: "собираю снимок по всем сотне." },
  ],
  async validate() {
    return true;
  },
  async handler(runtime, _state, params) {
    const profile = params.network ? await findNetwork(runtime, String(params.network)) : currentProfile(runtime);
    if (!profile) {
      return {
        ok: false,
        text: params.network
          ? `No network "${String(params.network)}" — list_networks shows the known ones.`
          : "No chain is active here; name the network (e.g. network: robinhood).",
      };
    }
    if (params.file && !safePath(String(params.file))) return { ok: false, text: `${String(params.file)} is outside the workspace.` };
    const title = String(params.title ?? "wallets").trim() || "wallets";

    // A long scan must not hold the conversation hostage: past two days of
    // look-back (or a from_block) it goes to the background unless told not to.
    const long =
      params.from_block !== undefined || Number(params.days ?? DEFAULT_DAYS) > INLINE_MAX_DAYS;
    if (params.background === true || (long && params.background !== false)) {
      const job: SnapshotJob = { id: `s${jobs.length + 1}`, title, network: profile.name, startedAt: Date.now(), status: "running" };
      jobs.push(job);
      void runSnapshot({ runtime, profile, params: { ...params, telegram: true }, title, job })
        .then((r) => {
          job.status = "done";
          job.result = r.telegram ?? "done";
          job.files = r.files;
        })
        .catch(async (err: Error) => {
          job.status = "failed";
          job.result = err.message;
          await sendToOperator((k) => runtime.getSetting(k), `snapshot "${title}" failed: ${err.message}`).catch(() => {});
        });
      return {
        ok: true,
        text: `Started snapshot ${job.id} ("${title}", ${profile.title}) in the background — the report goes to Telegram when it is done.`,
        data: { job: job.id },
      };
    }

    try {
      const r = await runSnapshot({ runtime, profile, params, title });
      const ok = !r.telegram || !r.telegram.startsWith("Telegram delivery FAILED");
      return { ok, text: r.summary, data: { files: r.files, wallets: r.snapshot.rows.length, tokens: r.snapshot.tokens.length } };
    } catch (err) {
      return { ok: false, text: `snapshot failed: ${(err as Error).message}` };
    }
  },
};

/** How to do wallet work, and what is running — so the model reaches for the tools, not for a script. */
const walletsProvider: Provider = {
  name: "wallets",
  async get() {
    const running = jobs.filter((j) => j.status === "running");
    const recent = jobs.filter((j) => j.status !== "running").slice(-3);
    const lines = [
      "Wallet work has tools: wallets_snapshot (what a list of wallets holds — native + every token, totals, Telegram report with explorer links) " +
        "and watch_wallets (follow the same list for every change, digests to Telegram). Both take a workspace file of addresses and any network. " +
        "Reach for them before writing a script.",
    ];
    for (const j of running) lines.push(`Snapshot ${j.id} "${j.title}" is running${j.progress ? ` (${j.progress})` : ""}.`);
    for (const j of recent) lines.push(`Snapshot ${j.id} "${j.title}": ${j.status} — ${j.result ?? ""}${j.files ? ` · ${j.files.join(", ")}` : ""}.`);
    return lines.join("\n");
  },
};

export const walletsPlugin: Plugin = {
  name: "wallets",
  description: "Wallet analytics over lists of addresses: portfolio snapshots with totals, on any known network.",
  providers: [walletsProvider],
  actions: [walletsSnapshotAction],
};
