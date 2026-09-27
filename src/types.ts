/**
 * LainOS core types.
 *
 * The framework is organised around a small set of composable primitives,
 * deliberately close in spirit to ElizaOS but trimmed to the essentials:
 *
 *   Character   — the agent's identity, voice, and knowledge.
 *   Memory      — a single recorded message/observation/fact.
 *   Provider    — injects live context into the prompt (time, chain state, ...).
 *   Action      — something the agent can *do* (reply, transfer, query chain).
 *   Evaluator   — runs after a response to learn/extract facts.
 *   Plugin      — a bundle of actions + providers + evaluators + services.
 *   ModelProvider — the LLM backend (Anthropic Claude by default).
 *   EmbeddingProvider — optional vector backend for semantic memory recall.
 *   AgentRuntime — wires it all together and drives the think→act loop.
 */

import type { SessionStore } from "./memory/sessions.js";
import type { TaskKind } from "./models/tasks.js";

export type UUID = string;

/** Model capability tiers. Map to concrete model ids in the provider. */
export enum ModelTier {
  SMALL = "small",
  MEDIUM = "medium",
  LARGE = "large",
}

export interface CharacterStyle {
  /** Global voice guidance. */
  all: string[];
  /** Chat-specific tone. */
  chat: string[];
  /** Post/announcement tone. */
  post: string[];
}

export interface Character {
  name: string;
  /** A few sentences establishing who the agent is. */
  bio: string[];
  /** Background lore the agent treats as true about itself. */
  lore: string[];
  /** Topics the agent gravitates toward. */
  topics: string[];
  /** Adjectives describing the agent's manner. */
  adjectives: string[];
  /** Few-shot examples: pairs of (user, agent) turns. */
  examples: { user: string; agent: string }[];
  style: CharacterStyle;
  /** Which model tier to use for the main reasoning step. */
  modelTier?: ModelTier;
  /** Plugin names this character wants enabled. */
  plugins?: string[];
}

export interface Memory {
  id: UUID;
  roomId: string;
  /** Stable id for the speaker (user id, "agent", a wallet, ...). */
  userId: string;
  role: "user" | "agent" | "system";
  content: string;
  /** Free-form structured payload (action results, chain data, ...). */
  metadata?: Record<string, unknown>;
  createdAt: number;
  /** Higher = more important; biases retrieval and retention. */
  importance?: number;
}

export interface MemoryStore {
  add(memory: Memory): Promise<void>;
  /** Most recent memories in a room, newest last. */
  recent(roomId: string, limit: number): Promise<Memory[]>;
  /**
   * Relevance retrieval. Keyword + recency + importance by default; semantic
   * (embedding cosine) + recency + importance when an {@link EmbeddingProvider}
   * is wired into the store.
   */
  search(roomId: string, query: string, limit: number): Promise<Memory[]>;
  /** Durable agent facts not tied to a single room (learned knowledge). */
  remember(fact: string, metadata?: Record<string, unknown>): Promise<void>;
  facts(limit: number): Promise<string[]>;
}

/**
 * Turns text into vectors for semantic memory retrieval. Optional: without one,
 * the memory store falls back to keyword matching. Vectors are expected to be
 * L2-normalised so similarity is a dot product.
 */
export interface EmbeddingProvider {
  name: string;
  /** Nominal vector dimensionality (informational; the store is dim-agnostic). */
  dimensions: number;
  /** Embed a batch, returning one vector per input in the same order. */
  embed(texts: string[]): Promise<number[][]>;
}

/** The assembled context handed to the model on each turn. */
export interface State {
  roomId: string;
  agentName: string;
  /** Latest incoming message being responded to. */
  message: Memory;
  /** Recent conversation, oldest first. */
  recent: Memory[];
  /** Retrieved relevant memories. */
  relevant: Memory[];
  /** Durable learned facts. */
  facts: string[];
  /** Text contributed by providers, keyed by provider name. */
  providerContext: Record<string, string>;
  /** Names of actions currently available. */
  availableActions: string[];
}

export interface Provider {
  name: string;
  /** Return a chunk of context text, or "" to contribute nothing. */
  get(runtime: IAgentRuntime, state: State): Promise<string>;
}

export interface ActionExample {
  user: string;
  agent: string;
}

export interface ActionResult {
  text?: string;
  /** Arbitrary structured output (tx hash, balances, ...). */
  data?: Record<string, unknown>;
  /** If false, the runtime treats the action as a no-op/decline. */
  ok: boolean;
}

export interface Action {
  name: string;
  /** Aliases the model may emit. */
  similes: string[];
  description: string;
  examples: ActionExample[];
  /** JSON schema for the action's params, exposed to the model as a tool. */
  parameters?: ToolSchema["input_schema"];
  /** Cheap gate: can this action even run for the current state? */
  validate(runtime: IAgentRuntime, state: State): Promise<boolean>;
  /** Perform the action. `params` come from the model's tool call. */
  handler(
    runtime: IAgentRuntime,
    state: State,
    params: Record<string, unknown>,
  ): Promise<ActionResult>;
}

