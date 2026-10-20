#!/usr/bin/env -S npx tsx
/**
 * What is loud today, and the one post worth making from it.
 *
 *   npm run content:trends
 *   npm run content:trends -- --write
 *
 * Reads public feeds (Hacker News, Reddit, Google News) and, when
 * LAINOS_SCOUT_NITTER is set, X search through that instance. Prints which
 * topics to use and which to leave alone, plus a paste-ready post for each
 * usable topic. Publish one of them. Nothing here posts.
 */
import "dotenv/config";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fetch as undiciFetch } from "undici";
import { parseRss, type ScoutItem } from "../src/plugins/scout/index.js";
import { briefTrends, type TrendHit } from "../src/plugins/press/trends.js";

const QUERIES = [
  "bitcoin liquidation",
  "bitcoin price",
  "solana crypto",
  "memecoin",
  "crypto airdrop",
  "crypto wallet",
];

async function get(url: string, headers: Record<string, string> = {}): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await undiciFetch(url, {
      headers: { "user-agent": "LainOS-trends/0.1", ...headers },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${new URL(url).host} HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function hackerNews(query: string): Promise<ScoutItem[]> {
  const raw = await get(
    `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=10`,
  );
  const data = JSON.parse(raw) as {
    hits?: { title?: string; url?: string; objectID?: string; points?: number }[];
  };
  return (data.hits ?? [])
    .filter((hit) => hit.title)
    .map((hit) => ({
      title: hit.title!,
      url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
      source: "HN",
      score: hit.points,
    }));
}

async function reddit(query: string): Promise<ScoutItem[]> {
  const raw = await get(
    `https://www.reddit.com/search.rss?q=${encodeURIComponent(query)}&sort=new&t=day&limit=10`,
    { "user-agent": "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0" },
  );
  return parseRss(raw, "Reddit", 10);
}

async function googleNews(query: string): Promise<ScoutItem[]> {
  const raw = await get(
    `https://news.google.com/rss/search?q=${encodeURIComponent(query)}+when:1d&hl=en-US&gl=US&ceid=US:en`,
  );
  return parseRss(raw, "News", 10);
}

async function nitter(base: string, query: string): Promise<ScoutItem[]> {
  const raw = await get(`${base.replace(/\/$/, "")}/search/rss?f=tweets&q=${encodeURIComponent(query)}`);
  return parseRss(raw, "X", 10);
}

async function gather(query: string, nitterBase: string | undefined): Promise<TrendHit[]> {
  const jobs = [hackerNews(query), reddit(query), googleNews(query)];
  if (nitterBase) jobs.push(nitter(nitterBase, query));
  const settled = await Promise.allSettled(jobs);
  const hits: TrendHit[] = [];
  for (const result of settled) {
    if (result.status === "rejected") {
      console.error(`source failed: ${(result.reason as Error).message ?? result.reason}`);
      continue;
    }
    for (const item of result.value) hits.push(item);
  }
  return hits;
}

async function main(): Promise<void> {
  const nitterBase = process.env.LAINOS_SCOUT_NITTER?.trim() || undefined;
  console.log(
    nitterBase
      ? `reading HN, Reddit, Google News, and X via ${nitterBase}`
      : "reading HN, Reddit, and Google News. Set LAINOS_SCOUT_NITTER to include X search.",
  );
  const batches = await Promise.all(QUERIES.map((query) => gather(query, nitterBase)));
  const seen = new Set<string>();
  const hits: TrendHit[] = [];
  for (const batch of batches) {
    for (const hit of batch) {
      const key = (hit.url || hit.title).trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      hits.push(hit);
    }
  }
  const briefs = briefTrends(hits);
  console.log("");
  console.log(`${hits.length} items, ${briefs.length} topics`);
  if (!briefs.length) {
    console.log("nothing in the watched topics. The standing post is still the wallet.");
    return;
  }
  for (const brief of briefs) {
    console.log("");
    console.log(`${brief.verdict === "use" ? "USE " : "SKIP"}  ${brief.label}  (${brief.mentions})`);
    console.log(brief.why);
    for (const hit of brief.hits.slice(0, 3)) {
      console.log(`  - [${hit.source}] ${hit.title}`);
    }
    if (brief.post) {
      console.log("");
      console.log(brief.post);
      console.log(`reply: ${brief.reply}`);
    }
  }
  const usable = briefs.filter((brief) => brief.verdict === "use" && brief.post);
  console.log("");
  console.log(usable.length ? "Publish one of the USE posts. Not all of them." : "No usable topic. Publish the standing wallet post.");

  if (!process.argv.includes("--write")) {
    console.log("dry run. pass --write to save content-trends.json");
    return;
  }
  const path = resolve("content-trends.json");
  await writeFile(
    path,
    JSON.stringify({ at: new Date().toISOString(), items: hits.length, briefs }, null, 2) + "\n",
    "utf8",
  );
  console.log(`wrote ${path}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
