import { join } from "node:path";
import {
  budgetFiles,
  GROQ_FREE_MODELS,
  GROQ_FREE_QUOTA,
  QuotaBook,
  REFERENCE_PRICE,
  summarizeUsage,
  UsageLedger,
  type UsageSummary,
} from "../../models/budget.js";
import type { Action, IAgentRuntime, Plugin } from "../../types.js";

/**
 * Where the model budget goes. Every call is in data/usage-ledger.jsonl (the
 * metered providers write it); this turns the last day into one answer: calls,
 * tokens and seconds per kind of task, the free share and what it would have
 * cost on a paid model, how far the estimates were off, and how much of each
 * Groq model's free quota is left today.
 */

export function usageReport(dataDir: string, hours = 24, now = Date.now()): { summary: UsageSummary; text: string } {
  const files = budgetFiles(dataDir);
  const summary = summarizeUsage(new UsageLedger(files.ledger).lines(now - hours * 3_600_000));
  const groq = new QuotaBook(files.quotas).today(now);
  const lines = [
    `model use, last ${hours}h: ${summary.calls} calls (${summary.failed} failed), ~${Math.round(summary.tokens / 1000)}k tokens, ${Math.round(summary.seconds / 60)} min waiting`,
    `free tiers carried ~${Math.round(summary.freeTokens / 1000)}k tokens — about $${summary.savedUsd} at ${REFERENCE_PRICE.label} prices`,
    ...summary.byTask.slice(0, 6).map((t) => `· ${t.task}: ${t.calls} calls, ~${Math.round(t.tokens / 1000)}k tokens, ${t.seconds}s — ${t.providers}`),
    ...(summary.estimateRatio !== null ? [`estimates vs actual output: ×${summary.estimateRatio}`] : []),
    ...GROQ_FREE_MODELS.map((m) => {
      const used = groq[`groq/${m}`];
      return used
        ? `groq ${m}: ${used.requests}/${GROQ_FREE_QUOTA.rpd} requests, ${Math.round(used.tokens / 1000)}k/${GROQ_FREE_QUOTA.tpd / 1000}k tokens today`
        : `groq ${m}: unused today`;
    }),
  ];
  return { summary, text: lines.join("\n") };
}

const modelBudget: Action = {
  name: "model_budget",
  similes: ["usage_today", "token_budget", "how_many_tokens"],
  description:
    "How the model budget was spent: calls, tokens and time per kind of task over the last hours, the share carried by free tiers (Groq, OpenRouter free) and what it saved, how far estimates were off, and the Groq free quota left today.",
  examples: [],
  parameters: { type: "object", properties: { hours: { type: "number", description: "Window in hours (default 24)." } } },
  async validate() {
    return true;
  },
  async handler(runtime: IAgentRuntime, _state, params) {
    const hours = Math.max(1, Math.min(24 * 14, Number(params.hours) || 24));
    const dataDir = runtime.getSetting("LAINOS_DATA_DIR") ?? join(process.cwd(), "data");
    return { ok: true, text: usageReport(dataDir, hours).text };
  },
};

export const budgetPlugin: Plugin = {
  name: "budget",
  description: "Model usage, free-tier quotas and what the free tiers saved.",
  actions: [modelBudget],
};
