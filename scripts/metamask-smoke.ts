#!/usr/bin/env -S npx tsx
/**
 * MetaMask Agent Wallet smoke test (headless, fake `mm` binary).
 *
 * Pinned here:
 *   1. the CLI's output — pretty-printed JSON documents, concatenated, notices
 *      first — splits into its envelope, its hint and its notices; a run with
 *      no envelope keeps what stderr said;
 *   2. secrets never reach a command line (seed, password, token) and the
 *      operator-only commands (login, reset, passwords, plugin installs) are
 *      refused with what to do instead;
 *   3. the child process does not inherit LainOS's own secrets;
 *   4. chain names resolve to ids, a one-string command line splits;
 *   5. end to end against a fake `mm`: status walks the quickstart (not signed
 *      in → link → token through MM_CLI_TOKEN, never argv → setup); a send that
 *      stops on an approval is tracked, its wait is bounded, and its outcome is
 *      reported to the chat that asked; a send that confirms is not tracked;
 *   6. a host without `mm` gets the install line, and only the status tool.
 *
 * Run: npm run metamask:smoke
 */
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  childEnv,
  parseEnvelope,
  parseJsonStream,
  movesFunds,
  pollingIds,
  refuseArgs,
} from "../src/plugins/metamask/cli.js";
import {
  defaultChain,
  metamaskPlugin,
  MetaMaskService,
  resolveChain,
  splitArgs,
  type MetaMaskEvent,
} from "../src/plugins/metamask/index.js";
import { isSecretCommand, maskSecrets } from "../src/clients/tui/commands.js";
import type { Action, IAgentRuntime, State } from "../src/types.js";

const results: [string, boolean][] = [];
const check = (name: string, pass: boolean) => results.push([name, pass]);
const tmp = await mkdtemp(join(tmpdir(), "lainos-metamask-"));

// ---------------------------------------------------------------- 1. output

const notice = { _notice: { kind: "AWAITING_MFA", pollingId: "job-abc123", message: "approve {it}" } };
const stream =
  `${JSON.stringify(notice, null, 2)}\n` +
  `${JSON.stringify({ ok: true, data: { quoteId: "q-1", note: 'brace } in "string"' }, hint: "Run `mm swap execute --quote-id q-1`" }, null, 2)}\n`;
const docs = parseJsonStream(stream);
check("concatenated pretty JSON splits into its documents", docs.length === 2);
const env1 = parseEnvelope(stream, "", 0);
check("the envelope, its hint and its notices come apart", env1.ok && env1.notices.length === 1 && env1.hint?.includes("q-1") === true);
const env2 = parseEnvelope(
  JSON.stringify({ ok: false, error: { code: "JOB_TIMEOUT", message: "timed out", hint: "Run `mm wallet requests watch job-xyz789`" } }),
  "",
  1,
);
check("an error envelope keeps code and hint", !env2.ok && env2.error?.code === "JOB_TIMEOUT");
check("polling ids come from notices and from a timed-out wait's hint", pollingIds(env1).includes("job-abc123") && pollingIds(env2).includes("job-xyz789"));
const env4 = parseEnvelope(
  "",
  `[progress] Fetching quote [1/2]\n${JSON.stringify({ ok: false, error: { code: "AUTH_FAILED", message: "No CLI refresh token", hint: "Run \`mm login\`" } }, null, 2)}\n`,
  1,
);
check("failures arrive on stderr, past bracketed log lines", !env4.ok && env4.error?.code === "AUTH_FAILED");
const listing = parseEnvelope(JSON.stringify({ ok: true, data: { requests: [{ pollingId: "job-someone-else", status: "AWAITING_MFA" }] } }), "", 0);
check("a listing of jobs is not a job this run submitted", pollingIds(listing).length === 0);
// Once a notice went out, the CLI ends with {_summary} or {_error} rather than {ok}.
const approved = parseEnvelope(
  `${JSON.stringify(notice, null, 2)}\n${JSON.stringify({ _summary: { status: "CONFIRMED", txHash: "0xfeed" }, _hint: "done" }, null, 2)}\n`,
  "",
  0,
);
check("a send approved while the CLI waited is a success", approved.ok && (approved.data as { txHash?: string })?.txHash === "0xfeed" && approved.notices.length === 1);
const held = parseEnvelope(
  `${JSON.stringify(notice, null, 2)}\n`,
  `[progress] Waiting for approval...\n${JSON.stringify({ _error: { code: "JOB_TIMEOUT", message: "Timed out waiting for wallet job." } }, null, 2)}\n`,
  1,
);
check("a send still held for approval keeps its error code", !held.ok && held.error?.code === "JOB_TIMEOUT" && pollingIds(held).includes("job-abc123"));
const env3 = parseEnvelope("", "node: something broke\n", 1);
check("no envelope: stderr is the message", !env3.ok && env3.error?.code === "MM_NO_RESULT" && env3.error.message.includes("something broke"));

