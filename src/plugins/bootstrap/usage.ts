import { usageLimits } from "../../models/limits.js";
import { SwitchableModelProvider } from "../../models/routing.js";
import type { Action, IAgentRuntime, Provider } from "../../types.js";

type ObjectData = Record<string, unknown>;
type Reading = { status: "ok" | "unavailable" | "not_connected"; reason?: string } & ObjectData;
type GetSetting = (key: string) => string | undefined;

const object = (value: unknown): ObjectData =>
  value && typeof value === "object" && !Array.isArray(value) ? value as ObjectData : {};
const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const usd = (value: unknown) => typeof value === "number" ? `$${value.toFixed(6)}` : "unknown";

/** Never echo upstream bodies, key labels, URLs or transport errors into model context. */
async function read(url: string, key: string, fetchImpl: typeof fetch): Promise<Reading> {
  try {
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8_000),
      redirect: "error",
    });
    if (!response.ok) return { status: "unavailable", reason: `HTTP ${response.status}` };
    const data = object(await response.json());
    return Object.keys(data).length
      ? { status: "ok", data }
      : { status: "unavailable", reason: "Invalid balance response" };
  } catch {
    return { status: "unavailable", reason: "Balance endpoint unreachable or invalid response" };
  }
}

/** Recognize a billing API before sending its configured credential anywhere. */
function gateway(raw: string): "openrouter" | "lain" | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.port || url.username || url.password || url.search || url.hash) return;
    const path = url.pathname.replace(/\/+$/, "");
    if (url.hostname === "openrouter.ai" && path === "/api/v1") return "openrouter";
    if (url.hostname === "lain-os.com" && path === "/v1") return "lain";
  } catch { /* Unsupported configuration is unknown, never a zero balance. */ }
}

async function openrouter(key: string, fetchImpl: typeof fetch): Promise<Reading> {
  const [keyRead, credits] = await Promise.all([
    read("https://openrouter.ai/api/v1/key", key, fetchImpl),
    read("https://openrouter.ai/api/v1/credits", key, fetchImpl),
  ]);
  const data = object(object(keyRead.data).data);
  const totals = object(object(credits.data).data);
  const purchased = number(totals.total_credits);
  const spent = number(totals.total_usage);
  const free = object(data.free_model_daily_requests);
  const used = count(free.used), limit = count(free.limit), remaining = count(free.remaining);
  const freeRequests = used !== null && limit !== null && remaining !== null && used + remaining === limit
    ? { used, limit, remaining, window: "UTC day" } : null;
  const keyLimitUsd = number(data.limit);
  const keyRemainingUsd = number(data.limit_remaining);
  const effective = object(data.effective_budget);
  const effectiveRemaining = number(effective.remaining_usd);
  const accountBalanceUsd = purchased !== null && spent !== null ? purchased - spent : null;
  const validKey = keyRead.status === "ok" && (
    freeRequests !== null || number(data.usage) !== null || keyLimitUsd !== null || keyRemainingUsd !== null
  );
  return {
    status: validKey || accountBalanceUsd !== null ? "ok" : "unavailable",
    keyStatus: validKey ? "ok" : "unavailable",
    keyReason: validKey ? undefined : keyRead.reason ?? "Missing usage fields",
    accountBalanceUsd,
    accountReason: accountBalanceUsd === null ? credits.reason ?? "Missing credit totals" : undefined,
    keyLimitUsd,
    keyRemainingUsd,
    keyHasNoSpendingCap: validKey && data.limit === null,
    effectiveBudgetRemainingUsd: effectiveRemaining,
    usedUsd: number(data.usage),
    freeRequests,
  };
}

async function lainCredits(key: string | undefined, fetchImpl: typeof fetch): Promise<Reading> {
  if (!key) return { status: "not_connected", reason: "No Lain OS billing credential is connected; balance unknown" };
  const response = await read("https://lain-os.com/v1/usage", key, fetchImpl);
  if (response.status !== "ok") return response;
  const data = object(response.data);
  const microdollars = number(data.balance_microdollars);
  if (microdollars === null || !Number.isSafeInteger(microdollars)) {
    return { status: "unavailable", reason: "Missing credit balance" };
  }
  return {
    status: "ok",
    balanceUsd: microdollars / 1_000_000,
    stakingPerDayUsd: number(object(data.pace).staking_per_day_microdollars) === null
      ? null : Number(object(data.pace).staking_per_day_microdollars) / 1_000_000,
  };
}

/** The provider key belongs to its gateway; an MCP key is never a billing credential. */
export async function readAiCredits(setting: GetSetting, fetchImpl: typeof fetch = fetch) {
  const key = setting("OPENROUTER_API_KEY")?.trim();
  const kind = gateway(setting("OPENROUTER_BASE_URL")?.trim() || "https://openrouter.ai/api/v1");
  const lainKey = setting("LAINOS_CREDITS_API_KEY")?.trim() || (kind === "lain" ? key : undefined);
  const [router, lain] = await Promise.all([
    kind === "openrouter" && key
      ? openrouter(key, fetchImpl)
      : Promise.resolve<Reading>({ status: "not_connected", reason: "No direct OpenRouter billing credential is connected; balance unknown" }),
    lainCredits(lainKey, fetchImpl),
  ]);
  return {
    checkedAt: new Date().toISOString(),
    openrouter: router,
    lainOs: lain,
    gatewayStatus: key && !kind ? "Unsupported gateway; its balance is unknown" : undefined,
  };
}

