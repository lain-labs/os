# Slack + Discord bridge for Lain OS (test MVP)

This opt-in bridge runs **one Slack app** and **one Discord bot** against the
existing Lain OS OpenAI-compatible agent API. Both are bot identities, not Orpheus
(the human test user). It is intentionally isolated from the production daemon:
no deployment, account-linking UI, or multi-tenant OAuth installation flow.

## Behavior

- **DM:** an allowlisted person can ask Lain anything; each platform/user DM
  has an independent short-term session.
- **Channel:** only an explicit bot mention from an allowlisted user in an
  allowlisted channel triggers a reply. The reply goes to the Slack thread or
  Discord message/thread, as the bot (never impersonating the human).
- **Conversation assistant:** at that explicit request, the bot may read up to
  `BOT_CONTEXT_MESSAGES` recent messages in that allowed channel/thread, if
  the app has permission, and ask Lain to summarize or draft a reply.
  This is **not** continuous monitoring or automatic posting. Set
  `BOT_CONTEXT_MESSAGES=0` to turn context retrieval off.
- Requests use the Lain OS agent model (`lain-free` by default), which exposes
  Lain's read-only knowledge/market tools. This bridge offers no wallet,
  trading, system-configuration or file-write tools and does not authorize
  actions as Orpheus.
- Recent bot conversations live in process memory only (up to 8 turns per
  participant/room, expire after 24 hours). Restarting clears this memory.
  Channel context is sent to the model only when a request is explicitly made.

## Setup

Node.js 20+ required. Inside `integrations/messaging`:

```bash
npm install
cp .env.example .env
npm test
npm start
```

Get `LAIN_API_KEY` from the Lain OS dashboard's API Keys page. Keep this key
and bot tokens in the local `.env`; do **not** paste them into chat or commit
them. The bridge only starts a platform when its token is configured.

### Slack

1. Create one app at https://api.slack.com/apps for a test workspace.
2. Enable **Socket Mode**. Generate an **app-level token** with
   `connections:write` → `SLACK_APP_TOKEN`.
3. Add bot scopes: `chat:write`, `app_mentions:read`, `im:history`.
   For channel summaries also grant `channels:history` and (only if needed)
   `groups:history`. Subscribe to events `app_mention` and `message.im`.
4. Install the app in your test workspace. Copy the **bot user OAuth token**
   to `SLACK_BOT_TOKEN`. Invite the app to the chosen channel.
5. Set `SLACK_ALLOWED_TEAMS` (workspace ID), `SLACK_ALLOWED_USERS` (Orpheus's
   Slack user ID), and `SLACK_ALLOWED_CHANNELS` (test channel IDs).

No public event URL is needed because of Socket Mode.

### Discord

1. Create an app/bot at https://discord.com/developers/applications.
2. Enable **Message Content Intent** in the developer portal.
3. Invite only to a test guild, with permission to View Channels, Send
   Messages, Read Message History, and Send Messages in Threads (where used).
4. Set `DISCORD_BOT_TOKEN`, `DISCORD_ALLOWED_USERS` (Orpheus's Discord user
   ID), `DISCORD_ALLOWED_GUILDS`, `DISCORD_ALLOWED_CHANNELS`. Multiple IDs
   can be comma-separated.

No Discord webhook endpoint is needed; the bot uses the Gateway.

## Test with Orpheus

1. DM the Slack bot “привет” and verify a reply.
2. In the allowed Slack channel, type `@Lain подведи итог этого треда`.
   Verify the answer is posted in the thread, not as an unrelated channel post.
3. Repeat in Discord DM; then mention the bot in the test channel and ask
   it to draft a reply to the conversation.
4. Verify a non-allowlisted user or channel receives **no** answer.
5. Verify the same question in another platform/thread does not inherit the
   previous participant's conversation history.
6. Verify tokens and message bodies do not appear in application logs.

## Limits / follow-up

- This version is for controlled testing, not public multi-tenant distribution.
- It needs reachable Lain OS API and live platform credentials for end-to-end
  validation. Unit tests do not make a live connection.
- Read-only agent behavior also depends on the configured Lain OS model/API
  policy. Keep privileged API capabilities disabled for the test key.
- Storage is ephemeral; production needs durable encrypted session storage,
  stronger observability, abuse/rate budgets, and an explicit user consent and
  channel-permission model.
- For Slack/Discord "draft reply" means the bot posts its suggestion; it never
  sends as a human or silently edits another person's message.
