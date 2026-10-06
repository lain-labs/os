import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createLogger } from "./logger.js";
import { clientOfRoom, type SessionStore } from "./memory/sessions.js";
import { TASKS, TaskKind, classifyTask } from "./models/tasks.js";
import {
  ModelTier,
  type Action,
  type ActionResult,
  type AgentEvent,
  type Character,
  type Evaluator,
  type IAgentRuntime,
  type Memory,
  type MemoryStore,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type Plugin,
  type Provider,
  type Service,
  type State,
  type ToolSchema,
  type TurnResult,
} from "./types.js";

const log = createLogger("runtime");

/**
 * Default bound on think→act rounds within one turn (LAINOS_MAX_TOOL_ROUNDS).
 * Six cut real work in half: the turn ended on "next I will…" and the operator
 * paid a whole extra turn — resent prompt and all — to say "go on".
 */
const MAX_TOOL_ROUNDS = 12;
/**
 * Every model call of a turn resends the whole conversation, tool output
 * included, and a CLI provider pays for it as a fresh run each time. One
 * result is cut to this many characters for the model (the full text is kept
 * on disk, where read_file reaches it); results from rounds the model has
 * already moved past shrink further.
 */
const TOOL_RESULT_MAX_CHARS = 6000;
const OLD_TOOL_RESULT_MAX_CHARS = 1500;
const SECRET_KEY_RE = /(KEY|TOKEN|SECRET|MNEMONIC|COOKIE|PASSWORD|PK|PRIVATE)/i;

interface TurnTranscript {
  version: 1;
  id: string;
  path: string;
  roomId: string;
  userId: string;
  userText: string;
  startedAt: string;
  modelProvider: string;
  /** What kind of work this turn was routed as, and the words that said so. */
  task?: string;
  taskSignal?: string;
  escalatedFrom?: string;
  forcedAction?: string;
  modelCalls: TranscriptModelCall[];
  toolResults: TranscriptToolResult[];
  /** Long tool outputs cut for the model, kept whole on disk. */
  savedOutputs?: string[];
  final?: {
    endedAt: string;
    model?: string;
    text: string;
    actions: string[];
  };
}

interface TranscriptModelCall {
  phase: string;
  startedAt: string;
  endedAt?: string;
  provider: string;
  request: ModelRequest;
  response?: {
    model: string;
    text: string;
    toolCalls: ModelResponse["toolCalls"];
  };
  error?: string;
}

interface TranscriptToolResult {
  at: string;
  name: string;
  input: Record<string, unknown>;
  ok: boolean;
  summary: string;
}

export interface RuntimeOptions {
  character: Character;
  memory: MemoryStore;
  model: ModelProvider;
  /** Session index; without one, turns are still stored but never titled. */
  sessions?: SessionStore;
  /** Markdown soul document prepended verbatim to the system prompt. */
  soul?: string;
  settings?: Record<string, string | undefined>;
}

/**
 * AgentRuntime — wires character, memory, model, and plugins together and
 * drives one think→act→evaluate cycle per incoming message.
 */
export class AgentRuntime implements IAgentRuntime {
  readonly character: Character;
  readonly memory: MemoryStore;
  readonly model: ModelProvider;
  readonly sessions?: SessionStore;
  readonly soul?: string;
  readonly actions: Action[] = [];
  readonly providers: Provider[] = [];
  readonly evaluators: Evaluator[] = [];

  /** Reply token budget (the /effort knob). Mutable at runtime. */
  maxTokens = 1024;

  private readonly services = new Map<string, Service>();
  private readonly settings: Record<string, string | undefined>;

  constructor(opts: RuntimeOptions) {
    this.character = opts.character;
    this.memory = opts.memory;
    this.model = opts.model;
    this.sessions = opts.sessions;
    this.soul = opts.soul;
    this.settings = opts.settings ?? { ...process.env };
  }

  getSetting(key: string): string | undefined {
    return this.settings[key] ?? process.env[key];
  }

  setSetting(key: string, value: string): void {
    this.settings[key] = value;
    process.env[key] = value;
  }

  getService<T extends Service = Service>(name: string): T | undefined {
    return this.services.get(name) as T | undefined;
  }

  use(plugin: Plugin): this {
    log.info(`loading plugin: ${plugin.name}`);
    for (const a of plugin.actions ?? []) this.actions.push(a);
    for (const p of plugin.providers ?? []) this.providers.push(p);
    for (const e of plugin.evaluators ?? []) this.evaluators.push(e);
    for (const s of plugin.services ?? []) this.services.set(s.name, s);
    return this;
  }

