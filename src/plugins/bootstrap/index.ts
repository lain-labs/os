import {
  answerStamp,
  CHAT_PROVIDER_CHOICES,
  chatProviderLabel,
  resolveChatProviderKind,
  SwitchableModelProvider,
} from "../../models/routing.js";
import { TASKS, TASK_ORDER, TaskKind, isTaskKind } from "../../models/tasks.js";
import type { Action, Evaluator, IAgentRuntime, Plugin, Provider } from "../../types.js";

/** Injects the current wall-clock time so the agent is temporally grounded. */
const timeProvider: Provider = {
  name: "time",
  async get() {
    const now = new Date();
    return `Current UTC time: ${now.toISOString()}.`;
  },
};

/**
 * Heuristic fact extractor. Avoids an extra model call (so it works offline):
 * captures self-identification and explicit "remember ..." requests as durable
 * facts. A model-backed extractor can replace this via the same interface.
 */
const factEvaluator: Evaluator = {
  name: "fact_extractor",
  description: "Stores durable facts the user shares about themselves.",
  async validate(_runtime, state) {
    return state.message.role === "user";
  },
  async handler(runtime, state) {
    const text = state.message.content.trim();
    const patterns: Array<{ re: RegExp; userName?: boolean }> = [
      { re: /\bmy name is\s+([^.!?\n]{1,40})/i, userName: true },
      { re: /\bremember that\s+([^.!?\n]{1,120})/i },
    ];
    for (const { re, userName } of patterns) {
      const m = text.match(re);
      if (m?.[1]) {
        const fact = userName
          ? `The user (${state.message.userId}) is named ${m[1].trim()}.`
          : m[1].trim();
        await runtime.memory.remember(fact, {
          source: "fact_extractor",
          userId: state.message.userId,
        });
      }
    }
  },
};

/**
 * Deliberate write to long-term memory. The fact extractor catches things
 * passively; this lets the agent itself choose to persist something durable.
 */
const rememberAction: Action = {
  name: "remember",
  similes: ["memorize", "note", "save_memory", "keep_in_mind"],
  description:
    "Store a durable fact in long-term memory so it persists across sessions and rooms.",
  parameters: {
    type: "object",
    properties: {
      fact: {
        type: "string",
        description: "The fact to remember, as a short standalone statement.",
      },
    },
    required: ["fact"],
  },
  examples: [{ user: "remember that my wallet is 0xabc", agent: "Noting that down." }],
  async validate() {
    return true;
  },
  async handler(runtime, _state, params) {
    const fact = String(params.fact ?? "").trim();
    if (!fact) return { ok: false, text: "There's nothing to remember." };
    await runtime.memory.remember(fact, { source: "remember_action" });
    return { ok: true, text: `Remembered: ${fact}`, data: { fact } };
  },
};

/** Read back from long-term memory: durable facts plus this room's history. */
const recallAction: Action = {
  name: "recall",
  similes: ["search_memory", "what_do_you_know", "remember_what"],
  description:
    "Search long-term memory — durable facts and earlier conversation in this room — for relevant context.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "What to look for. Omit to list recent durable facts.",
      },
    },
  },
  examples: [{ user: "what do you know about me?", agent: "Let me check my memory…" }],
  async validate() {
    return true;
  },
  async handler(runtime, state, params) {
    const query = String(params.query ?? "").trim();
    const facts = await runtime.memory.facts(50);
    const matchedFacts = query
      ? facts.filter((f) => f.toLowerCase().includes(query.toLowerCase()))
      : facts.slice(-15);
    const episodic = query ? await runtime.memory.search(state.roomId, query, 5) : [];
    const lines: string[] = [];
    if (matchedFacts.length) lines.push("facts:", ...matchedFacts.map((f) => `- ${f}`));
    if (episodic.length)
      lines.push("from earlier here:", ...episodic.map((m) => `- (${m.role}) ${m.content}`));
    if (!lines.length) {
      return {
        ok: true,
        text: query ? `Nothing in memory about "${query}".` : "Memory is empty.",
      };
    }
    return { ok: true, text: lines.join("\n"), data: { facts: matchedFacts } };
  },
};

// ------------------------------------------------------------- chat provider

