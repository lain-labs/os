import type { Action } from "../../types.js";

/**
 * offer_choices: when a request really has two or more sensible readings, the
 * agent offers them as buttons instead of asking an open question — the
 * operator answers with one tap (a picker in the TUI, a reply keyboard in
 * Telegram), and the turn ends without another model call.
 *
 * The runtime treats this tool as the end of the turn: the reply is the
 * question and the numbered options, and TurnResult.choices carries them to
 * the client.
 */
export const OFFER_CHOICES = "offer_choices";

export interface Choices {
  question: string;
  options: { label: string; detail?: string }[];
  /** 0-based index of the option the agent recommends. */
  recommended?: number;
}

/** Validate the model's arguments into Choices, or explain what is wrong. */
export function parseChoices(params: Record<string, unknown>): Choices | string {
  const question = String(params.question ?? "").trim();
  if (!question) return "question is required.";
  const raw = Array.isArray(params.options) ? params.options : [];
  const options = raw
    .map((o) =>
      typeof o === "string"
        ? { label: o.trim() }
        : o && typeof o === "object"
          ? {
              label: String((o as Record<string, unknown>).label ?? "").trim(),
              detail: (o as Record<string, unknown>).detail ? String((o as Record<string, unknown>).detail).trim() : undefined,
            }
          : { label: "" },
    )
    .filter((o) => o.label);
  if (options.length < 2 || options.length > 5) return "give 2 to 5 options.";
  const rec = params.recommended === undefined ? undefined : Number(params.recommended);
  return {
    question,
    options: options.map((o) => ({ ...o, label: o.label.slice(0, 60) })),
    recommended: rec !== undefined && Number.isInteger(rec) && rec >= 0 && rec < options.length ? rec : undefined,
  };
}

/** The reply text a choice turns into: the question, then numbered options. */
export function renderChoices(c: Choices): string {
  const lines = c.options.map(
    (o, i) => `${i + 1}. ${o.label}${i === c.recommended ? " (recommended)" : ""}${o.detail ? ` — ${o.detail}` : ""}`,
  );
  return [c.question, "", ...lines].join("\n");
}

/** Button labels: "1. Mainnet" — the number keeps a tap unambiguous in the history. */
export function choiceButtons(c: Choices): string[] {
  return c.options.map((o, i) => `${i + 1}. ${o.label}`);
}

export const offerChoicesAction: Action = {
  name: OFFER_CHOICES,
  similes: ["ask_choice", "choose", "offer_options", "multiple_choice"],
  description:
    "End the turn by offering the operator 2–5 options to pick with one tap (buttons in Telegram, arrows in the terminal). " +
    "Use ONLY when the request genuinely has several sensible readings that lead to different work, or before an irreversible step with real alternatives. " +
    "Never use it to ask permission for what was already asked, and never instead of doing the work: if one reading is clearly most likely, do that. " +
    "Mark the option you would pick as `recommended`. Write labels in the operator's language.",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", description: "One short question." },
      options: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: "Short button text (≤ 60 chars)." },
            detail: { type: "string", description: "One line on what this option does." },
          },
          required: ["label"],
        },
      },
      recommended: { type: "number", description: "0-based index of the option you recommend." },
    },
    required: ["question", "options"],
  },
  examples: [{ user: "переключи сеть", agent: "(offer_choices: robinhood / robinhood-testnet / cyberia)" }],
  async validate() {
    return true;
  },
  async handler(_runtime, _state, params) {
    const parsed = parseChoices(params);
    if (typeof parsed === "string") return { ok: false, text: `offer_choices: ${parsed}` };
    return { ok: true, text: renderChoices(parsed), data: { choices: parsed } };
  },
};
