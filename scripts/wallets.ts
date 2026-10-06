#!/usr/bin/env -S npx tsx
/**
 * Wallet analytics from a shell — the same code wallets_snapshot runs, without
 * the agent. Handy for a long first pass in the background (full history),
 * which fills the discovery cache so the agent's later snapshots are quick.
 *
 *   npm run wallets -- snapshot --file exports/holders.csv --network robinhood
 *       [--days 30 | --from-block 0] [--title "LAIN top-100"] [--focus LAIN]
 *       [--tokens USDC,0x…] [--telegram]
 *   npm run wallets -- networks
 *
 * --file is read as given (absolute, or relative to the current directory);
 * the report lands in $LAINOS_WORKSPACE/exports like the agent's.
 */
import "../src/env.js";
import { readFile } from "node:fs/promises";
import { describeNetworks, findNetwork } from "../src/plugins/chain/networks.js";
import { parseWalletList } from "../src/plugins/wallets/lists.js";
import { runSnapshot } from "../src/plugins/wallets/index.js";
import type { IAgentRuntime } from "../src/types.js";

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
};
const has = (name: string) => argv.includes(`--${name}`);

// Only settings are read on this path; nothing else of a runtime is touched.
const runtime = { getSetting: (k: string) => process.env[k] } as unknown as IAgentRuntime;

async function main(): Promise<void> {
  if (cmd === "networks") {
    console.log(await describeNetworks(runtime));
    return;
  }
  if (cmd !== "snapshot") {
    console.error("usage: npm run wallets -- snapshot --file <list> [--network robinhood] [--days 30|--from-block N] [--telegram]\n       npm run wallets -- networks");
    process.exit(2);
  }
  const file = flag("file");
  if (!file) throw new Error("--file is required");
  const wallets = parseWalletList(await readFile(file, "utf8"));
  if (!wallets.length) throw new Error(`no 0x addresses in ${file}`);
  const network = flag("network") ?? process.env.CHAIN_NAME ?? "";
  const profile = await findNetwork(runtime, network);
  if (!profile) throw new Error(`unknown network "${network}" — npm run wallets -- networks`);
  const title = flag("title") ?? "wallets";
  const started = Date.now();
  console.error(`${title}: ${wallets.length} wallets on ${profile.title}`);
  const r = await runSnapshot({
    runtime,
    profile,
    title,
    params: {
      addresses: wallets.map((w) => w.address),
      ...(flag("days") ? { days: Number(flag("days")) } : {}),
      ...(flag("from-block") !== undefined ? { from_block: Number(flag("from-block")) } : {}),
      ...(flag("focus") ? { focus: flag("focus") } : {}),
      ...(flag("tokens") ? { tokens: flag("tokens")!.split(",") } : {}),
      ...(flag("out") ? { out: flag("out") } : {}),
      telegram: has("telegram"),
    },
  });
  console.log(r.summary);
  console.error(`done in ${Math.round((Date.now() - started) / 1000)}s`);
}

main().catch((err) => {
  console.error(`wallets: ${(err as Error).message}`);
  process.exit(1);
});
