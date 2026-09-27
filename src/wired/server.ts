import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { encodeFunctionData, isAddress, type Address } from "viem";
import { createLogger } from "../logger.js";
import type { SessionStore } from "./sessions.js";
import type { TicketSigner } from "./signer.js";
import type { Ticket } from "./types.js";

const log = createLogger("wired");

/** Minimal ABI to pre-encode startRun calldata server-side (tuple+bytes is
 * painful to encode in GDScript, so we return ready calldata to the client). */
const WIRED_FORGE_ABI = [
  {
    type: "function",
    name: "startRun",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "t",
        type: "tuple",
        components: [
          { name: "player", type: "address" },
          { name: "tier", type: "uint8" },
          { name: "seed", type: "bytes32" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      { name: "sig", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

export interface WiredServerOptions {
  signer: TicketSigner;
  sessions: SessionStore;
  host?: string;
  port?: number;
}

/**
 * HTTP surface for the Wired game-auth (model B). The Godot client uses:
 *   GET  /wired/health                              -> { ok, signer, contract, chainId }
 *   POST /wired/session/start  { address }          -> { sessionId, seed, tier, deadline }
 *   POST /wired/session/ticket { sessionId, address, proof } -> { ticket, signature }
 * The returned ticket+signature are passed straight to WiredForge.startRun().
 */
export function createWiredServer(opts: WiredServerOptions): Server {
  const host = opts.host ?? process.env.WIRED_HTTP_HOST ?? "127.0.0.1";
  const port = Number(opts.port ?? process.env.WIRED_HTTP_PORT ?? 7788);

  const server = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") return void res.writeHead(204).end();

    if (req.method === "GET" && req.url === "/wired/health") {
      return json(res, 200, {
        ok: true,
        signer: opts.signer.address,
        contract: opts.signer.verifyingContract,
        chainId: opts.signer.chainId,
      });
    }

    if (req.method === "POST" && req.url === "/wired/session/start") {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        const address = body.address;
        if (typeof address !== "string" || !isAddress(address)) {
          return json(res, 400, { error: "valid 'address' required" });
        }
        const result = opts.sessions.start(address as Address);
        if ("error" in result) return json(res, 429, { error: result.error });
        log.info(`session ${result.id.slice(0, 8)} for ${address}`);
        return json(res, 200, {
          sessionId: result.id,
          seed: result.seed,
          tier: result.tier,
          deadline: result.deadline.toString(),
          fragmentsRequired: opts.sessions.config.fragmentsRequired,
        });
      } catch (err) {
        log.error("session/start failed", err);
        return json(res, 500, { error: "internal error" });
      }
    }

    if (req.method === "POST" && req.url === "/wired/session/ticket") {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        const { sessionId, address, proof } = body;
        if (typeof address !== "string" || !isAddress(address)) {
          return json(res, 400, { error: "valid 'address' required" });
        }
        const v = opts.sessions.validate(String(sessionId), address as Address, proof);
        if (!v.ok || !v.session) return json(res, 400, { error: v.reason ?? "invalid session" });

        const ticket: Ticket = {
          player: v.session.player,
          tier: v.session.tier,
          seed: v.session.seed,
          nonce: v.session.nonce,
          deadline: v.session.deadline,
        };
        const signature = await opts.signer.sign(ticket);
        // Pre-encode startRun(t, sig) calldata so the Godot client sends it raw.
        const startCalldata = encodeFunctionData({
          abi: WIRED_FORGE_ABI,
          functionName: "startRun",
          args: [ticket, signature],
        });
        log.agent(`signed ticket for ${address} (tier ${ticket.tier})`);
        return json(res, 200, { ticket: serializeTicket(ticket), signature, startCalldata });
      } catch (err) {
        log.error("session/ticket failed", err);
        return json(res, 500, { error: "internal error" });
      }
    }

    json(res, 404, { error: "not found" });
  });

  server.listen(port, host, () => {
    log.info(`Wired auth on http://${host}:${port}`);
    log.info(`signer ${opts.signer.address} — must equal WiredForge.signer() on-chain`);
  });
  return server;
}

/** uint256 fields are returned as decimal strings the client can pass on-chain. */
function serializeTicket(t: Ticket) {
  return {
    player: t.player,
    tier: t.tier,
    seed: t.seed,
    nonce: t.nonce.toString(),
    deadline: t.deadline.toString(),
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 100_000) reject(new Error("payload too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
