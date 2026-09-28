import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createLogger } from "../logger.js";
import { ModelTier, type ModelProvider } from "../types.js";
import { AnthropicModelProvider } from "./anthropic.js";
import { ClaudeCliModelProvider, resolveClaudeBin } from "./claude-cli.js";
import { CodexModelProvider, resolveCodexBin } from "./codex.js";
import { MockModelProvider } from "./mock.js";
import { OpenRouterModelProvider } from "./openrouter.js";
import { OpencodeModelProvider, resolveOpenCodeBin } from "./opencode.js";
import {
  FallbackModelProvider,
  SwitchableModelProvider,
  TieredModelProvider,
  type TaskRouteEntry,
} from "./routing.js";
import {
  TASKS,
  TASK_ORDER,
  TaskKind,
  formatTaskRoute,
  parseTaskRoute,
  taskEnvKey,
  type TaskRoute,
} from "./tasks.js";

const log = createLogger("model");

export { AnthropicModelProvider, MockModelProvider, OpenRouterModelProvider };
export { ClaudeCliModelProvider, resolveClaudeBin } from "./claude-cli.js";
export { CodexModelProvider, resolveCodexBin } from "./codex.js";
export { OpencodeModelProvider, resolveOpenCodeBin } from "./opencode.js";
export {
  CHAT_PROVIDER_CHOICES,
  chatProviderLabel,
  FallbackModelProvider,
  resolveChatProviderKind,
  SwitchableModelProvider,
  TieredModelProvider,
} from "./routing.js";
export type { ChatProviderState, TaskRouteEntry, TaskRouteState } from "./routing.js";
export {
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
} from "./tasks.js";
export type { Classification, TaskRoute, TaskSpec } from "./tasks.js";

function tierOverrides(
  getSetting: (key: string) => string | undefined,
  prefix: string,
): Partial<Record<ModelTier, string>> {
  const out: Partial<Record<ModelTier, string>> = {};
  const map: Record<ModelTier, string> = {
    [ModelTier.SMALL]: `${prefix}_SMALL`,
    [ModelTier.MEDIUM]: `${prefix}_MEDIUM`,
    [ModelTier.LARGE]: `${prefix}_LARGE`,
  };
  for (const [tier, key] of Object.entries(map)) {
    const v = getSetting(key);
    if (v) out[tier as ModelTier] = v;
  }
  return out;
}
function splitArgs(raw?: string): string[] {
  return (raw ?? "").split(/\s+/).filter(Boolean);
}

/**
 * Pick a model provider from the environment.
 *
 * Base selection order:
 *   1. LAINOS_MODEL_PROVIDER, if set (codex | claude | opencode | openrouter | anthropic | mock)
 *   2. OPENROUTER_API_KEY present  -> openrouter
 *   3. ANTHROPIC_API_KEY present   -> anthropic
 *   4. claude CLI on the machine   -> claude
 *   5. otherwise                   -> offline mock
 *
 * `codex`, `claude` and `opencode` run completions through a coding-agent CLI
 * on the machine (ChatGPT / Claude subscription / OpenCode config, no LainOS
 * API key) and retry a failed call once on their own
 * (LAINOS_CODEX_RETRIES / LAINOS_CLAUDE_RETRIES / LAINOS_OPENCODE_RETRIES).
 * `claude` and `anthropic` are the same model family by two routes — subscription
 * CLI vs. API key — and each falls back to the other when its own route is
 * missing, so "switch to Claude" works with either one configured.
 *
 * Cross-provider fallback is opt-in: LAINOS_MODEL_FALLBACK=<provider> retries
 * failed calls on that provider. Off by default so the agent never silently
 * lands on a model the operator didn't choose.
 *
 * On top of the base, LAINOS_MODEL_TIER_SMALL / _MEDIUM / _LARGE may route a
 * single tier to a different provider.
 *
 * The returned provider is switchable at runtime (set_chat_provider): the
 * operator's choice is persisted to data/chat-provider.json and, when present,
 * wins over the env base selection on the next boot.
 */
