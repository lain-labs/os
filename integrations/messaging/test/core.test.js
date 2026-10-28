import test from "node:test";
import assert from "node:assert/strict";
import { ids, sessionKey, stripMention, splitText, SeenEvents, LainBridge } from "../src/core.js";

test("allowlist parses exact IDs", () => {
  assert.deepEqual([...ids(" A, B , ,A")], ["A", "B"]);
  assert.equal(ids("").size, 0);
});

test("mentions stripped without removing the prompt", () => {
  assert.equal(stripMention("<@U123> summarize", "slack", "U123"), "summarize");
  assert.equal(stripMention("<@!123> help", "discord", "123"), "help");
});

test("responses split below platform limit", () => {
  const parts = splitText("hello world ".repeat(200), 190);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((part) => part.length <= 190));
});

test("room IDs isolate platform, thread and user", () => {
  const base = { workspace: "w", channel: "c", thread: "t", user: "u", dm: false };
  assert.notEqual(sessionKey({ ...base, platform: "slack" }), sessionKey({ ...base, platform: "discord" }));
  assert.notEqual(sessionKey({ ...base, platform: "slack" }), sessionKey({ ...base, platform: "slack", user: "other" }));
  assert.notEqual(sessionKey({ ...base, platform: "slack" }), sessionKey({ ...base, platform: "slack", thread: "other" }));
});

test("duplicate platform deliveries are ignored", () => {
  const seen = new SeenEvents();
  assert.equal(seen.has("event-1"), false);
  assert.equal(seen.has("event-1"), true);
  assert.equal(seen.has("event-2"), false);
});

test("Lain request uses configured model and remembers only the same session", async () => {
  const requests = [];
  const fetchImpl = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "reply" } }] }) };
  };
  const bridge = new LainBridge({ apiKey: "test-key", fetchImpl });
  const a = { platform: "slack", workspace: "w", channel: "c", thread: "t", user: "u", dm: false, text: "hello" };
  await bridge.answer(a);
  await bridge.answer({ ...a, text: "again" });
  await bridge.answer({ ...a, user: "other", text: "different" });
  assert.equal(requests[0].model, "lain-free");
  assert.equal(requests[1].messages.length, 4); // system + first two turns + new user
  assert.equal(requests[2].messages.length, 2); // separate user
});
