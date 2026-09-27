#!/usr/bin/env -S npx tsx
/** Run the Wired game-auth server (model B: signs WiredForge entry tickets). */
import "dotenv/config";
import type { Address, Hex } from "viem";
import { createWiredServer } from "../src/wired/server.js";
import { SessionStore } from "../src/wired/sessions.js";
import { TicketSigner } from "../src/wired/signer.js";

function main() {
  const pk = process.env.CHAIN_AGENT_PK;
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    console.error(
      "CHAIN_AGENT_PK (0x + 64 hex) is required to sign tickets.\n" +
        "Its address must equal WiredForge.signer() on-chain (currently the deployer).",
    );
    process.exit(1);
  }
  const contract = process.env.WIRED_FORGE_ADDRESS as Address | undefined;
  if (!contract) {
    console.error("WIRED_FORGE_ADDRESS (0x address of the deployed WiredForge contract) is required.");
    process.exit(1);
  }
  const chainIdRaw = process.env.WIRED_CHAIN_ID ?? process.env.CHAIN_ID;
  const chainId = Number(chainIdRaw);
  if (!chainIdRaw || !Number.isInteger(chainId) || chainId <= 0) {
    console.error("WIRED_CHAIN_ID or CHAIN_ID (a positive integer) is required.");
    process.exit(1);
  }

  const signer = new TicketSigner({ privateKey: pk as Hex, chainId, verifyingContract: contract });
  const sessions = new SessionStore();
  createWiredServer({ signer, sessions, port: Number(process.env.WIRED_HTTP_PORT ?? 7788) });
}

main();