// ---------------------------------------------------------------- 2. refusals

check("a seed phrase never goes on argv", refuseArgs(["init", "--wallet", "byok", "--mnemonic", "x y z"]) !== null);
check("nor a password in --flag=value form", refuseArgs(["transfer", "--password=hunter2"]) !== null);
check("nor a token", refuseArgs(["login", "--token", "a:b"]) !== null);
check("login, reset, passwords and plugin installs are the operator's", [
  ["login", "qr"],
  ["reset", "--yes"],
  ["wallet", "password", "set"],
  ["plugins", "install", "evil"],
  [],
].every((a) => refuseArgs(a) !== null));
check("everything else runs", [
  ["perps", "positions"],
  ["plugins", "inspect", "x"],
  ["wallet", "balance"],
  ["logout"],
].every((a) => refuseArgs(a) === null));

// ---------------------------------------------------------------- 3. env

const env = childEnv({
  PATH: "/bin",
  HOME: "/h",
  HTTPS_PROXY: "http://p",
  ANTHROPIC_API_KEY: "sk",
  CHAIN_AGENT_PK: "0x1",
  TELEGRAM_BOT_TOKEN: "t",
  LAINOS_MM_LOGIN_TOKEN: "a:b",
  MM_CLI_TOKEN: "c:d",
  MM_MNEMONIC: "m",
});
check(
  "the child keeps PATH, HOME, proxy and MM_* but none of LainOS's secrets",
  env.PATH === "/bin" && env.HTTPS_PROXY === "http://p" && env.MM_CLI_TOKEN === "c:d" && env.MM_MNEMONIC === "m" &&
    !env.ANTHROPIC_API_KEY && !env.CHAIN_AGENT_PK && !env.TELEGRAM_BOT_TOKEN && !env.LAINOS_MM_LOGIN_TOKEN,
);

// ---------------------------------------------------------------- 4. parsing

check("chain names resolve to ids", resolveChain("Base") === "8453" && resolveChain("Robinhood Chain") === "4663" && resolveChain("eip155:1") === "eip155:1" && resolveChain("42161") === "42161");
check(
  "the default chain is the active network when MetaMask has it, LAINOS_MM_CHAIN wins, and an unknown one means ask",
  defaultChain((k) => ({ CHAIN_ID: "4663" } as Record<string, string>)[k]) === "4663" &&
    defaultChain((k) => ({ CHAIN_ID: "4663", LAINOS_MM_CHAIN: "base" } as Record<string, string>)[k]) === "8453" &&
    defaultChain((k) => ({ CHAIN_ID: "49406" } as Record<string, string>)[k]) === undefined,
);
check("a one-string command line splits, quotes kept together", JSON.stringify(splitArgs(`mm wallet sign-message --message "hello world" --chain-id 1`)) === JSON.stringify(["wallet", "sign-message", "--message", "hello world", "--chain-id", "1"]));

// ---------------------------------------------------------------- 4b. TUI /metamask

const typed = "/metamask abcdefgh12:refresh-token-xyz";
check("a token after /metamask is masked as typed, length kept", maskSecrets(typed) === "/metamask " + "•".repeat(typed.length - 10) && maskSecrets(typed).length === typed.length);
check("a subcommand being typed stays readable, other commands untouched", maskSecrets("/metamask lo") === "/metamask lo" && maskSecrets("/network robinhood") === "/network robinhood");
check("and the line stays out of the input history", isSecretCommand(typed) && !isSecretCommand("/network robinhood") && !isSecretCommand("hello"));

// ---------------------------------------------------------------- 5. end to end

