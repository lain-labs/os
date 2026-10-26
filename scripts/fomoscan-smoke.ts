#!/usr/bin/env -S npx tsx
/**
 * Fomoscan smoke test (headless, fake fetch).
 *
 * Pinned here:
 *   1. both walls are read with the key as a Bearer header and the token in the path;
 *   2. each line carries the author's position next to the words — holding, out, unknown;
 *   3. a wall that failed is "unreadable", never "none"; a 404 is an empty wall;
 *   4. the tool is off without FOMOSCAN_API_KEY.
 *
 * Run: npm run fomoscan:smoke
 */
import assert from "node:assert/strict";
import { Fomoscan, fomoscanPlugin, wallsReport } from "../src/plugins/fomoscan/index.js";

const seen: { url: string; auth: string | null }[] = [];
const fake = (routes: Record<string, [number, unknown]>) =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    const [status, body] = hit ? hit[1] : [404, {}];
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;

const mint = "So1anaMint1111111111111111111111111111pump";
const api = new Fomoscan("fsk_test_x", fake({
  "/v2/thesis/token/": [200, { items: [
    { authorHandle: "alice", thesis: "dev ships every day", holdingsUsd: 420, realizedPnlUsd: 0, unrealizedPnlUsd: 120 },
    { authorHandle: "bob", authorIsDev: true, thesis: "send it", closedAt: "2026-10-26T00:00:00Z", realizedPnlUsd: -35 },
  ] }],
  "/v2/pump/thesis/token/": [200, { items: [
    { userName: "carol", xUsername: "carol_x", isVerified: true, thesis: "early", calledOutAtMcap: 12000, multiple: 2.5, position: { valueUsd: 80, pnlUsd: 48, isExited: false } },
    { userName: "dave", thesis: "100x", position: null },
  ] }],
}));

const walls = await api.walls(mint);
assert.equal(seen.length, 2);
assert.ok(seen.every((s) => s.auth === "Bearer fsk_test_x"));
assert.ok(seen.some((s) => s.url.endsWith(`/v2/thesis/token/${mint}?limit=20`)));
assert.ok(seen.some((s) => s.url.endsWith(`/v2/pump/thesis/token/${mint}`)));

const text = wallsReport(walls);
assert.match(text, /Fomo theses: 2 — 1 still holding, 1 already out/);
assert.match(text, /@alice \[holds \$420, \+\$120\]/);
assert.match(text, /@bob \(dev\) \[out, −\$35\]/);
assert.match(text, /pump\.fun callouts: 2 — 1 still holding, 0 already out, 1 unknown/);
assert.match(text, /carol \(x: @carol_x\) ✓ \[holds \$80, \+\$48\] · called at \$12,000 mcap, now 2\.50×/);
assert.match(text, /dave \[position unknown\]/);

const broken = await new Fomoscan("k", fake({ "/v2/thesis/token/": [500, {}] })).walls(mint);
assert.equal(broken.theses, null);
assert.deepEqual(broken.callouts, []);
const brokenText = wallsReport(broken);
assert.match(brokenText, /Fomo theses: unreadable/);
assert.match(brokenText, /pump\.fun callouts: none/);
assert.match(brokenText, /! fomo theses: HTTP 500/);

delete process.env.FOMOSCAN_API_KEY;
const action = fomoscanPlugin.actions!.find((a) => a.name === "social_calls")!;
assert.equal(await action.validate({} as never, {} as never), false);

console.log("fomoscan smoke: ok");