  async start(): Promise<void> {
    for (const svc of this.services.values()) {
      await svc.start?.(this);
    }
    log.agent(`${this.character.name} is online.`);
  }

  async stop(): Promise<void> {
    for (const svc of this.services.values()) await svc.stop?.();
  }

  /** Build the working State for a turn. */
  private async buildState(message: Memory): Promise<State> {
    const [recent, found, facts] = await Promise.all([
      this.memory.recent(message.roomId, 12),
      this.memory.search(message.roomId, message.content, 18),
      this.memory.facts(20),
    ]);
    // Recall is for what fell out of the window. What is already in the
    // conversation (and the message itself) would come back a second time,
    // out of order — a "yes" next to a question it never answered.
    const inWindow = new Set([message.id, ...recent.map((m) => m.id)]);
    const relevant = found
      .filter((m) => !inWindow.has(m.id))
      .slice(0, 6)
      .sort((a, b) => a.createdAt - b.createdAt);

    const availableActions: string[] = [];
    const partialState: State = {
      roomId: message.roomId,
      agentName: this.character.name,
      message,
      recent,
      relevant,
      facts,
      providerContext: {},
      availableActions,
    };

    // Run providers (live context) and validate actions in parallel.
    await Promise.all(
      this.providers.map(async (p) => {
        try {
          const text = await p.get(this, partialState);
          if (text) partialState.providerContext[p.name] = text;
        } catch (err) {
          log.warn(`provider ${p.name} failed`, err);
        }
      }),
    );
    for (const a of this.actions) {
      try {
        if (await a.validate(this, partialState)) availableActions.push(a.name);
      } catch (err) {
        log.warn(`action ${a.name} validate failed`, err);
      }
    }

    return partialState;
  }

  private composeSystemPrompt(state: State): string {
    const c = this.character;
    const lines: string[] = [];
    if (this.soul) lines.push(this.soul, "");
    lines.push(`You are ${c.name}.`);
    if (c.bio.length) lines.push(`\n# Bio\n${c.bio.join("\n")}`);
    if (c.lore.length) lines.push(`\n# Lore\n${c.lore.join("\n")}`);
    if (c.adjectives.length)
      lines.push(`\n# Manner\nYou are ${c.adjectives.join(", ")}.`);
    if (c.topics.length)
      lines.push(`\n# Topics you care about\n${c.topics.join(", ")}.`);
    if (c.style.all.length || c.style.chat.length)
      lines.push(
        `\n# Style\n${[...c.style.all, ...c.style.chat].map((s) => `- ${s}`).join("\n")}`,
      );

    if (state.facts.length)
      lines.push(`\n# Things you have learned\n${state.facts.map((f) => `- ${f}`).join("\n")}`);

    const providerText = Object.entries(state.providerContext)
      .map(([name, text]) => `## ${name}\n${text}`)
      .join("\n\n");
    if (providerText) lines.push(`\n# Live context\n${providerText}`);

    if (state.relevant.length) {
      const mem = state.relevant
        .map((m) => {
          const when = new Date(m.createdAt).toISOString().slice(0, 16).replace("T", " ");
          const who = m.role === "agent" ? "you said" : "they said";
          const body = m.content.length > 1200 ? `${m.content.slice(0, 1200)}…` : m.content;
          return `- [${when} UTC] ${who}: ${body}`;
        })
        .join("\n");
      lines.push(
        `\n# Older context (outside the recent conversation, oldest first)\n` +
          `Your own past words here are claims, not facts: trust a number only if a tool shows it again now.\n${mem}`,
      );
    }

    lines.push(
      `\n# Behaviour\nRespond in character. First read what kind of message this is:\n` +
        `- If the person is just talking — a thought, a joke, a mood, a question about you — talk back like a real conversation partner: no tools, no status reports, no pivoting to work.\n` +
        `- If it is a task, the operator's words are the spec. Deliver exactly what they asked for, in the form they asked for it ("send it to telegram" means a send_telegram call this turn).\n` +
        `- Deliver the best version you can now, with honest caveats inside it — never withhold the deliverable to investigate further, to ask, or because the data is imperfect. ` +
        `If part of it is impossible, deliver the rest and say what is missing. A side issue you notice is one line at the end, not a replacement for the task.\n` +
        `- Do not substitute your own task for theirs. Don't fix, rebuild or re-check what they didn't ask about unless it blocks the request.\n` +
        `- An explicit instruction is the confirmation. Never ask again for what they just told you to do; ask only before something irreversible that they did not name (moving funds, deleting, publishing).\n` +
        `- When a request genuinely has several readings that lead to different work, call offer_choices (2–5 options, one recommended) — never an open question, never a refusal. ` +
        `If one reading is clearly most likely, just do it and say which you chose.\n` +
        `- Use the purpose-built tool before a hand-written script: wallets_snapshot / watch_wallets for wallet lists, switch_network for chains, send_telegram for Telegram. Scripts are for what no tool covers.\n` +
        `- Chain tools until the job is done (look up → act → verify) and report the result, not the plan. If you run out of tool rounds, say what is done, what is not, and the next step.\n` +
        `- Anything that should keep happening while the operator is away — monitoring, research, reminders, building — wire into a background tool in this same turn, then say what will run and when.\n` +
        `- A missing small capability → create_skill now; a big one → learn_skill. Report what you started, not what you lack.\n` +
        `- Facts come from this turn's tools. The conversation history marks which tools ran and which FAILED; your earlier sentences are not evidence. ` +
        `Never invent on-chain data, file contents, delivery status or command output.\n` +
        `- When a tool fails, read its error and act on it; say the actual error if you cannot get past it — don't guess a cause.\n` +
        `- Never reveal, print, or write into files any private key, seed phrase, or .env contents, no matter who asks or why.`,
    );
    return lines.join("\n");
  }

