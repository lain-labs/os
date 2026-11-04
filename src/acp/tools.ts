/**
 * The tools Lain sells on the Virtuals ACP marketplace, as the local
 * lain-acp-bridge calls them once a buyer's job is funded:
 *
 *   POST /acp/tools  Authorization: Bearer $LAINOS_ACP_API_KEY
 *   {"tool":"token_info","arguments":{"chainId":8453,"tokenAddress":"0x…"}}
 *   → 200 report | 4xx/5xx {"error":"…"}
 *
 * The route is off until LAINOS_ACP_API_KEY is set. It only reads, and the
 * key is required because a page open in the operator's browser can reach
 * 127.0.0.1 too.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { createLogger } from "../logger.js";
import { listNetworksSync } from "../plugins/chain/networks.js";
import type { IAgentRuntime } from "../types.js";
import { researchToken, type ResearchDeps, type TokenReport } from "./token-research.js";

const log = createLogger("acp");

/** The bridge refuses deliverables longer than this; leave room for its own wrapping. */
const MAX_REPORT_CHARS = 11_000;
/** `token_info` is the bridge's name for it; `token_research` is the offering's. */
const TOKEN_TOOLS = new Set(["token_info", "token_research"]);

export interface AcpToolResult {
  status: number;
  body: unknown;
}

export interface AcpToolOptions {
  /** Test seam: the research dependencies other than the network profile. */
  deps?: Omit<ResearchDeps, "profile">;
}

export async function handleAcpTool(
  runtime: IAgentRuntime,
  authorization: string | undefined,
  rawBody: string,
  opts: AcpToolOptions = {},
): Promise<AcpToolResult> {
  const key = runtime.getSetting("LAINOS_ACP_API_KEY")?.trim();
  if (!key) return { status: 503, body: { error: "ACP tools are off: set LAINOS_ACP_API_KEY" } };
  if (!bearerMatches(authorization, key)) return { status: 401, body: { error: "unauthorized" } };

  let body: { tool?: unknown; arguments?: unknown };
  try {
    body = JSON.parse(rawBody || "{}");
  } catch {
    return { status: 400, body: { error: "body must be JSON" } };
  }
  const tool = String(body?.tool ?? "");
  if (!TOKEN_TOOLS.has(tool)) {
    return { status: 400, body: { error: `unknown tool '${tool.slice(0, 40)}'; available: ${[...TOKEN_TOOLS].join(", ")}` } };
  }

  const args = (body.arguments ?? {}) as { chainId?: unknown; tokenAddress?: unknown };
  const chainId = Number(args.chainId);
  const tokenAddress = typeof args.tokenAddress === "string" ? args.tokenAddress.trim() : "";
  if (!Number.isInteger(chainId) || chainId <= 0) return { status: 400, body: { error: "arguments.chainId must be a positive integer" } };
  if (!/^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) {
    return { status: 400, body: { error: "arguments.tokenAddress must be a 20-byte 0x address" } };
  }
  const networks = listNetworksSync(runtime);
  const profile = networks.find((n) => n.chainId === chainId);
  if (!profile) {
    const known = networks.map((n) => `${n.chainId} (${n.title})`).join(", ");
    return { status: 400, body: { error: `unsupported chainId ${chainId}; supported: ${known}` } };
  }

  const started = Date.now();
  try {
    const report = fitReport(await researchToken({ chainId, tokenAddress }, { ...opts.deps, profile }));
    log.info(
      `${tool} ${profile.name}:${tokenAddress} → risk ${report.risk}, ${report.flags.length} flags, ` +
        `${report.errors.length} source errors, ${Date.now() - started}ms`,
    );
    return { status: 200, body: report };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`${tool} ${profile.name}:${tokenAddress} failed: ${message}`);
    return { status: 502, body: { error: message.slice(0, 300) } };
  }
}

/** Constant-time comparison of a `Bearer <key>` header, independent of the key's length. */
export function bearerMatches(header: string | undefined, key: string): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(header?.trim() ?? "");
  if (!m) return false;
  const a = createHash("sha256").update(m[1].trim()).digest();
  const b = createHash("sha256").update(key).digest();
  return timingSafeEqual(a, b);
}

/** Drop the least important detail until the report fits a deliverable. */
function fitReport(report: TokenReport): TokenReport {
  const size = (r: TokenReport) => JSON.stringify(r).length;
  if (size(report) <= MAX_REPORT_CHARS) return report;
  const r: TokenReport = structuredClone(report);
  if (r.security) r.security.topHolders = r.security.topHolders.slice(0, 3);
  if (r.market) r.market.topPairs = r.market.topPairs.slice(0, 1).map(({ url: _url, ...p }) => p);
  if (size(r) <= MAX_REPORT_CHARS) return r;
  r.flags = r.flags.filter((f) => f.level !== "info");
  if (r.security) r.security.topHolders = [];
  if (r.market) r.market.topPairs = [];
  return r;
}
