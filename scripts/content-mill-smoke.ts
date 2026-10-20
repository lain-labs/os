#!/usr/bin/env -S npx tsx
/**
 * Content mill smoke test. No network, no model, no account export on disk.
 *
 * Pins the reading of an analytics export and the one decision the calendar
 * is not allowed to get wrong: the format that acquired the followers becomes
 * a weekly spike, replies never become the day's post, and a flood of posts
 * does not become the rhythm.
 *
 * Run: npm run content:smoke
 */
import { parseAnalyticsDate, parseContentAnalytics, parseOverviewAnalytics } from "../src/plugins/press/analytics.js";
import { calendarShape, classifyPost, runMill, scoreFormats } from "../src/plugins/press/mill.js";
import { parsePlan } from "../src/plugins/press/plan.js";

const results: [string, boolean][] = [];
const check = (name: string, pass: boolean) => results.push([name, pass]);

check("iso dates pass through     ", parseAnalyticsDate("2026-10-17") === "2026-10-17");
check("x export dates parse       ", parseAnalyticsDate("Sat, Oct 17, 2026") === "2026-10-17");
check("a garbage date is empty    ", parseAnalyticsDate("not a date") === "");

const content = [
  "Post ID,Date,Post text,Link,Impressions,Likes,Engagements,Bookmarks,Shares,New followers,Replies,Reposts,Profile visits,Detail expands,URL clicks",
  '1,"Sat, Sep 26, 2026","We\'ll provide the 10 CYBER you need to get your token started. Just reply to this post.",https://x.com/i/1,286,40,120,0,0,19,10,18,9,4,0',
  '2,"Sun, Oct 05, 2026","Cyberia Wallet v0.14 — the wallet is now a more complete operating layer.",https://x.com/i/2,156,10,40,0,0,1,2,2,12,6,0',
  '3,"Mon, Oct 06, 2026","You can create a token from the wallet. Name, ticker, supply.",https://x.com/i/3,140,8,30,0,0,0,1,1,9,2,0',
  '4,"Tue, Oct 07, 2026","@somebody when I see something like this, I want to resume my game",https://x.com/i/4,7488,20,26,0,0,0,1,0,6,0,0',
  '5,"Wed, Oct 08, 2026","Our cathedral is a network. Our scripture is source code.",https://x.com/i/5,48,5,8,0,0,0,0,1,2,0,0',
  '6,"Thu, Oct 09, 2026","New token on Cyberia Launchpad: SMTP https://t.co/abc",https://x.com/i/6,103,8,18,0,0,0,1,3,4,1,3',
  '7,"Fri, Oct 10, 2026","The DAO voted. The server is live. Here it is.",https://x.com/i/7,97,4,12,0,0,0,0,2,3,0,4',
  '8,"Sat, Oct 11, 2026","A quoted, comma, inside the text still parses",https://x.com/i/8,10,0,0,0,0,0,0,0,0,0,0',
  '9,"Sun, Oct 04, 2026","posted four times and gained nobody",https://x.com/i/9,40,0,1,0,0,0,0,0,0,0,0',
  '10,"Sun, Oct 04, 2026","posted four times and gained nobody, again",https://x.com/i/10,40,0,1,0,0,0,0,0,0,0,0',
  '11,"Sun, Oct 04, 2026","posted four times and gained nobody, third",https://x.com/i/11,40,0,1,0,0,0,0,0,0,0,0',
  '12,"Sun, Oct 04, 2026","posted four times and gained nobody, fourth",https://x.com/i/12,40,0,1,0,0,0,0,0,0,0,0',
].join("\n");

const posts = parseContentAnalytics(content);
check("every post is read         ", posts.length === 12);
check("a quoted comma survives    ", posts[7].text === "A quoted, comma, inside the text still parses");
check("follows land on the offer  ", posts[0].newFollowers === 19 && posts[0].date === "2026-09-26");
check("the grant post is an offer ", classifyPost(posts[0].text) === "offer");
check("a wallet post is proof     ", classifyPost(posts[1].text) === "proof");
check("an @ post is a reply       ", classifyPost(posts[3].text) === "reply");
check("a cathedral post is metaphor", classifyPost(posts[4].text) === "manifesto");
check("a launchpad post is a receipt", classifyPost(posts[5].text) === "receipt");
check(
  "a media link does not save a metaphor",
  classifyPost("Our cathedral is a network. Our scripture is source code. https://t.co/abc") === "manifesto",
);
check(
  "an action inside a metaphor stays proof",
  classifyPost("Alchemists tried. In Cyberia, you can create a token from your wallet.") === "proof",
);
check(
  "mentioning the launchpad is not a receipt",
  classifyPost("We can list your coins on our launchpad and more") === "other",
);

const russian = [
  "Идентификатор поста,Дата,Текст поста,Ссылка на пост,Показы,Нравится,Взаимодействия,Закладки,Поделились,Новые читатели,Ответы,Репосты,Посещения профиля,Разворачивания подробных сведений,Клики по URL-адресам",
  '9,"Mon, Oct 12, 2026","You can create a token from the wallet.",https://x.com/i/9,20,1,2,0,0,0,0,0,1,0,0',
].join("\n");
check("russian headers parse      ", parseContentAnalytics(russian)[0].impressions === 20);

