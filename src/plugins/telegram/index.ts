import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fetch as undiciFetch, ProxyAgent } from "undici";
import { splitMessage } from "../../clients/telegram.js";
import { createLogger } from "../../logger.js";
import type { Action, Plugin } from "../../types.js";

const log = createLogger("plugin:telegram");

/**
 * The telegram plugin is the agent's operator notification channel: a single
 * `send_telegram` action that delivers a message via the Bot API from TUI,
 * HTTP, or daemon mode. The bot token never leaves this module — the model
 * sees only delivery status. This is deliberate: the agent's shell is scoped
 * away from .env, so messaging goes through this action instead of `curl` with
 * a leaked secret.
 */

const MAX_MESSAGE = 4000; // Telegram hard limit is 4096; leave headroom.

type GetSetting = (key: string) => string | undefined;

/**
 * Operator chat id, in order: TELEGRAM_OPERATOR_CHAT_ID, the first
 * TELEGRAM_ALLOWED_CHATS entry, then the single known private chat in
 * data/telegram.json. Null when ambiguous.
 */
export async function resolveOperatorChatId(getSetting: GetSetting): Promise<string | null> {
  const explicit = getSetting("TELEGRAM_OPERATOR_CHAT_ID")?.trim();
  if (explicit) return explicit;

  const allowed = getSetting("TELEGRAM_ALLOWED_CHATS")
    ?.split(",")
    .map((s) => s.trim())
    .find(Boolean);
  if (allowed) return allowed;

  const dataDir = getSetting("LAINOS_DATA_DIR") ?? "./data";
  try {
    const parsed = JSON.parse(await readFile(join(dataDir, "telegram.json"), "utf8")) as {
      chats?: number[];
    };
    const chats = parsed.chats ?? [];
    // Private chats have positive ids; only an unambiguous match is usable.
    const privates = chats.filter((id) => id > 0);
    if (privates.length === 1) return String(privates[0]);
    if (chats.length === 1) return String(chats[0]);
  } catch {
    // No known chats yet.
  }
  return null;
}

/**
 * Resolve the operator chat and deliver a message to it. Shared by the
 * send_telegram action and background services (initiative, trader) that speak
 * to the operator on their own. Throws when no chat is known or delivery fails.
 */
export async function sendToOperator(getSetting: GetSetting, text: string): Promise<string> {
  const chatId = await resolveOperatorChatId(getSetting);
  if (!chatId) throw new Error("operator chat unknown (set TELEGRAM_OPERATOR_CHAT_ID)");
  await deliver(getSetting, chatId, text);
  return chatId;
}

/** POST sendMessage chunk-by-chunk; throws with the API description on failure. */
async function deliver(getSetting: GetSetting, chatId: string, text: string): Promise<void> {
  const token = getSetting("TELEGRAM_BOT_TOKEN") ?? "";
  const proxy =
    getSetting("TELEGRAM_PROXY") ?? getSetting("HTTPS_PROXY") ?? getSetting("https_proxy");
  const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
  try {
    for (const chunk of splitMessage(text, MAX_MESSAGE)) {
      const res = await undiciFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: chunk }),
        dispatcher,
        signal: AbortSignal.timeout(30_000),
      });
      const json = (await res.json()) as { ok: boolean; description?: string };
      if (!res.ok || !json.ok) {
        throw new Error(`telegram sendMessage ${res.status}: ${json.description ?? "error"}`);
      }
    }
  } finally {
    await dispatcher?.close();
  }
}

const sendTelegramAction: Action = {
  name: "send_telegram",
  similes: ["telegram", "message_operator", "notify_operator", "write_telegram", "tg_send"],
  description:
    "Send a Telegram message to the operator right now and return delivery status. " +
    "The bot token stays on the host — use this action to reach Telegram; never try to read the token or curl the API yourself.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "The message to deliver. Keep it short." },
    },
    required: ["text"],
  },
  examples: [{ user: "message me on telegram", agent: "sent. check telegram." }],
  async validate(runtime) {
    return Boolean(runtime.getSetting("TELEGRAM_BOT_TOKEN"));
  },
  async handler(runtime, _state, params) {
    const text = String(params.text ?? "").trim();
    if (!text) return { ok: false, text: "Nothing to send." };

    const getSetting = (k: string) => runtime.getSetting(k);
    const chatId = await resolveOperatorChatId(getSetting);
    if (!chatId) {
      return {
        ok: false,
        text: "I don't know the operator's chat yet: set TELEGRAM_OPERATOR_CHAT_ID, or have the operator message me on Telegram once so I learn it.",
      };
    }

    try {
      await deliver(getSetting, chatId, text);
      return {
        ok: true,
        text: `delivered to operator (chat ${chatId})`,
        data: { chatId, chars: text.length },
      };
    } catch (err) {
      const token = runtime.getSetting("TELEGRAM_BOT_TOKEN") ?? "";
      const raw = err instanceof Error ? err.message : String(err);
      const msg = token ? raw.split(token).join("[token]") : raw;
      log.warn(`send_telegram failed: ${msg}`);
      return { ok: false, text: `delivery failed: ${msg}` };
    }
  },
};

export const telegramPlugin: Plugin = {
  name: "telegram",
  description: "Operator Telegram notifications: send_telegram delivers a message to the operator.",
  actions: [sendTelegramAction],
};
