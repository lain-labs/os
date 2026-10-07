/**
 * News for the underlyings: Google News RSS per search query, in the query's
 * language (Russian funds are covered in Russian, coins in English), only the
 * last day and a half, nothing the operator was already shown. Identical
 * queries from several assets (two gold tokens) are fetched once.
 */
import { parseRss, type ScoutItem } from "../scout/index.js";
import type { Asset, NewsQuery } from "./assets.js";
import type { Http } from "./markets.js";

export interface AssetNews {
  symbols: string[];
  query: NewsQuery;
  items: ScoutItem[];
}

const LOCALE: Record<NewsQuery["lang"], string> = {
  ru: "hl=ru&gl=RU&ceid=RU:ru",
  en: "hl=en-US&gl=US&ceid=US:en",
};

/** Items per search: the writer keeps a dozen bullets in all, so more is only noise. */
const PER_QUERY = 3;
const CONCURRENCY = 4;

export async function gatherNews(
  assets: Asset[],
  http: Http,
  opts: { sinceMs: number; seen: Set<string>; onError?: (q: string, err: string) => void },
): Promise<AssetNews[]> {
  const byQuery = new Map<string, AssetNews>();
  for (const a of assets) {
    for (const q of a.news) {
      const k = `${q.lang}:${q.q.toLowerCase()}`;
      const entry = byQuery.get(k) ?? { symbols: [], query: q, items: [] };
      if (!entry.symbols.includes(a.symbol)) entry.symbols.push(a.symbol);
      byQuery.set(k, entry);
    }
  }
  const entries = [...byQuery.values()];
  const titles = new Set<string>();
  let next = 0;
  const worker = async () => {
    while (next < entries.length) {
      const e = entries[next++];
      try {
        const xml = await http(`https://news.google.com/rss/search?q=${encodeURIComponent(`${e.query.q} when:2d`)}&${LOCALE[e.query.lang]}`);
        e.items = parseRss(xml, "News", 30)
          .filter((i) => (i.at ?? 0) >= opts.sinceMs && !opts.seen.has(i.url))
          .filter((i) => {
            // The same story syndicated under five URLs is one story.
            const t = i.title.replace(/\s+-\s+[^-]+$/, "").toLowerCase().slice(0, 80);
            if (titles.has(t)) return false;
            titles.add(t);
            return true;
          })
          .slice(0, PER_QUERY);
      } catch (err) {
        opts.onError?.(e.query.q, (err as Error).message);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, entries.length) }, worker));
  return entries.filter((e) => e.items.length);
}
