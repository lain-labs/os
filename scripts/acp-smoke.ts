#!/usr/bin/env -S npx tsx
/**
 * ACP tools smoke test (offline: a fake chain client, fake DexScreener and
 * GoPlus answers).
 *
 * Pinned here:
 *   1. the route is off without LAINOS_ACP_API_KEY, and refuses a missing or
 *      wrong bearer;
 *   2. bad requests (unknown tool, chain id, address, unknown chain) are 400s
 *      with a reason;
 *   3. a clean token reads as low risk, and the report carries its contract,
 *      market and security facts;
 *   4. a honeypot with a tax, a whale and a proxy reads as high risk with every
 *      one of those flagged, worst first;
 *   5. a failed source is named in `errors` and the rest still ships; when all
 *      fail there is no report (502);
 *   6. a wallet (plain or EIP-7702 delegated) is not a token;
 *   7. the HTTP route answers through the daemon's server.
 *
 * Run: npm run acp:smoke
 */
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PublicClient } from "viem";
import { handleAcpTool } from "../src/acp/tools.js";
import type { TokenReport } from "../src/acp/token-research.js";
import { createHttpServer } from "../src/clients/http.js";
import type { IAgentRuntime } from "../src/types.js";

const results: [string, boolean][] = [];
const check = (name: string, pass: boolean) => results.push([name, pass]);
const tmp = await mkdtemp(join(tmpdir(), "lainos-acp-"));

const KEY = "test-key-123";
const TOKEN = "0x1111111111111111111111111111111111111111";
const POOL = "0x2222222222222222222222222222222222222222";
const WHALE = "0x3333333333333333333333333333333333333333";
const IMPL = "0x4444444444444444444444444444444444444444";

function runtimeWith(settings: Record<string, string>): IAgentRuntime {
  return {
    character: { name: "Lain" },
    getSetting: (k: string) => ({ LAINOS_DATA_DIR: tmp, ...settings })[k],
  } as unknown as IAgentRuntime;
}
const runtime = runtimeWith({ LAINOS_ACP_API_KEY: KEY });
const auth = `Bearer ${KEY}`;
const body = (args: Record<string, unknown>, tool = "token_info") => JSON.stringify({ tool, arguments: args });

interface FakeToken {
  code?: string;
  reads?: Record<string, unknown>;
  slots?: Record<string, string>;
  fail?: boolean;
}
function fakeClient(t: FakeToken): PublicClient {
  return {
    async getCode() {
      if (t.fail) throw new Error("rpc down");
      return t.code ?? "0x6080604052";
    },
    async getStorageAt({ slot }: { slot: string }) {
      return t.slots?.[slot] ?? `0x${"0".repeat(64)}`;
    },
    async readContract({ functionName }: { functionName: string }) {
      if (!t.reads || !(functionName in t.reads)) throw new Error(`execution reverted: ${functionName}`);
      return t.reads[functionName];
    },
  } as unknown as PublicClient;
}

const ERC20 = { name: "Clean Coin", symbol: "CLEAN", decimals: 18, totalSupply: 1_000_000n * 10n ** 18n };
const dexPairs = (liquidity: number, createdAt = Date.parse("2026-01-01T00:00:00Z")) => [
  {
    dexId: "uniswap",
    url: "https://dexscreener.com/base/pool",
    pairAddress: POOL,
    baseToken: { address: TOKEN, name: "Clean Coin", symbol: "CLEAN" },
    quoteToken: { address: "0x4200000000000000000000000000000000000006", symbol: "WETH" },
    priceUsd: "0.0123",
    txns: { h24: { buys: 40, sells: 30 } },
    volume: { h24: 50_000 },
    priceChange: { h24: -4.2 },
    liquidity: { usd: liquidity },
    fdv: 12_300_000,
    marketCap: 12_300_000,
    pairCreatedAt: createdAt,
  },
];
const goplus = (fields: Record<string, unknown>) => ({
  code: 1,
  message: "OK",
  result: {
    [TOKEN]: {
      is_honeypot: "0",
      buy_tax: "0",
      sell_tax: "0",
      is_open_source: "1",
      is_proxy: "0",
      is_mintable: "0",
      owner_change_balance: "0",
      hidden_owner: "0",
      selfdestruct: "0",
      holder_count: "4200",
      creator_address: "0x5555555555555555555555555555555555555555",
      creator_percent: "0.01",
      holders: [{ address: POOL, is_contract: 1, percent: "0.30", is_locked: 0 }],
      dex: [{ pair: POOL }],
      ...fields,
    },
  },
});
function fakeFetch(answers: { dex?: unknown; goplus?: unknown }) {
  return async (url: string) => {
    const key = url.includes("dexscreener") ? "dex" : "goplus";
    const answer = answers[key];
    if (answer instanceof Error) throw answer;
    return answer;
  };
}
const NOW = () => new Date("2026-10-17T00:00:00Z");

