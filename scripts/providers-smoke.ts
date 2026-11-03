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
import {
  configuredOpenAiCompatible,
  parseModelList,
  resolveOpenAiCompatible,
} from "../src/models/providers.js";
import { TaskKind } from "../src/models/tasks.js";
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
check("default small kept", pinned?.models[ModelTier.SMALL] === "llama-3.1-8b-instant", pinned?.models);
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

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nproviders smoke: all checks passed");