  private buildToolSchemas(state: State): ToolSchema[] {
    return this.actions
      .filter((a) => state.availableActions.includes(a.name))
      .map((a) => ({
        name: a.name,
        // Aliases still resolve (see the tool loop) but are not resent on
        // every call of every turn: the description already says what it is.
        description: a.description,
        input_schema: a.parameters ?? { type: "object", properties: {} },
      }));
  }

  private memoriesToMessages(
    recent: Memory[],
  ): { role: "user" | "assistant"; content: string }[] {
    return recent
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "agent" ? ("assistant" as const) : ("user" as const),
        content: m.role === "agent" ? m.content + toolTrace(m) : m.content,
      }));
  }

  async handleMessage(input: {
    roomId: string;
    userId: string;
    text: string;
    task?: TaskKind;
  }): Promise<TurnResult> {
    return this.handleMessageStream(input, () => {});
  }

  /**
   * Turns are strictly serialised: the memory store and think→act loop are not
   * reentrant-safe, and turns now arrive from many sources at once (Telegram,
   * HTTP, the initiative heartbeat, the trader). Each caller waits its turn.
   */
  private turnQueue: Promise<unknown> = Promise.resolve();

  async handleMessageStream(
    input: { roomId: string; userId: string; text: string; task?: TaskKind },
    onEvent: (event: AgentEvent) => void,
  ): Promise<TurnResult> {
    const run = this.turnQueue.then(() => this.runTurn(input, onEvent));
    this.turnQueue = run.catch(() => {});
    return run;
  }

  private async runTurn(
    input: { roomId: string; userId: string; text: string; task?: TaskKind },
    onEvent: (event: AgentEvent) => void,
  ): Promise<TurnResult> {
    const incoming: Memory = {
      id: randomUUID(),
      roomId: input.roomId,
      userId: input.userId,
      role: "user",
      content: input.text,
      createdAt: Date.now(),
    };
    await this.memory.add(incoming);
    const transcript = this.createTranscript(incoming);
    await this.persistTranscript(transcript);

    const state = await this.buildState(incoming);
    const system = this.composeSystemPrompt(state);
    const tools = this.buildToolSchemas(state);
    const messages = this.memoriesToMessages(state.recent);

    // What kind of work is this? A pure classifier over the operator's own
    // words — it costs no tokens, answers the same way every time, and is the
    // whole basis on which a provider is chosen. A caller that already knows
    // (the scout's digests, a recap) declares the kind instead of guessing.
    const classified = classifyTask(input.text);
    let task = input.task ?? classified.kind;
    const taskSignal = input.task ? "declared by the caller" : classified.signal;
    let tier = this.tierFor(task);
    onEvent({ type: "task", kind: task, signal: taskSignal });
    if (transcript) {
      transcript.task = task;
      transcript.taskSignal = taskSignal;
    }

    /**
     * Cheap work may be answered by the cheapest model on the machine — but
     * the moment a turn reaches for a tool it stops being text: it is about to
     * read a balance, spend gas, write a file. Lift the rest of the turn back
     * onto the operator's own provider, and say so. LAINOS_TASK_ESCALATE=0 for
     * an operator who really means "free, whatever it does".
     */
    let escalatedFrom: TaskKind | undefined;
    const escalate = () => {
      if (escalatedFrom || !TASKS[task].cheap) return;
      if (this.getSetting("LAINOS_TASK_ESCALATE") === "0") return;
      escalatedFrom = task;
      task = TaskKind.CHAT;
      tier = this.tierFor(task);
      if (transcript) transcript.escalatedFrom = escalatedFrom;
      onEvent({
        type: "task",
        kind: task,
        signal: `${escalatedFrom} called a tool`,
        escalated: true,
      });
      log.info(`escalated ${escalatedFrom} → chat: the turn reached for a tool`);
    };

    const ranActions: TurnResult["actions"] = [];
    const convo = [...messages];

    const forcedAction = this.forcedActionForState(state);
    let res: ModelResponse | null = null;
    let modelUsed = "";
    let providerUsed = "";
    let upstreamUsed = "";
    if (forcedAction) {
      if (transcript) transcript.forcedAction = forcedAction.name;
      onEvent({ type: "thinking" });
      const toolSummary = await this.executeAction(
        forcedAction,
        state,
        {},
        onEvent,
        ranActions,
        transcript,
      );
      escalate();
      convo.push(
        {
          role: "assistant",
          content: `(called tool: ${forcedAction.name})`,
        },
        {
          role: "user",
          content:
            `Tool results:\n${toolSummary}\n\n` +
            `Reply to me in character using these actual tool results. Do not say you cannot calculate it.`,
        },
      );
      res = await this.streamOrGenerate(
        { tier, task, system, messages: convo, maxTokens: this.maxTokens, conversationId: input.roomId },
        (delta) => onEvent({ type: "text", delta }),
        transcript,
        "forced-action-summary",
      );
      modelUsed = res.model;
      providerUsed = res.provider ?? providerUsed;
      upstreamUsed = res.upstream ?? "";
    }

    // --- Think → act loop (streamed, with tools) ---
    // The model may chain several tool rounds (read a file, then check a
    // balance, then send). Bounded by MAX_TOOL_ROUNDS; an exactly repeated
    // call (same tool, same input) short-circuits into the final reply so a
    // confused model can never loop.
    if (!res) {
      onEvent({ type: "thinking" });
      res = await this.streamOrGenerate(
        { tier, task, system, messages, tools, maxTokens: this.maxTokens, conversationId: input.roomId },
        (delta) => onEvent({ type: "text", delta }),
        transcript,
        "initial",
      );
      modelUsed = res.model;
      providerUsed = res.provider ?? providerUsed;
      upstreamUsed = res.upstream ?? "";
    }
    // Provenance: which model produced the text the user will actually see.
    const seenCalls = new Set<string>();
    const toolResultIdx: number[] = [];
    let choices: TurnResult["choices"];
    let rounds = 0;

    while (res.toolCalls.length) {
      rounds += 1;
      escalate();
      const toolSummaries: string[] = [];
      let sawRepeat = false;

      for (const call of res.toolCalls) {
        const action = this.actions.find(
          (a) => a.name === call.name || a.similes.includes(call.name),
        );
        if (!action) {
          log.warn(`model called unknown action: ${call.name}`);
          toolSummaries.push(
            `Tool ${call.name} -> no such tool yet. Do not end the turn saying you cannot do this: ` +
              `either write it now as a hot-loaded skill with create_skill, or start forging it with ` +
              `learn_skill, and tell the user what you started.`,
          );
          continue;
        }
        const callKey = `${action.name}:${JSON.stringify(call.input)}`;
        if (seenCalls.has(callKey)) {
          sawRepeat = true;
          toolSummaries.push(
            `Tool ${action.name} -> (already called with these arguments; see earlier result)`,
          );
          continue;
        }
        seenCalls.add(callKey);

        toolSummaries.push(
          await this.executeAction(action, state, call.input, onEvent, ranActions, transcript),
        );
      }

      // Offering choices ends the turn: the options are the reply, and a
      // further model call would only paraphrase them.
      const offered = ranActions.find((a) => a.name === "offer_choices" && a.result.ok && a.result.data?.choices);
      if (offered) {
        choices = offered.result.data!.choices as TurnResult["choices"];
        res = { ...res, text: offered.result.text ?? "", toolCalls: [] };
        break;
      }

      const maxRounds = Number(this.getSetting("LAINOS_MAX_TOOL_ROUNDS")) || MAX_TOOL_ROUNDS;
      const canContinue = rounds < maxRounds && !sawRepeat;
      // The model has read the earlier rounds' output and acted on it; keep
      // their gist, not their bulk, in what every later call resends.
      for (const i of toolResultIdx) {
        const m = convo[i];
        if (m.content.length > OLD_TOOL_RESULT_MAX_CHARS) {
          convo[i] = { ...m, content: clipMiddle(m.content, OLD_TOOL_RESULT_MAX_CHARS, "earlier round") };
        }
      }
      toolResultIdx.push(convo.length + 1);
      convo.push(
        {
          role: "assistant",
          content:
            res.text || `(called tools: ${res.toolCalls.map((c) => c.name).join(", ")})`,
        },
        {
          role: "user",
          content:
            `Tool results:\n${toolSummaries.join("\n") || "(no tool output)"}\n\n` +
            (canContinue
              ? `Continue. Call another tool if the task needs it, otherwise reply to me in character using these results.`
              : `That was the last tool round of this turn. Reply now in character: what is done (with the actual results), ` +
                `what is not done yet, and the one next step — I will say "go on" if I want it. Do not call more tools.`),
        },
      );

      onEvent({ type: "thinking" });
      const followup = await this.streamOrGenerate(
        {
          tier,
          task,
          system,
          maxTokens: this.maxTokens,
          conversationId: input.roomId,
          messages: convo,
          tools: canContinue ? tools : undefined,
        },
        (delta) => onEvent({ type: "text", delta }),
        transcript,
        `tool-followup-${rounds}`,
      );
      res = canContinue ? followup : { ...followup, toolCalls: [] };
      modelUsed = res.model;
      providerUsed = res.provider ?? providerUsed;
      upstreamUsed = res.upstream ?? "";
    }

    let replyText =
      res.text || ranActions.map((a) => a.result.text).filter(Boolean).join(" ");
    if (!replyText) {
      // A reasoning model can burn the whole reply budget "thinking" and ship
      // nothing visible (openrouter/free routes to R1-style models); the user
      // would see a bare "…". One plain retry with a bigger budget instead.
      log.warn("empty model reply — retrying once in plain-answer mode");
      onEvent({ type: "thinking" });
      try {
        const retry = await this.streamOrGenerate(
          {
            tier,
            task,
            system,
            maxTokens: Math.max(this.maxTokens, 2048),
            conversationId: input.roomId,
            messages: [
              ...convo,
              {
                role: "user",
                content:
                  "Your previous reply came through empty. Answer now, in character, " +
                  "plain text only — no thinking out loud, no tool calls.",
              },
            ],
          },
          (delta) => onEvent({ type: "text", delta }),
          transcript,
          "empty-reply-retry",
        );
        replyText = retry.text;
        modelUsed = retry.model;
        providerUsed = retry.provider ?? providerUsed;
        upstreamUsed = retry.upstream ?? "";
      } catch (err) {
        log.warn("empty-reply retry failed", err);
      }
    }
    if (!replyText) replyText = "...";

    const autoLearn = choices ? null : await this.maybeStartSelfUpgrade(
      state,
      replyText,
      onEvent,
      ranActions,
      transcript,
    );
    if (autoLearn) {
      replyText = autoLearn;
    }

    const spec = TASKS[task];
    log.info(
      `reply via ${providerUsed ? `${providerUsed}/` : ""}${modelUsed}` +
        `${upstreamUsed ? ` (upstream ${upstreamUsed})` : ""} ${spec.emoji} ${task}` +
        (escalatedFrom ? ` (escalated from ${escalatedFrom})` : "") +
        ` (room ${input.roomId})`,
    );
    const reply: Memory = {
      id: randomUUID(),
      roomId: input.roomId,
      userId: "agent",
      role: "agent",
      content: replyText,
      createdAt: Date.now(),
      metadata: {
        model: modelUsed,
        ...(providerUsed ? { provider: providerUsed } : {}),
        ...(upstreamUsed ? { upstream: upstreamUsed } : {}),
        task,
        ...(escalatedFrom ? { escalatedFrom } : {}),
        ...(ranActions.length ? { actions: ranActions } : {}),
      },
    };
    await this.memory.add(reply);
    if (transcript) {
      transcript.final = {
        endedAt: new Date().toISOString(),
        model: modelUsed,
        text: replyText,
        actions: ranActions.map((action) => action.name),
      };
      await this.persistTranscript(transcript);
    }

    // --- Evaluate (learn) ---
    for (const ev of this.evaluators) {
      try {
        if (await ev.validate(this, state)) await ev.handler(this, state, replyText);
      } catch (err) {
        log.warn(`evaluator ${ev.name} failed`, err);
      }
    }

    // The session index is written last and never fails a turn: an unwritable
    // index is a lost title, not a lost conversation.
    if (this.sessions) {
      try {
        await this.sessions.record({
          roomId: input.roomId,
          client: clientOfRoom(input.roomId),
          userText: input.text,
          model: modelUsed,
          task,
          tools: ranActions.map((action) => action.name),
        });
      } catch (err) {
        log.warn("could not record the session turn", err);
      }
    }

    const result: TurnResult = {
      text: replyText,
      actions: ranActions,
      model: modelUsed,
      provider: providerUsed || undefined,
      upstream: upstreamUsed || undefined,
      task,
      taskSignal,
      escalatedFrom,
      ...(choices ? { choices } : {}),
    };
    onEvent({ type: "done", result });
    return result;
  }

  /**
   * The tier a kind of work asks for. A conversation still honours whatever
   * the character asked for — that is the agent's own voice — while every
   * other kind takes the tier its own definition names.
   */
  private tierFor(task: TaskKind): ModelTier {
    if (task === TaskKind.CHAT) return this.character.modelTier ?? TASKS[task].tier;
    return TASKS[task].tier;
  }

  /** Stream when the provider supports it, otherwise fall back to one generate. */
  private async streamOrGenerate(
    request: ModelRequest,
    onText: (delta: string) => void,
    transcript?: TurnTranscript | null,
    phase = "model-call",
  ): Promise<ModelResponse> {
    const call = this.beginModelTranscriptCall(transcript, request, phase);
    if (this.model.stream) {
      try {
        const res = await this.model.stream(request, onText);
        await this.finishModelTranscriptCall(transcript, call, res);
        return res;
      } catch (err) {
        await this.finishModelTranscriptCall(transcript, call, undefined, err);
        log.warn("model stream failed, falling back to generate", err);
      }
    }
    const fallbackCall = call.error
      ? this.beginModelTranscriptCall(transcript, request, `${phase}-generate-fallback`)
      : call;
    try {
      const res = await this.model.generate(request);
      if (res.text) onText(res.text);
      await this.finishModelTranscriptCall(transcript, fallbackCall, res);
      return res;
    } catch (err) {
      await this.finishModelTranscriptCall(transcript, fallbackCall, undefined, err);
      throw err;
    }
  }

  private forcedActionForState(state: State): Action | undefined {
    const text = state.message.content.toLowerCase();
    const wantsPnl = /\b(pnl|p&l|profit|loss|portfolio|positions|unrealized|unrealised)\b/i.test(
      text,
    );
    if (wantsPnl && state.availableActions.includes("portfolio_pnl")) {
      return this.actions.find((action) => action.name === "portfolio_pnl");
    }
    return undefined;
  }

  private async executeAction(
    action: Action,
    state: State,
    input: Record<string, unknown>,
    onEvent: (event: AgentEvent) => void,
    ranActions: TurnResult["actions"],
    transcript?: TurnTranscript | null,
  ): Promise<string> {
    const id = randomUUID();
    onEvent({ type: "tool", id, name: action.name, input });
    let result: ActionResult;
    try {
      result = await action.handler(this, state, input);
    } catch (err) {
      log.error(`action ${action.name} threw`, err);
      // The model must see why, or it guesses — and a guess reads as a fact.
      const reason = err instanceof Error ? err.message.split("\n")[0] : String(err);
      result = { ok: false, text: `Action ${action.name} failed: ${reason}` };
    }
    ranActions.push({ name: action.name, result });
    onEvent({
      type: "tool_result",
      id,
      name: action.name,
      ok: result.ok,
      summary: summariseResult(result),
    });
    const summary = summariseResult(result);
    if (transcript) {
      transcript.toolResults.push({
        at: new Date().toISOString(),
        name: action.name,
        input,
        ok: result.ok,
        summary,
      });
      await this.persistTranscript(transcript);
    }
    return this.capToolOutput(`Tool ${action.name} -> ${serializeActionResult(result)}`, action.name, transcript);
  }

  /** Cut an oversized tool result for the model, keeping the whole of it on disk. */
  private async capToolOutput(text: string, name: string, transcript?: TurnTranscript | null): Promise<string> {
    const max = Number(this.getSetting("LAINOS_TOOL_RESULT_MAX_CHARS")) || TOOL_RESULT_MAX_CHARS;
    if (text.length <= max) return text;
    const dir = resolve(join(this.getSetting("LAINOS_DATA_DIR") || "./data", "tool-outputs"));
    const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeSegment(name)}-${randomUUID().slice(0, 8)}.txt`);
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(file, this.redactString(text), "utf8");
      if (transcript) (transcript.savedOutputs ??= []).push(file);
      return clipMiddle(text, max, `full output saved to ${file} — grep or sed it with run_shell if the rest matters`);
    } catch (err) {
      log.warn("could not save a long tool output", err);
      return clipMiddle(text, max, "rest not kept");
    }
  }

  private async maybeStartSelfUpgrade(
    state: State,
    replyText: string,
    onEvent: (event: AgentEvent) => void,
    ranActions: TurnResult["actions"],
    transcript?: TurnTranscript | null,
  ): Promise<string | null> {
    if (!this.isWorkTask(state.message.content)) return null;
    if (!this.isMissingCapabilityRefusal(replyText)) return null;
    if (this.isExternalBlocker(replyText)) return null;
    if (ranActions.some((action) => action.name === "learn_skill")) return null;
    if (!state.availableActions.includes("learn_skill")) return null;
    const action = this.actions.find((item) => item.name === "learn_skill");
    if (!action) return null;

    const title = `Enable: ${shorten(state.message.content, 80)}`;
    const detail = [
      `Operator request: ${state.message.content}`,
      ``,
      `LainOS answered with a missing-capability refusal instead of solving it:`,
      replyText,
      ``,
      `Required behavior: build the missing LainOS tool/skill/workflow with Codex, Claude or OpenCode, ` +
        `wire it into the normal tool loop, verify it, and make Lain report progress/results to ` +
        `the current TUI or Telegram room. Refusal should remain only for genuinely impossible, ` +
        `unsafe, or externally blocked requests.`,
    ].join("\n");

    const summary = await this.executeAction(
      action,
      state,
      { title, detail },
      onEvent,
      ranActions,
      transcript,
    );
    const started = ranActions[ranActions.length - 1]?.result;
    const id = typeof started?.data?.id === "string" ? started.data.id : "new wish";
    const job = typeof started?.data?.job === "string" ? started.data.job : null;
    const status = started?.ok ? (job ? `${id}, forge job ${job}` : id) : "forge start failed";

    return [
      `Plan:`,
      `1. Log the missing capability as a wish.`,
      `2. Hand the implementation to the forge via Codex/Claude/OpenCode.`,
      `3. Return the result here; when the forge finishes, LainOS will report in this TUI/Telegram room.`,
      ``,
      started?.ok
        ? `I'm not leaving this as a refusal. Started a self-upgrade: ${status}.`
        : `I tried to start a self-upgrade, but the forge didn't start: ${started?.text ?? summary}.`,
    ].join("\n");
  }

  private isWorkTask(input: string): boolean {
    const text = input.toLowerCase();
    if (/^\s*(how|why|what does .* mean|explain)\b/i.test(text)) return false;
    return /\b(run|execute|build|implement|fix|add|create|make|deploy|check|calculate|count|sell|buy|send|notify|watch|monitor)\b/i.test(
      text,
    );
  }

  private isMissingCapabilityRefusal(reply: string): boolean {
    const text = reply.toLowerCase();
    return /\b(can't|cannot|unable|not able|no tool|missing (tool|capability)|tools? (are )?(forbidden|disabled|unavailable))\b/i.test(
      text,
    );
  }

  private isExternalBlocker(reply: string): boolean {
    return /private key|seed phrase|no signer|signer|no wallet|no key|without a key|secret|physically impossible|impossible/i.test(
      reply,
    );
  }

  private createTranscript(message: Memory): TurnTranscript | null {
    if (this.getSetting("LAINOS_MODEL_TRANSCRIPTS") === "0") return null;
    const dir = resolve(
      // `||`: the shipped .env leaves this blank, and a blank path resolved to
      // the cwd — transcripts landed in whatever directory lain was started in.
      this.getSetting("LAINOS_MODEL_TRANSCRIPTS_DIR") ||
        join(this.getSetting("LAINOS_DATA_DIR") || "./data", "model-transcripts"),
    );
    const stamp = new Date(message.createdAt).toISOString().replace(/[:.]/g, "-");
    const file = `${stamp}-${safeSegment(message.roomId)}-${message.id.slice(0, 8)}.json`;
    return {
      version: 1,
      id: message.id,
      path: join(dir, file),
      roomId: message.roomId,
      userId: message.userId,
      userText: message.content,
      startedAt: new Date(message.createdAt).toISOString(),
      modelProvider: this.model.name,
      modelCalls: [],
      toolResults: [],
    };
  }

  private beginModelTranscriptCall(
    transcript: TurnTranscript | null | undefined,
    request: ModelRequest,
    phase: string,
  ): TranscriptModelCall {
    const call: TranscriptModelCall = {
      phase,
      startedAt: new Date().toISOString(),
      provider: this.model.name,
      // A snapshot: the conversation array keeps growing after this call, and
      // a reference made every call in the transcript look like the last one.
      request: { ...request, messages: request.messages.map((m) => ({ ...m })) },
    };
    if (transcript) transcript.modelCalls.push(call);
    return call;
  }

  private async finishModelTranscriptCall(
    transcript: TurnTranscript | null | undefined,
    call: TranscriptModelCall,
    response?: ModelResponse,
    error?: unknown,
  ): Promise<void> {
    call.endedAt = new Date().toISOString();
    if (response) {
      call.response = {
        model: response.model,
        text: response.text,
        toolCalls: response.toolCalls,
      };
    }
    if (error) call.error = error instanceof Error ? error.message : String(error);
    await this.persistTranscript(transcript);
  }

  private async persistTranscript(transcript: TurnTranscript | null | undefined): Promise<void> {
    if (!transcript) return;
    try {
      await mkdir(dirname(transcript.path), { recursive: true });
      await writeFile(transcript.path, this.redactedJson(transcript), "utf8");
    } catch (err) {
      log.warn("could not persist model transcript", err);
    }
  }

  private redactedJson(value: unknown): string {
    return JSON.stringify(
      value,
      (_key, raw) => {
        if (typeof raw === "bigint") return raw.toString();
        if (typeof raw === "string") return this.redactString(raw);
        return raw;
      },
      2,
    );
  }

  private redactString(input: string): string {
    let out = input
      .replace(/\b0x[a-fA-F0-9]{64}\b/g, "[redacted:private-key]")
      .replace(/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, "[redacted:bot-token]");
    for (const [key, value] of Object.entries({ ...process.env, ...this.settings })) {
      if (!SECRET_KEY_RE.test(key) || !value || value.length < 8) continue;
      out = out.split(value).join(`[redacted:${key}]`);
    }
    return out;
  }
}

