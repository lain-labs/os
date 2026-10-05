/**
 * LainOS — a framework for autonomous AI agents with native EVM chain tooling.
 *
 * Public surface. Build an agent like:
 *
 *   import { createAgent, lain } from "lainos";
 *   const agent = await createAgent({ character: lain });
 *   const { text } = await agent.handleMessage({ roomId: "cli", userId: "me", text: "hi" });
 */
// Must be the very first import: it's a side-effecting module that loads
// .env into process.env, and every other import below (plus their own
// transitive imports) needs it to have already run in case any of them read
// process.env at their own module top level. See src/env.ts for why this
// can't just be `import "dotenv/config"`.
import "./env.js";
import { createLogger } from "./logger.js";
import { createEmbeddingProvider } from "./memory/embeddings.js";
import { SessionStore } from "./memory/sessions.js";
import { FileMemoryStore } from "./memory/store.js";
import { createModelProvider } from "./models/index.js";
import { bootstrapPlugin } from "./plugins/bootstrap/index.js";
import { channelPlugin } from "./plugins/channel/index.js";
import { chainPlugin } from "./plugins/chain/index.js";
import { crmPlugin } from "./plugins/crm/index.js";
import { forgePlugin } from "./plugins/forge/index.js";
import { githubPlugin } from "./plugins/github/index.js";
import { initiativePlugin } from "./plugins/initiative/index.js";
import { presencePlugin } from "./plugins/presence/index.js";
import { pressPlugin } from "./plugins/press/index.js";
import { scoutPlugin } from "./plugins/scout/index.js";
import { sentinelPlugin } from "./plugins/sentinel/index.js";
import { skillsPlugin } from "./plugins/skills/index.js";
import { studyPlugin } from "./plugins/study/index.js";
import { systemPlugin } from "./plugins/system/index.js";
import { telegramPlugin } from "./plugins/telegram/index.js";
import { traderPlugin } from "./plugins/trader/index.js";
import { AgentRuntime } from "./runtime.js";
import { loadSoul } from "./soul.js";
import type { Character, Plugin } from "./types.js";

export * from "./types.js";
export { AgentRuntime } from "./runtime.js";
export { loadSoul } from "./soul.js";
export { FileMemoryStore } from "./memory/store.js";
export { SessionStore, clientOfRoom, newRoomId } from "./memory/sessions.js";
export type { SessionRecap, SessionRecord, TurnRecord } from "./memory/sessions.js";
export { buildRecap, humanDuration, recapHeader, transcriptFor } from "./memory/recap.js";
export type { RecapResult } from "./memory/recap.js";
export {
  createModelProvider,
  AnthropicModelProvider,
  CodexModelProvider,
  FallbackModelProvider,
  MockModelProvider,
  OpenRouterModelProvider,
  OpencodeModelProvider,
  SwitchableModelProvider,
  TieredModelProvider,
  resolveCodexBin,
  resolveOpenCodeBin,
  TASKS,
  TASK_ORDER,
  TaskKind,
  classifyTask,
  formatTaskRoute,
  isTaskKind,
  parseTaskRoute,
  taskEnvKey,
  taskSpec,
  taskTag,
} from "./models/index.js";
export type {
  ChatProviderState,
  Classification,
  TaskRoute,
  TaskRouteState,
  TaskSpec,
} from "./models/index.js";
export { bootstrapPlugin } from "./plugins/bootstrap/index.js";
export {
  createEmbeddingProvider,
  HashingEmbeddingProvider,
  OpenAIEmbeddingProvider,
} from "./memory/embeddings.js";
export { chainPlugin, ChainService, loadChainConfig, loadChainTokens, loadDexConfig } from "./plugins/chain/index.js";
export type { ChainDexConfig, NativeBuyQuote, NativeSellQuote, DexLiquidityQuote } from "./plugins/chain/index.js";
export { systemPlugin } from "./plugins/system/index.js";
export { sentinelPlugin, SentinelService, alertLine, describeWatch } from "./plugins/sentinel/index.js";
export type { Alert, BriefSchedule, Watch, WatchKind } from "./plugins/sentinel/index.js";
export { scanWallet, buysWithin, convergingWallets, chainActivitySource } from "./plugins/sentinel/activity.js";
export type { ActivitySource, RawTransfer, WalletMove } from "./plugins/sentinel/activity.js";
export { briefMaterial, parseClock } from "./plugins/sentinel/brief.js";
export { forgePlugin, ForgeService } from "./plugins/forge/index.js";
export type { ForgeEvent, ForgeJob, Wish, WishStatus } from "./plugins/forge/index.js";
export { scoutPlugin, ScoutService, parseRss, looksLikeNothing } from "./plugins/scout/index.js";
export type { ScoutEvent, ScoutItem, Topic } from "./plugins/scout/index.js";
export { githubPlugin, GithubStreakService, parseContributionDay } from "./plugins/github/index.js";
export type { ContributionDay, GithubEvent, GithubWatch } from "./plugins/github/index.js";
export {
  channelPlugin,
  ChannelWatchService,
  parseChannelPosts,
  parseChannelPostTexts,
  normalizeChannel,
  localDay,
  inferVenueKind,
  isReadableVenue,
  isVenueDue,
  reminderText,
  venueLabel,
} from "./plugins/channel/index.js";
export type {
  ChannelActivity,
  ChannelEvent,
  ChannelPost,
  ChannelWatch,
  VenueKind,
} from "./plugins/channel/index.js";
export { TelegramClient } from "./clients/telegram.js";
export { telegramPlugin, resolveOperatorChatId, sendToOperator } from "./plugins/telegram/index.js";
export { skillsPlugin, SkillsService } from "./plugins/skills/index.js";
export type { SkillModule } from "./plugins/skills/index.js";
export { initiativePlugin, InitiativeService } from "./plugins/initiative/index.js";
export {
  studyPlugin,
  StudyService,
  DEFAULT_STUDY_AREAS,
  fingerprintOf,
  fingerprintSimilarity,
  formatFinding,
  isDuplicateFinding,
  isQuietHour,
  isSensitivePath,
  parseFinding,
  redactEvidence,
} from "./plugins/study/index.js";
export type { ParsedFinding, StudyArea, StudyFinding } from "./plugins/study/index.js";
export { presencePlugin, PresenceService } from "./plugins/presence/index.js";
export type { PresenceJournalEntry, PresenceState } from "./plugins/presence/index.js";
export {
  pressPlugin,
  PressService,
  cleanPostText,
  commitsText,
  parseGitLog,
  parsePlan,
  pendingSlots,
  planDay,
  resolveDay,
  slotFor,
  writerBrief,
  writerSystemPrompt,
} from "./plugins/press/index.js";
export type { Commit, ContentPlan, PostRecord, PostSlot, PressEvent } from "./plugins/press/index.js";
export { traderPlugin, TraderService } from "./plugins/trader/index.js";
export type { TraderEvent } from "./plugins/trader/index.js";
export { crmPlugin, CrmService } from "./plugins/crm/index.js";
export type { CrmRecord, CrmStatus } from "./plugins/crm/index.js";
export { TradeJournal, applyBuy, applySell } from "./plugins/chain/journal.js";
export type { LiquidityRecord, Position, TradeRecord } from "./plugins/chain/journal.js";
export { lain } from "./characters/lain.js";

