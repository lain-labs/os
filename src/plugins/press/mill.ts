/**
 * The content mill. It reads what the account's posts actually did and writes
 * the next month of the press-room calendar from that, plus a paste-ready
 * post and one reply for each day.
 *
 * The press room already writes one post a day from `content-plan.json`. What
 * it did not do is decide the calendar. A month of manifesto posts and reply
 * jokes spends the impressions and does not bring anyone who uses the product.
 * The mill's job is to keep the calendar on something a person can do.
 *
 * Two formats are scored and then never scheduled. A reply is distribution:
 * the same action, under someone else's post. A paid reply (coins for a
 * reply) is disqualified outright. It selects people who came for the
 * transfer, it is the pattern that gets the account banned, and the follows
 * it buys are not users.
 */

import type { AnalyticsPost, OverviewDay } from "./analytics.js";
import type { ContentPlan, PostSlot } from "./plan.js";

export const FORMATS = ["offer", "proof", "receipt", "manifesto", "reply", "other"] as const;
export type FormatId = (typeof FORMATS)[number];

export interface FormatScore {
  id: FormatId;
  posts: number;
  impressions: number;
  engagements: number;
  newFollowers: number;
  profileVisits: number;
  urlClicks: number;
  reposts: number;
  /** Follows X attributed to the post, per thousand impressions. */
  followsPer1k: number;
  profilePer1k: number;
  engageRate: number;
}

export interface Rhythm {
  postsPerDay: 1;
  /** Why the day is one original post. */
  reason: string;
  /** Weekday the acquisition post lands on, when the leading format is a spike. */
  spikeWeekday: string;
  postingDays: number;
  floodDays: number;
  followersPerPostLean: number;
  followersPerPostFlood: number;
}

export interface DistributionDay {
  date: string;
  day: string;
  pillar: string;
  /**
   * `publish` — the post can go out as written.
   * `fallback` — nothing live was known when the plan was cut, so the post is
   * the standing proof. Replace it if a token, a zone or a proposal actually
   * went live.
   */
  status: "publish" | "fallback";
  post: string;
  /** The line to reply with under someone else's post. Same action, shorter. */
  reply: string;
  note: string;
}

export interface MillResult {
  scorecard: FormatScore[];
  rhythm: Rhythm;
  plan: ContentPlan;
  distribution: DistributionDay[];
}

