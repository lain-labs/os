/**
 * What the timeline is loud about, and whether this account should touch it.
 *
 * A loud topic is not a post. Politics, a war clip, and a points campaign buy
 * replies from people who will not open the wallet. A price flush or a
 * memecoin callout can be a post, because the reader can do something else
 * with that hour: create a token, or open the wallet. A figure from the
 * timeline is repeated only when two items carry the same one.
 */

export interface TrendHit {
  title: string;
  url?: string;
  source: string;
  score?: number;
}

export interface TrendBrief {
  id: string;
  label: string;
  verdict: "use" | "skip";
  why: string;
  mentions: number;
  hits: TrendHit[];
  post?: string;
  reply?: string;
}

interface Lane {
  id: string;
  label: string;
  verdict: "use" | "skip";
  why: string;
  test: RegExp;
  draft?: (figure: string | null) => { post: string; reply: string };
}

const LANES: Lane[] = [
  {
    id: "politics",
    label: "Politics",
    verdict: "skip",
    why: "A scandal is loud and it is not the product. Repeating it does not get the wallet opened.",
    test: /\b(trump|vance|biden|pardons?|white house|congress|election)\b/i,
  },
  {
    id: "violence",
    label: "Violence",
    verdict: "skip",
    why: "A clip of a fire or a war is not a reason to post.",
    test: /\b(civil war|burnt down|burned down|assassina|airstrike)\b/i,
  },
  {
    id: "airdrop",
    label: "Points and airdrops",
    verdict: "skip",
    why: "A points balance, a whitelist, or a reply-for-coins post is the audience that shows up for a transfer and does not use the product.",
    test: /\b(airdrops?|whitelists?|freemints?|galxe|zealy|zaps|points balance|reply to (this|win)|giveaways?)\b/i,
  },
  {
    id: "regulation",
    label: "Regulation rumor",
    verdict: "skip",
    why: "A single 'SEC confirmed' post is not a fact to repeat. Wait until the same claim shows up as a document.",
    test: /\b(sec|cftc|regulator|regulation)\b/i,
  },
  {
    id: "leverage",
    label: "Leverage flush",
    verdict: "use",
    why: "The timeline is a liquidation chart. The post is the thing a person can do instead of watching it.",
    test: /\b(liquidat\w*|longs?|bitcoin|ethereum)\b|\$btc|\bbtc\b|\$eth|\beth\b/i,
    draft: leverageDraft,
  },
  {
    id: "memecoin",
    label: "Memecoin callouts",
    verdict: "use",
    why: "A callout is not a token. The post is the four fields that actually create one.",
    test: /\b(memecoin|meme coin|pump\.fun|fair launch|callout)\b/i,
    draft: calloutDraft,
  },
  {
    id: "wallet",
    label: "Wallets",
    verdict: "use",
    why: "People are comparing wallets. The post is what a person does in this one, with no market-share table.",
    test: /\b(wallet|metamask|phantom|self-custody)\b/i,
    draft: () => walletDraft(),
  },
];

function leverageDraft(figure: string | null): { post: string; reply: string } {
  const line = figure
    ? `BTC is around ${figure} and the timeline is a liquidation chart.`
    : "The timeline is a liquidation chart.";
  return {
    post: [
      line,
      "",
      "A token does not need a long.",
      "",
      "Name. Ticker. Supply. One transaction.",
      "",
      "Which ticker would you launch while that chart is open?",
    ].join("\n"),
    reply: figure
      ? `BTC is around ${figure} and the timeline is liquidations. A token is still name, ticker, supply, one transaction.`
      : "The timeline is liquidations. A token is still name, ticker, supply, one transaction.",
  };
}

function calloutDraft(): { post: string; reply: string } {
  return {
    post: [
      "A callout is not a token.",
      "",
      "A token is a name, a ticker, a supply, and the transaction that creates it.",
      "",
      "Which ticker would you actually launch?",
    ].join("\n"),
    reply: "A callout is not a token. Name, ticker, supply, one transaction. Which ticker would you launch?",
  };
}

function walletDraft(): { post: string; reply: string } {
  return {
    post: [
      "The wallet runs in the browser.",
      "",
      "Hold the coin. Create a token. Send either one. Same window.",
      "",
      "What would you send first, the coin or a token you just made?",
    ].join("\n"),
    reply: "The wallet runs in the browser: hold the coin, create a token, send either one. What would you send first?",
  };
}

/** A figure that at least two items state. One account's number stays out of the post. */
export function corroboratedFigure(hits: TrendHit[]): string | null {
  const counts = new Map<string, { display: string; n: number }>();
  for (const hit of hits) {
    const found = hit.title.match(/\$?\d{1,3}(?:,\d{3})+(?:\.\d+)?|\b\d{2,3}k\b/gi) ?? [];
    const seen = new Set<string>();
    for (const raw of found) {
      const key = raw.replace(/[$,]/g, "").toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const prior = counts.get(key);
      counts.set(key, { display: raw.replace(/^\$/, ""), n: (prior?.n ?? 0) + 1 });
    }
  }
  const winner = [...counts.values()].filter((row) => row.n >= 2).sort((a, b) => b.n - a.n)[0];
  return winner?.display ?? null;
}

function laneFor(title: string): Lane | undefined {
  return LANES.find((lane) => lane.test.test(title));
}

/**
 * Group a pile of posts and headlines into a short brief. Lanes with nothing
 * in them are omitted. Usable topics come first.
 */
export function briefTrends(hits: TrendHit[]): TrendBrief[] {
  const groups = new Map<string, { lane: Lane; hits: TrendHit[] }>();
  for (const hit of hits) {
    const title = hit.title?.trim();
    if (!title) continue;
    const lane = laneFor(title);
    if (!lane) continue;
    const group = groups.get(lane.id) ?? { lane, hits: [] };
    group.hits.push(hit);
    groups.set(lane.id, group);
  }
  const briefs: TrendBrief[] = [];
  for (const { lane, hits: grouped } of groups.values()) {
    const figure = lane.verdict === "use" ? corroboratedFigure(grouped) : null;
    const draft = lane.verdict === "use" ? lane.draft?.(figure) : undefined;
    briefs.push({
      id: lane.id,
      label: lane.label,
      verdict: lane.verdict,
      why: lane.why,
      mentions: grouped.length,
      hits: grouped.slice(0, 5),
      post: draft?.post,
      reply: draft?.reply,
    });
  }
  return briefs.sort((a, b) => {
    if (a.verdict !== b.verdict) return a.verdict === "use" ? -1 : 1;
    return b.mentions - a.mentions;
  });
}