function switchableModel(runtime: IAgentRuntime): SwitchableModelProvider | undefined {
  return runtime.model instanceof SwitchableModelProvider ? runtime.model : undefined;
}

/**
 * Re-route the live replies between Claude, Codex and OpenCode on operator
 * request ("answer using Claude"). Forge coding jobs have their own
 * switch (set_forge_provider); this one only touches the chat model.
 */
const setChatProviderAction: Action = {
  name: "set_chat_provider",
  similes: [
    "switch_chat_provider",
    "set_reply_provider",
    "reply_via_claude",
    "reply_via_codex",
    "reply_via_opencode",
  ],
  description:
    "Switch which model writes the live replies in this chat: claude (Claude CLI subscription), " +
    "claude-api (Anthropic API key), codex (Codex CLI), or opencode (OpenCode CLI). " +
    "Takes effect immediately and survives restarts. Forge coding jobs are separate — " +
    "use set_forge_provider for those.",
  parameters: {
    type: "object",
    properties: {
      provider: {
        type: "string",
        enum: CHAT_PROVIDER_CHOICES.map((c) => c.name),
        description: "Model provider for live replies.",
      },
    },
    required: ["provider"],
  },
  examples: [
    {
      user: "answer using Claude instead of codex",
      agent: "Switching: live replies are now written by Claude.",
    },
  ],
  async validate(runtime) {
    return Boolean(switchableModel(runtime));
  },
  async handler(runtime, _state, params) {
    const model = switchableModel(runtime);
    if (!model) return { ok: false, text: "The live model provider is fixed for this run." };
    const kind = resolveChatProviderKind(String(params.provider ?? ""));
    if (!kind) {
      return {
        ok: false,
        text: `provider must be one of: ${CHAT_PROVIDER_CHOICES.map((c) => c.name).join(", ")}`,
      };
    }
    const result = model.switchTo(kind);
    if (typeof result === "string") return { ok: false, text: result };
    return {
      ok: true,
      text:
        `Live replies now go through ${chatProviderLabel(result.kind)} — ${result.model}. ` +
        `Forge jobs are unchanged.`,
      data: { provider: result.kind, model: result.model, overridden: result.overridden },
    };
  },
};

const chatProviderStatusAction: Action = {
  name: "chat_provider_status",
  similes: ["which_model_answers", "reply_provider_status", "what_writes_replies"],
  description:
    "Report which model provider writes the live replies right now, and what the environment " +
    "default is.",
  parameters: { type: "object", properties: {} },
  examples: [
    {
      user: "what are you answering with right now?",
      agent: "Live replies are written by codex; that's also the default provider.",
    },
  ],
  async validate(runtime) {
    return Boolean(switchableModel(runtime));
  },
  async handler(runtime, state) {
    const model = switchableModel(runtime);
    if (!model) return { ok: false, text: "The live model provider is fixed for this run." };
    const s = model.state();
    // What is *configured* is not what answered: an alias like `openrouter/free`
    // resolves to a different model per call, and the last reply carries the
    // provider, the model and the upstream that actually produced it. Report
    // the receipt, not the setting — that is what the question is usually about.
    const recent = await runtime.memory.recent(state.roomId, 12);
    const previous = [...recent]
      .reverse()
      .find((m) => m.role === "agent" && typeof m.metadata?.model === "string");
    const last = previous
      ? answerStamp({
          task: isTaskKind(previous.metadata?.task) ? previous.metadata?.task : undefined,
          model: String(previous.metadata?.model),
          provider:
            typeof previous.metadata?.provider === "string" ? previous.metadata.provider : undefined,
          upstream:
            typeof previous.metadata?.upstream === "string" ? previous.metadata.upstream : undefined,
        })
      : "";
    return {
      ok: true,
      text:
        (last ? `The previous reply here was written by ${last}. ` : "") +
        `Configured for live replies: ${chatProviderLabel(s.kind)} — ${s.model} (ensemble ${s.name}). ` +
        (s.overridden
          ? `Runtime override active; env default is ${s.envKind}.`
          : `Matches the env default.`) +
        ` Note the id is what is asked for; every reply is stamped with the provider, the model and the upstream that actually answered.`,
      data: {
        provider: s.kind,
        model: s.model,
        ensemble: s.name,
        envDefault: s.envKind,
        overridden: s.overridden,
        lastAnswer: last || undefined,
      },
    };
  },
};

