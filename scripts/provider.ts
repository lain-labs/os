#!/usr/bin/env -S npx tsx
/**
 * Show or switch the chat provider of the running daemon — the model that
 * writes Lain's live replies (Telegram, HTTP, sentinel follow-ups):
 *
 *   npm run provider              # who is answering right now
 *   npm run provider openrouter   # switch to OpenRouter
 *   npm run provider claude       # switch to the Claude CLI subscription
 *   npm run provider codex        # switch back to the Codex CLI
 *   npm run provider opencode     # switch to the OpenCode CLI
 *
 * The switch is immediate and persisted (data/chat-provider.json), so it also
 * survives the daemon's next restart. The TUI is a separate process with its
 * own runtime: use /model there.
 */
import "dotenv/config";
import { CHAT_PROVIDER_CHOICES, chatProviderLabel } from "../src/models/routing.js";
import type { ChatProviderState } from "../src/models/routing.js";

const host = process.env.LAINOS_HTTP_HOST ?? "127.0.0.1";
const port = Number(process.env.LAINOS_HTTP_PORT ?? 7777);
const base = `http://${host}:${port}`;

function describe(state: ChatProviderState): string {
  return (
    `${chatProviderLabel(state.kind)} · ${state.model}` +
    (state.overridden ? `  (override; env default ${state.envKind})` : "  (env default)")
  );
}

async function main() {
  const wanted = process.argv[2]?.trim().toLowerCase();
  const names = CHAT_PROVIDER_CHOICES.map((c) => c.name);

  let res: Response;
  try {
    res = wanted
      ? await fetch(`${base}/provider`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider: wanted }),
        })
      : await fetch(`${base}/provider`);
  } catch {
    console.error(
      `no daemon on ${base} — start it with "npm run serve" or "systemctl --user start lainos".`,
    );
    process.exit(1);
  }

  const body = (await res.json()) as { provider?: ChatProviderState; error?: string };
  if (!res.ok || !body.provider) {
    console.error(body.error ?? `daemon answered ${res.status}`);
    process.exit(1);
  }
  console.log(`${wanted ? "now" : "chat provider"}: ${describe(body.provider)}`);
  if (!wanted) console.log(`switch with: npm run provider <${names.join("|")}>`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
