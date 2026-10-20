#!/usr/bin/env -S npx tsx
/**
 * Trend brief smoke test. No network.
 *
 * Run: npm run content:trends:smoke
 */
import { briefTrends, corroboratedFigure } from "../src/plugins/press/trends.js";

const results: [string, boolean][] = [];
const check = (name: string, pass: boolean) => results.push([name, pass]);

const hits = [
  { title: "BTC just fell to 81,000 while ETH dropped", source: "X", url: "https://x.com/a/1" },
  { title: "Bitcoin settled around 81,000 for the weekend", source: "News", url: "https://news.example/btc" },
  { title: "Over $115 million worth of longs liquidated in an hour", source: "X", url: "https://x.com/a/2" },
  { title: "Check your Zaps balance for the upcoming airdrop", source: "X", url: "https://x.com/a/3" },
  { title: "Check any crypto wallet address for unclaimed airdrops", source: "HN", url: "https://news.ycombinator.com/item?id=1" },
  { title: "The SEC has officially confirmed crypto companies can operate nationwide", source: "X", url: "https://x.com/a/4" },
  { title: "Trump's crypto company and the pardons", source: "News", url: "https://news.example/pol" },
  { title: "my favorite trader just posted a memecoin callout", source: "X", url: "https://x.com/a/5" },
  { title: "Trust Wallet versus MetaMask market share", source: "Reddit", url: "https://reddit.com/r/cc/1" },
];

check("a repeated price is kept", corroboratedFigure(hits.slice(0, 2)) === "81,000");
check("one account's number is dropped", corroboratedFigure([hits[2]]) === null);

const briefs = briefTrends(hits);
const byId = new Map(briefs.map((brief) => [brief.id, brief]));
check("the flush is usable", byId.get("leverage")?.verdict === "use");
check("the flush post names the repeated price", byId.get("leverage")?.post?.includes("81,000") === true);
check("the flush post skips the lone liquidation figure", !byId.get("leverage")?.post?.includes("115"));
check("an airdrop is skipped", byId.get("airdrop")?.verdict === "skip" && !byId.get("airdrop")?.post);
check(
  "a wallet airdrop page is not the wallet topic",
  !byId.get("wallet")?.hits.some((hit) => /unclaimed airdrops/i.test(hit.title)),
);
check("a regulation rumor is skipped", byId.get("regulation")?.verdict === "skip");
check("politics are skipped", byId.get("politics")?.verdict === "skip");
check("a callout becomes a token post", byId.get("memecoin")?.post?.includes("A callout is not a token.") === true);
check("a wallet thread becomes the wallet post", byId.get("wallet")?.verdict === "use");
check(
  "nothing promises coins",
  briefs.every((brief) => !/we send|10 CYBER|airdrop/i.test(`${brief.post ?? ""}\n${brief.reply ?? ""}`)),
);

const failed = results.filter(([, pass]) => !pass);
for (const [name, pass] of results) console.log(`${pass ? "ok  " : "FAIL"} ${name}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
