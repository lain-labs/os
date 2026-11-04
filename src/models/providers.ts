import { fetch as undiciFetch, ProxyAgent } from "undici";
import { ModelTier } from "../types.js";

/**
 * OpenAI-compatible APIs LainOS can talk to directly, besides OpenRouter.
 *
 * Every one of them is the same client (OpenRouterModelProvider speaks plain
 * OpenAI chat completions) pointed at another base URL with another key, so a
 * provider is data, not code: an id, a base URL, a default model per tier and
 * whether its keys come with a free tier.
 *
 * Switching one on is only its key: `GROQ_API_KEY=…` makes `groq` a chat
 * provider, a standby and a task route (`LAINOS_TASK_DIGEST=groq`). Per-tier
 * models follow the OpenRouter convention: `GROQ_MODEL_SMALL`, `_MEDIUM`,
 * `_LARGE`; `GROQ_BASE_URL` points it elsewhere.
 *
 * A provider that is not listed here is still one env block away:
 *   LAINOS_PROVIDERS=myhost
 *   MYHOST_API_KEY=…  MYHOST_BASE_URL=https://…/v1  MYHOST_MODEL_LARGE=…
 */
export interface OpenAiCompatibleSpec {
  id: string;
  label: string;
  baseUrl: string;
  models: Record<ModelTier, string>;
  /** Its keys come with a free tier (rate-limited, no per-token bill). */
  free: boolean;
  /** The most tools one request may carry, when the host caps it. */
  maxTools?: number;
}

export const OPENAI_COMPATIBLE_PROVIDERS: Record<string, OpenAiCompatibleSpec> = {
  groq: {
    id: "groq",
    label: "Groq API · fast open models, free tier",
    baseUrl: "https://api.groq.com/openai/v1",
    // The free plan's models (each with its own quota, see budget.ts).
    models: {
      [ModelTier.SMALL]: "openai/gpt-oss-20b",
      [ModelTier.MEDIUM]: "openai/gpt-oss-120b",
      [ModelTier.LARGE]: "openai/gpt-oss-120b",
    },
    free: true,
    maxTools: 128,
  },
  cerebras: {
    id: "cerebras",
    label: "Cerebras API · fast open models, free tier",
    baseUrl: "https://api.cerebras.ai/v1",
    models: {
      [ModelTier.SMALL]: "llama3.1-8b",
      [ModelTier.MEDIUM]: "llama-3.3-70b",
      [ModelTier.LARGE]: "gpt-oss-120b",
    },
    free: true,
  },
  together: {
    id: "together",
    label: "Together API · open models, per token",
    baseUrl: "https://api.together.xyz/v1",
    models: {
      [ModelTier.SMALL]: "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
      [ModelTier.MEDIUM]: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
      [ModelTier.LARGE]: "deepseek-ai/DeepSeek-V3",
    },
    free: false,
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek API · per token",
    baseUrl: "https://api.deepseek.com/v1",
    models: {
      [ModelTier.SMALL]: "deepseek-chat",
      [ModelTier.MEDIUM]: "deepseek-chat",
      [ModelTier.LARGE]: "deepseek-reasoner",
    },
    free: false,
  },
  mistral: {
    id: "mistral",
    label: "Mistral API · free tier",
    baseUrl: "https://api.mistral.ai/v1",
    models: {
      [ModelTier.SMALL]: "mistral-small-latest",
      [ModelTier.MEDIUM]: "mistral-medium-latest",
      [ModelTier.LARGE]: "mistral-large-latest",
    },
    free: true,
  },
};

type Settings = (key: string) => string | undefined;

const envPrefix = (id: string): string => id.toUpperCase().replace(/[^A-Z0-9]/g, "_");

/** The ids listed in LAINOS_PROVIDERS, lower-cased, never one of the built-in kinds. */
function declaredIds(getSetting: Settings): string[] {
  const reserved = new Set(["openrouter", "anthropic", "claude", "codex", "opencode", "grok", "mock"]);
  return (getSetting("LAINOS_PROVIDERS") ?? "")
    .split(/[\s,]+/)
    .map((id) => id.trim().toLowerCase())
    .filter((id) => /^[a-z][a-z0-9_-]{0,31}$/.test(id) && !reserved.has(id));
}

