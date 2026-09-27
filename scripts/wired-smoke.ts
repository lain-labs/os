#!/usr/bin/env -S npx tsx
/**
 * Offline end-to-end check of the Wired game-auth (model B). Uses an EPHEMERAL
 * key (never the real CHAIN_AGENT_PK) and verifies the signed ticket recovers
 * to the signer's address — i.e. the on-chain ECDSA.recover in WiredForge would
 * accept it. Also checks plausibility, single-use, and rate-limit behaviour.
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getAddress, recoverTypedDataAddress } from "viem";
import { SessionStore } from "../src/wired/sessions.js";
import { TICKET_TYPES, TicketSigner } from "../src/wired/signer.js";

const FORGE = "0x2222222222222222222222222222222222222222" as const;

async function main() {
  const signer = new TicketSigner({
    privateKey: generatePrivateKey(), // ephemeral — not the real signer
    chainId: 1337,
    verifyingContract: FORGE,
  });
  const player = privateKeyToAccount(generatePrivateKey()).address;
  const sessions = new SessionStore({ minRunMs: 0, rateLimitPerMin: 3 });

  // 1. happy path: start -> validate -> sign -> recover
  const s = sessions.start(player);
  if ("error" in s) throw new Error("unexpected rate limit");
  const v = sessions.validate(s.id, player, { collected: 3, elapsedMs: 12_000 });
  const ticket = { player, tier: s.tier, seed: s.seed, nonce: s.nonce, deadline: s.deadline };
  const signature = await signer.sign(ticket);
  const recovered = await recoverTypedDataAddress({
    domain: signer.domain(),
    types: TICKET_TYPES,
    primaryType: "Ticket",
    message: ticket,
    signature,
  });
  const recoversToSigner = getAddress(recovered) === getAddress(signer.address);

  // 2. single-use: same session can't issue a second ticket
  const reuse = sessions.validate(s.id, player, { collected: 3, elapsedMs: 12_000 });

  // 3. plausibility: too few fragments is rejected
  const s2 = sessions.start(player);
  const tooFew =
    "error" in s2 ? { ok: true } : sessions.validate(s2.id, player, { collected: 1, elapsedMs: 12_000 });

  // 4. rate limit: 3 allowed/min, the 4th start (we've used 2) should trip soon
  sessions.start(player); // 3rd
  const limited = sessions.start(player); // 4th -> error

  console.log("\n=== assertions ===");
  const checks: [string, boolean][] = [
    ["happy validate ok", v.ok === true],
    ["signature recovers to signer", recoversToSigner],
    ["session single-use enforced", reuse.ok === false],
    ["too-few-fragments rejected", tooFew.ok === false],
    ["rate limit trips", "error" in limited],
  ];
  let pass = true;
  for (const [name, ok] of checks) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
    pass = pass && ok;
  }
  console.log(`\nsigner address: ${signer.address}`);
  console.log(pass ? "\n✅ wired-auth OK" : "\n❌ wired-auth FAILED");
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