const log = createLogger("boot");

/** Built-in plugins keyed by the names a character may request. */
const BUILTIN_PLUGINS: Record<string, Plugin> = {
  bootstrap: bootstrapPlugin,
  chain: chainPlugin,
  system: systemPlugin,
  sentinel: sentinelPlugin,
  forge: forgePlugin,
  scout: scoutPlugin,
  github: githubPlugin,
  channel: channelPlugin,
  telegram: telegramPlugin,
  skills: skillsPlugin,
  trader: traderPlugin,
  initiative: initiativePlugin,
  presence: presencePlugin,
  press: pressPlugin,
  study: studyPlugin,
  crm: crmPlugin,
};

export interface CreateAgentOptions {
  character: Character;
  /** Extra plugins beyond those named in the character. */
  plugins?: Plugin[];
  dataDir?: string;
}

/** Assemble and start an agent runtime from a character. */
export async function createAgent(opts: CreateAgentOptions): Promise<AgentRuntime> {
  const dataDir = opts.dataDir ?? process.env.LAINOS_DATA_DIR ?? "./data";
  const getSetting = (k: string) => process.env[k];
  const embedder = createEmbeddingProvider(getSetting);
  const memory = new FileMemoryStore(dataDir, embedder);
  const model = createModelProvider(getSetting);
  // Every surface leaves a session behind without being asked to — that is
  // what makes /resume and /recap possible days later.
  const sessionLimit = Number(getSetting("LAINOS_SESSION_LIMIT"));
  const sessions = new SessionStore(
    dataDir,
    Number.isFinite(sessionLimit) && sessionLimit > 0 ? sessionLimit : undefined,
  );

  // Pin the data dir in settings so services (sentinel, telegram) that read
  // LAINOS_DATA_DIR land in the same place as the memory store.
  const runtime = new AgentRuntime({
    character: opts.character,
    memory,
    model,
    sessions,
    soul: loadSoul(getSetting),
    settings: { ...process.env, LAINOS_DATA_DIR: dataDir },
  });

  const wanted = new Set(opts.character.plugins ?? ["bootstrap"]);
  for (const name of wanted) {
    const plugin = BUILTIN_PLUGINS[name];
    if (plugin) runtime.use(plugin);
    else log.warn(`character requested unknown plugin: ${name}`);
  }
  for (const p of opts.plugins ?? []) runtime.use(p);

  await runtime.start();
  return runtime;
}
