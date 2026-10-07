/**
 * Daily moves of the underlyings, from free public sources that need no key:
 *
 *   coingecko — coins and stablecoins (one batched call)
 *   yahoo     — futures and US tickers: gold GC=F, silver SI=F, SPY
 *   cbr       — the Bank of Russia's daily rates (via cbr-xml-daily.ru)
 *   moex      — Moscow exchange ISS, for the T-Capital funds (board TQBR)
 *
 * Every source fails on its own: a quote that cannot be read is reported as
 * missing with the reason, never guessed. MOEX in particular is unreachable
 * from many hosts outside Russia; after its first timeout the rest of its
 * quotes in the run are skipped instead of waiting out each one.
 */
import type { Asset, PriceSource } from "./assets.js";

export type Http = (url: string, opts?: { timeoutMs?: number; headers?: Record<string, string> }) => Promise<string>;

export interface Quote {
  price: number;
  /** Change over the source's last day, in percent. */
  changePct?: number;
  currency: string;
  source: string;
}

export interface QuoteResult {
  quotes: Map<string, Quote>;
  /** Symbol → why there is no quote. */
  missing: Map<string, string>;
}

const key = (a: Asset) => a.symbol.toUpperCase();

export async function fetchQuotes(assets: Asset[], http: Http): Promise<QuoteResult> {
  const quotes = new Map<string, Quote>();
  const missing = new Map<string, string>();
  const by = (src: PriceSource["source"]) => assets.filter((a) => a.price?.source === src);

  // CoinGecko: every coin in one call.
  const cg = by("coingecko");
  if (cg.length) {
    const ids = [...new Set(cg.map((a) => (a.price as { id: string }).id))];
    try {
      const body = JSON.parse(
        await http(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=usd&include_24hr_change=true`),
      ) as Record<string, { usd?: number; usd_24h_change?: number }>;
      for (const a of cg) {
        const row = body[(a.price as { id: string }).id];
        if (row?.usd !== undefined) {
          quotes.set(key(a), { price: row.usd, changePct: row.usd_24h_change, currency: "USD", source: "coingecko" });
        } else missing.set(key(a), "coingecko has no price for it");
      }
    } catch (err) {
      for (const a of cg) missing.set(key(a), `coingecko: ${(err as Error).message}`);
    }
  }

  await Promise.all(
    by("yahoo").map(async (a) => {
      const symbol = (a.price as { symbol: string }).symbol;
      try {
        const body = JSON.parse(
          await http(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`, {
            headers: { "user-agent": "Mozilla/5.0" },
          }),
        ) as { chart: { result?: { meta: { regularMarketPrice?: number; chartPreviousClose?: number; currency?: string } }[] } };
        const meta = body.chart.result?.[0]?.meta;
        if (!meta?.regularMarketPrice) throw new Error("no price");
        const prev = meta.chartPreviousClose;
        quotes.set(key(a), {
          price: meta.regularMarketPrice,
          changePct: prev ? ((meta.regularMarketPrice - prev) / prev) * 100 : undefined,
          currency: meta.currency ?? "USD",
          source: "yahoo",
        });
      } catch (err) {
        missing.set(key(a), `yahoo ${symbol}: ${(err as Error).message}`);
      }
    }),
  );

  const cbr = by("cbr");
  if (cbr.length) {
    try {
      const body = JSON.parse(await http("https://www.cbr-xml-daily.ru/daily_json.js")) as {
        Valute: Record<string, { Value: number; Previous: number; Nominal: number }>;
      };
      for (const a of cbr) {
        const code = (a.price as { code: string }).code;
        const v = body.Valute[code];
        if (!v) {
          missing.set(key(a), `cbr has no ${code}`);
          continue;
        }
        quotes.set(key(a), {
          price: v.Value / v.Nominal,
          changePct: ((v.Value - v.Previous) / v.Previous) * 100,
          currency: `RUB per ${code}`,
          source: "cbr",
        });
      }
    } catch (err) {
      for (const a of cbr) missing.set(key(a), `cbr: ${(err as Error).message}`);
    }
  }

  let moexDown: string | null = null;
  for (const a of by("moex")) {
    const { secid, board } = a.price as { secid: string; board?: string };
    if (moexDown) {
      missing.set(key(a), moexDown);
      continue;
    }
    try {
      const body = JSON.parse(
        await http(
          `https://iss.moex.com/iss/engines/stock/markets/shares/boards/${board ?? "TQBR"}/securities/${secid}.json` +
            `?iss.meta=off&iss.only=marketdata,securities&marketdata.columns=LAST,LASTTOPREVPRICE&securities.columns=PREVPRICE`,
          { timeoutMs: 8_000 },
        ),
      ) as { marketdata: { data: [number | null, number | null][] }; securities: { data: [number | null][] } };
      const [last, change] = body.marketdata.data[0] ?? [];
      const prev = body.securities.data[0]?.[0];
      // Before the session opens there is no LAST yet: yesterday's price, no move.
      if (last) quotes.set(key(a), { price: last, changePct: change ?? undefined, currency: "RUB", source: "moex" });
      else if (prev) quotes.set(key(a), { price: prev, currency: "RUB", source: "moex (previous close)" });
      else throw new Error(`no price for ${secid} on ${board ?? "TQBR"}`);
    } catch (err) {
      const msg = (err as Error).message;
      if (/abort|timeout|ECONN|fetch failed|ENOTFOUND|socket/i.test(msg)) moexDown = "MOEX is unreachable from this host";
      missing.set(key(a), moexDown ?? `moex ${secid}: ${msg}`);
    }
  }

  return { quotes, missing };
}
