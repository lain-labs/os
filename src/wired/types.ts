import type { Address, Hex } from "viem";

/**
 * Wired game-server types (model B: server-signed entry tickets for WiredForge).
 * The Ticket shape mirrors the contract's EIP-712 struct exactly.
 */

export interface Ticket {
  player: Address;
  tier: number; // uint8
  seed: Hex; // bytes32 — drives the on-chain ICE
  nonce: bigint; // uint256 — unique, single-use on-chain
  deadline: bigint; // uint256 — unix expiry
}

/** A server-issued play session, before a ticket is granted. */
export interface Session {
  id: string;
  player: Address;
  tier: number;
  seed: Hex;
  nonce: bigint;
  deadline: bigint;
  createdAt: number;
  ticketIssued: boolean;
}

/** What the 3D client reports about a finished run, for plausibility checks. */
export interface RunProof {
  collected: number; // fragments gathered
  elapsedMs: number; // wall-clock spent in the run
}