export function formatAiCredits(credits: Awaited<ReturnType<typeof readAiCredits>>): string {
  const router = credits.openrouter;
  const free = object(router.freeRequests);
  const lines = [`AI resources checked at ${credits.checkedAt}.`];
  if (router.status === "not_connected") lines.push(`OpenRouter: ${router.reason}.`);
  else {
    lines.push(`OpenRouter account credit balance: ${usd(router.accountBalanceUsd)}${router.accountReason ? ` (${router.accountReason})` : ""}.`);
    lines.push(`OpenRouter key spending cap: ${router.keyHasNoSpendingCap ? "not set (this does not mean unlimited account credit or requests)" : usd(router.keyLimitUsd)}; remaining under key cap: ${usd(router.keyRemainingUsd)}.`);
    if (typeof router.effectiveBudgetRemainingUsd === "number") {
      lines.push(`OpenRouter effective budget remaining: ${usd(router.effectiveBudgetRemainingUsd)}.`);
    }
    lines.push(Object.keys(free).length
      ? `OpenRouter free-model requests: ${free.remaining} remaining of ${free.limit}, ${free.used} used in the current UTC day. Requests are not tokens; this allowance may also be used by other agents sharing the account.`
      : `OpenRouter free-model request allowance: unknown${router.keyReason ? ` (${router.keyReason})` : ""}.`);
  }
  const lain = credits.lainOs;
  lines.push(lain.status === "ok"
    ? `Lain OS account AI credits: ${usd(lain.balanceUsd)}; staking credit income per day: ${usd(lain.stakingPerDayUsd)}.`
    : `Lain OS AI credits: unknown (${lain.reason}).`);
  if (credits.gatewayStatus) lines.push(credits.gatewayStatus);
  lines.push("There is no verified single remaining-token count. Credit balances are USD amounts; request quotas are counts. Unknown is not zero. These readings say nothing about a cryptocurrency wallet or CLI subscription quota.");
  return lines.join("\n");
}

function chatStatus(runtime: IAgentRuntime): string {
  if (runtime.model instanceof SwitchableModelProvider) {
    const state = runtime.model.state();
    return `Configured live chat: ${state.kind} / ${state.model}. Task overrides and actual reply stamps can differ; use chat_provider_status or task_routes for details.`;
  }
  return `Configured live chat provider: ${runtime.model.name}.`;
}

export const aiUsageAction: Action = {
  name: "ai_usage",
  similes: ["ai_tokens", "ai_credits", "model_limits", "remaining_quota"],
  description:
    "Check your actual AI resources now: OpenRouter account credits, key budget and remaining daily free-model requests, " +
    "Lain OS account credits and staking income when connected, and locally observed provider cooldowns. " +
    "Use whenever asked how many AI tokens, credits or model requests you have left. Unknown balances remain unknown; " +
    "this does not read cryptocurrency balances or prove a CLI is signed in. Read-only; no model completions or payments.",
  parameters: { type: "object", properties: {} },
  examples: [{ user: "How many AI tokens do you have left?", agent: "Checking my AI credits and request limits now." }],
  async validate() { return true; },
  async handler(runtime) {
    const credits = await readAiCredits(key => runtime.getSetting(key));
    const cooldowns = usageLimits(runtime.getSetting("LAINOS_DATA_DIR") ?? "data").list()
      .map(({ kind, until, at }) => ({ provider: kind, retryAt: new Date(until).toISOString(), observedAt: new Date(at).toISOString() }));
    return {
      ok: true,
      text: [
        chatStatus(runtime),
        formatAiCredits(credits),
        cooldowns.length ? `Locally observed provider cooldowns: ${JSON.stringify(cooldowns)}`
          : "No active provider cooldowns are recorded locally. This is not a measurement of remaining CLI subscription quota or authentication.",
      ].join("\n"),
      data: { ...credits, cooldowns },
    };
  },
};

/** Cheap context on every turn; network reads happen only when the action is called. */
export const aiResourcesProvider: Provider = {
  name: "ai_resources",
  async get(runtime) {
    return `${chatStatus(runtime)} ` +
      "When asked about your AI tokens, credits, remaining requests or model limits, call ai_usage before answering, even in casual conversation. " +
      "Do not infer zero or unlimited resources from a missing balance, a free model, installed coding CLIs or an empty cooldown list. " +
      "Coding agents and subagents are separate from the live chat provider. For cryptocurrency holdings use wallet tools; never guess that a wallet is empty.";
  },
};
