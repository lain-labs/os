#!/usr/bin/env -S npx tsx
/**
 * Cut the next month of the content calendar from an X analytics export.
 *
 *   npm run content:mill -- \
 *     --content ~/Документы/account_analytics_content_….csv \
 *     --overview ~/Документы/account_overview_analytics.csv \
 *     --write
 *
 * Without --write it prints the scorecard and the next week and changes
 * nothing. With --write it replaces content-plan.json (the file the press
 * room reads at boot) and content-distribution.json (the paste-ready post
 * and the reply line for each day).
 *
 * The press room drafts from the plan at its usual hour. Publish that draft
 * or the paste-ready post, not both. Restart the daemon after --write so it
 * picks up the new calendar.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseContentAnalytics, parseOverviewAnalytics } from "../src/plugins/press/analytics.js";
import { runMill, type DistributionDay, type FormatScore } from "../src/plugins/press/mill.js";

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  if (at === -1) return undefined;
  const value = process.argv[at + 1];
  if (!value || value.startsWith("--")) return undefined;
  return value;
}

function tomorrow(): string {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function usage(): void {
  console.error(
    [
      "usage: npm run content:mill -- --content <posts.csv> --overview <days.csv> [--from YYYY-MM-DD] [--days 28] [--write]",
      "",
      "  --content        X content analytics export (one row per post)",
      "  --overview       X account overview export (one row per day)",
      "  --from           first day of the calendar (default: tomorrow)",
      "  --days           length of the calendar (default: 28)",
      "  --account        X account the posts publish from (default: @cyberia_chain)",
      "  --channel        Telegram channel the press room watches (default: cyberia_network)",
      "  --coin           native coin named in the wallet posts (default: CYBER)",
      "  --out            content plan path (default: content-plan.json)",
      "  --distribution   paste-ready sheet path (default: content-distribution.json)",
      "  --write          write both files; without it, this only prints",
    ].join("\n"),
  );
}

function scoreLine(score: FormatScore): string {
  const rate = score.impressions ? score.followsPer1k.toFixed(2) : "  —";
  return (
    `  ${score.id.padEnd(10)} ${String(score.posts).padStart(4)} posts` +
    `  ${String(score.impressions).padStart(7)} impr` +
    `  ${String(score.newFollowers).padStart(4)} fol` +
    `  ${String(score.profileVisits).padStart(4)} profile` +
    `  ${String(score.urlClicks).padStart(4)} clicks` +
    `  ${rate.padStart(7)} fol/1k`
  );
}

function dayLine(day: DistributionDay): string {
  const mark = day.status === "fallback" ? "FALLBACK" : "publish ";
  return `${day.date} ${day.day}  ${day.pillar.padEnd(8)} ${mark}`;
}

async function main(): Promise<void> {
  const contentPath = flag("--content");
  const overviewPath = flag("--overview");
  if (!contentPath || !overviewPath) {
    usage();
    process.exit(1);
  }
  const days = Number(flag("--days") ?? 28);
  if (!Number.isFinite(days) || days < 1) {
    console.error("--days must be a positive number");
    process.exit(1);
  }
  const from = flag("--from") ?? tomorrow();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    console.error("--from must be YYYY-MM-DD");
    process.exit(1);
  }
  const posts = parseContentAnalytics(await readFile(resolve(contentPath), "utf8"));
  const overview = parseOverviewAnalytics(await readFile(resolve(overviewPath), "utf8"));
  const result = runMill({
    posts,
    days: overview,
    from,
    count: days,
    account: flag("--account"),
    channel: flag("--channel"),
    coin: flag("--coin"),
  });

  console.log(`posts ${posts.length}   overview days ${overview.length}`);
  console.log("");
  console.log("format      posts     impr   fol  profile  clicks   fol/1k");
  for (const score of [...result.scorecard].sort((a, b) => b.followsPer1k - a.followsPer1k || b.posts - a.posts)) {
    if (score.posts === 0) continue;
    console.log(scoreLine(score));
  }
  console.log("");
  console.log(result.rhythm.reason);
  console.log("");
  console.log(`calendar ${result.plan.range.from} → ${result.plan.range.to}  (${result.plan.slots.length} days)`);
  for (const pillar of result.plan.pillars) {
    console.log(`  ${pillar.name} ${pillar.share ?? 0}%  ${pillar.what}`);
  }
  console.log("");
  const preview = result.distribution.slice(0, 7);
  for (const day of preview) {
    console.log(dayLine(day));
    console.log(day.post);
    console.log(`reply: ${day.reply}`);
    if (day.note) console.log(`note: ${day.note}`);
    console.log("");
  }
  if (result.distribution.length > preview.length) {
    console.log(`… ${result.distribution.length - preview.length} more days in the sheet`);
    console.log("");
  }

  if (!process.argv.includes("--write")) {
    console.log("dry run. pass --write to replace the plan and the distribution sheet.");
    return;
  }

  const planPath = resolve(flag("--out") ?? "content-plan.json");
  const sheetPath = resolve(flag("--distribution") ?? "content-distribution.json");
  await writeFile(planPath, JSON.stringify(result.plan, null, 2) + "\n", "utf8");
  const sheet = {
    account: result.plan.account,
    channel: result.plan.channel,
    rhythm: result.rhythm.reason,
    rule: "Publish one original post a day. The reply goes under someone else's post and carries the same action. Publish the press room's draft of a day or this post, not both.",
    scorecard: result.scorecard.filter((score) => score.posts > 0),
    days: result.distribution,
  };
  await writeFile(sheetPath, JSON.stringify(sheet, null, 2) + "\n", "utf8");
  console.log(`wrote ${planPath}`);
  console.log(`wrote ${sheetPath}`);
  console.log("restart the press daemon so it reads the new plan.");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
