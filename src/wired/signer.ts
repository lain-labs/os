import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex, LocalAccount } from "viem";
import type { Ticket } from "./types.js";

/**
 * EIP-712 ticket signer (model B). The domain and types MUST match WiredForge:
 *   EIP712("WiredForge", "1")
 *   Ticket(address player,uint8 tier,bytes32 seed,uint256 nonce,uint256 deadline)
 * so that the contract's ECDSA.recover yields this signer's address.
 */

export const WIRED_DOMAIN_NAME = "WiredForge";
export const WIRED_DOMAIN_VERSION = "1";

export const TICKET_TYPES = {
  Ticket: [
    { name: "player", type: "address" },
    { name: "tier", type: "uint8" },
    { name: "seed", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export interface TicketSignerOptions {
  /** Server signing key. Loaded from CHAIN_AGENT_PK; never logged. */
  privateKey: Hex;
  chainId: number;
  verifyingContract: Address;
}

export class TicketSigner {
  private readonly account: LocalAccount;
  readonly chainId: number;
  readonly verifyingContract: Address;

  constructor(opts: TicketSignerOptions) {
    this.account = privateKeyToAccount(opts.privateKey);
    this.chainId = opts.chainId;
    this.verifyingContract = opts.verifyingContract;
  }

  /** Public address of the signer — must equal WiredForge.signer() on-chain. */
  get address(): Address {
    return this.account.address;
  }

  domain() {
    return {
      name: WIRED_DOMAIN_NAME,
      version: WIRED_DOMAIN_VERSION,
      chainId: this.chainId,
      verifyingContract: this.verifyingContract,
    } as const;
  }

  /** Sign a ticket; returns the 65-byte signature the client passes to startRun. */
  async sign(ticket: Ticket): Promise<Hex> {
    return this.account.signTypedData({
      domain: this.domain(),
      types: TICKET_TYPES,
      primaryType: "Ticket",
      message: ticket,
    });
  }
}