export function createModelProvider(
  getSetting: (key: string) => string | undefined,
): ModelProvider {
  const explicit = getSetting("LAINOS_MODEL_PROVIDER")?.toLowerCase();
  const openrouterKey = getSetting("OPENROUTER_API_KEY");
  const anthropicKey = getSetting("ANTHROPIC_API_KEY");
  // Proxy for model API traffic only (hosts where the provider is blocked).
  const proxy =
    getSetting("LAINOS_MODEL_PROXY") ??
    getSetting("HTTPS_PROXY") ??
    getSetting("https_proxy");

  // Resolved once per factory call: both "claude" and a keyless "anthropic"
  // ask for it, and a PATH walk per lookup is pointless.
  let claudeBinCache: string | null | undefined;
  const claudeBin = (): string | null => {
    if (claudeBinCache === undefined) {
      claudeBinCache = resolveClaudeBin(getSetting("LAINOS_CLAUDE_BIN"));
    }
    return claudeBinCache;
  };

  const cache = new Map<string, ModelProvider>();
  const make = (kind: string, pinned?: string): ModelProvider | undefined => {
    const key = pinned ? `${kind}|${pinned}` : kind;
    const cached = cache.get(key);
    if (cached) return cached;
    const built = build(kind, pinned);
    if (built) cache.set(key, built);
    return built;
  };

  /**
   * A task route may pin one model id (`openrouter:openai/gpt-oss-120b:free`).
   * A pinned model answers every tier — the route already said what to use, so
   * a tier default underneath it would only ever contradict it.
   */
  const pin = (
    pinned: string | undefined,
    fallback: Partial<Record<ModelTier, string>>,
  ): Partial<Record<ModelTier, string>> =>
    pinned
      ? {
          [ModelTier.SMALL]: pinned,
          [ModelTier.MEDIUM]: pinned,
          [ModelTier.LARGE]: pinned,
        }
      : fallback;

  const build = (kind: string, pinned?: string): ModelProvider | undefined => {
    switch (kind) {
      case "mock":
        return new MockModelProvider();
      case "openrouter": {
        if (!openrouterKey) {
          log.warn("OpenRouter selected but OPENROUTER_API_KEY is missing.");
          return undefined;
        }
        return new OpenRouterModelProvider({
          apiKey: openrouterKey,
          baseUrl: getSetting("OPENROUTER_BASE_URL"),
          models: pin(pinned, tierOverrides(getSetting, "OPENROUTER_MODEL")),
          referer: getSetting("OPENROUTER_REFERER"),
          title: getSetting("OPENROUTER_TITLE"),
          proxy,
        });
      }
      case "anthropic": {
        if (!anthropicKey) {
          // Same models, other route: the subscription CLI needs no key.
          if (claudeBin()) {
            log.info("ANTHROPIC_API_KEY is missing — using the Claude CLI subscription instead.");
            return make("claude", pinned);
          }
          log.warn("Anthropic selected but ANTHROPIC_API_KEY is missing.");
          return undefined;
        }
        return new AnthropicModelProvider({
          apiKey: anthropicKey,
          models: pin(pinned, tierOverrides(getSetting, "LAINOS_MODEL")),
          proxy,
        });
      }
      case "claude": {
        const bin = claudeBin();
        if (!bin) {
          if (anthropicKey) {
            log.info("no claude CLI found — using the Anthropic API key instead.");
            return make("anthropic", pinned);
          }
          log.warn("claude selected but no claude CLI found (PATH or ~/.local/bin).");
          return undefined;
        }
        const timeoutRaw = Number(getSetting("LAINOS_CLAUDE_TIMEOUT_MS"));
        const retriesRaw = Number(getSetting("LAINOS_CLAUDE_RETRIES"));
        return new ClaudeCliModelProvider({
          bin,
          models: pin(pinned, tierOverrides(getSetting, "LAINOS_CLAUDE_MODEL")),
          timeoutMs: Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : undefined,
          retries: Number.isFinite(retriesRaw) && retriesRaw >= 0 ? retriesRaw : undefined,
          extraArgs: splitArgs(getSetting("LAINOS_CLAUDE_ARGS")),
          cwd:
            getSetting("LAINOS_CLAUDE_CWD") ??
            join(getSetting("LAINOS_DATA_DIR") ?? "./data", "claude"),
          proxy,
        });
      }
      case "codex": {
        const bin = resolveCodexBin(getSetting("LAINOS_CODEX_BIN"));
        if (!bin) {
          log.warn("codex selected but no codex CLI found (PATH or ~/.local/bin).");
          return undefined;
        }
        const timeoutRaw = Number(getSetting("LAINOS_CODEX_TIMEOUT_MS"));
        const retriesRaw = Number(getSetting("LAINOS_CODEX_RETRIES"));
        return new CodexModelProvider({
          bin,
          models: pin(pinned, tierOverrides(getSetting, "LAINOS_CODEX_MODEL")),
          timeoutMs: Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : undefined,
          retries: Number.isFinite(retriesRaw) && retriesRaw >= 0 ? retriesRaw : undefined,
          extraArgs: splitArgs(getSetting("LAINOS_CODEX_ARGS")),
          cwd:
            getSetting("LAINOS_CODEX_CWD") ??
            join(getSetting("LAINOS_DATA_DIR") ?? "./data", "codex"),
          proxy,
        });
      }
      case "opencode": {
        const bin = resolveOpenCodeBin(getSetting("LAINOS_OPENCODE_BIN"));
        if (!bin) {
          log.warn(
            "opencode selected but no opencode CLI found (PATH, ~/.local/bin or ~/.opencode/bin).",
          );
          return undefined;
        }
        const timeoutRaw = Number(getSetting("LAINOS_OPENCODE_TIMEOUT_MS"));
        const retriesRaw = Number(getSetting("LAINOS_OPENCODE_RETRIES"));
        return new OpencodeModelProvider({
          bin,
          models: pin(pinned, tierOverrides(getSetting, "LAINOS_OPENCODE_MODEL")),
          timeoutMs: Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : undefined,
          retries: Number.isFinite(retriesRaw) && retriesRaw >= 0 ? retriesRaw : undefined,
          extraArgs: splitArgs(getSetting("LAINOS_OPENCODE_ARGS")),
          cwd:
            getSetting("LAINOS_OPENCODE_CWD") ??
            join(getSetting("LAINOS_DATA_DIR") ?? "./data", "opencode"),
          proxy,
        });
      }
      default:
        log.warn(`unknown model provider "${kind}".`);
        return undefined;
    }
  };

  // Build the full ensemble for a base kind: base + opt-in fallback + tier
  // routing. Returns undefined when the base itself cannot be built so callers
  // (boot, set_chat_provider) decide how loudly to fail.
  const assemble = (baseKind: string): ModelProvider | undefined => {
    let provider = make(baseKind);
    if (!provider) return undefined;

    // Cross-provider fallback is opt-in only: a failed call must fail loudly
    // rather than silently land on a model the operator didn't choose.
    const fallbackKind = getSetting("LAINOS_MODEL_FALLBACK")?.toLowerCase();
    if (fallbackKind && fallbackKind !== "none" && fallbackKind !== baseKind) {
      const backup = make(fallbackKind);
      if (backup) provider = new FallbackModelProvider(provider, backup);
      else log.warn(`fallback provider "${fallbackKind}" unavailable — running without one.`);
    }

    // Per-tier routing on top of the base provider.
    const tierKinds: Record<ModelTier, string | undefined> = {
      [ModelTier.SMALL]: getSetting("LAINOS_MODEL_TIER_SMALL")?.toLowerCase(),
      [ModelTier.MEDIUM]: getSetting("LAINOS_MODEL_TIER_MEDIUM")?.toLowerCase(),
      [ModelTier.LARGE]: getSetting("LAINOS_MODEL_TIER_LARGE")?.toLowerCase(),
    };
    const routed = Object.values(tierKinds).some((k) => k && k !== baseKind);
    if (routed) {
      const routes = {} as Record<ModelTier, ModelProvider>;
      for (const tier of Object.values(ModelTier)) {
        const kind = tierKinds[tier];
        routes[tier] = (kind && make(kind)) || provider;
      }
      provider = new TieredModelProvider(routes);
      const detail = Object.values(ModelTier)
        .map((tier) => `${tier}→${routes[tier].name}`)
        .join(", ");
      log.info(`per-tier routing: ${detail}`);
    }
    return provider;
  };

  const envKind =
    explicit ||
    (openrouterKey
      ? "openrouter"
      : anthropicKey
        ? "anthropic"
        : claudeBin()
          ? "claude"
          : "mock");
  const overrideFile = chatProviderFile(getSetting);
  const stored = loadStoredChatProvider(overrideFile);
  if (stored && stored !== envKind) {
    log.info(`live chat provider override: ${stored} (env default ${envKind})`);
  }

  let baseKind = stored ?? envKind;
  let assembled = assemble(baseKind);
  if (!assembled && stored) {
    log.warn(`stored chat provider "${stored}" unavailable — using env default "${envKind}".`);
    baseKind = envKind;
    assembled = assemble(envKind);
  }
  if (!assembled) {
    log.warn(`provider "${baseKind}" unavailable — using offline mock model.`);
    baseKind = "mock";
    assembled = assemble("mock")!;
  }

  // envKind resolves to "mock" by itself only when nothing else was found
  // (no explicit override, no key, no CLI on PATH) -- as opposed to landing
  // on the mock model above because something explicit failed to build, or
  // an operator deliberately set LAINOS_MODEL_PROVIDER=mock. That specific
  // "nothing configured" case is the common one right after a fresh install
  // that skipped (or never ran) install.sh's API key prompt, so point at the
  // fastest fix instead of leaving the operator to dig through env var docs.
  if (baseKind === "mock" && envKind === "mock" && !explicit) {
    log.warn(
      "no model provider configured. Get a free Lain OS API key at " +
        "https://lain.cyberia.church/register, then set OPENROUTER_API_KEY " +
        "(and OPENROUTER_BASE_URL=https://lain.cyberia.church/v1) in your .env.",
    );
  }

  // Per-task routing: what the environment says, plus whatever the operator
  // pointed elsewhere in an earlier run (data/task-routes.json wins).
  const routesFile = taskRoutesFile(getSetting);
  const envRoutes = resolveEnvTaskRoutes(getSetting, baseKind);
  const operatorRoutes = loadStoredTaskRoutes(routesFile);

  const provider = new SwitchableModelProvider({
    initial: assembled,
    kind: baseKind,
    envKind,
    assemble,
    persist: (kind) => storeChatProvider(overrideFile, kind),
    routes: envRoutes,
    operatorRoutes,
    buildRoute: (route) => make(route.provider, route.model),
    persistRoutes: (routes) => storeTaskRoutes(routesFile, routes),
  });
  log.info(`using model provider: ${provider.name}`);

  // Say the table out loud at boot: a routing decision nobody can see is how
  // an operator ends up paying Opus rates for a news digest.
  const routed = provider
    .taskRoutes()
    .filter((r) => r.source !== "base")
    .map((r) => `${r.emoji} ${r.task}→${r.provider}${r.model ? `/${r.model}` : ""} (${r.source})`);
  if (routed.length) log.info(`task routing: ${routed.join(", ")}`);

  return provider;
}

