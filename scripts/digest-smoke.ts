#!/usr/bin/env -S npx tsx
/**
 * Portfolio digest smoke test (headless: fake web, fake chain, fake model).
 *
 * Pinned here:
 *   1. the asset list: LP shares and lending receipts are dropped, a repeated
 *      symbol keeps its most-held contract, known underlyings need no model,
 *      unknown ones are classified once (in batches) and cached;
 *   2. quotes: coingecko / yahoo / cbr / moex parsed; MOEX before the open
 *      falls back to the previous close; an unreachable MOEX is reported once;
 *   3. the material carries moves, on-chain changes vs the last digest, and
 *      news by id; the written links get their real URLs back, and a link to
 *      an id that does not exist is dropped;
 *   4. a broken analysis route falls back to the chat provider;
 *   5. the daily schedule fires once a day, remembers what was shown, and
 *      /digest at|off change it.
 *
 * Run: npm run digest:smoke
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AssetBook,
  DigestService,
  digestCommand,
  digestLinks,
  digestMaterial,
  fetchQuotes,
  generateWithFallback,
  isDerivative,
  jsonObjects,
  newsIds,
  resolveAssets,
  type Asset,
  type Http,
} from "../src/plugins/digest/index.js";
import { TaskKind } from "../src/models/tasks.js";
import { ModelTier, type IAgentRuntime, type ModelRequest } from "../src/types.js";

const results: [string, boolean][] = [];
const check = (name: string, pass: boolean) => results.push([name, pass]);
const tmp = await mkdtemp(join(tmpdir(), "lainos-digest-"));

// ---------------------------------------------------------------- fakes

const TOKENS = [
  { address_hash: "0x01", symbol: "BTC", name: "Bitcoin", holders_count: "3", decimals: "8" },
  { address_hash: "0x02", symbol: "TMOS", name: "T-Capital Russian Stocks", holders_count: "4", decimals: "18" },
  { address_hash: "0x03", symbol: "UNI-V2", name: "Uniswap V2", holders_count: "9", decimals: "18" },
  { address_hash: "0x04", symbol: "clASH", name: "Cyberia Lend ASH", holders_count: "3", decimals: "18" },
  { address_hash: "0x05", symbol: "TG", name: "Telegram", holders_count: "31", decimals: "18" },
  { address_hash: "0x06", symbol: "TG", name: "Telegram", holders_count: "7", decimals: "18" },
  { address_hash: "0x07", symbol: "ASH", name: "Ash", holders_count: "15", decimals: "18" },
  { address_hash: "0x08", symbol: "GOLD", name: "Gold", holders_count: "3", decimals: "18" },
  { address_hash: "0x09", symbol: "RUB", name: "Russian Ruble", holders_count: "9", decimals: "2" },
  { address_hash: "0x0a", symbol: "TRUR", name: "T-Capital Rouble Liquidity", holders_count: "4", decimals: "18" },
];

let moexOpen = true;
const asked: string[] = [];
const http: Http = async (url) => {
  asked.push(url);
  if (url.includes("/tokens")) return JSON.stringify({ items: TOKENS, next_page_params: null });
  if (url.includes("coingecko")) return JSON.stringify({ bitcoin: { usd: 85000, usd_24h_change: -0.5 } });
  if (url.includes("yahoo")) return JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: 4200, chartPreviousClose: 4000, currency: "USD" } }] } });
  if (url.includes("cbr-xml")) return JSON.stringify({ Valute: { USD: { Value: 85.7, Previous: 85, Nominal: 1 } } });
  if (url.includes("moex")) {
    if (url.includes("/TRUR.")) return JSON.stringify({ marketdata: { data: [[null, null]] }, securities: { data: [[9.94]] } });
    return JSON.stringify({ marketdata: { data: [moexOpen ? [5.81, -0.17] : [null, null]] }, securities: { data: [[5.82]] } });
  }
  if (url.includes("news.google")) {
    const now = new Date().toUTCString();
    const q = decodeURIComponent(url.split("q=")[1].split("&")[0]);
    return `<rss><channel><item><title>${q} story - Outlet</title><link>https://news.example/${encodeURIComponent(q)}</link><pubDate>${now}</pubDate></item>
      <item><title>old ${q} - Outlet</title><link>https://news.example/old</link><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item></channel></rss>`;
  }
  throw new Error(`unexpected ${url}`);
};

const prompts: ModelRequest[] = [];
let analysisBroken = false;
const model = {
  name: "fake",
  async generate(req: ModelRequest) {
    prompts.push(req);
    if (analysisBroken && req.task === TaskKind.ANALYSIS) throw new Error("openrouter HTTP 400: model not found");
    if (req.system?.includes("You map tokens")) {
      // Cut off mid-array, as a long answer can be: the complete objects still count.
      return {
        text: `[{"symbol":"TG","kind":"brand","about":"Telegram messenger","news":[{"q":"Telegram","lang":"ru"}]},{"symbol":"ASH","kind":"native","about":"Ash","news":[]},{"symbol":"x"`,
        model: "fake",
      };
    }
    return { text: "день спокойный. **BTC** −0.50%\n- **TG** — новость [Outlet](n1)\n- выдумка [Fake](n99)", model: "fake" };
  },
};

const settings: Record<string, string> = { LAINOS_DATA_DIR: tmp, CHAIN_RPC_URL: "http://x", CHAIN_ID: "49406", CHAIN_NAME: "Cyberia", CHAIN_NATIVE_SYMBOL: "CYBER", CHAIN_EXPLORER_URL: "https://explorer.example" };
const svc = new DigestService();
const runtime = {
  character: { name: "Lain" },
  getSetting: (k: string) => settings[k],
  getService: (n: string) => (n === "digest" ? svc : undefined),
  model,
} as unknown as IAgentRuntime;

// ---------------------------------------------------------------- 1. assets

check("LP shares and lending receipts are not assets", isDerivative("UNI-V2", "Uniswap V2") && isDerivative("clASH", "Cyberia Lend ASH"));
check("a rouble liquidity fund is not a derivative", !isDerivative("TRUR", "T-Capital Rouble Liquidity"));
check("objects survive a cut-off array", jsonObjects('[{"a":1},{"b":[1,2]},{"c"').length === 2);

const book = await AssetBook.forRuntime(runtime).load();
const assets = await resolveAssets(runtime, TOKENS, book, "CYBER");
const bySym = Object.fromEntries(assets.map((a) => [a.symbol, a]));
check("derivatives are left out", !bySym["UNI-V2"] && !bySym["clASH"]);
check("a repeated symbol keeps its most-held contract", bySym.TG?.address === "0x05");
check("known underlyings need no model", bySym.TMOS?.kind === "fund" && bySym.BTC?.price?.source === "coingecko");
check("unknown tokens are classified", bySym.TG?.kind === "brand" && bySym.TG.news[0]?.q === "Telegram" && bySym.ASH?.kind === "native");
const classifyCalls = prompts.filter((p) => p.system?.includes("You map tokens")).length;
await resolveAssets(runtime, TOKENS, await AssetBook.forRuntime(runtime).load(), "CYBER");
check("classifications are cached", prompts.filter((p) => p.system?.includes("You map tokens")).length === classifyCalls);

// ---------------------------------------------------------------- 2. quotes

let q = await fetchQuotes(assets, http);
check("coingecko quote", q.quotes.get("BTC")?.price === 85000 && q.quotes.get("BTC")?.changePct === -0.5);
check("yahoo quote with the day's change", q.quotes.get("GOLD")?.changePct === 5);
check("cbr rate", Math.abs((q.quotes.get("RUB")?.price ?? 0) - 85.7) < 1e-9);
check("moex quote on TQBR", q.quotes.get("TMOS")?.price === 5.81 && asked.some((u) => u.includes("/boards/TQBR/securities/TMOS")));
check("before the open: the previous close, no move", q.quotes.get("TRUR")?.price === 9.94 && q.quotes.get("TRUR")?.changePct === undefined);
const down: Http = async (url) => {
  if (url.includes("moex")) throw new Error("This operation was aborted");
  return http(url);
};
const moexCalls = () => asked.filter((u) => u.includes("moex")).length;
q = await fetchQuotes(assets, down);
check("an unreachable MOEX is said plainly for every fund", q.missing.get("TMOS") === "MOEX is unreachable from this host" && q.missing.get("TRUR") === q.missing.get("TMOS"));

// ---------------------------------------------------------------- 3. material, links

const news = [{ symbols: ["TG"], query: { q: "Telegram", lang: "ru" as const }, items: [{ title: "story - Outlet", url: "https://news.example/1", source: "News", at: Date.now() }] }];
const material = digestMaterial({
  network: "Cyberia",
  nativeSymbol: "CYBER",
  assets: assets as Asset[],
  quotes: q.quotes,
  missing: q.missing,
  dex: new Map([["ASH", { native: 2, depthNative: 100, usd: 0.1 }]]),
  nativeUsd: 0.05,
  previous: { at: Date.now() - 86_400_000, dex: { ASH: 1 }, holders: { ASH: 10 } },
  news,
  notes: ["1 news search failed"],
});
check("material shows an on-chain move against the last digest", material.includes("price +100.00%") && material.includes("holders 15 (was 10)"));
check("material gives news an id, not a URL", material.includes("n1: story - Outlet") && !material.includes("https://news.example/1"));
check("material says where there is no quote", material.includes("no external quote — MOEX is unreachable"));
const linked = digestLinks("a [Outlet](n1) b [Fake](n7)", newsIds(news));
check("links get their URLs back", linked.includes("[Outlet](https://news.example/1)"));
check("a link to an unknown id is dropped", linked.endsWith("b Fake"));

// ---------------------------------------------------------------- 4. fallback

analysisBroken = true;
const fb = await generateWithFallback(runtime, { tier: ModelTier.MEDIUM, task: TaskKind.ANALYSIS, system: "s", messages: [{ role: "user", content: "x" }] });
check("a broken analysis route falls back to chat", fb.text.length > 0 && prompts.at(-1)?.task === TaskKind.CHAT);
analysisBroken = false;

// ---------------------------------------------------------------- 5. service

svc.http = http;
svc.dexReader = async () => ({ prices: new Map(), nativeUsd: undefined });
await svc.start(runtime);
const text = await svc.generate({ remember: true });
check("the digest is written, with real links", /\[Outlet\]\(https:\/\/news\.example\/[^)]+\)/.test(text));
check("an invented source is not linked", text.includes("выдумка Fake") && !text.includes("(n99)"));
check("the digest is written by the chat provider by default", prompts.at(-1)?.task === TaskKind.CHAT);
check("old news is not in it", !prompts.at(-1)?.messages[0].content.includes("old Telegram"));
asked.length = 0;
await svc.generate({ remember: true });
check("news shown yesterday is not shown again", !prompts.at(-1)?.messages[0].content.includes("Telegram story"));

check("/digest at sets the schedule", (await digestCommand(runtime, ["at", "9:05"])).includes("09:05") && svc.schedule().at === "09:05");
const tick = (svc as unknown as { tick(now?: Date): Promise<void> }).tick.bind(svc);
const sent: string[] = [];
settings.TELEGRAM_BOT_TOKEN = "";
const before = prompts.length;
const day = new Date();
day.setHours(8, 0, 0, 0);
await tick(day);
check("not before its time", prompts.length === before);
day.setHours(9, 30, 0, 0);
await tick(day).catch((e) => sent.push(String(e)));
const afterFirst = prompts.length;
await tick(day);
check("once a day", afterFirst > before && prompts.length === afterFirst);
check("/digest off stops it", (await digestCommand(runtime, ["off"])).includes("выключен") && svc.schedule().at === null);
await svc.stop();

await rm(tmp, { recursive: true, force: true });

let failed = 0;
for (const [name, pass] of results) {
  console.log(`${pass ? "✓" : "✗"} ${name}`);
  if (!pass) failed += 1;
}
if (failed) {
  console.error(`${failed} digest check(s) failed`);
  process.exit(1);
}
console.log(`digest smoke ok (${results.length} checks)`);
