import { createLogger } from "../../logger.js";

const log = createLogger("plugin:telegram:language");

type GetSetting = (key: string) => string | undefined;

/**
 * Chats where every message Lain sends is in Russian.
 *
 * TELEGRAM_RUSSIAN_CHATS lists chat ids (or @usernames), comma-separated. A turn
 * answering someone there is told to write Russian in its system prompt; anything
 * else that reaches the chat in another language (a digest, an alert, a report
 * written in English by a plugin) is translated on its way out by the translator
 * the client registers, on the cheap translate route.
 */
export function russianChatList(getSetting: GetSetting): string[] {
  return (getSetting("TELEGRAM_RUSSIAN_CHATS") ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^@/, "").toLowerCase())
    .filter(Boolean);
}

export function isRussianChat(getSetting: GetSetting, chatId: number | string, username?: string): boolean {
  const list = russianChatList(getSetting);
  if (!list.length) return false;
  return list.includes(String(chatId).toLowerCase()) || (username !== undefined && list.includes(username.toLowerCase()));
}

/** Mostly Cyrillic letters (URLs, tickers and code aside): already Russian. */
export function looksRussian(text: string): boolean {
  const words = text.replace(/https?:\/\/\S+/g, " ").replace(/`[^`]*`/g, " ");
  const letters = words.match(/\p{L}/gu) ?? [];
  if (letters.length < 12) return true;
  const cyrillic = letters.filter((ch) => /[Ѐ-ӿ]/.test(ch)).length;
  return cyrillic / letters.length >= 0.5;
}

type Translator = (text: string) => Promise<string>;
let translator: Translator | null = null;

export function setRussianTranslator(fn: Translator | null): void {
  translator = fn;
}

/** The text as it should reach this chat: translated into Russian when the chat asks for it. */
export async function inChatLanguage(getSetting: GetSetting, chatId: number | string, text: string): Promise<string> {
  if (!isRussianChat(getSetting, chatId) || looksRussian(text) || !translator) return text;
  try {
    const out = (await translator(text)).trim();
    return out && looksRussian(out) ? out : text;
  } catch (err) {
    log.warn(`could not translate a message for ${chatId}: ${err instanceof Error ? err.message : String(err)}`);
    return text;
  }
}

export const RUSSIAN_TRANSLATE_SYSTEM =
  "Translate the Telegram message into natural, plain Russian. Keep every URL, @handle, $ticker, number, " +
  "address, code span, emoji and line break exactly as they are; keep proper names in Latin script. " +
  "Do not add, explain or shorten anything. Output only the translation.";