/**
 * The standing per-task policy, read from the environment.
 *
 * Two knobs, and the second is the one that matters on a budget:
 *   LAINOS_TASK_<KIND>  — this exact kind goes to this provider[:model]
 *   LAINOS_TASK_CHEAP   — every kind marked `cheap` (digests, translation,
 *                         analysis, recaps) goes there unless named above
 *
 * With neither set, cheap work still moves off a paid base when the machine
 * already holds a free key — OpenRouter's free router — because that is free
 * by construction and the alternative is paying Opus rates to summarise an
 * RSS feed. Set LAINOS_TASK_CHEAP=none to keep everything on one provider.
 *
 * `critical` kinds (money, code) are never swept up by the cheap knob: they
 * act on the world, and cheapening them takes naming them explicitly.
 */
export function resolveEnvTaskRoutes(
  getSetting: (key: string) => string | undefined,
  baseKind: string,
): Partial<Record<TaskKind, TaskRouteEntry>> {
  const out: Partial<Record<TaskKind, TaskRouteEntry>> = {};
  const cheapRaw = getSetting("LAINOS_TASK_CHEAP")?.trim();
  const cheap = cheapRaw ? parseTaskRoute(cheapRaw) : autoCheapRoute(getSetting, baseKind);

  for (const kind of TASK_ORDER) {
    const raw = getSetting(taskEnvKey(kind))?.trim();
    const explicit = raw ? parseTaskRoute(raw) : undefined;
    if (explicit) {
      out[kind] = { route: explicit, source: "env" };
      if (TASKS[kind].critical) {
        log.warn(
          `${TASKS[kind].emoji} ${kind} is routed to ${formatTaskRoute(explicit)} — ` +
            `this kind acts on the world (money/code), so trust that model`,
        );
      }
      continue;
    }
    if (cheap && TASKS[kind].cheap) out[kind] = { route: cheap, source: "cheap" };
  }
  return out;
}