export interface MillInput {
  posts: AnalyticsPost[];
  days: OverviewDay[];
  /** First day of the calendar, YYYY-MM-DD. */
  from: string;
  /** Length of the calendar. Default 28. */
  count?: number;
  account?: string;
  channel?: string;
  audience?: string;
  /** Native coin named in the wallet posts. Default CYBER. */
  coin?: string;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const WEEKDAY_PREFERENCE = ["Sat", "Sun", "Fri", "Thu", "Wed", "Tue", "Mon"];

interface Beat {
  pillar: string;
  primary: string;
  asset: string;
  cta: string;
  post: string;
  reply: string;
  status: "publish" | "fallback";
  note: string;
}

/** Which machine format a historical post belongs to. First match wins. */
export function classifyPost(text: string): FormatId {
  const raw = text.trim();
  const l = raw.toLowerCase();
  if (isOffer(l)) return "offer";
  if (/^\s*@[\w_]+/.test(raw)) return "reply";
  if (isManifesto(l)) return "manifesto";
  if (isReceipt(l)) return "receipt";
  if (isProof(l)) return "proof";
  return "other";
}

function isOffer(l: string): boolean {
  if (/reply to this post/.test(l)) return true;
  if (/(we['’]ll|we will) provide/.test(l) && /cyber/.test(l)) return true;
  if (/\b\d+\s*cyber\b/.test(l) && /reply/.test(l)) return true;
  return false;
}

function isManifesto(l: string): boolean {
  const poetic =
    /cathedral|scripture|alchemist|alchemy|civilization|while you sleep|occult|congregation|divine intervention|rituals are transactions/.test(
      l,
    );
  if (!poetic) return false;
  // A metaphor wrapped around a real action is still the action. A t.co on the
  // end of a post is usually the image, so a link alone does not save it.
  // Naming "the wallet" inside a list of metaphors is not an action either.
  if (/reply to this post|download|install|launchpad|from (the|your) wallet|you can/.test(l)) return false;
  return true;
}

function isReceipt(l: string): boolean {
  // "Launchpad" alone is a capability. A receipt is something that just went live.
  return /new token|just bought|new dao proposal|dao voted|stream is live|server is live/.test(l);
}

function isProof(l: string): boolean {
  return /wallet|chrome web store|web store|agent|linux|distribution|\bblocks\b|foundation|\bdns\b|liquidity|\biso\b|operating layer|extension|digest/.test(
    l,
  );
}

function rate(part: number, whole: number, scale = 1): number {
  if (whole <= 0) return 0;
  return (part / whole) * scale;
}

export function scoreFormats(posts: AnalyticsPost[]): FormatScore[] {
  const buckets = new Map<FormatId, AnalyticsPost[]>();
  for (const id of FORMATS) buckets.set(id, []);
  for (const post of posts) buckets.get(classifyPost(post.text))!.push(post);
  return FORMATS.map((id) => {
    const rows = buckets.get(id)!;
    const sum = (key: keyof AnalyticsPost) => rows.reduce((acc, row) => acc + Number(row[key] ?? 0), 0);
    const impressions = sum("impressions");
    const engagements = sum("engagements");
    const newFollowers = sum("newFollowers");
    const profileVisits = sum("profileVisits");
    return {
      id,
      posts: rows.length,
      impressions,
      engagements,
      newFollowers,
      profileVisits,
      urlClicks: sum("urlClicks"),
      reposts: sum("reposts"),
      followsPer1k: rate(newFollowers, impressions, 1000),
      profilePer1k: rate(profileVisits, impressions, 1000),
      engageRate: rate(engagements, impressions),
    };
  });
}

function inWindow(days: OverviewDay[], posts: AnalyticsPost[]): OverviewDay[] {
  if (!posts.length) return days;
  const from = posts.reduce((min, post) => (post.date < min ? post.date : min), posts[0].date);
  const to = posts.reduce((max, post) => (post.date > max ? post.date : max), posts[0].date);
  const sliced = days.filter((day) => day.date >= from && day.date <= to);
  return sliced.length ? sliced : days;
}

interface DayBucket {
  posts: number;
  followers: number;
}

/** Posts per day from the content export. The overview's "posts created" column is a different counter. */
function postsByDay(posts: AnalyticsPost[]): Map<string, DayBucket> {
  const byDay = new Map<string, DayBucket>();
  for (const post of posts) {
    const bucket = byDay.get(post.date) ?? { posts: 0, followers: 0 };
    bucket.posts += 1;
    bucket.followers += post.newFollowers;
    byDay.set(post.date, bucket);
  }
  return byDay;
}

function perBucket(rows: DayBucket[]): number {
  const postCount = rows.reduce((sum, row) => sum + row.posts, 0);
  const followers = rows.reduce((sum, row) => sum + row.followers, 0);
  return postCount > 0 ? followers / postCount : 0;
}

/**
 * One original post a day. Counted from the content export: days with four or
 * more posts against quieter days, followers attributed to the posts themselves.
 * The overview still decides which weekday grows the account.
 */
export function postingRhythm(days: OverviewDay[], posts: AnalyticsPost[]): Rhythm {
  const window = inWindow(days, posts);
  // Paid replies buy the follow and are left out of the rate, or one grant
  // post makes every quieter day look like it "worked".
  const counted = posts.filter((post) => classifyPost(post.text) !== "offer");
  const paidFollows = posts
    .filter((post) => classifyPost(post.text) === "offer")
    .reduce((sum, post) => sum + post.newFollowers, 0);
  const paidPosts = posts.length - counted.length;
  const groups = [...postsByDay(counted).values()];
  const lean = groups.filter((row) => row.posts <= 3);
  const flood = groups.filter((row) => row.posts >= 4);
  const leanRate = perBucket(lean);
  const floodRate = perBucket(flood);
  const byWeekday = new Map<string, { followers: number; impressions: number }>();
  for (const name of DAY_NAMES) byWeekday.set(name, { followers: 0, impressions: 0 });
  for (const day of window) {
    const bucket = byWeekday.get(weekday(day.date))!;
    bucket.followers += day.newFollowers;
    bucket.impressions += day.impressions;
  }
  const spikeWeekday = [...byWeekday.entries()].sort((a, b) => {
    if (b[1].followers !== a[1].followers) return b[1].followers - a[1].followers;
    if (b[1].impressions !== a[1].impressions) return b[1].impressions - a[1].impressions;
    return WEEKDAY_PREFERENCE.indexOf(a[0]) - WEEKDAY_PREFERENCE.indexOf(b[0]);
  })[0][0];

  const accountFollowers = window.reduce((sum, day) => sum + day.newFollowers, 0);
  const disqualified = paidPosts
    ? `Paid replies are disqualified (${paidPosts} post${paidPosts === 1 ? "" : "s"}, ${paidFollows} attributed follows). ` +
      `A coin for a reply got the account banned and the coins were not used, so that follow count is not a result. `
    : "";
  let reason: string;
  if (flood.length && lean.length && floodRate < leanRate) {
    reason =
      disqualified +
      `Days with 1–3 posts gained ${leanRate.toFixed(2)} follows per post, attributed to the post, excluding paid replies. ` +
      `Days with 4 or more gained ${floodRate.toFixed(2)}. The machine writes one original post a day. ` +
      `Replies do not count as that post.`;
  } else if (groups.length) {
    reason =
      disqualified +
      `One original post a day. Across ${groups.length} days with posts, ` +
      `${counted.reduce((sum, post) => sum + post.newFollowers, 0)} follows were attributed to posts other than paid replies` +
      (accountFollowers ? `, and the account gained ${accountFollowers} followers in the same window` : "") +
      `. Replies do not count as that post.`;
  } else {
    reason = disqualified + "One original post a day. Replies do not count as that post.";
  }

  return {
    postsPerDay: 1,
    reason,
    spikeWeekday,
    postingDays: groups.length,
    floodDays: flood.length,
    followersPerPostLean: leanRate,
    followersPerPostFlood: floodRate,
  };
}

function weekday(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return DAY_NAMES[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

function addDays(iso: string, days: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** A format may occupy the calendar when it has actually moved someone, or when people clicked through. */
function earnsPillar(score: FormatScore): boolean {
  // Replies are distribution. Metaphor has no action. A paid reply buys a
  // follow from someone who came for the transfer and gets the account banned.
  // None of those three is a day on the calendar, whatever the export counted.
  if (score.id === "reply" || score.id === "manifesto" || score.id === "offer" || score.posts === 0) return false;
  return score.newFollowers > 0 || score.urlClicks >= 3 || (score.profileVisits >= 8 && score.posts >= 2);
}

function byAcquisition(a: FormatScore, b: FormatScore): number {
  if (b.followsPer1k !== a.followsPer1k) return b.followsPer1k - a.followsPer1k;
  if (b.newFollowers !== a.newFollowers) return b.newFollowers - a.newFollowers;
  return b.profilePer1k - a.profilePer1k;
}

interface CalendarShape {
  /** Format that lands only on the spike weekday. Null when the leader is strong enough to be daily. */
  spike: FormatId | null;
  /** Daily formats, best first. The first takes two days out of three. */
  daily: FormatId[];
}

export function calendarShape(scorecard: FormatScore[]): CalendarShape {
  const ranked = scorecard.filter(earnsPillar).sort(byAcquisition);
  if (!ranked.length) return { spike: null, daily: ["proof"] };
  const leader = ranked[0];
  // A format with a handful of posts and a huge rate is a spike, not a daily voice.
  const spike = leader.posts < 5 ? leader.id : null;
  const rest = ranked.filter((score) => score.id !== spike);
  const daily = (rest.length ? rest : ranked).map((score) => score.id);
  if (!daily.length) daily.push("proof");
  return { spike, daily: daily.slice(0, 2) };
}

function tokenBeat(coin: string): Beat {
  return {
    pillar: "Proof",
    primary:
      "A person creates a token from the wallet. Four fields only: name, ticker, supply, and the transaction that sends it. " +
      "No application and no one who approves it. Do not add a second feature.",
    asset: "The wallet screen with those four fields visible. Crop out anything that is not the form.",
    cta: "Which ticker would you actually launch?",
    post: [
      "You can create a token from the wallet.",
      "",
      "Name. Ticker. Supply. One transaction.",
      "",
      "No application, and no one to approve it.",
      "",
      "Which ticker would you actually launch?",
    ].join("\n"),
    reply: "The wallet creates the token. Name, ticker, supply, one transaction. Which ticker would you launch?",
    status: "publish",
    note: "Attach the wallet form. The post does not describe the picture.",
  };
}

function walletBeat(): Beat {
  return {
    pillar: "Proof",
    primary:
      "The wallet runs in the browser. A person can hold the network coin, create a token, and send either one without leaving it. " +
      "One surface, one session. Do not list a changelog.",
    asset: "A phone or a browser window with the wallet open on a balance.",
    cta: "What would you send first, the coin or a token you just made?",
    post: [
      "The wallet runs in the browser.",
      "",
      "Hold the coin. Create a token. Send either one. Same window.",
      "",
      "What would you send first, the coin or a token you just made?",
    ].join("\n"),
    reply: "The wallet runs in the browser: hold the coin, create a token, send either one. What would you send first?",
    status: "publish",
    note: "Attach the open wallet. Do not mention a version number unless the material names one.",
  };
}

function blocksBeat(): Beat {
  return {
    pillar: "Proof",
    primary:
      "The chain is still producing blocks, and it does not pause for a post. " +
      "Use a block height only if today's material states it. Otherwise do not write a number. " +
      "The point is that it kept going.",
    asset: "A block explorer page showing a recent block. The height must be the one on screen, not a remembered one.",
    cta: "What would you run on a network that does not take a day off?",
    post: [
      "The chain is still producing blocks.",
      "",
      "The next one does not wait for a post.",
      "",
      "What would you run on a network that does not take a day off?",
    ].join("\n"),
    reply: "The chain is still producing blocks. The next one does not wait for a post.",
    status: "publish",
    note: "If you know today's height, put that number in the post in place of the second line's claim. Do not guess it.",
  };
}

function liquidityBeat(coin: string): Beat {
  return {
    pillar: "Proof",
    primary:
      `Adding liquidity is a path in the wallet: Wallet, then More, then Liquidity, then Add. ` +
      `Two assets. The first is ${coin} unless the person changes it. Give the path and stop.`,
    asset: "The Add-liquidity screen, both asset pickers visible.",
    cta: "Which pair would you fund with a small amount?",
    post: [
      "Adding liquidity is in the wallet.",
      "",
      `Wallet, then More, then Liquidity, then Add. Two assets. The first is ${coin} unless you change it.`,
      "",
      "Which pair would you fund with a small amount?",
    ].join("\n"),
    reply: `Liquidity is in the wallet: More, then Liquidity, then Add. The first asset is ${coin}. Which pair would you fund?`,
    status: "publish",
    note: "Attach the Add screen.",
  };
}

function osBeat(): Beat {
  return {
    pillar: "Proof",
    primary:
      "Cyberia OS boots. Say what a person does after boot that they came for: the wallet, the chain, a terminal that already knows the network. " +
      "The download link is attached, not pasted as a magnet URI inside the sentence. " +
      "Do not invent a new base distribution. Mint is the one this image was built from, and only say Ubuntu if the operator is actually offering that choice.",
    asset: "The boot screen, or the desktop with the wallet open. Attach the download link the operator already has.",
    cta: "Would you install it this week?",
    post: [
      "Cyberia OS boots.",
      "",
      "After the desktop comes up, the wallet is there and it is already on this chain.",
      "",
      "The download is the link on this post.",
      "",
      "Would you install it this week?",
    ].join("\n"),
    reply: "Cyberia OS boots into a desktop with the wallet already on this chain. The download is on the post.",
    status: "publish",
    note: "Attach the image link you are willing to support. If the image is not actually downloadable today, skip this post and publish the token one.",
  };
}

function proofWheel(coin: string): Beat[] {
  return [tokenBeat(coin), walletBeat(), blocksBeat(), liquidityBeat(coin), osBeat()];
}

/** A receipt day with nothing known to be live keeps a real post, and says so. */
function asReceipt(beat: Beat): Beat {
  return {
    ...beat,
    pillar: "Receipt",
    status: "fallback",
    primary:
      "Something went live since the last post: a token on the launchpad, a zone, a proposal, a download. " +
      "Name it, give one link, and ask the reader to open it. " +
      "If the material names nothing that went live, do not invent one. Write the fallback below and do not pretend a launch happened: " +
      beat.primary,
    note:
      "HOLD the receipt until something is actually live. The text above is the fallback. " +
      "If a token, a zone, or a proposal went live, replace this post with its name, one link, and 'Open it.'",
  };
}

function pillarShare(slots: PostSlot[], name: string): number {
  if (!slots.length) return 0;
  return Math.round((slots.filter((slot) => slot.pillar === name).length / slots.length) * 100);
}

const PILLAR_COPY: Record<string, string> = {
  Proof: "One thing a person can do today: create a token, open the wallet, add liquidity, or boot the OS. One surface, then one action. Nobody is paid to show up.",
  Receipt: "Something that just went live, named, with one link. When nothing went live, the day becomes the token-creation proof. Never invent a launch.",
  Manifesto: "A metaphor with no action. The history of this account says it does not acquire. It is on the calendar only because the export gave it the followers.",
  Action: "One thing a person can do, taken from what actually shipped. The export had no format that acquired anyone, so the day stays concrete anyway.",
};

/**
 * Build the next calendar and the paste-ready sheet from one analytics export.
 * Same inputs, same plan: there is no clock in here. `from` is the first day.
 */
export function runMill(input: MillInput): MillResult {
  const count = Math.max(1, Math.min(60, Math.round(input.count ?? 28)));
  const coin = (input.coin ?? "CYBER").trim() || "CYBER";
  const scorecard = scoreFormats(input.posts);
  const rhythm = postingRhythm(input.days, input.posts);
  const shape = calendarShape(scorecard);

  const slots: PostSlot[] = [];
  const distribution: DistributionDay[] = [];
  // One wheel, so a receipt fallback is not the same post as the proof day next to it.
  const wheel = proofWheel(coin);
  let wheelAt = 0;
  const nextBeat = (): Beat => {
    const beat = wheel[wheelAt % wheel.length];
    wheelAt += 1;
    return beat;
  };

  let dailyOrdinal = 0;
  for (let i = 0; i < count; i++) {
    const date = addDays(input.from, i);
    const day = weekday(date);
    const spiked = shape.spike !== null && day === rhythm.spikeWeekday;
    let beat: Beat;
    if (spiked) {
      beat = { ...nextBeat(), pillar: pillarName(shape.spike!) };
    } else {
      const format = nextDaily(shape.daily, dailyOrdinal++);
      const body = nextBeat();
      beat = format === "receipt" ? asReceipt(body) : format === "proof" ? body : { ...body, pillar: pillarName(format) };
    }
    slots.push({
      date,
      day,
      pillar: beat.pillar,
      primary: beat.primary,
      asset: beat.asset,
      cta: beat.cta,
    });
    distribution.push({
      date,
      day,
      pillar: beat.pillar,
      status: beat.status,
      post: beat.post,
      reply: beat.reply,
      note: beat.note,
    });
  }

  const windowFrom = input.posts.reduce((min, post) => (post.date < min ? post.date : min), input.posts[0]?.date ?? input.from);
  const windowTo = input.posts.reduce((max, post) => (post.date > max ? post.date : max), input.posts[0]?.date ?? input.from);
  const overview = inWindow(input.days, input.posts);
  const gained = overview.reduce((sum, day) => sum + day.newFollowers, 0);
  const lost = overview.reduce((sum, day) => sum + day.lostFollowers, 0);
  const attributed = input.posts.reduce((sum, post) => sum + post.newFollowers, 0);

  const used = [...new Set(slots.map((slot) => slot.pillar))];
  const plan: ContentPlan = {
    title: "Acquisition calendar",
    source:
      `Content mill over the X export ${windowFrom} to ${windowTo}: ${input.posts.length} posts, ` +
      `${attributed} follows attributed to posts. Account-level in that window: ${gained} new, ${lost} lost, net ${gained - lost}. ` +
      rhythm.reason,
    account: input.account?.trim() || "@cyberia_chain",
    channel: input.channel?.trim() || "cyberia_network",
    language: "en",
    audience:
      input.audience?.trim() ||
      "A person who will create a token, open the wallet, or install the OS without being paid to show up. Not a developer, and not someone collecting a transfer.",
    goal: "One person does one thing in the product: creates a token, opens the wallet, adds liquidity, or installs the OS.",
    rhythm: rhythm.reason,
    pillars: used.map((name) => ({
      name,
      share: pillarShare(slots, name),
      what: PILLAR_COPY[name] ?? PILLAR_COPY.Action,
    })),
    rules: rulesFor(rhythm),
    voice: [
      "Two to six short lines. One action in the product.",
      "One number, and only a number this brief or the material already states.",
      "No metaphor stack. Name the thing and the action.",
      "No hashtags, no emoji, no markdown.",
      "No payment for attention. No grant, no airdrop, no coins for a reply, a follow, or a repost.",
      "The account's own post is never a reply to someone else. Replies are a separate sheet and they carry the same action.",
      "End on the day's CTA. The CTA is something the reader does in the product.",
    ],
    range: { from: slots[0].date, to: slots[slots.length - 1].date },
    slots,
  };

  return { scorecard, rhythm, plan, distribution };
}

function pillarName(id: FormatId): string {
  switch (id) {
    case "offer":
      return "Offer";
    case "proof":
      return "Proof";
    case "receipt":
      return "Receipt";
    case "manifesto":
      return "Manifesto";
    default:
      return "Action";
  }
}

function nextDaily(daily: FormatId[], ordinal: number): FormatId {
  if (daily.length === 1) return daily[0];
  // Two of the leader, then one of the second. 16 and 8 across 24 days.
  return ordinal % 3 === 2 ? daily[1] : daily[0];
}

function rulesFor(rhythm: Rhythm): string[] {
  return [
    rhythm.reason,
    "Never pay for a reply, a follow, or a repost. The post that promised coins for a reply got the account banned, the coins were not used, and the people who showed up came for the transfer.",
    "A reply under someone else's post is distribution. It repeats today's action in one or two lines. It does not joke about their topic, it does not offer coins, and it is not the day's post.",
    "A receipt day with nothing live becomes the standing proof for that day. Never invent a launch, a buy, a partner, a block height, or a download that is not the one the operator attaches.",
    "One link, and only when the action needs it. Do not paste a magnet URI into the sentence.",
    "Do not post about a ban, a meme, or someone else's game. Those days collected the impressions and did not collect the followers.",
    "Do not publish a second original thesis the same day. The asset can be a second message. A second idea cannot.",
  ];
}