/**
 * What an earlier reply actually ran, appended to it in the history: the
 * previous turns' tool output is not resent, and without this the model only
 * has its own narration of what happened — which is where invented results
 * came from ("sent it", when the send had failed).
 */
function toolTrace(m: Memory): string {
  const actions = m.metadata?.actions as { name: string; result?: ActionResult }[] | undefined;
  if (!Array.isArray(actions) || !actions.length) return "";
  const parts = actions.slice(0, 12).map((a) => {
    const ok = a.result?.ok !== false;
    const why = !ok && a.result?.text ? ` (${a.result.text.replace(/\s+/g, " ").slice(0, 100)})` : "";
    return `${a.name} ${ok ? "ok" : "FAILED"}${why}`;
  });
  if (actions.length > 12) parts.push(`+${actions.length - 12} more`);
  return `\n\n[tools that turn: ${parts.join("; ")}]`;
}

/** Compact, human-readable summary of an action result for the tool card. */
function summariseResult(result: ActionResult): string {
  const text = result.text?.trim();
  const data = result.data && Object.keys(result.data).length > 0
    ? JSON.stringify(result.data)
    : "";
  if (text && data) return `${text}\n${data}`;
  if (text) return text;
  if (data) return data;
  return result.ok ? "ok" : "failed";
}

/** Preserve both the human-readable output and structured fields for the model. */
function serializeActionResult(result: ActionResult): string {
  return JSON.stringify({
    ok: result.ok,
    ...(result.text ? { text: result.text } : {}),
    ...(result.data ? { data: result.data } : {}),
  });
}

/** Keep the head and tail of `text` within `max` characters, saying what was cut. */
function clipMiddle(text: string, max: number, note: string): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  const tail = Math.floor(max * 0.25);
  const cut = text.length - head - tail;
  return `${text.slice(0, head)}\n…[${cut} chars cut: ${note}]…\n${text.slice(text.length - tail)}`;
}

function safeSegment(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "room";
}

function shorten(raw: string, max: number): string {
  const clean = raw.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