// ------------------------------------------------------------ 1. auth

const off = await handleAcpTool(runtimeWith({}), auth, body({ chainId: 8453, tokenAddress: TOKEN }));
check("without LAINOS_ACP_API_KEY the route is off (503)", off.status === 503);
const noAuth = await handleAcpTool(runtime, undefined, body({ chainId: 8453, tokenAddress: TOKEN }));
check("a missing bearer is refused (401)", noAuth.status === 401);
const wrongAuth = await handleAcpTool(runtime, "Bearer nope", body({ chainId: 8453, tokenAddress: TOKEN }));
check("a wrong bearer is refused (401)", wrongAuth.status === 401);

// ---------------------------------------------------------- 2. requests

const errorOf = (r: { body: unknown }) => String((r.body as { error?: string }).error ?? "");
const badTool = await handleAcpTool(runtime, auth, body({ chainId: 8453, tokenAddress: TOKEN }, "swap"));
check("an unknown tool is a 400 that lists the tools", badTool.status === 400 && errorOf(badTool).includes("token_info"));
const badJson = await handleAcpTool(runtime, auth, "{nope");
check("a body that is not JSON is a 400", badJson.status === 400);
const badChain = await handleAcpTool(runtime, auth, body({ chainId: "base", tokenAddress: TOKEN }));
check("a chain id that is not an integer is a 400", badChain.status === 400 && errorOf(badChain).includes("chainId"));
const badAddr = await handleAcpTool(runtime, auth, body({ chainId: 8453, tokenAddress: "0x123" }));
check("an address that is not 20 bytes is a 400", badAddr.status === 400 && errorOf(badAddr).includes("tokenAddress"));
const unknownChain = await handleAcpTool(runtime, auth, body({ chainId: 999999, tokenAddress: TOKEN }));
check(
  "an unknown chain is a 400 that names the supported ones",
  unknownChain.status === 400 && errorOf(unknownChain).includes("8453 (Base)") && errorOf(unknownChain).includes("4663"),
);

// ------------------------------------------------------- 3. clean token

const clean = await handleAcpTool(runtime, auth, body({ chainId: 8453, tokenAddress: TOKEN }), {
  deps: {
    client: fakeClient({ reads: ERC20 }),
    fetchJson: fakeFetch({ dex: dexPairs(250_000), goplus: goplus({}) }),
    now: NOW,
  },
});
const cleanReport = clean.body as TokenReport;
check("a clean token answers 200", clean.status === 200);
check("a clean token reads as low risk with no flags", cleanReport.risk === "low" && cleanReport.flags.length === 0);
check(
  "the report carries the contract's own facts",
  cleanReport.token.symbol === "CLEAN" && cleanReport.token.totalSupply === "1000000" && cleanReport.contract?.proxy === null,
);
check(
  "the report carries the market and security facts",
  cleanReport.market?.priceUsd === 0.0123 &&
    cleanReport.market.liquidityUsd === 250_000 &&
    cleanReport.security?.holderCount === 4200 &&
    cleanReport.security.creator?.percent === 1,
);
check("the summary states price, liquidity and the verdict", /Price \$0\.0123/.test(cleanReport.summary) && /Risk: low\./.test(cleanReport.summary));
check("a pool holding 30% is not a whale", !cleanReport.flags.some((f) => f.code === "whale"));
check("every source answered", cleanReport.errors.length === 0 && cleanReport.sources.length === 3);
check("the chain id comes back as asked", cleanReport.chain.id === 8453 && cleanReport.chain.name === "Base");

// ---------------------------------------------------------- 4. honeypot