// --------------------------------------------------------------- task routes

/** One printable row: `📰 digest → openrouter/openrouter/free (cheap)`. */
function routeLine(row: {
  emoji: string;
  task: TaskKind;
  provider: string;
  model: string;
  source: string;
  error?: string;
}): string {
  const where = `${row.provider}${row.model ? ` · ${row.model}` : ""}`;
  return `${row.emoji} ${row.task} → ${where} (${row.source})${row.error ? ` ⚠ ${row.error}` : ""}`;
}

/**
 * Point one kind of work at one provider. This is the knob that makes a
 * budget hold: digests and translation on a free model, the chat and anything
 * touching money on the one the operator trusts.
 */
const setTaskRouteAction: Action = {
  name: "set_task_route",
  similes: ["route_task", "set_task_provider", "assign_model_to_task"],
  description:
    "Route one kind of work to a model provider: " +
    TASK_ORDER.map((t) => `${t} (${TASKS[t].desc})`).join(", ") +
    ". The route is provider[:model], e.g. openrouter:openrouter/free, claude. " +
    'Pass route="default" to hand the kind back to the environment\'s own choice. ' +
    "Live chat provider switching is a different thing — use set_chat_provider for that.",
  parameters: {
    type: "object",
    properties: {
      task: { type: "string", enum: [...TASK_ORDER], description: "Kind of work to route." },
      route: {
        type: "string",
        description: 'provider[:model], or "default" to clear the override.',
      },
    },
    required: ["task", "route"],
  },
  examples: [
    {
      user: "run digests on a free model, don't spend tokens",
      agent: "Done: 📰 digest now goes through openrouter/openrouter/free.",
    },
  ],
  async validate(runtime) {
    return Boolean(switchableModel(runtime));
  },
  async handler(runtime, _state, params) {
    const model = switchableModel(runtime);
    if (!model) return { ok: false, text: "The model provider is fixed for this run." };
    const task = String(params.task ?? "").trim().toLowerCase();
    if (!isTaskKind(task)) {
      return { ok: false, text: `task must be one of: ${TASK_ORDER.join(", ")}` };
    }
    const raw = String(params.route ?? "").trim();
    const clearing = !raw || ["default", "none", "base"].includes(raw.toLowerCase());
    const result = model.setTaskRoute(task, clearing ? null : raw);
    if (typeof result === "string") return { ok: false, text: result };
    const warning =
      TASKS[task].critical && !clearing
        ? " This kind acts on the world (money/code) — make sure that model is one you trust."
        : "";
    return {
      ok: true,
      text: `${routeLine(result)}.${warning}`,
      data: { task, provider: result.provider, model: result.model, source: result.source },
    };
  },
};

/** What answers what, right now — the table an operator asks for out loud. */
const taskRoutesAction: Action = {
  name: "task_routes",
  similes: ["which_model_for_what", "routing_table", "show_task_routes"],
  description:
    "Report which model provider answers each kind of work (chat, code, money, write, " +
    "analysis, digest, translate, memory) and where that route came from.",
  parameters: { type: "object", properties: {} },
  examples: [
    {
      user: "which model answers what?",
      agent: "💬 chat → claude, 📰 digest → openrouter/free, 💰 money → claude.",
    },
  ],
  async validate(runtime) {
    return Boolean(switchableModel(runtime));
  },
  async handler(runtime) {
    const model = switchableModel(runtime);
    if (!model) return { ok: false, text: "The model provider is fixed for this run." };
    const rows = model.taskRoutes();
    return {
      ok: true,
      text: rows.map(routeLine).join("\n"),
      data: { routes: rows },
    };
  },
};

export const bootstrapPlugin: Plugin = {
  name: "bootstrap",
  description: "Core providers, evaluators, and long-term memory skills every agent needs.",
  actions: [
    rememberAction,
    recallAction,
    setChatProviderAction,
    chatProviderStatusAction,
    setTaskRouteAction,
    taskRoutesAction,
  ],
  providers: [timeProvider],
  evaluators: [factEvaluator],
};
