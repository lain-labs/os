#!/usr/bin/env -S npx tsx
/** AI-resource readings: units, partial failures, credential isolation and live context. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { usageLimits } from "../src/models/limits.js";
import { bootstrapPlugin } from "../src/plugins/bootstrap/index.js";
import { aiResourcesProvider, aiUsageAction, formatAiCredits, readAiCredits } from "../src/plugins/bootstrap/usage.js";
import type { IAgentRuntime, State } from "../src/types.js";

const setting = (values: Record<string, string>) => (key: string) => values[key];
const secret = "private-provider-credential";
const lainSecret = "private-lain-credential";
const keyData = {
  label: secret,
  limit: null, limit_remaining: null, usage: 0.005,
  free_model_daily_requests: { used: 26, limit: 1000, remaining: 974 },
};
let calls: string[] = [];
const api = (key: unknown = keyData, credits: unknown = { total_credits: 10, total_usage: 2.25 }, lain: unknown = {
  balance_microdollars: 1234567, pace: { staking_per_day_microdollars: 300000 },
}): typeof fetch => (async (url, options) => {
  const path = String(url);
  calls.push(path);
  assert.equal(options?.redirect, "error");
  assert.equal(options?.method ?? "GET", "GET");
  assert.ok(options?.signal);
  assert.equal(objectHeaders(options).Authorization, `Bearer ${path.startsWith("https://lain-os.com/") ? lainSecret : secret}`);
  if (path.endsWith("/key")) return Response.json({ data: key });
  if (path.endsWith("/credits")) return credits instanceof Response ? credits : Response.json({ data: credits });
  if (path.endsWith("/usage")) return Response.json(lain);
  throw new Error("Unexpected endpoint");
}) as typeof fetch;
function objectHeaders(options: RequestInit | undefined) {
  return options?.headers as Record<string, string>;
}

const values = { OPENROUTER_API_KEY: secret, CHAOS_MCP_KEY: "not-a-billing-credential" };
const first = await readAiCredits(setting(values), api());
assert.equal(first.openrouter.status, "ok");
assert.equal(first.openrouter.accountBalanceUsd, 7.75);
assert.equal(first.openrouter.keyHasNoSpendingCap, true);
assert.equal(first.openrouter.keyRemainingUsd, null);
assert.deepEqual(first.openrouter.freeRequests, { used: 26, limit: 1000, remaining: 974, window: "UTC day" });
assert.equal(first.lainOs.status, "not_connected");
assert.equal(calls.length, 2, "An MCP key must never be sent to the billing API");
assert.match(formatAiCredits(first), /974 remaining of 1000/);
assert.match(formatAiCredits(first), /Requests are not tokens/);
assert.match(formatAiCredits(first), /does not mean unlimited/);
assert.ok(!JSON.stringify(first).includes(secret), "Key labels must not reach the model");

calls = [];
const both = await readAiCredits(setting({ ...values, LAINOS_CREDITS_API_KEY: lainSecret }), api());
assert.equal(both.lainOs.balanceUsd, 1.234567);
assert.equal(both.lainOs.stakingPerDayUsd, 0.3);
assert.equal(calls.length, 3);
calls = [];
const viaLain = await readAiCredits(setting({ OPENROUTER_API_KEY: lainSecret, OPENROUTER_BASE_URL: "https://lain-os.com/v1/" }), api());
assert.equal(viaLain.openrouter.status, "not_connected");
assert.equal(viaLain.lainOs.balanceUsd, 1.234567);
assert.deepEqual(calls, ["https://lain-os.com/v1/usage"]);

const capped = await readAiCredits(setting(values), api({ ...keyData, limit: 0, limit_remaining: 0, effective_budget: { remaining_usd: 0 } }));
assert.equal(capped.openrouter.keyRemainingUsd, 0);
assert.equal(capped.openrouter.keyHasNoSpendingCap, false);
assert.equal(capped.openrouter.effectiveBudgetRemainingUsd, 0);
assert.deepEqual(capped.openrouter.freeRequests, first.openrouter.freeRequests, "A zero spending cap is not a zero free-request allowance");

const partial = await readAiCredits(setting(values), api(keyData, new Response(secret, { status: 403 })));
assert.equal(partial.openrouter.status, "ok");
assert.equal(partial.openrouter.accountBalanceUsd, null);
assert.equal(partial.openrouter.accountReason, "HTTP 403");
assert.deepEqual(partial.openrouter.freeRequests, first.openrouter.freeRequests);
assert.match(formatAiCredits(partial), /balance: unknown \(HTTP 403\)/);
assert.ok(!formatAiCredits(partial).includes(secret));

const unavailable = await readAiCredits(setting(values), (async () => { throw new Error(secret); }) as typeof fetch);
assert.equal(unavailable.openrouter.status, "unavailable");
assert.equal(unavailable.openrouter.accountBalanceUsd, null);
assert.equal(unavailable.openrouter.freeRequests, null);
assert.ok(!JSON.stringify(unavailable).includes(secret));

for (const malformed of [null, { usage: "0", limit: "100", limit_remaining: "80" }, {
  free_model_daily_requests: { used: 1, limit: 1000, remaining: 900 },
}]) {
  const result = await readAiCredits(setting(values), api(malformed, {}));
  assert.equal(result.openrouter.status, "unavailable");
  assert.equal(result.openrouter.freeRequests, null);
  assert.equal(result.openrouter.keyHasNoSpendingCap, false);
}
const zero = await readAiCredits(setting({ LAINOS_CREDITS_API_KEY: lainSecret }), api(null, {}, { balance_microdollars: 0 }));
assert.equal(zero.lainOs.balanceUsd, 0, "A confirmed zero must survive");
const missing = await readAiCredits(setting({ LAINOS_CREDITS_API_KEY: lainSecret }), api(null, {}, { balance_microdollars: null }));
assert.equal(missing.lainOs.status, "unavailable");
assert.equal(missing.lainOs.balanceUsd, undefined);

calls = [];
for (const base of ["https://other.example/v1", "https://openrouter.ai/api/v1?key=secret", "https://user:pass@openrouter.ai/api/v1", "http://openrouter.ai/api/v1"]) {
  const result = await readAiCredits(setting({ ...values, OPENROUTER_BASE_URL: base }), api());
  assert.equal(result.openrouter.status, "not_connected");
  assert.equal(result.lainOs.status, "not_connected");
  assert.ok(result.gatewayStatus);
}
await readAiCredits(setting({}), api());
assert.deepEqual(calls, [], "Missing or unsupported credentials must not trigger network requests");

const dir = await mkdtemp(join(tmpdir(), "lainos-usage-"));
const runtime = { model: { name: "test-chat" }, getSetting: setting({ ...values, LAINOS_DATA_DIR: dir }) } as unknown as IAgentRuntime;
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = api();
  const context = await aiResourcesProvider.get(runtime, {} as State);
  assert.match(context, /test-chat/);
  assert.match(context, /call ai_usage before answering/);
  assert.equal(calls.length, 0, "Context does not spend API requests on unrelated turns");
  assert.ok(bootstrapPlugin.actions?.includes(aiUsageAction));
  assert.ok(bootstrapPlugin.providers?.includes(aiResourcesProvider));
  const empty = await aiUsageAction.handler(runtime, {} as State, {});
  assert.match(empty.text!, /not a measurement of remaining CLI subscription quota/);
  usageLimits(dir).note("codex", "usage limit reached; try again in 3 hours");
  const observed = await aiUsageAction.handler(runtime, {} as State, {});
  assert.match(observed.text!, /Locally observed provider cooldowns.*codex/);
  assert.ok(!observed.text!.includes(secret));
} finally {
  globalThis.fetch = originalFetch;
  await rm(dir, { recursive: true, force: true });
}
console.log("AI usage: live quotas, separate credit accounts, units, unknowns, failures and credential isolation passed.");
