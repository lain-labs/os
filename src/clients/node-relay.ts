import type { TelegramSender } from "../plugins/telegram/identity.js";

type Settings = (key: string) => string | undefined;

/** Only explicitly selected chats use the remote agent; private conversations stay local. */
export function isNodeChat(chatId: number, setting: Settings): boolean {
  return (setting("LAINOS_NODE_TELEGRAM_CHATS") ?? "").split(",").map(s => s.trim()).includes(String(chatId));
}

export async function relayNodeMessage(
  setting: Settings,
  input: { chatId: number; sender: TelegramSender; text: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ text: string; model?: string }> {
  if (!input.sender.operatorKnown || input.sender.role !== "operator") {
    throw new Error("Only the configured operator can talk to the autonomous node.");
  }
  const url = setting("LAINOS_NODE_URL");
  const key = setting("LAINOS_NODE_KEY");
  if (!url || !key) throw new Error("The autonomous node is not connected.");
  let response: Response;
  try {
    response = await fetchImpl(`${url.replace(/\/$/, "")}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        roomId: `tg-${input.chatId}`, userId: `tg:${input.sender.id}`, text: input.text,
        metadata: { telegram: input.sender },
      }),
      signal: AbortSignal.timeout(600_000),
    });
  } catch {
    throw new Error("The autonomous node is unreachable or did not answer in time. I did not send this to the local agent.");
  }
  if (!response.ok) throw new Error(`The autonomous node answered HTTP ${response.status}.`);
  const body = await response.json() as { text?: unknown; model?: unknown };
  if (typeof body.text !== "string" || !body.text.trim()) throw new Error("The autonomous node returned no reply.");
  return { text: body.text, model: typeof body.model === "string" ? body.model : undefined };
}
