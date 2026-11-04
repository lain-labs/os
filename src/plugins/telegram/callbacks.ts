/**
 * Inline-button presses (Telegram callback_query), routed by the prefix of
 * their callback_data ("plan:…"). A plugin registers a handler for its prefix;
 * the Telegram client answers the press and passes it on. A handler's answer is
 * shown to the person as the button's toast and replaces the buttons under the
 * message, so a question is answered once.
 */
export interface CallbackPress {
  chatId: number;
  messageId?: number;
  /** callback_data without the "prefix:" part. */
  data: string;
  fromId: number;
  fromUsername?: string;
}

export interface CallbackAnswer {
  /** Toast shown on the press. */
  toast?: string;
  /** Appended to the message the buttons were under (the buttons are removed). */
  note?: string;
  /** A follow-up message to the same chat. */
  reply?: string;
}

type Handler = (press: CallbackPress) => Promise<CallbackAnswer | null>;
const handlers = new Map<string, Handler>();

export function onTelegramCallback(prefix: string, handler: Handler): void {
  handlers.set(prefix, handler);
}

export async function dispatchTelegramCallback(raw: string, press: Omit<CallbackPress, "data">): Promise<CallbackAnswer | null> {
  const at = raw.indexOf(":");
  if (at <= 0) return null;
  const handler = handlers.get(raw.slice(0, at));
  return handler ? handler({ ...press, data: raw.slice(at + 1) }) : null;
}

/** Replies to a press that a plugin is waiting for as free text (e.g. "what is in the way?"). */
type TextHook = (chatId: number, text: string) => Promise<string | null>;
const textHooks: TextHook[] = [];

export function onTelegramText(hook: TextHook): void {
  textHooks.push(hook);
}

/** The first hook that claims this message answers it; null means "a normal turn". */
export async function claimTelegramText(chatId: number, text: string): Promise<string | null> {
  for (const hook of textHooks) {
    const answer = await hook(chatId, text);
    if (answer !== null) return answer;
  }
  return null;
}