export interface Evaluator {
  name: string;
  description: string;
  validate(runtime: IAgentRuntime, state: State): Promise<boolean>;
  handler(runtime: IAgentRuntime, state: State, response: string): Promise<void>;
}

/** A service is a long-lived dependency (chain client, http server, ...). */
export interface Service {
  name: string;
  start?(runtime: IAgentRuntime): Promise<void>;
  stop?(): Promise<void>;
}

export interface Plugin {
  name: string;
  description: string;
  actions?: Action[];
  providers?: Provider[];
  evaluators?: Evaluator[];
  services?: Service[];
}

export interface ModelRequest {
  tier: ModelTier;
  /**
   * What kind of work this is (see models/tasks.ts). The router reads it to
   * pick a provider by cost and responsibility; providers ignore it.
   */
  task?: TaskKind;
  system: string;
  /** Conversation turns. */
  messages: { role: "user" | "assistant"; content: string }[];
  /** Tools the model may call (action schemas). */
  tools?: ToolSchema[];
  maxTokens?: number;
  temperature?: number;
}

export interface ToolSchema {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ModelToolCall {
  name: string;
  input: Record<string, unknown>;
}

export interface ModelResponse {
  text: string;
  toolCalls: ModelToolCall[];
  /** Underlying model id used, for logging. */
  model: string;
  /** Provider that actually answered ("openrouter", "claude", ...). */
  provider?: string;
  /**
   * Who ran it upstream, when the provider is a gateway rather than the model's
   * home — e.g. OpenRouter's free router served out of DeepInfra. Absent when
   * the provider *is* the runner.
   */
  upstream?: string;
}

export interface ModelProvider {
  name: string;
  modelFor(tier: ModelTier): string;
  generate(request: ModelRequest): Promise<ModelResponse>;
  /**
   * Optional streaming variant: emit text deltas through `onText` as they
   * arrive and resolve with the full response (including any tool calls).
   * Providers without this fall back to {@link generate}.
   */
  stream?(
    request: ModelRequest,
    onText: (delta: string) => void,
  ): Promise<ModelResponse>;
}

/** Result of one full think→act cycle. */
export interface TurnResult {
  text: string;
  actions: { name: string; result: ActionResult }[];
  /** Model id that produced the final reply (provenance, e.g. "codex/gpt-5.5"). */
  model?: string;
  /** Provider that produced it ("openrouter", "claude", ...). */
  provider?: string;
  /** Who ran the model upstream, when the provider is a gateway. */
  upstream?: string;
  /** Kind of work this turn was routed as, and why it was tagged that way. */
  task?: TaskKind;
  taskSignal?: string;
  /**
   * Set when a cheap task called a tool and was lifted back onto the main
   * provider mid-turn: acting on the world is never left to the free pool.
   */
  escalatedFrom?: TaskKind;
}

/**
 * Live events emitted while a turn is produced — the spine of the TUI. A turn
 * is: `thinking` → (`text` deltas) → optional (`tool` → `tool_result`)* →
 * (more `text` deltas) → `done`.
 */
export type AgentEvent =
  | { type: "thinking" }
  | { type: "task"; kind: TaskKind; signal: string; escalated?: boolean }
  | { type: "text"; delta: string }
  | { type: "tool"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; id: string; name: string; ok: boolean; summary: string }
  | { type: "done"; result: TurnResult }
  | { type: "error"; message: string };

export interface IAgentRuntime {
  readonly character: Character;
  readonly memory: MemoryStore;
  readonly model: ModelProvider;
  readonly actions: Action[];
  readonly providers: Provider[];
  readonly evaluators: Evaluator[];
  /** Index over the conversation rooms: titles, counts, recaps. */
  readonly sessions?: SessionStore;

  /** Reply token budget — the effort knob the TUI's /effort selector writes. */
  maxTokens: number;

  getService<T extends Service = Service>(name: string): T | undefined;
  getSetting(key: string): string | undefined;

  /** Register a plugin's contributions. */
  use(plugin: Plugin): void;

  /** Drive a single turn: ingest a user message, return the agent's reply. */
  handleMessage(input: {
    roomId: string;
    userId: string;
    text: string;
    /** Declare the kind of work instead of letting the classifier guess. */
    task?: TaskKind;
  }): Promise<TurnResult>;

  /**
   * Same as {@link handleMessage} but streams progress through `onEvent`
   * (thinking, text deltas, tool calls). Returns the final turn result.
   */
  handleMessageStream(
    input: { roomId: string; userId: string; text: string; task?: TaskKind },
    onEvent: (event: AgentEvent) => void,
  ): Promise<TurnResult>;
}
