#!/usr/bin/env -S npx tsx
/**
 * Wallet tools smoke test (headless, fake chain).
 *
 * Pinned here:
 *   1. lists: a holders CSV and a launchpad JSON read in rank order, labels merge;
 *   2. range scans split what the node refuses, and wait out a 429 instead of splitting;
 *   3. an EIP-7702 delegated wallet is a wallet, not a contract;
 *   4. the group watch starts at the head, then reports every token and native
 *      move once, aggregated per wallet (a flooding pool is one line);
 *   5. the digest escapes token names and links addresses to the explorer;
 *   6. a snapshot discovers tokens, reads balances, totals them, and resumes
 *      discovery from its cache instead of rescanning;
 *   7. copycat tickers are told apart;
 *   8. a `wallets` watch in the sentinel delivers its digest to Telegram itself;
 *   9. offer_choices validates and renders; networks resolve by loose names.
 *
 * Run: npm run wallets:smoke
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address } from "viem";
import { findNetwork, type NetworkProfile } from "../src/plugins/chain/networks.js";
import { SentinelService, type Alert } from "../src/plugins/sentinel/index.js";
import { parseChoices, renderChoices } from "../src/plugins/system/choices.js";
import {
  isContractCode,
  pairKey,
  rangeScan,
  type TokenMeta,
  type Transfer,
  type WalletSource,
} from "../src/plugins/wallets/chainread.js";
import { mergeWalletLists, parseWalletList } from "../src/plugins/wallets/lists.js";
import { formatSnapshot, takeSnapshot, tokenLabels, TokenCache } from "../src/plugins/wallets/snapshot.js";
import { formatGroupAlert, scanGroup, type GroupState } from "../src/plugins/wallets/watch.js";
import type { IAgentRuntime, State } from "../src/types.js";

const results: [string, boolean][] = [];
const check = (name: string, pass: boolean) => results.push([name, pass]);
const tmp = await mkdtemp(join(tmpdir(), "lainos-wallets-"));

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const A = addr(0xa1);
const B = addr(0xb2);
const POOL = addr(0x9001);
const STRANGER = addr(0xdead);
const TOK = addr(0x7a);
const EVIL = addr(0x7e);

// ---------------------------------------------------------------- 1. lists

const csv = `1,"${POOL}",100,10\n2,"${A}",50,5\n3,"${B}",10,1\n2,"${A}",50,5\n`;
const fromCsv = parseWalletList(csv);
check("CSV list keeps rank order and drops repeats", fromCsv.length === 3 && fromCsv[1].address === A && fromCsv[1].rank === 2);
const json = JSON.stringify({ source: "x", response: { holders: [{ address: B, label: "friend" }, { address: A }] } });
const fromJson = parseWalletList(json);
check("holders JSON is walked and labels kept", fromJson.length === 2 && fromJson[0].label === "friend");
const merged = mergeWalletLists([fromCsv, fromJson], { [POOL.toUpperCase().replace("0X", "0x")]: "pool" });
check("lists merge: first order wins, labels from both", merged.length === 3 && merged[0].label === "pool" && merged[2].label === "friend");

// ---------------------------------------------------------------- 2. range scan

const asked: [bigint, bigint][] = [];
const got = await rangeScan(
  async (a, b) => {
    asked.push([a, b]);
    if (b - a + 1n > 25n) throw new Error("query exceeds limit of 10000 logs");
    return [`${a}-${b}`];
  },
  0n,
  99n,
  100n,
);
check("a refused range is split until accepted", got.length === 4 && got[0] === "0-24" && got[3] === "75-99");
let throttled = 0;
const limited = await rangeScan(
  async () => {
    if (throttled++ === 0) throw new Error("HTTP 429 Too Many Requests");
    return ["ok"];
  },
  0n,
  9n,
  10n,
);
check("a 429 is waited out, not split", limited.length === 1 && throttled === 2);
const gaps: string[] = [];
const tolerant = await rangeScan(
  async (a, b) => {
    if (a <= 5n && b >= 5n) throw new Error("internal error");
    return [`${a}-${b}`];
  },
  0n,
  9n,
  5n,
  { onGap: (a, b, why) => gaps.push(`${a}-${b}:${why}`) },
);
check("an unreadable small window becomes a gap, the rest still arrives", gaps.length === 1 && tolerant.length === 1);
let blind = 0;
const bigWindow = await rangeScan(
  async (a, b) => {
    blind++;
    if (b - a + 1n > 4_000n) throw new Error("RPC Request failed.");
    return [`${a}`];
  },
  0n,
  9_999n,
  10_000n,
);
check("an unexplained failure on a big window is split, not fatal", bigWindow.length === 4 && blind > 1);

// ---------------------------------------------------------------- 3. EIP-7702

check("EIP-7702 delegated wallet is not a contract", !isContractCode(`0xef0100${"ab".repeat(20)}`));
check("real bytecode is a contract", isContractCode("0x6080604052"));
check("no code is not a contract", !isContractCode("0x") && !isContractCode(undefined));

// ---------------------------------------------------------------- fake chain

let head = 1_000n;
let transfers: Transfer[] = [];
const balances = new Map<string, bigint>();
const natives = new Map<string, bigint>([
  [A.toLowerCase(), 10n ** 18n],
  [B.toLowerCase(), 0n],
  [POOL.toLowerCase(), 5n * 10n ** 18n],
]);
const META: Record<string, TokenMeta> = {
  [TOK.toLowerCase()]: { symbol: "LAIN", decimals: 18 },
  [EVIL.toLowerCase()]: { symbol: "<b>EVIL&", decimals: 18 },
};
let tx = 0;
const move = (token: Address, from: Address, to: Address, value: bigint) => {
  transfers.push({ token, from, to, value, tx: `0x${(++tx).toString(16).padStart(64, "0")}`, block: head });
  balances.set(pairKey(token, to), (balances.get(pairKey(token, to)) ?? 0n) + value);
  balances.set(pairKey(token, from), (balances.get(pairKey(token, from)) ?? 0n) - value);
};
const logCalls: string[] = [];
const fake: WalletSource = {
  head: async () => head,
  async transfers(wallets, dir, from, to) {
    logCalls.push(`${dir}:${from}-${to}`);
    const set = new Set(wallets.map((w) => w.toLowerCase()));
    return transfers.filter(
      (t) => t.block >= from && t.block <= to && set.has((dir === "in" ? t.to : t.from).toLowerCase()),
    );
  },
  async receivedTokens(wallets, from, to) {
    logCalls.push(`in:${from}-${to}`);
    const set = new Set(wallets.map((w) => w.toLowerCase()));
    const out = new Map<string, Set<string>>();
    for (const t of transfers) {
      const w = t.to.toLowerCase();
      if (t.block < from || t.block > to || !set.has(w)) continue;
      if (!out.has(w)) out.set(w, new Set());
      out.get(w)!.add(t.token.toLowerCase());
    }
    return out;
  },
  contracts: async (list) => new Set(list.filter((a) => a === POOL).map((a) => a.toLowerCase())),
  nativeBalances: async (list) => new Map(list.map((w) => [w.toLowerCase(), natives.get(w.toLowerCase()) ?? 0n])),
  async tokenBalances(pairs) {
    return new Map(pairs.map((p) => [pairKey(p.token, p.wallet), balances.get(pairKey(p.token, p.wallet)) ?? 0n]));
  },
  tokenMeta: async (tokens) => new Map(tokens.map((t) => [t.toLowerCase(), META[t.toLowerCase()] ?? { symbol: "?", decimals: 18 }])),
};

// ---------------------------------------------------------------- 4–5. group watch

const members = mergeWalletLists([parseWalletList([POOL, A, B].join("\n"))], { [POOL]: "pool", [A]: "me" });
const state: GroupState = {};
const opts = { tokens: true, native: true, minNativeWei: 10n ** 15n, maxSpan: 10_000n, maxLag: 100_000n };
const meta = new Map<string, TokenMeta>();
const contracts = new Set([POOL.toLowerCase()]);

const first = await scanGroup(fake, members, state, opts, meta, contracts);
check("a new group watch starts at the head", first.baseline && state.cursor === "1000" && !first.changes.length);

head = 1_010n;
move(TOK, STRANGER, A, 5n * 10n ** 18n); // A opens LAIN
for (let i = 0; i < 30; i++) move(TOK, STRANGER, POOL, 10n ** 18n); // the pool floods
move(EVIL, STRANGER, B, 10n ** 18n);
natives.set(A.toLowerCase(), 10n ** 18n - 10n ** 17n); // A spent 0.1 native
natives.set(B.toLowerCase(), 10n ** 12n); // dust below the threshold
const second = await scanGroup(fake, members, state, opts, meta, contracts);
const byRank = Object.fromEntries(second.changes.map((c) => [c.wallet.rank, c]));
check("every moved wallet is reported once", second.changes.length === 3);
check("a token received from zero is a new position", byRank[2]?.tokens[0]?.opened === true);
check("a flooding pool is one aggregated entry", byRank[1]?.tokens.length === 1 && byRank[1].tokens[0].count === 30);
check("native moves over the threshold count, dust does not", byRank[2]?.native !== undefined && byRank[3]?.native === undefined);
check("cursor advances to the head", state.cursor === "1010");

const profile = { title: "Testchain", nativeSymbol: "ETH", explorerUrl: "https://scan.example" } as NetworkProfile;
const report = formatGroupAlert("top holders", profile, second)!;
check("digest links addresses to the explorer", report.html.includes(`href="https://scan.example/address/${A}"`));
check("digest marks contracts and new positions", report.text.includes("[contract]") && report.text.includes("new position"));
check("digest counts a flood instead of listing it", report.text.includes("30 transfers"));
check("token names cannot inject markup", !report.html.includes("<b>EVIL") && report.html.includes("&lt;b&gt;EVIL"));

const third = await scanGroup(fake, members, state, opts, meta, contracts);
check("nothing new, nothing reported", third.changes.length === 0);

// ---------------------------------------------------------------- 6–7. snapshot

const cache = await new TokenCache(join(tmp, "cache.json")).load();
logCalls.length = 0;
const snap = await takeSnapshot({
  profile: { ...profile, name: "test", chainId: 1, rpcUrl: "x" } as NetworkProfile,
  wallets: members,
  source: fake,
  fromBlock: 900n,
  cache,
});
const rowA = snap.rows.find((r) => r.address === A)!;
check("snapshot finds discovered tokens", rowA.holdings.some((h) => h.token === TOK));
check("contracts are skipped in discovery but read", logCalls.length === 1 && snap.rows[0].isContract && snap.rows[0].holdings.length === 1);
check("totals count holders", snap.tokens.find((t) => t.token === TOK)?.holders === 2);
logCalls.length = 0;
head = 1_020n;
await takeSnapshot({
  profile: { ...profile, name: "test", chainId: 1, rpcUrl: "x" } as NetworkProfile,
  wallets: members,
  source: fake,
  fromBlock: 900n,
  cache: await new TokenCache(join(tmp, "cache.json")).load(),
});
check("a second snapshot resumes discovery from the cache", logCalls[0] === "in:1011-1020");
const labels = tokenLabels(
  [
    { token: addr(0x1111), symbol: "NVDA" },
    { token: addr(0x2222), symbol: "NVDA" },
    { token: addr(0x3333), symbol: "ETH" },
    { token: TOK, symbol: "LAIN" },
  ],
  "ETH",
);
check("copycat tickers are told apart", labels.get(addr(0x1111).toLowerCase()) !== labels.get(addr(0x2222).toLowerCase()));
check("a token named like the native currency is marked", labels.get(addr(0x3333).toLowerCase()) !== "ETH");
check("a unique ticker stays plain", labels.get(TOK.toLowerCase()) === "LAIN");
check("snapshot report renders", formatSnapshot(snap, { focus: TOK }).html.includes("LAIN"));

// ---------------------------------------------------------------- 8. sentinel

const svc = new SentinelService();
const runtime = {
  character: { name: "Lain" },
  getSetting: (key: string) => ({ LAINOS_DATA_DIR: tmp } as Record<string, string>)[key],
  getService: (name: string) => (name === "sentinel" ? svc : undefined),
  actions: [],
} as unknown as IAgentRuntime;
const sent: string[] = [];
svc.groupSource = () => fake;
svc.deliverTelegram = async (html) => void sent.push(html);
await svc.start(runtime);
await svc.stop();
const alerts: Alert[] = [];
svc.onAlert((a) => alerts.push(a));
const watchAction = (await import("../src/plugins/sentinel/index.js")).sentinelPlugin.actions!.find((a) => a.name === "watch_wallets")!;
const created = await watchAction.handler(runtime, {} as State, {
  addresses: [POOL, A, B],
  network: "robinhood",
  labels: { [A]: "me" },
  note: "holders",
});
check("watch_wallets sets up one group watch", created.ok && svc.listWatches().some((w) => w.kind === "wallets" && w.group?.members.length === 3));
check("contracts are recorded on the watch", svc.listWatches().find((w) => w.kind === "wallets")?.group?.contracts.length === 1);
await svc.tick();
head = 1_030n;
move(TOK, STRANGER, B, 10n ** 18n);
await svc.tick();
check("the digest goes to Telegram from the sentinel", sent.length === 1 && sent[0].includes("holders"));
check("and is marked so the daemon does not repeat it", alerts.length === 1 && alerts[0].telegramSent === true && Boolean(alerts[0].html));

// ---------------------------------------------------------------- 9. choices, networks

const choice = parseChoices({ question: "which?", options: ["a", { label: "b", detail: "the b one" }], recommended: 1 });
check("choices parse", typeof choice !== "string" && choice.options.length === 2);
check("choices render numbered with the recommendation", typeof choice !== "string" && renderChoices(choice).includes("2. b (recommended) — the b one"));
check("one option is not a choice", typeof parseChoices({ question: "?", options: ["only"] }) === "string");
check("networks resolve by loose name", (await findNetwork(runtime, "Robinhood mainnet"))?.chainId === 4663);
check("a test name finds the testnet", (await findNetwork(runtime, "robinhood testnet"))?.chainId === 46630);
check("networks resolve by chain id", (await findNetwork(runtime, "49406"))?.name === "cyberia");

await rm(tmp, { recursive: true, force: true });

let failed = 0;
for (const [name, pass] of results) {
  console.log(`${pass ? "✓" : "✗"} ${name}`);
  if (!pass) failed += 1;
}
if (failed) {
  console.error(`${failed} wallets check(s) failed`);
  process.exit(1);
}
console.log(`wallets smoke ok (${results.length} checks)`);