/** A free route this machine already has, other than the one already in use. */
function autoCheapRoute(
  getSetting: (key: string) => string | undefined,
  baseKind: string,
): TaskRoute | undefined {
  if (getSetting("OPENROUTER_API_KEY") && baseKind !== "openrouter") {
    return {
      provider: "openrouter",
      model: getSetting("OPENROUTER_MODEL_CHEAP")?.trim() || "openrouter/free",
    };
  }
  return undefined;
}

/** Where the operator's own per-task routes live between runs. */
function taskRoutesFile(getSetting: (key: string) => string | undefined): string {
  return join(getSetting("LAINOS_DATA_DIR") ?? "./data", "task-routes.json");
}

function loadStoredTaskRoutes(file: string): Partial<Record<TaskKind, TaskRoute>> {
  const out: Partial<Record<TaskKind, TaskRoute>> = {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { routes?: Record<string, unknown> };
    for (const [task, raw] of Object.entries(parsed.routes ?? {})) {
      if (!(task in TASKS) || typeof raw !== "string") continue;
      const route = parseTaskRoute(raw);
      if (route) out[task as TaskKind] = route;
    }
  } catch {
    // No stored routes.
  }
  return out;
}

function storeTaskRoutes(file: string, routes: Record<string, string>): void {
  if (!Object.keys(routes).length) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify({ routes, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
}

/**
 * Where the runtime chat-provider override (set_chat_provider) is persisted:
 * it must survive the self-upgrade restarts the forge triggers, or "answer
 * using Claude" would silently revert to the env default minutes later.
 */
function chatProviderFile(getSetting: (key: string) => string | undefined): string {
  return join(getSetting("LAINOS_DATA_DIR") ?? "./data", "chat-provider.json");
}

function loadStoredChatProvider(file: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { provider?: unknown };
    if (typeof parsed.provider === "string" && parsed.provider.trim()) {
      return parsed.provider.trim().toLowerCase();
    }
  } catch {
    // No override stored.
  }
  return undefined;
}

function storeChatProvider(file: string, kind: string | null): void {
  if (!kind) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify({ provider: kind, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
}