/** Every OpenAI-compatible provider id this build knows, built-in or declared. */
export function openAiCompatibleIds(getSetting: Settings): string[] {
  return [...new Set([...Object.keys(OPENAI_COMPATIBLE_PROVIDERS), ...declaredIds(getSetting)])];
}

export interface ResolvedProvider {
  id: string;
  label: string;
  apiKey: string;
  baseUrl: string;
  models: Record<ModelTier, string>;
  free: boolean;
  /** The most tools one request may carry (`<ID>_MAX_TOOLS` overrides the spec). */
  maxTools?: number;
}

/**
 * The provider `id` as this machine has it configured, or undefined when it
 * has no key (or, for a declared one, no base URL or no model to ask for).
 */
export function resolveOpenAiCompatible(id: string, getSetting: Settings): ResolvedProvider | undefined {
  const spec = OPENAI_COMPATIBLE_PROVIDERS[id];
  if (!spec && !declaredIds(getSetting).includes(id)) return undefined;
  const p = envPrefix(id);
  const apiKey = getSetting(`${p}_API_KEY`)?.trim();
  const baseUrl = (getSetting(`${p}_BASE_URL`)?.trim() || spec?.baseUrl || "").replace(/\/$/, "");
  if (!apiKey || !baseUrl) return undefined;

  const tier = (t: ModelTier, suffix: string): string | undefined =>
    getSetting(`${p}_MODEL_${suffix}`)?.trim() || spec?.models[t];
  const large = tier(ModelTier.LARGE, "LARGE") ?? getSetting(`${p}_MODEL`)?.trim();
  const medium = tier(ModelTier.MEDIUM, "MEDIUM") ?? large;
  const small = tier(ModelTier.SMALL, "SMALL") ?? medium;
  if (!small || !medium || !large) return undefined;

  const freeRaw = getSetting(`${p}_FREE_TIER`)?.trim().toLowerCase();
  const free = freeRaw ? ["1", "true", "yes", "on"].includes(freeRaw) : (spec?.free ?? false);

  return {
    id,
    label: spec?.label ?? `${id} API · OpenAI-compatible`,
    apiKey,
    baseUrl,
    models: { [ModelTier.SMALL]: small, [ModelTier.MEDIUM]: medium, [ModelTier.LARGE]: large },
    free,
    maxTools: Number(getSetting(`${p}_MAX_TOOLS`)) || spec?.maxTools,
  };
}

/** The configured providers, in the order above (built-ins first). */
export function configuredOpenAiCompatible(getSetting: Settings): ResolvedProvider[] {
  return openAiCompatibleIds(getSetting)
    .map((id) => resolveOpenAiCompatible(id, getSetting))
    .filter((p): p is ResolvedProvider => Boolean(p));
}

/**
 * The provider's own model list (`GET /models`), chat models only. A free-tier
 * key makes every one of them free for the `/model` picker.
 */
export async function listOpenAiCompatibleModels(
  provider: ResolvedProvider,
  proxy?: string,
): Promise<{ id: string; free: boolean }[]> {
  const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
  const res = await undiciFetch(`${provider.baseUrl}/models`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${provider.apiKey}` },
    ...(dispatcher ? { dispatcher } : {}),
  });
  if (!res.ok) throw new Error(`${provider.id} answered ${res.status} for its own catalogue`);
  return parseModelList(await res.json()).map((id) => ({ id, free: provider.free }));
}

/** Ids from an OpenAI `/models` body, minus speech, moderation and inactive models. */
export function parseModelList(body: unknown): string[] {
  const rows = Array.isArray((body as { data?: unknown })?.data) ? (body as { data: unknown[] }).data : [];
  const notChat = /whisper|tts|guard|embed|moderation|distil|rerank|image|audio|transcribe/i;
  return rows
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
    .filter((row) => typeof row.id === "string" && row.active !== false && !notChat.test(row.id as string))
    .map((row) => row.id as string)
    .sort((a, b) => a.localeCompare(b));
}