const trap = await handleAcpTool(runtime, auth, body({ chainId: 8453, tokenAddress: TOKEN }, "token_research"), {
  deps: {
    client: fakeClient({
      reads: { ...ERC20, owner: WHALE },
      slots: { "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc": `0x${"0".repeat(24)}${IMPL.slice(2)}` },
    }),
    fetchJson: fakeFetch({
      dex: dexPairs(3_000, Date.parse("2026-10-16T20:00:00Z")),
      goplus: goplus({
        is_honeypot: "1",
        sell_tax: "0.25",
        is_mintable: "1",
        holders: [
          { address: WHALE, is_contract: 0, percent: "0.62", is_locked: 0 },
          { address: POOL, is_contract: 1, percent: "0.20", is_locked: 0 },
        ],
      }),
    }),
    now: NOW,
  },
});
const trapReport = trap.body as TokenReport;
const codes = new Set(trapReport.flags.map((f) => f.code));
check("a honeypot reads as high risk", trap.status === 200 && trapReport.risk === "high");
check(
  "honeypot, tax, whale, mint, proxy, thin liquidity and a new pool are all flagged",
  ["honeypot", "high_tax", "whale", "mintable", "upgradeable", "thin_liquidity", "new_token", "owned"].every((c) => codes.has(c)),
);
check("the proxy's implementation is read from the EIP-1967 slot", trapReport.contract?.proxy?.implementation?.toLowerCase() === IMPL);
check("a 25% sell tax reads as 25", trapReport.security?.sellTaxPct === 25);
check(
  "flags come worst first",
  trapReport.flags.findIndex((f) => f.level !== "high") > trapReport.flags.findLastIndex((f) => f.level === "high"),
);

// ------------------------------------------------- 5. failing sources

const partial = await handleAcpTool(runtime, auth, body({ chainId: 8453, tokenAddress: TOKEN }), {
  deps: {
    client: fakeClient({ reads: ERC20 }),
    fetchJson: fakeFetch({ dex: new Error("HTTP 429 from api.dexscreener.com"), goplus: goplus({}) }),
    now: NOW,
  },
});
const partialReport = partial.body as TokenReport;
check(
  "a failed source is named and the rest still ships",
  partial.status === 200 &&
    partialReport.market === null &&
    partialReport.errors.some((e) => e.source === "dexscreener" && e.message.includes("429")) &&
    partialReport.security !== null,
);
const unknownToGoplus = await handleAcpTool(runtime, auth, body({ chainId: 8453, tokenAddress: TOKEN }), {
  deps: {
    client: fakeClient({ reads: ERC20 }),
    fetchJson: fakeFetch({ dex: dexPairs(250_000), goplus: { code: 1, message: "OK", result: {} } }),
    now: NOW,
  },
});
const unknownReport = unknownToGoplus.body as TokenReport;
check(
  "without GoPlus's record the risk is unknown, not low",
  unknownReport.risk === "unknown" && unknownReport.errors.some((e) => e.source === "goplus"),
);
const dead = await handleAcpTool(runtime, auth, body({ chainId: 8453, tokenAddress: TOKEN }), {
  deps: {
    client: fakeClient({ fail: true }),
    fetchJson: fakeFetch({ dex: new Error("down"), goplus: new Error("down") }),
    now: NOW,
  },
});
check("when every source fails there is no report (502)", dead.status === 502 && errorOf(dead).includes("every source failed"));

// ----------------------------------------------------------- 6. wallets

const wallet = await handleAcpTool(runtime, auth, body({ chainId: 8453, tokenAddress: TOKEN }), {
  deps: { client: fakeClient({ code: "0x" }), fetchJson: fakeFetch({ dex: [], goplus: { code: 1, result: {} } }), now: NOW },
});
const walletReport = wallet.body as TokenReport;
check("a plain wallet is not a contract", walletReport.risk === "high" && walletReport.flags[0]?.code === "not_a_contract");
const delegated = await handleAcpTool(runtime, auth, body({ chainId: 8453, tokenAddress: TOKEN }), {
  deps: {
    client: fakeClient({ code: `0xef0100${IMPL.slice(2)}` }),
    fetchJson: fakeFetch({ dex: [], goplus: { code: 1, result: {} } }),
    now: NOW,
  },
});
const delegatedReport = delegated.body as TokenReport;
check(
  "an EIP-7702 delegated wallet is not a token",
  delegatedReport.flags[0]?.code === "not_a_token" && delegatedReport.contract?.delegatedTo?.toLowerCase() === IMPL,
);

// ------------------------------------------------------------- 7. HTTP

const server = createHttpServer(runtime, { host: "127.0.0.1", port: 0 });
await new Promise<void>((r) => server.once("listening", () => r()));
const { port } = server.address() as AddressInfo;
const post = (headers: Record<string, string>) =>
  fetch(`http://127.0.0.1:${port}/acp/tools`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: body({ chainId: 8453, tokenAddress: "nope" }),
  });
check("POST /acp/tools without a bearer is a 401", (await post({})).status === 401);
const viaHttp = await post({ Authorization: auth });
check("POST /acp/tools validates through the server", viaHttp.status === 400 && String((await viaHttp.json()).error).includes("tokenAddress"));
await new Promise<void>((r) => server.close(() => r()));

await rm(tmp, { recursive: true, force: true });

let failed = 0;
for (const [name, pass] of results) {
  console.log(`${pass ? "✓" : "✗"} ${name}`);
  if (!pass) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