const state = join(tmp, "state.json");
const calls = join(tmp, "calls.log");
const fakeMm = join(tmp, "mm");
await writeFile(state, JSON.stringify({ authenticated: false, initialized: false, mfa: true, jobStatus: "AWAITING_MFA" }));
await writeFile(
  fakeMm,
  `#!/usr/bin/env node
const fs = require("node:fs");
const st = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, token: process.env.MM_CLI_TOKEN || null, leaked: Boolean(process.env.ANTHROPIC_API_KEY), home: process.env.HOME }) + "\\n");
const save = () => fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(st));
const out = (o) => process.stdout.write(JSON.stringify(o, null, 2) + "\\n");
const fail = (o) => { process.stderr.write("[progress] working [1/1]\\n" + JSON.stringify(o, null, 2) + "\\n"); process.exit(1); };
const cmd = args.filter((a) => a !== "--json").slice(0, 3).join(" ");
if (cmd === "doctor") out({ ok: true, data: { cli: "7.2.0", env: "prod", authenticated: st.authenticated, initialized: st.initialized, hints: ["No MetaMask AI skills found. Run npx skills add", "Not authenticated. Run mm login."] } });
else if (cmd === "login browser --no-wait") out({ ok: true, data: { mode: "no-wait", loginUrl: "https://developer.metamask.io/agentic/login?x=1" } });
else if (cmd === "login") { st.authenticated = true; save(); out({ ok: true, data: { mode: "token" } }); }
else if (cmd === "init show") out({ ok: true, data: { walletMode: st.initialized ? "server-wallet" : undefined, tradingMode: st.initialized ? "guard" : null } });
else if (cmd === "wallet address") out({ ok: true, data: { mode: "server-wallet", chainNamespace: "eip155", address: "0x00000000000000000000000000000000000000aa" } });
else if (cmd.startsWith("init --wallet")) { st.initialized = true; save(); out({ ok: true, data: { walletMode: "server-wallet", tradingMode: "guard" } }); }
else if (cmd.startsWith("transfer")) {
  if (st.mfa) {
    out({ _notice: { kind: "AWAITING_MFA", pollingId: "job-777777", message: "Approve in your email" } });
    fail({ ok: false, error: { code: "JOB_TIMEOUT", message: "Timed out waiting", hint: "Run \`mm wallet requests watch job-777777\`; do not re-run." } });
  }
  out({ ok: true, data: { pollingId: "job-888888", status: "CONFIRMED", txHash: "0x" + "1".repeat(64) } });
}
else if (cmd === "wallet requests list") out({ ok: true, data: { requests: [{ pollingId: "job-777777", kind: "transaction", status: st.jobStatus, txHash: "0x" + "2".repeat(64) }] } });
else if (cmd === "perps positions") out({ ok: true, data: { positions: [] } });
else if (cmd === "chains list" && !st.authenticated) fail({ ok: false, error: { code: "AUTH_FAILED", message: "No CLI refresh token available", hint: "Run \`mm login\` to sign in." } });
else { process.stderr.write("unknown " + cmd); process.exit(2); }
`,
);
await chmod(fakeMm, 0o755);

const settings: Record<string, string> = {
  LAINOS_DATA_DIR: tmp,
  LAINOS_MM_BIN: fakeMm,
  LAINOS_MM_HOME: join(tmp, "mm-home"),
  LAINOS_MM_POLL_MS: "3600000",
};
process.env.ANTHROPIC_API_KEY = "sk-test-should-not-leak";
const svc = new MetaMaskService();
const runtime = {
  getSetting: (k: string) => settings[k],
  getService: (name: string) => (name === "metamask" ? svc : undefined),
} as unknown as IAgentRuntime;
await svc.start(runtime);
const events: MetaMaskEvent[] = [];
svc.onEvent((ev) => events.push(ev));

const action = (name: string): Action => metamaskPlugin.actions!.find((a) => a.name === name)!;
const st = (roomId = "tg-4242") => ({ roomId, message: { userId: "op" } }) as unknown as State;
const lastCall = async () => JSON.parse((await readFile(calls, "utf8")).trim().split("\n").at(-1)!) as { args: string[]; token: string | null; leaked: boolean; home: string };

const s1 = await action("metamask_status").handler(runtime, st(), {});
check("status: installed, not signed in, next step is the login", s1.ok && /not signed in/.test(s1.text!) && /metamask_login/.test(s1.text!));
check("the coding-agent skill hint is dropped", !/skills add/.test(s1.text!));

const early = await action("metamask").handler(runtime, st(), { args: ["chains", "list"] });
check("a CLI failure reaches the model with its code and hint", !early.ok && early.text!.includes("AUTH_FAILED") && early.text!.includes("mm login"));

