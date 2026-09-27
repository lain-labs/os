import { createLogger } from "../logger.js";
import {
  ModelTier,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from "../types.js";
import {
  TASKS,
  TASK_ORDER,
  TaskKind,
  formatTaskRoute,
  parseTaskRoute,
  type TaskRoute,
} from "./tasks.js";

const log = createLogger("model:routing");

/**
 * Try the primary provider, and when a call fails, retry it on the backup so
 * one dead subscription/CLI never silences the agent. Built for codex (a CLI
 * that can hit rate limits or an expired login) backed by OpenRouter.
 */
export class FallbackModelProvider implements ModelProvider {
  readonly name: string;

  constructor(
    private primary: ModelProvider,
    private backup: ModelProvider,
  ) {
    this.name = `${primary.name}+${backup.name}`;
  }

  modelFor(tier: ModelTier): string {
    return this.primary.modelFor(tier);
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    try {
      return await this.primary.generate(request);
    } catch (err) {
      log.warn(`${this.primary.name} failed — falling back to ${this.backup.name}`, err);
      return this.backup.generate(request);
    }
  }

  async stream(
    request: ModelRequest,
    onText: (delta: string) => void,
  ): Promise<ModelResponse> {
    // Once the primary has emitted visible deltas a silent switch would
    // duplicate text, so only fall back on failures that produced nothing.
    let emitted = false;
    const guarded = (delta: string) => {
      emitted = true;
      onText(delta);
    };
    try {
      return await callProvider(this.primary, request, guarded);
    } catch (err) {
      if (emitted) throw err;
      log.warn(`${this.primary.name} failed — falling back to ${this.backup.name}`, err);
      return callProvider(this.backup, request, onText);
    }
  }
}
/**
 * Route each {@link ModelTier} to its own provider, e.g. the main chat (LARGE)
 * through codex while cheap background work (scout digests use MEDIUM) stays
 * on OpenRouter. Configured via LAINOS_MODEL_TIER_* in createModelProvider.
 */
export class TieredModelProvider implements ModelProvider {
  readonly name: string;

  constructor(private routes: Record<ModelTier, ModelProvider>) {
    // The LARGE route answers the main chat, so it names the ensemble; a
    // joined all-tiers name overflows the TUI boot card. createModelProvider
    // logs the full per-tier map instead.
    this.name = routes[ModelTier.LARGE].name;
  }

  modelFor(tier: ModelTier): string {
    return this.routes[tier].modelFor(tier);
  }

  generate(request: ModelRequest): Promise<ModelResponse> {
    return this.routes[request.tier].generate(request);
  }

  stream(
    request: ModelRequest,
    onText: (delta: string) => void,
  ): Promise<ModelResponse> {
    return callProvider(this.routes[request.tier], request, onText);
  }
}

/**
 * The chat providers an operator switches between, in preference order —
 * the single source of truth behind every switch surface (the TUI's /model,
 * the HTTP /provider endpoint, and Lain's own set_chat_provider action).
 */
export const CHAT_PROVIDER_CHOICES: { name: string; kind: string; desc: string }[] = [
  { name: "claude", kind: "claude", desc: "Claude CLI · subscription, no key" },
  { name: "codex", kind: "codex", desc: "Codex CLI · ChatGPT subscription" },
  { name: "opencode", kind: "opencode", desc: "OpenCode CLI · your own OpenCode setup" },
  { name: "claude-api", kind: "anthropic", desc: "Anthropic API key · per token" },
];

/** Operator-facing name (or a raw kind) → model-provider kind. */
export function resolveChatProviderKind(raw: string): string | undefined {
  const name = raw.trim().toLowerCase();
  const choice = CHAT_PROVIDER_CHOICES.find((c) => c.name === name || c.kind === name);
  if (choice) return choice.kind;
  // Kinds without a switch entry are still addressable by their own name.
  return ["openrouter", "mock"].includes(name) ? name : undefined;
}

/** Human label for a kind: "claude" and "anthropic" are the same models. */
export function chatProviderLabel(kind: string): string {
  if (kind === "claude") return "claude (cli)";
  if (kind === "opencode") return "opencode (cli)";
  return kind === "anthropic" ? "claude (anthropic api)" : kind;
}

/** One row of the routing table an operator reads with `/tasks`. */
export interface TaskRouteState {
  task: TaskKind;
  emoji: string;
  /** Provider kind answering this kind of work. */
  provider: string;
  /** Model id it will use. */
  model: string;
  /**
   * Where the route came from: an operator's own choice, the environment, the
   * blanket cheap knob, or nothing at all (it rides the live chat provider).
   */
  source: "operator" | "env" | "cheap" | "base";
  /** True when this kind acts on the world (money, code). */
  critical: boolean;
  /** Set when the route could not be built — the base answers instead. */
  error?: string;
}

/** A route plus where it came from, as the router stores it. */
export interface TaskRouteEntry {
  route: TaskRoute;
  source: "operator" | "env" | "cheap";
}

export interface ChatProviderState {
  /** Active base kind, e.g. "codex" or "anthropic". */
  kind: string;
  /** Name of the active ensemble (may include a fallback suffix). */
  name: string;
  /** Model id that answers LARGE-tier (live chat) requests. */
  model: string;
  /** Base kind the environment would pick with no runtime override. */
  envKind: string;
  /** True when a runtime override (set_chat_provider) diverges from the env. */
  overridden: boolean;
}

/**
 * Mutable front for the live chat ensemble so the operator can re-route
 * replies between providers ("answer using Claude") without a restart.
 * The runtime keeps one reference to this object; switchTo swaps what it
 * delegates to and persists the choice so self-upgrade restarts keep it.
 */
export class SwitchableModelProvider implements ModelProvider {
  private active: ModelProvider;
  private kind: string;
  private readonly envKind: string;
  private readonly assemble: (kind: string) => ModelProvider | undefined;
  private readonly persist: (kind: string | null) => void;
  /** Standing policy from the environment (LAINOS_TASK_*, LAINOS_TASK_CHEAP). */
  private readonly baseRoutes: Partial<Record<TaskKind, TaskRouteEntry>>;
  /** Routes the operator set at runtime — they win, and they are persisted. */
  private operatorRoutes: Partial<Record<TaskKind, TaskRoute>>;
  private readonly buildRoute?: (route: TaskRoute) => ModelProvider | undefined;
  private readonly persistRoutes?: (routes: Record<string, string>) => void;
  /** Built providers keyed by formatted route, and the routes that failed. */
  private readonly routeCache = new Map<string, ModelProvider>();
  private readonly routeErrors = new Map<string, string>();

  constructor(opts: {
    initial: ModelProvider;
    kind: string;
    envKind: string;
    /** Rebuild the full ensemble (base + fallback + tiers) for a base kind. */
    assemble: (kind: string) => ModelProvider | undefined;
    /** Store the override; null clears it (choice matches the env default). */
    persist: (kind: string | null) => void;
    /** Per-task routes read from the environment at boot. */
    routes?: Partial<Record<TaskKind, TaskRouteEntry>>;
    /** Per-task routes the operator set in an earlier run. */
    operatorRoutes?: Partial<Record<TaskKind, TaskRoute>>;
    /** Build one provider for a route (provider kind + optional pinned model). */
    buildRoute?: (route: TaskRoute) => ModelProvider | undefined;
    /** Store the operator's routes so a restart keeps them. */
    persistRoutes?: (routes: Record<string, string>) => void;
  }) {
    this.active = opts.initial;
    this.kind = opts.kind;
    this.envKind = opts.envKind;
    this.assemble = opts.assemble;
    this.persist = opts.persist;
    this.baseRoutes = opts.routes ?? {};
    this.operatorRoutes = { ...(opts.operatorRoutes ?? {}) };
    this.buildRoute = opts.buildRoute;
    this.persistRoutes = opts.persistRoutes;
  }

  get name(): string {
    return this.active.name;
  }

  modelFor(tier: ModelTier): string {
    return this.active.modelFor(tier);
  }

  generate(request: ModelRequest): Promise<ModelResponse> {
    return this.providerFor(request.task).generate(request);
  }

  stream(
    request: ModelRequest,
    onText: (delta: string) => void,
  ): Promise<ModelResponse> {
    return callProvider(this.providerFor(request.task), request, onText);
  }

  // ------------------------------------------------------------ task routes

  /**
   * Who answers this kind of work: its route when it has one, otherwise the
   * live chat provider. A route that cannot be built (missing key, missing
   * CLI) falls back to the base and is remembered as an error rather than
   * retried on every turn — an operator reads it in `/tasks`.
   */
  providerFor(task?: TaskKind): ModelProvider {
    const entry = this.routeEntry(task);
    if (!entry) return this.active;
    return this.buildCached(entry.route) ?? this.active;
  }

  private routeEntry(task?: TaskKind): TaskRouteEntry | undefined {
    if (!task) return undefined;
    const own = this.operatorRoutes[task];
    if (own) return { route: own, source: "operator" };
    return this.baseRoutes[task];
  }

  private buildCached(route: TaskRoute): ModelProvider | undefined {
    const key = formatTaskRoute(route);
    const cached = this.routeCache.get(key);
    if (cached) return cached;
    if (this.routeErrors.has(key)) return undefined;
    const built = this.buildRoute?.(route);
    if (!built) {
      this.routeErrors.set(key, `route "${key}" is unavailable (missing API key or CLI?)`);
      log.warn(`task route ${key} could not be built — those tasks stay on ${this.kind}`);
      return undefined;
    }
    this.routeCache.set(key, built);
    return built;
  }

  /**
   * Point one kind of work at a provider — `/tasks digest openrouter:…`, or
   * Lain's own set_task_route. `null` drops the operator's route and returns
   * the kind to whatever the environment says. Fails loudly (a string) when
   * the route cannot be built: a route nobody can serve is worse than none.
   */
  setTaskRoute(task: TaskKind, raw: string | null): TaskRouteState | string {
    if (raw === null) {
      delete this.operatorRoutes[task];
      this.savePersistedRoutes();
      return this.taskRouteState(task);
    }
    const route = parseTaskRoute(raw);
    if (!route) return `could not read the route "${raw}" — use provider[:model], e.g. openrouter:openrouter/free`;
    const key = formatTaskRoute(route);
    this.routeErrors.delete(key);
    const built = this.buildCached(route);
    if (!built) {
      return `provider "${route.provider}" is unavailable (missing API key or CLI?) — ${task} unchanged`;
    }
    this.operatorRoutes[task] = route;
    this.savePersistedRoutes();
    const spec = TASKS[task];
    if (spec.critical) {
      log.warn(
        `${spec.emoji} ${task} now answers through ${key} — this kind acts on the world, ` +
          `make sure that model is one you trust`,
      );
    } else {
      log.info(`${spec.emoji} ${task} now answers through ${key}`);
    }
    return this.taskRouteState(task);
  }

  private savePersistedRoutes(): void {
    if (!this.persistRoutes) return;
    const out: Record<string, string> = {};
    for (const [task, route] of Object.entries(this.operatorRoutes)) {
      if (route) out[task] = formatTaskRoute(route);
    }
    try {
      this.persistRoutes(out);
    } catch (err) {
      log.warn("could not persist task routes", err);
    }
  }

  /** The whole routing table, in display order — what `/tasks` prints. */
  taskRoutes(): TaskRouteState[] {
    return TASK_ORDER.map((task) => this.taskRouteState(task));
  }

  taskRouteState(task: TaskKind): TaskRouteState {
    const spec = TASKS[task];
    const entry = this.routeEntry(task);
    if (!entry) {
      return {
        task,
        emoji: spec.emoji,
        provider: this.kind,
        model: this.active.modelFor(spec.tier),
        source: "base",
        critical: spec.critical,
      };
    }
    const built = this.buildCached(entry.route);
    if (!built) {
      return {
        task,
        emoji: spec.emoji,
        provider: this.kind,
        model: this.active.modelFor(spec.tier),
        source: "base",
        critical: spec.critical,
        error: this.routeErrors.get(formatTaskRoute(entry.route)),
      };
    }
    return {
      task,
      emoji: spec.emoji,
      provider: entry.route.provider,
      model: entry.route.model ?? built.modelFor(spec.tier),
      source: entry.source,
      critical: spec.critical,
    };
  }

  /**
   * Re-route live replies to another base kind. Fails loudly (returns an
   * error string) when the kind cannot be built — a missing key or CLI must
   * never silently land the chat on the mock model.
   */
  switchTo(kind: string): ChatProviderState | string {
    const next = this.assemble(kind);
    if (!next) {
      return `provider "${kind}" is unavailable (missing API key or CLI?) — staying on ${this.kind}`;
    }
    this.active = next;
    this.kind = kind;
    try {
      this.persist(kind === this.envKind ? null : kind);
    } catch (err) {
      log.warn("could not persist chat provider override", err);
    }
    log.info(`live chat provider switched to ${kind} (${next.name})`);
    return this.state();
  }

  state(): ChatProviderState {
    return {
      kind: this.kind,
      name: this.active.name,
      model: this.active.modelFor(ModelTier.LARGE),
      envKind: this.envKind,
      overridden: this.kind !== this.envKind,
    };
  }
}

/**
 * One line of provenance: `📰 digest · openrouter/free ← groq`.
 *
 * Every surface that shows who answered renders this same string, because the
 * question "which model generated this?" has one answer and three places it
 * could disagree. The arrow is the part a model id alone cannot say: the
 * provider is a *gateway* (`lain-free`, `openrouter/free` are aliases) and the
 * upstream is who actually ran it.
 */
export function answerStamp(result: {
  task?: TaskKind;
  model?: string;
  provider?: string;
  upstream?: string;
  escalatedFrom?: TaskKind;
}): string {
  const parts: string[] = [];
  if (result.task) {
    const spec = TASKS[result.task];
    parts.push(`${spec.emoji} ${spec.label}${result.escalatedFrom ? `↑ (was ${result.escalatedFrom})` : ""}`);
  }
  const who = [result.provider, result.model].filter(Boolean).join("/");
  if (who) parts.push(result.upstream ? `${who} ← ${result.upstream}` : who);
  return parts.join(" · ");
}

/** Stream when the provider can, otherwise generate and emit the text whole. */
async function callProvider(
  provider: ModelProvider,
  request: ModelRequest,
  onText: (delta: string) => void,
): Promise<ModelResponse> {
  if (provider.stream) return provider.stream(request, onText);
  const res = await provider.generate(request);
  if (res.text) onText(res.text);
  return res;
}
