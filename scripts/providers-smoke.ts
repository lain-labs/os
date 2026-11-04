#!/usr/bin/env -S npx tsx
/**
 * OpenAI-compatible providers smoke test (headless, no network).
 *
 * Pins what adding Groq (and every provider after it) must keep true:
 *   1. a provider is switched on by its key alone, and off without one;
 *   2. tier models come from <ID>_MODEL_* first, the built-in defaults second;
 *   3. a provider nobody built in is one LAINOS_PROVIDERS entry plus env;
 *   4. the factory picks Groq when it is the only key, names it, and pins a model;
 *   5. with no OpenRouter key, cheap tasks go to a free-tier provider;
 *   6. /models parsing drops speech, moderation and inactive models.
 *
 * Run: npm run providers:smoke
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModelProvider, resolveEnvTaskRoutes } from "../src/models/index.js";
import { fitTools } from "../src/models/openrouter.js";
import {
  configuredOpenAiCompatible,
  parseModelList,
  resolveOpenAiCompatible,
} from "../src/models/providers.js";
import { TaskKind } from "../src/models/tasks.js";
import {
  estimateRequest,
  estimateTokens,
  GroqPool,
  QuotaBook,
  summarizeUsage,
  type LedgerLine,
} from "../src/models/budget.js";
import type { ModelProvider, ModelRequest } from "../src/types.js";
import { ModelTier } from "../src/types.js";

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown): void => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};
const env = (vars: Record<string, string>) => (key: string) => vars[key];

// 1. Key switches a provider on.
check("no key → groq off", resolveOpenAiCompatible("groq", env({})) === undefined);
const groq = resolveOpenAiCompatible("groq", env({ GROQ_API_KEY: "gsk_test" }));
check("key → groq on", groq?.baseUrl === "https://api.groq.com/openai/v1" && groq.free === true, groq);

// 2. Tier overrides beat defaults.
const pinned = resolveOpenAiCompatible(
  "groq",
  env({ GROQ_API_KEY: "k", GROQ_MODEL_LARGE: "moonshotai/kimi-k2-instruct", GROQ_FREE_TIER: "false" }),
);
check("GROQ_MODEL_LARGE wins", pinned?.models[ModelTier.LARGE] === "moonshotai/kimi-k2-instruct", pinned?.models);
check("default small kept", pinned?.models[ModelTier.SMALL] === "openai/gpt-oss-20b", pinned?.models);
check("GROQ_FREE_TIER=false → paid", pinned?.free === false);

// 3. A declared provider.
const declared = env({
  LAINOS_PROVIDERS: "myhost, claude",
  MYHOST_API_KEY: "k",
  MYHOST_BASE_URL: "https://llm.example/v1/",
  MYHOST_MODEL: "qwen3",
});
const myhost = resolveOpenAiCompatible("myhost", declared);
check("declared provider resolves", myhost?.baseUrl === "https://llm.example/v1" && myhost.models[ModelTier.SMALL] === "qwen3", myhost);
check("a built-in kind cannot be redeclared", resolveOpenAiCompatible("claude", declared) === undefined);
check("undeclared id is not a provider", resolveOpenAiCompatible("nobody", env({ NOBODY_API_KEY: "k" })) === undefined);
check(
  "configured list holds only keyed providers",
  configuredOpenAiCompatible(env({ GROQ_API_KEY: "k" })).map((p) => p.id).join() === "groq",
);

// 4. The factory.
const dataDir = mkdtempSync(join(tmpdir(), "lainos-providers-"));
const onlyGroq = env({ GROQ_API_KEY: "k", LAINOS_DATA_DIR: dataDir, LAINOS_MODEL_STANDBY: "none" });
const provider = createModelProvider(onlyGroq);
check("groq is the base when it is the only key", provider.name.includes("groq"), provider.name);

// 5. Cheap work moves to a free-tier provider when OpenRouter is absent.
const routes = resolveEnvTaskRoutes(env({ GROQ_API_KEY: "k" }), "claude");
const cheap = Object.entries(routes).find(([, entry]) => entry?.source === "cheap");
check("cheap route → groq", cheap?.[1]?.route.provider === "groq", routes);
check("a critical kind is never swept to the cheap route", routes[TaskKind.MONEY] === undefined, routes[TaskKind.MONEY]);

// 6. /models parsing.
const ids = parseModelList({
  data: [
    { id: "llama-3.3-70b-versatile", active: true },
    { id: "whisper-large-v3" },
    { id: "meta-llama/llama-guard-4-12b" },
    { id: "playai-tts" },
    { id: "old-model", active: false },
    { id: "openai/gpt-oss-120b" },
  ],
});
check("chat models only", ids.join() === "llama-3.3-70b-versatile,openai/gpt-oss-120b", ids);

// 7. Budget: estimates, the quota book, the Groq pool, the daily summary.
check("tokens ≈ chars/4", estimateTokens("a".repeat(400)) === 100 && estimateTokens("你好世界") === 4);
const request: ModelRequest = { tier: ModelTier.SMALL, system: "s".repeat(4000), messages: [{ role: "user", content: "hi" }], maxTokens: 900 };
const est = estimateRequest(request, "groq");
check("estimate counts the prompt and a third of the cap", est.input > 1000 && est.output === 300 && est.seconds < 2, est);

const book = new QuotaBook();
const quota = { rpm: 2, rpd: 100, tpm: 8000, tpd: 200_000 };
book.record("groq/a", 100, 0);
book.record("groq/a", 100, 1000);
check("a model at its requests-per-minute is full", !book.fits("groq/a", quota, 100, 2000));
check("the next minute is free again", book.fits("groq/a", quota, 100, 61_000));

const calls: string[] = [];
const fake = (model: string, fail?: string): ModelProvider => ({
  name: "groq",
  modelFor: () => model,
  generate: async () => {
    calls.push(model);
    if (fail) throw new Error(fail);
    return { text: `from ${model}`, toolCalls: [], model };
  },
});
const pool = new GroqPool(
  [{ model: "big", provider: fake("big", "groq HTTP 429: rate limit") }, { model: "small", provider: fake("small") }],
  new QuotaBook(),
  () => ["big", "small"],
);
const answered = await pool.generate({ tier: ModelTier.LARGE, system: "", messages: [{ role: "user", content: "q" }] });
check("a 429 cools the model and the next one answers", answered.model === "small" && calls.join() === "big,small", calls);
let refused = "";
await pool.generate({ tier: ModelTier.LARGE, system: "x".repeat(40_000), messages: [] }).catch((e) => (refused = String(e)));
check("a prompt over the per-minute window is refused, not sent", /long-context/.test(refused), refused);

const lines: LedgerLine[] = [
  { at: new Date().toISOString(), task: "digest", provider: "groq", model: "openai/gpt-oss-120b", estIn: 1000, estOut: 300, out: 250, ms: 900, ok: true },
  { at: new Date().toISOString(), task: "code", provider: "claude", model: "sonnet", estIn: 5000, estOut: 1000, out: 2000, ms: 30_000, ok: true },
];
const summary = summarizeUsage(lines);
check("summary: free share and what it saved", summary.freeTokens === 1250 && summary.savedUsd > 0 && summary.byTask[0].task === "code", summary);

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
// Groq refuses a request with more than 128 tools; Lain registers more.
check("groq caps tools at 128", groq?.maxTools === 128, groq);
const many = Array.from({ length: 200 }, (_, i) => ({ name: `tool_${i}`, description: i === 150 ? "arena trades and the paper cup" : "other" }));
const fitted = fitTools(many, 128, "how is my arena doing?") ?? [];
check("fitTools keeps 128, the one the message names among them", fitted.length === 128 && fitted.some((t) => t.name === "tool_150"));
check("fitTools leaves a short list alone", fitTools(many.slice(0, 5), 128, "x")?.length === 5);

console.log("\nproviders smoke: all checks passed");
