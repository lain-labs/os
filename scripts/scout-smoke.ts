#!/usr/bin/env -S npx tsx
/**
 * Scout digest smoke test (headless, fake sources, fake model).
 *
 * Pinned here:
 *   1. tool-call markup — XML <tool_call>/<function=…> and JSON calls — is
 *      recognised, a plain digest is not;
 *   2. a digest model that answers with markup is asked again on the main
 *      provider, and only the clean retry is delivered;
 *   3. markup twice delivers nothing at all.
 *
 * Run: npm run scout:smoke
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { looksLikeToolCall, ScoutService, type ScoutEvent } from "../src/plugins/scout/index.js";
import type { IAgentRuntime, ModelRequest, ModelResponse } from "../src/types.js";

const results: [string, boolean][] = [];
const check = (name: string, pass: boolean) => results.push([name, pass]);

// The topic5 digest exactly as it reached Telegram.
const TOPIC5_OUTPUT =
  "<tool_call><function=news_search><parameter=days>180</parameter><parameter=language>en</parameter><parameter=query>Anthropic mechanistic interpretability 2025 2026</parameter></function></tool_call>";
const CLEAN =
  "Anthropic published new circuit-tracing results.\n- Attribution graphs for a production model — https://example.com/a";

// ------------------------------------------------------------- detection

check("topic5 output is tool-call markup", looksLikeToolCall(TOPIC5_OUTPUT));
check("bare <function=…> markup", looksLikeToolCall("<function=news_search>\n<parameter=query>x</parameter>\n</function>"));
check("<invoke name=…> markup", looksLikeToolCall('<function_calls><invoke name="news_search"><parameter name="query">x</parameter></invoke></function_calls>'));
check("DeepSeek tool-call tokens", looksLikeToolCall("<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>news_search"));
check("JSON call", looksLikeToolCall('{"name": "news_search", "arguments": {"query": "Anthropic"}}'));
check("fenced JSON call after prose", looksLikeToolCall('Let me search.\n```json\n{"name":"news_search","parameters":{"days":180}}\n```'));
check("OpenAI-shaped tool_calls JSON", looksLikeToolCall('{"tool_calls": [{"type": "function", "function": {"name": "news_search"}}]}'));
check("a plain digest is not markup", !looksLikeToolCall(CLEAN));
check("a digest mentioning functions is not markup", !looksLikeToolCall("New function calling API for <model> users — https://example.com/b"));

// ------------------------------------------------------------- delivery

const tmp = await mkdtemp(join(tmpdir(), "lainos-scout-"));
const settings: Record<string, string> = { LAINOS_DATA_DIR: tmp };
let replies: string[] = [];
const requests: ModelRequest[] = [];
const runtime = {
  getSetting: (key: string) => settings[key],
  model: {
    async generate(request: ModelRequest): Promise<ModelResponse> {
      requests.push(request);
      return { text: replies.shift() ?? "NOTHING", toolCalls: [], model: "fake", provider: "fake" };
    },
  },
} as unknown as IAgentRuntime;

const scout = new ScoutService();
await scout.start(runtime);
let n = 0;
scout.gather = async () => [{ title: `Interpretability item ${++n}`, url: `https://example.com/item${n}`, source: "News" }];
const delivered: ScoutEvent[] = [];
scout.onEvent((event) => delivered.push(event));
const topic = await scout.addTopic({ query: "Anthropic J-lens", reporter: "tg:tester", chatId: 1, runImmediately: false });

replies = [TOPIC5_OUTPUT, CLEAN];
const retried = await scout.runTopic(topic, { deliver: true });
check("markup is retried off the digest route", requests.length === 2 && requests[0].task === "digest" && requests[1].task === undefined);
check("the clean retry is delivered", delivered.length === 1 && Boolean(retried?.endsWith(CLEAN)));

replies = [TOPIC5_OUTPUT, TOPIC5_OUTPUT];
const dropped = await scout.runTopic(topic, { deliver: true });
check("markup twice delivers nothing", dropped === null && delivered.length === 1);
check("no delivered text carries markup", delivered.every((e) => !looksLikeToolCall(e.text)));

await scout.stop();
await rm(tmp, { recursive: true, force: true });

let failed = 0;
for (const [name, pass] of results) {
  console.log(`${pass ? "✓" : "✗"} ${name}`);
  if (!pass) failed += 1;
}
if (failed) {
  console.error(`${failed} scout check(s) failed`);
  process.exit(1);
}
console.log(`scout smoke ok (${results.length} checks)`);