const l1 = await action("metamask_login").handler(runtime, st(), {});
check("login without a token hands out the dashboard link", l1.ok && l1.text!.includes("https://developer.metamask.io/agentic/login") && /different wallet/.test(l1.text!));

const token = "cliTokenAAAA1234:refreshBBBB5678";
const l2 = await action("metamask_login").handler(runtime, st(), { token });
const loginCall = await lastCall();
const allCalls = (await readFile(calls, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as { args: string[]; token: string | null });
const tokenCall = allCalls.find((c) => c.args[0] === "login" && c.token);
check("the token travels as MM_CLI_TOKEN, never on argv", Boolean(tokenCall) && !allCalls.some((c) => c.args.join(" ").includes(token)));
check("and is registered for transcript redaction", process.env.LAINOS_MM_LOGIN_TOKEN === token);
check("after sign-in the next step is setup", l2.ok && /not set up/.test(l2.text!) && /metamask_setup/.test(l2.text!));
check("the child never sees LainOS's API key", !loginCall.leaked);
check("LAINOS_MM_HOME gives mm a session of its own", loginCall.home === join(tmp, "mm-home"));

const setup = await action("metamask_setup").handler(runtime, st(), {});
const initCall = allCalls.length; // calls before setup
const after = (await readFile(calls, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as { args: string[] });
check(
  "setup defaults to a server wallet in guard mode",
  setup.ok && after.slice(initCall).some((c) => c.args.join(" ") === "init --wallet server-wallet --mode guard --json") && /ready/.test(setup.text!),
);
check("validate is open once mm is installed", await action("metamask_send").validate(runtime, st()));

const bad = await action("metamask_send").handler(runtime, st(), { to: "vitalik.eth", amount: "1", token: "USDC", chain: "base" });
check("ENS recipients are refused before the CLI runs", !bad.ok && /0x address/.test(bad.text!));

const sent = await action("metamask_send").handler(runtime, st(), {
  to: "0x00000000000000000000000000000000000000bb",
  amount: "10",
  token: "USDC",
  chain: "base",
});
const sendCall = await lastCall();
check(
  "a send runs mm transfer on the resolved chain, waiting a bounded time",
  sendCall.args.join(" ") ===
    "transfer --to 0x00000000000000000000000000000000000000bb --amount 10 --token USDC --chain-id 8453 --wait --wallet-timeout 45 --json",
);
check("a send stopped on an approval is reported as waiting, not failed", sent.ok && /waiting for the operator's approval/.test(sent.text!) && /do not submit it again/.test(sent.text!));
check("and is tracked on disk", svc.listJobs().length === 1 && JSON.parse(await readFile(join(tmp, "metamask-jobs.json"), "utf8")).jobs[0].pollingId === "job-777777");

await svc.tick();
check("a still-pending job stays tracked and silent", svc.listJobs().length === 1 && events.length === 0);
await writeFile(state, JSON.stringify({ ...JSON.parse(await readFile(state, "utf8")), jobStatus: "CONFIRMED" }));
await svc.tick();
check(
  "once confirmed, the outcome goes to the chat that asked, with the tx",
  events.length === 1 && events[0].chatId === 4242 && events[0].text.includes("done") && events[0].text.includes("0x2222") && svc.listJobs().length === 0,
);

await writeFile(state, JSON.stringify({ ...JSON.parse(await readFile(state, "utf8")), mfa: false }));
const sent2 = await action("metamask_send").handler(runtime, st(), {
  to: "0x00000000000000000000000000000000000000bb",
  amount: "1",
  token: "native",
  chain: "1",
});
check("a send that confirms is not tracked", sent2.ok && sent2.text!.includes("CONFIRMED") && svc.listJobs().length === 0);

settings.CHAIN_ID = "4663";
settings.CHAIN_NAME = "Robinhood Chain";
await action("metamask_send").handler(runtime, st(), { to: "0x00000000000000000000000000000000000000bb", amount: "1", token: "USDC" });
check("on Robinhood a send without a chain goes to Robinhood", (await lastCall()).args.includes("4663"));
const onRobinhood = await metamaskPlugin.providers![0].get(runtime, st());
check(
  "and the provider says Robinhood is the default, and that swaps there go through MetaMask while her own DEX is unset",
  onRobinhood.includes("Robinhood Chain (4663)") && /swaps there go through metamask_swap/.test(onRobinhood),
);

await writeFile(state, JSON.stringify({ ...JSON.parse(await readFile(state, "utf8")), authenticated: false, initialized: false }));
const linked = await svc.connect(token);
check("/metamask <token> signs in and sets the wallet up in one go", /signed in/.test(linked) && /ready/.test(linked) && /guard mode/.test(linked));
let badToken = "";
await svc.connect("my seed phrase").catch((err: Error) => (badToken = err.message));
check("and refuses what is not a CLI token before running mm", /doesn't look like a CLI token/.test(badToken));

const refused = await action("metamask").handler(runtime, st(), { args: ["reset", "--yes"] });
check("the generic tool refuses mm reset", !refused.ok && /operator/.test(refused.text!));
const perps = await action("metamask").handler(runtime, st(), { args: "mm perps positions" });
check("and runs the rest, from a string too", perps.ok && (await lastCall()).args.join(" ") === "perps positions --json");

const provided = await metamaskPlugin.providers![0].get(runtime, st());
check("the provider tells her the wallet is separate from her own", /separate from your own chain wallet/.test(provided) && provided.includes("0x00000000000000000000000000000000000000aa"));

// Paper mode: no MetaMask money tool reaches `mm`, and each one says where the paper trade goes.
const paperRuntime = {
  getSetting: runtime.getSetting,
  getService: (name: string) => (name === "metamask" ? svc : name === "chain" ? { paperMode: true } : undefined),
} as unknown as IAgentRuntime;
const callsBefore = (await readFile(calls, "utf8")).split("\n").filter(Boolean).length;
const paperQuote = await action("metamask_swap").handler(paperRuntime, st(), { from: "SOL", to: "USDC", amount: "1" });
const paperSend = await action("metamask_send").handler(paperRuntime, st(), { to: "0x00000000000000000000000000000000000000bb", amount: "1", token: "USDC" });
const paperPerps = await action("metamask").handler(paperRuntime, st(), { args: ["perps", "open", "--symbol", "BTC", "--side", "long", "--size", "100", "--yes"] });
const callsAfter = (await readFile(calls, "utf8")).split("\n").filter(Boolean).length;
check(
  "in paper mode a swap quote, a send and a perps order are refused before mm runs, pointing at the paper swap",
  [paperQuote, paperSend, paperPerps].every((r) => !r.ok && /Paper mode is on/.test(r.text!) && /paper_trading mode swap/.test(r.text!)) &&
    callsAfter === callsBefore,
);
const paperRead = await action("metamask").handler(paperRuntime, st(), { args: ["perps", "positions"] });
check("reading still works in paper mode", paperRead.ok && (await lastCall()).args.join(" ") === "perps positions --json");
check(
  "only commands that move funds count as moving funds",
  movesFunds(["transfer", "--to", "0x1"]) && movesFunds(["swap", "execute"]) && movesFunds(["earn", "supply"]) &&
    !movesFunds(["swap", "status"]) && !movesFunds(["perps", "positions"]) && !movesFunds(["price", "spot"]),
);
const paperProvided = await metamaskPlugin.providers![0].get(paperRuntime, st());
check(
  "in paper mode the provider says MetaMask moves nothing and stops sending swaps its way",
  /Paper mode is on, so it moves nothing/.test(paperProvided) && !/swaps there go through metamask_swap/.test(paperProvided),
);
await svc.stop();

// ---------------------------------------------------------------- 6. not installed

const missing = new MetaMaskService();
const runtime2 = {
  getSetting: (k: string) => ({ ...settings, LAINOS_MM_BIN: join(tmp, "nope", "mm") } as Record<string, string>)[k],
  getService: (name: string) => (name === "metamask" ? missing : undefined),
} as unknown as IAgentRuntime;
await missing.start(runtime2);
const s2 = await action("metamask_status").handler(runtime2, st(), {});
check("without mm, status says how to install it", !s2.ok && s2.text!.includes("npm install -g @metamask/agent-wallet"));
check("and the other tools stay hidden", !(await action("metamask_send").validate(runtime2, st())) && (await metamaskPlugin.providers![0].get(runtime2, st())) === "");
await missing.stop();

await rm(tmp, { recursive: true, force: true });

let failed = 0;
for (const [name, pass] of results) {
  console.log(`${pass ? "✓" : "✗"} ${name}`);
  if (!pass) failed += 1;
}
if (failed) {
  console.error(`${failed} metamask check(s) failed`);
  process.exit(1);
}
console.log(`metamask smoke ok (${results.length} checks)`);