const scores = scoreFormats(posts);
const offer = scores.find((score) => score.id === "offer")!;
const reply = scores.find((score) => score.id === "reply")!;
check("offer leads follows per 1k", offer.followsPer1k > reply.followsPer1k && offer.newFollowers === 19);
check("a reply's impressions do not make it the winner", reply.impressions > offer.impressions);

const overview = [
  "Date,Impressions,Engagements,New followers,Lost followers,Replies,Reposts,Profile visits,Posts created",
  '"Sat, Sep 26, 2026",508,124,20,1,2,14,13,2',
  '"Sun, Oct 04, 2026",7419,99,0,1,7,8,10,8',
  '"Mon, Oct 05, 2026",1550,55,4,0,4,11,7,2',
  '"Tue, Oct 06, 2026",1925,43,0,0,2,2,15,1',
  '"Wed, Oct 07, 2026",813,48,1,0,4,7,1,7',
  '"Thu, Oct 08, 2026",410,14,0,0,0,0,1,2',
  '"Fri, Oct 09, 2026",218,3,0,0,0,1,1,1',
  '"Sat, Oct 10, 2026",486,32,2,0,2,5,5,3',
  '"Sun, Oct 11, 2026",1360,45,3,0,2,6,3,4',
].join("\n");
const days = parseOverviewAnalytics(overview);
check("overview days parse        ", days.length === 9 && days[0].postsCreated === 2 && days[0].lostFollowers === 1);

const shape = calendarShape(scores);
check("a paid reply is not a pillar", shape.spike !== "offer" && !shape.daily.includes("offer"));
check("replies are not a daily pillar", !shape.daily.includes("reply"));
check("metaphor is not a daily pillar", !shape.daily.includes("manifesto"));

const result = runMill({ posts, days, from: "2026-10-19", count: 28, account: "@cyberia_chain", coin: "CYBER" });
check("the plan is one slot a day ", result.plan.slots.length === 28);
check("the plan stays english     ", result.plan.language === "en");
check(
  "no day pays for a reply      ",
  result.plan.slots.every((slot) => slot.pillar !== "Offer"),
);
check(
  "no day is a reply or a metaphor",
  result.plan.slots.every((slot) => slot.pillar !== "Reply" && slot.pillar !== "Manifesto"),
);
check(
  "the sheet never promises coins",
  result.distribution.every((day) => !/we send|10 CYBER|coins for a reply/i.test(`${day.post}\n${day.reply}`)),
);
check(
  "the plan names why the grant died",
  result.plan.rules.some((rule) => /banned/.test(rule) && /not used/.test(rule)),
);
check("a receipt with no launch falls back", result.distribution.some((day) => day.pillar === "Receipt" && day.status === "fallback"));
check("every day has a reply line ", result.distribution.every((day) => day.reply.length > 20));
check("rhythm names the flood     ", /4 or more/.test(result.rhythm.reason) && result.rhythm.postsPerDay === 1);
check("spike weekday is saturday  ", result.rhythm.spikeWeekday === "Sat");

const again = parsePlan(JSON.stringify(result.plan));
check("the written plan re-parses ", again.slots.length === 28 && again.account === "@cyberia_chain");

// A sustained proof account with no grant does not grow an offer day.
const proofOnly = parseContentAnalytics(
  [
    "Post ID,Date,Post text,Impressions,New followers,Profile visits,URL clicks",
    '1,"Mon, Oct 05, 2026","You can create a token from the wallet.",200,3,8,1',
    '2,"Tue, Oct 06, 2026","You can create a token from the wallet. Again, the form.",180,2,6,1',
    '3,"Wed, Oct 07, 2026","The wallet runs in the browser as an extension.",160,2,5,0',
    '4,"Thu, Oct 08, 2026","Adding liquidity is in the wallet.",140,1,4,0',
    '5,"Fri, Oct 09, 2026","The chain is still producing blocks.",120,1,3,0',
    '6,"Sat, Oct 10, 2026","@somebody nice thread",5000,0,1,0',
  ].join("\n"),
);
const noOffer = runMill({
  posts: proofOnly,
  days: parseOverviewAnalytics(
    [
      "Date,New followers,Posts created,Impressions",
      '"Mon, Oct 05, 2026",3,1,200',
      '"Tue, Oct 06, 2026",2,1,180',
      '"Wed, Oct 07, 2026",2,1,160',
    ].join("\n"),
  ),
  from: "2026-10-19",
  count: 7,
});
check("no grant means no offer day", noOffer.plan.slots.every((slot) => slot.pillar !== "Offer"));
check("proof carries a week of no grant", noOffer.plan.slots.every((slot) => slot.pillar === "Proof"));

let refused = false;
try {
  parseContentAnalytics("Post ID,Date\n1,2026-10-01\n");
} catch {
  refused = true;
}
check("a export missing columns throws", refused);

const failed = results.filter(([, pass]) => !pass);
for (const [name, pass] of results) console.log(`${pass ? "ok  " : "FAIL"} ${name}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
