import "dotenv/config";
import { App } from "@slack/bolt";
import { Client, GatewayIntentBits, Partials } from "discord.js";
import { ids, stripMention, splitText, SeenEvents, LainBridge } from "./core.js";

const env = process.env;
const bridge = new LainBridge({
  apiKey: env.LAIN_API_KEY,
  baseUrl: env.LAIN_API_BASE_URL || "https://lain-os.com/v1",
  model: env.LAIN_MODEL || "lain-free"
});
const seen = new SeenEvents();
const contextLimit = Math.max(0, Math.min(15, Number(env.BOT_CONTEXT_MESSAGES ?? "10") || 0));
const slackUsers = ids(env.SLACK_ALLOWED_USERS);
const slackTeams = ids(env.SLACK_ALLOWED_TEAMS);
const slackChannels = ids(env.SLACK_ALLOWED_CHANNELS);
const discordUsers = ids(env.DISCORD_ALLOWED_USERS);
const discordGuilds = ids(env.DISCORD_ALLOWED_GUILDS);
const discordChannels = ids(env.DISCORD_ALLOWED_CHANNELS);

function background(job, platform) {
  void job.catch((error) => {
    // Do not log payloads, tokens, prompts or model output.
    console.error("[" + platform + "] request failed:", error?.name || "Error", error?.message || "");
  });
}

async function slackContext(client, channel, thread, currentTs) {
  if (!contextLimit) return [];
  try {
    const result = thread
      ? await client.conversations.replies({ channel, ts: thread, limit: contextLimit })
      : await client.conversations.history({ channel, limit: contextLimit });
    return (result.messages || [])
      .filter((m) => m.text && m.ts !== currentTs && !m.bot_id)
      .map((m) => ({ user: m.user || "unknown", text: m.text }))
      .reverse();
  } catch {
    // Missing history permissions should not break a direct mention.
    return [];
  }
}

let slack;
if (env.SLACK_BOT_TOKEN || env.SLACK_APP_TOKEN) {
  if (!env.SLACK_BOT_TOKEN || !env.SLACK_APP_TOKEN || !slackUsers.size || !slackTeams.size) {
    throw new Error("Slack needs SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_ALLOWED_USERS and SLACK_ALLOWED_TEAMS");
  }
  slack = new App({
    token: env.SLACK_BOT_TOKEN,
    appToken: env.SLACK_APP_TOKEN,
    socketMode: true
  });
  const identity = await slack.client.auth.test();
  const botId = identity.user_id;
  if (!botId) throw new Error("Cannot identify Slack bot");

  async function onSlack(event, body, client, dm) {
    if (!event.user || event.bot_id || event.subtype || !event.text) return;
    const team = body.team_id || body.authorizations?.[0]?.team_id;
    if (!slackTeams.has(team) || !slackUsers.has(event.user)) return;
    if (!dm && !slackChannels.has(event.channel)) return;
    const id = "slack:" + (body.event_id || event.client_msg_id || event.event_ts || event.ts);
    if (seen.has(id)) return;
    const query = stripMention(event.text, "slack", botId);
    if (!query) return;
    const thread = dm ? "dm" : (event.thread_ts || event.ts);
    const context = dm ? [] : await slackContext(client, event.channel, event.thread_ts || undefined, event.ts);
    const response = await bridge.answer({
      platform: "slack",
      workspace: team,
      channel: event.channel,
      thread,
      user: event.user,
      dm,
      text: query,
      context
    });
    for (const chunk of splitText(response, 3500)) {
      await client.chat.postMessage({
        channel: event.channel,
        text: chunk,
        ...(dm ? {} : { thread_ts: thread })
      });
    }
  }

  slack.event("app_mention", async ({ event, body, client }) => {
    background(onSlack(event, body, client, false), "slack");
  });
  slack.event("message", async ({ event, body, client }) => {
    if (event.channel_type !== "im") return;
    background(onSlack(event, body, client, true), "slack");
  });

  await slack.start();
  console.log("[slack] Socket Mode started");
}

let discord;
if (env.DISCORD_BOT_TOKEN) {
  if (!discordUsers.size) throw new Error("Discord needs DISCORD_ALLOWED_USERS");
  discord = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel]
  });

  async function onDiscord(message) {
    if (!message.author || message.author.bot || !message.content || !discord.user) return;
    const dm = !message.guildId;
    if (!discordUsers.has(message.author.id)) return;
    if (!dm && (!discordGuilds.has(message.guildId) || !discordChannels.has(message.channelId))) return;
    if (!dm && !message.mentions.users.has(discord.user.id)) return;
    if (seen.has("discord:" + message.id)) return;
    const query = stripMention(message.content, "discord", discord.user.id);
    if (!query) return;
    const thread = dm ? "dm" : (message.channel.isThread?.() ? message.channelId : message.id);
    let context = [];
    if (!dm && contextLimit && message.channel.messages?.fetch) {
      try {
        const recent = await message.channel.messages.fetch({ limit: contextLimit });
        context = [...recent.values()]
          .filter((m) => m.id !== message.id && !m.author?.bot && m.content)
          .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
          .map((m) => ({ user: m.author.id, text: m.content }));
      } catch { /* no history permission: answer without context */ }
    }
    const response = await bridge.answer({
      platform: "discord",
      workspace: message.guildId || "dm",
      channel: message.channelId,
      thread,
      user: message.author.id,
      dm,
      text: query,
      context
    });
    const chunks = splitText(response, 1900);
    await message.reply({ content: chunks.shift(), allowedMentions: { repliedUser: false, parse: [] } });
    for (const chunk of chunks) {
      await message.channel.send({ content: chunk, allowedMentions: { parse: [] } });
    }
  }

  discord.on("messageCreate", (message) => background(onDiscord(message), "discord"));
  discord.on("error", (error) => console.error("[discord]", error?.message || "connection error"));
  await discord.login(env.DISCORD_BOT_TOKEN);
  console.log("[discord] Gateway connected");
}

if (!slack && !discord) {
  throw new Error("Configure at least one Slack or Discord bot token");
}

async function stop() {
  await Promise.allSettled([slack?.stop(), Promise.resolve(discord?.destroy())]);
  process.exit(0);
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
