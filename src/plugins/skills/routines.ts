import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createLogger } from "../../logger.js";
import type { Action, ActionResult, IAgentRuntime, Service, State } from "../../types.js";
import type { Alert, SentinelService } from "../sentinel/index.js";
import type { SkillsService } from "./index.js";

const log = createLogger("plugin:routines");

/**
 * Routines put Lain's self-written tools to work on their own. A routine is a
 * skill plus its arguments plus a trigger — every N minutes/hours, daily at a
 * host-local time, or whenever the sentinel fires — and it reports back only
 * when the result changed (or every time, if asked). "Run my holders tool
 * every 6 hours and tell me when the top-10 share moves" is one routine.
 *
 * Routines run where the operator's schedules run: the daemon (LAINOS_DAEMON),
 * or any process with LAINOS_ROUTINES=1. Every process can create and list
 * them; the store (`data/routines.json`) is re-read before every change and
 * every tick, so a routine made in a TUI session is picked up by the daemon.
 *
 * Only self-written skills can be scheduled, and never with execute/confirm
 * arguments: a routine reads and reports, it does not sign for anyone.
 */

export type RoutineTrigger =
  | { kind: "every"; ms: number }
  | { kind: "daily"; at: string; timeZone?: string }
  | { kind: "event"; source: "sentinel"; watchId?: string };

export type RoutineNotify = "change" | "always";

export interface Routine {
  id: string;
  skill: string;
  params: Record<string, unknown>;
  trigger: RoutineTrigger;
  notify: RoutineNotify;
  /** The requester's instruction verbatim, e.g. "tell me when the share moves". */
  note?: string;
  reporter: string;
  /** Telegram chat to deliver to, when known. */
  chatId?: number;
  createdAt: number;
  runs: number;
  /** Consecutive failed runs; the routine pauses itself after MAX_FAILURES. */
  failures: number;
  paused?: boolean;
  lastRunAt?: number;
  lastOk?: boolean;
  lastText?: string;
  lastFingerprint?: string;
  lastDeliveredAt?: number;
}

export interface RoutineEvent {
  kind: "result" | "error";
  text: string;
  routine: Routine;
  chatId?: number;
}

export interface RoutineRun {
  ok: boolean;
  text: string;
  changed: boolean;
  delivered: boolean;
  data?: Record<string, unknown>;
}

interface RoutinesFile {
  routines: Routine[];
  counter: number;
}

export interface NewRoutine {
  skill: string;
  params?: Record<string, unknown>;
  trigger: RoutineTrigger;
  notify?: RoutineNotify;
  note?: string;
  reporter: string;
  chatId?: number;
}

const MIN_INTERVAL_MS = 5 * 60_000;
/** A background run may take a while — a scan over two days of blocks does. */
const RUN_TIMEOUT_MS = 300_000;
/**
 * The first run happens inside the conversation, which waits this long for
 * it; a longer one (a two-day scan of thirty wallets) finishes in the
 * background and is reported like any routine result.
 */
const FIRST_RUN_WAIT_MS = 90_000;
const MAX_FAILURES = 5;
const LATE_DAILY_MS = 3 * 3_600_000;
const TEXT_CAP = 3_500;
/** Arguments that turn a two-step spending skill into a signature. Never scheduled. */
const UNSAFE_PARAM_RE = /^(execute|confirm|confirmation|confirm_phrase)$/i;

export class RoutineService implements Service {
  readonly name = "routines";

  private runtime?: IAgentRuntime;
  private file = "";
  private routines: Routine[] = [];
  private counter = 0;
  private runsHere = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private subscribers = new Set<(event: RoutineEvent) => void>();
  private unsubscribeSentinel?: () => void;

  async start(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
    this.file = join(runtime.getSetting("LAINOS_DATA_DIR") ?? "./data", "routines.json");
    await this.load();

    const forced = runtime.getSetting("LAINOS_ROUTINES");
    this.runsHere = forced !== undefined && forced !== "" ? forced !== "0" : runtime.getSetting("LAINOS_DAEMON") === "1";
    if (!this.runsHere) {
      log.info(`routines: ${this.routines.length} stored; they run in the daemon (LAINOS_ROUTINES=1 runs them here)`);
      return;
    }

    const tick = Math.max(5_000, Number(runtime.getSetting("LAINOS_ROUTINES_TICK_MS") ?? 30_000));
    this.timer = setInterval(() => void this.tick(), tick);
    this.timer.unref?.();
    const sentinel = runtime.getService<SentinelService>("sentinel");
    this.unsubscribeSentinel = sentinel?.onAlert?.((alert) => void this.onSentinelAlert(alert));
    log.info(`routines online: ${this.routines.length} routine(s), tick every ${tick / 1000}s`);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribeSentinel?.();
  }

  /** Whether scheduled and event runs happen in this process. */
  get active(): boolean {
    return this.runsHere;
  }

  onEvent(fn: (event: RoutineEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  async list(): Promise<Routine[]> {
    await this.load();
    return [...this.routines];
  }

  async get(id: string): Promise<Routine | undefined> {
    await this.load();
    return this.routines.find((r) => r.id === id);
  }

  async add(input: NewRoutine): Promise<Routine> {
    this.assertSchedulable(input.skill, input.params ?? {});
    if (input.trigger.kind === "every" && input.trigger.ms < MIN_INTERVAL_MS) {
      throw new Error(`the shortest interval is ${MIN_INTERVAL_MS / 60_000} minutes`);
    }
    if (input.trigger.kind === "daily" && !parseClock(input.trigger.at)) {
      throw new Error("a daily time must look like HH:MM (24h, host-local)");
    }
    if (input.trigger.kind === "daily" && input.trigger.timeZone) {
      new Intl.DateTimeFormat("en-US", { timeZone: input.trigger.timeZone });
    }
    await this.load();
    const routine: Routine = {
      id: `r${++this.counter}`,
      skill: input.skill,
      params: input.params ?? {},
      trigger: input.trigger,
      notify: input.notify ?? "change",
      note: input.note,
      reporter: input.reporter,
      chatId: input.chatId,
      createdAt: Date.now(),
      runs: 0,
      failures: 0,
    };
    this.routines.push(routine);
    await this.persist();
    return routine;
  }

  async remove(id: string): Promise<boolean> {
    await this.load();
    const before = this.routines.length;
    this.routines = this.routines.filter((r) => r.id !== id);
    if (this.routines.length === before) return false;
    await this.persist();
    return true;
  }

  /**
   * Run one routine now. `deliver` pushes the result to subscribers under the
   * routine's notify rule; a manual run returns it to the caller instead.
   */
  async run(
    id: string,
    opts: { deliver: boolean; event?: Record<string, unknown>; timeoutMs?: number },
  ): Promise<RoutineRun> {
    // opts.deliver is read when the run ends, not now (schedule_skill relies on that).
    await this.load();
    const routine = this.routines.find((r) => r.id === id);
    if (!routine) throw new Error(`no routine ${id}`);

    const params = opts.event ? { ...routine.params, event: opts.event } : routine.params;
    let result: ActionResult;
    try {
      this.assertSchedulable(routine.skill, routine.params);
      const limit = opts.timeoutMs ?? (Number(this.runtime?.getSetting("LAINOS_ROUTINE_TIMEOUT_MS")) || RUN_TIMEOUT_MS);
      result = await withTimeout(this.callSkill(routine, params), limit);
    } catch (err) {
      result = { ok: false, text: (err as Error).message };
    }

    await this.load();
    const live = this.routines.find((r) => r.id === id) ?? routine;
    live.runs += 1;
    live.lastRunAt = Date.now();
    live.lastOk = result.ok;
    const text = (result.text ?? "").slice(0, TEXT_CAP) || (result.ok ? "(no text)" : "failed without a message");
    live.lastText = text;

    if (!result.ok) {
      live.failures += 1;
      const pausing = live.failures >= MAX_FAILURES;
      if (pausing) live.paused = true;
      await this.persist();
      // Say it once when it starts failing and once when it gives up — not every tick.
      const deliver = opts.deliver && (live.failures === 1 || pausing);
      if (deliver) {
        this.emit({
          kind: "error",
          text: `⚠️ routine ${live.id} (${live.skill}) failed${pausing ? ` ${MAX_FAILURES} times in a row and is paused` : ""}: ${text}`,
          routine: live,
          chatId: live.chatId,
        });
      }
      return { ok: false, text, changed: false, delivered: deliver };
    }

    live.failures = 0;
    const fingerprint = fingerprintOf(result);
    const changed = fingerprint !== live.lastFingerprint;
    live.lastFingerprint = fingerprint;
    const deliver = opts.deliver && (live.notify === "always" || changed);
    if (deliver) live.lastDeliveredAt = Date.now();
    await this.persist();
    if (deliver) {
      const head = `⚙️ ${live.skill} · routine ${live.id}${live.note ? ` — ${live.note}` : ""}`;
      this.emit({ kind: "result", text: `${head}\n\n${text}`, routine: live, chatId: live.chatId });
    }
    return { ok: true, text, changed, delivered: deliver, data: result.data };
  }

  /** Scheduled pass: run every due time-based routine, one at a time. */
  async tick(now = Date.now()): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.load();
      const due = this.routines.filter((r) => !r.paused && isDue(r, now));
      for (const routine of due) {
        try {
          await this.run(routine.id, { deliver: true });
        } catch (err) {
          log.warn(`routine ${routine.id} failed`, err);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  /** A sentinel alert: run every routine listening for it, with the alert as `event`. */
  async onSentinelAlert(alert: Pick<Alert, "watchId" | "text" | "at">): Promise<void> {
    await this.load();
    const listening = this.routines.filter(
      (r) =>
        !r.paused &&
        r.trigger.kind === "event" &&
        r.trigger.source === "sentinel" &&
        (!r.trigger.watchId || r.trigger.watchId === alert.watchId),
    );
    for (const routine of listening) {
      try {
        await this.run(routine.id, {
          deliver: true,
          event: { source: "sentinel", watchId: alert.watchId, text: alert.text, at: alert.at },
        });
      } catch (err) {
        log.warn(`routine ${routine.id} failed on a sentinel alert`, err);
      }
    }
  }

  private assertSchedulable(skill: string, params: Record<string, unknown>): void {
    const skills = this.runtime?.getService<SkillsService>("skills");
    if (!skills?.listLoaded().some((s) => s.name === skill)) {
      throw new Error(`"${skill}" is not one of your live skills (list_skills shows them)`);
    }
    const unsafe = Object.keys(params).find((k) => UNSAFE_PARAM_RE.test(k));
    if (unsafe) throw new Error(`a routine never passes "${unsafe}": spending stays a two-step, in-conversation act`);
  }

  private async callSkill(routine: Routine, params: Record<string, unknown>): Promise<ActionResult> {
    const runtime = this.runtime;
    if (!runtime) throw new Error("routines service not started");
    const action = runtime.actions.find((a) => a.name === routine.skill);
    if (!action) throw new Error(`skill ${routine.skill} is not loaded`);
    return action.handler(runtime, routineState(runtime, routine), params);
  }

  private emit(event: RoutineEvent): void {
    log.info(`routine ${event.routine.id} → ${event.kind}`);
    for (const fn of this.subscribers) {
      try {
        fn(event);
      } catch {
        /* a broken subscriber must never break a routine */
      }
    }
  }

  private async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as RoutinesFile;
      this.routines = parsed.routines ?? [];
      this.counter = parsed.counter ?? this.routines.length;
    } catch {
      // Fresh store (or none yet): keep what is in memory.
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const payload: RoutinesFile = { routines: this.routines, counter: this.counter };
    // Write-then-rename: a reader in another process never sees half a file.
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
    await rename(tmp, this.file);
  }
}

/** What "the result changed" compares: data.fingerprint if the skill sets one, else data, else text. */
export function fingerprintOf(result: Pick<ActionResult, "text" | "data">): string {
  const basis = result.data?.fingerprint ?? result.data ?? result.text ?? "";
  return createHash("sha256").update(JSON.stringify(basis)).digest("hex").slice(0, 16);
}

export function isDue(routine: Routine, now: number): boolean {
  const t = routine.trigger;
  if (t.kind === "every") return (routine.lastRunAt ?? 0) + t.ms <= now;
  if (t.kind === "daily") {
    const slot = todayAt(t.at, now, t.timeZone);
    if (slot === null || now < slot) return false;
    // A desk that slept through the slot skips it instead of reporting at lunch.
    return (routine.lastRunAt ?? 0) < slot && now - slot < LATE_DAILY_MS;
  }
  return false;
}

/** "15m", "2h", "1d", "90 min" → milliseconds; null if unreadable. */
export function parseInterval(text: string): number | null {
  const m = text.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2][0];
  const ms = unit === "m" ? n * 60_000 : unit === "h" ? n * 3_600_000 : n * 86_400_000;
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : null;
}

export function describeTrigger(t: RoutineTrigger): string {
  if (t.kind === "every") {
    const h = t.ms / 3_600_000;
    return h >= 1 && Number.isInteger(h) ? `every ${h}h` : `every ${Math.round(t.ms / 60_000)}m`;
  }
  if (t.kind === "daily") return `daily at ${t.at}${t.timeZone ? ` ${t.timeZone}` : ""}`;
  return `on sentinel alerts${t.watchId ? ` from ${t.watchId}` : ""}`;
}

function parseClock(at: string): { h: number; m: number } | null {
  const m = at.trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  return m ? { h: Number(m[1]), m: Number(m[2]) } : null;
}

function todayAt(at: string, now: number, timeZone?: string): number | null {
  const clock = parseClock(at);
  if (!clock) return null;
  if (timeZone) {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
    const local = (ms: number) => Object.fromEntries(
      formatter.formatToParts(ms).filter((p) => p.type !== "literal").map((p) => [p.type, Number(p.value)]),
    );
    const day = local(now);
    const target = Date.UTC(day.year!, day.month! - 1, day.day!, clock.h, clock.m);
    let slot = target;
    for (let i = 0; i < 3; i++) {
      const p = local(slot);
      const offset = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - slot;
      slot = target - offset;
    }
    const p = local(slot);
    // Skip a clock time that does not exist on a daylight-saving transition.
    return p.year === day.year && p.month === day.month && p.day === day.day &&
      p.hour === clock.h && p.minute === clock.m ? slot : null;
  }
  const d = new Date(now);
  d.setHours(clock.h, clock.m, 0, 0);
  return d.getTime();
}

function routineState(runtime: IAgentRuntime, routine: Routine): State {
  const roomId = `routine-${routine.id}`;
  return {
    roomId,
    agentName: runtime.character.name,
    message: {
      id: randomUUID(),
      roomId,
      userId: "routine",
      role: "system",
      content: `routine ${routine.id}: ${routine.skill}`,
      createdAt: Date.now(),
    },
    recent: [],
    relevant: [],
    facts: [],
    providerContext: {},
    availableActions: [],
  };
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ actions

function getRoutines(runtime: IAgentRuntime): RoutineService {
  const svc = runtime.getService<RoutineService>("routines");
  if (!svc) throw new Error("routines service not started");
  return svc;
}

function chatIdFromState(state: State): number | undefined {
  if (!state.roomId.startsWith("tg-")) return undefined;
  const id = Number(state.roomId.slice(3));
  return Number.isFinite(id) ? id : undefined;
}

function describeRoutine(r: Routine): string {
  const last = r.lastRunAt
    ? `last run ${Math.round((Date.now() - r.lastRunAt) / 60_000)}m ago (${r.lastOk ? "ok" : "failed"})`
    : "not run yet";
  const args = Object.keys(r.params).length ? ` ${JSON.stringify(r.params)}` : "";
  return `${r.id}: ${r.skill}${args} ${describeTrigger(r.trigger)}, tells you ${r.notify === "always" ? "every time" : "on change"}${r.paused ? ", PAUSED" : ""} — ${last}`;
}

export const scheduleSkillAction: Action = {
  name: "schedule_skill",
  operatorOnly: true,
  similes: ["run_skill_every", "automate_skill", "routine", "schedule_tool", "trigger_skill"],
  description:
    "Make one of your self-written skills run on its own: on an interval (`every`: '30m', '6h', '1d'), daily at a host-local time (`at`: '09:00'), " +
    "or whenever the sentinel fires (`on`: 'sentinel', optionally one `watch` id — the alert arrives in params.event). " +
    "By default it reports only when the result changed since the last run (`notify`: 'change'); 'always' reports every run. " +
    "Use it when the user wants a tool to keep working: 'check this every hour', 'tell me when it changes', 'run it whenever my watch fires'. " +
    "The first run happens right away and its result comes back to you; a slow one (a long chain scan) is reported when it finishes.",
  parameters: {
    type: "object",
    properties: {
      skill: { type: "string", description: "Name of a live self-written skill." },
      params: { type: "object", description: "Arguments the skill is called with on every run." },
      every: { type: "string", description: "Interval like '15m', '2h', '1d' (minimum 5m)." },
      at: { type: "string", description: "Daily time HH:MM, host-local." },
      on: { type: "string", enum: ["sentinel"], description: "Event trigger: run when a sentinel alert fires." },
      watch: { type: "string", description: "With on='sentinel': only alerts from this watch id (e.g. 'w3')." },
      notify: { type: "string", enum: ["change", "always"], description: "Report on change (default) or after every run." },
      note: { type: "string", description: "The user's instruction in their words, shown with each report." },
    },
    required: ["skill"],
  },
  examples: [
    {
      user: "run that holders tool every 6 hours and tell me only when the numbers move",
      agent: "scheduled — routine r1, every 6h, reports on change. First run: top-10 hold 61.2%.",
    },
  ],
  async validate(runtime) {
    return Boolean(runtime.getService("routines"));
  },
  async handler(runtime, state, params) {
    const svc = getRoutines(runtime);
    const triggers = [params.every, params.at, params.on].filter((v) => v !== undefined && v !== "");
    if (triggers.length !== 1) {
      return { ok: false, text: "Give exactly one trigger: every ('6h'), at ('09:00') or on ('sentinel')." };
    }
    let trigger: RoutineTrigger;
    if (params.every !== undefined && params.every !== "") {
      const ms = parseInterval(String(params.every));
      if (!ms) return { ok: false, text: `Can't read the interval "${String(params.every)}" — use e.g. 15m, 6h, 1d.` };
      trigger = { kind: "every", ms };
    } else if (params.at !== undefined && params.at !== "") {
      trigger = { kind: "daily", at: String(params.at) };
    } else {
      trigger = { kind: "event", source: "sentinel", watchId: params.watch ? String(params.watch) : undefined };
    }
    const notify: RoutineNotify = params.notify === "always" ? "always" : "change";
    const skillParams =
      params.params && typeof params.params === "object" && !Array.isArray(params.params)
        ? (params.params as Record<string, unknown>)
        : {};

    let routine: Routine;
    try {
      routine = await svc.add({
        skill: String(params.skill ?? "").trim(),
        params: skillParams,
        trigger,
        notify,
        note: params.note ? String(params.note) : undefined,
        reporter: state.message.userId,
        chatId: chatIdFromState(state),
      });
    } catch (err) {
      return { ok: false, text: `Not scheduled: ${(err as Error).message}.` };
    }

    const where = svc.active
      ? ""
      : " It runs in the daemon (npm run serve); this process only stored it.";
    if (trigger.kind === "event") {
      return {
        ok: true,
        text: `Routine ${routine.id}: ${routine.skill} ${describeTrigger(trigger)}, reports ${notify === "always" ? "every run" : "on change"}.${where}`,
        data: { routine },
      };
    }
    // The first run sets the baseline that "changed" is measured against.
    // `deliver` is read when the run ends: a run that outlasts the wait is
    // reported through the routine's channel instead of being lost.
    const opts = { deliver: false };
    const run = svc.run(routine.id, opts);
    const wait = Math.max(100, Number(runtime.getSetting("LAINOS_ROUTINE_FIRST_WAIT_MS")) || FIRST_RUN_WAIT_MS);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const first = await Promise.race([run, new Promise<null>((r) => (timer = setTimeout(() => r(null), wait)))]);
    if (timer) clearTimeout(timer);
    const head = `Routine ${routine.id}: ${routine.skill} ${describeTrigger(trigger)}, reports ${notify === "always" ? "every run" : "on change"}.${where}`;
    if (!first) {
      opts.deliver = true;
      run.catch((err) => log.warn(`routine ${routine.id} first run failed`, err));
      return {
        ok: true,
        text: `${head}\nFirst run is still going after ${Math.round(wait / 1000)}s — its result will be reported here when it finishes; nothing more to do now.`,
        data: { routine, firstRun: "running" },
      };
    }
    return {
      ok: true,
      text: `${head}\nFirst run (${first.ok ? "ok" : "failed"}): ${first.text}`,
      data: { routine: { ...routine, runs: 1 }, firstRun: first },
    };
  },
};

export const listRoutinesAction: Action = {
  name: "list_routines",
  similes: ["routines", "my_routines", "scheduled_skills", "automations"],
  description: "List the routines that run self-written skills on schedules or sentinel alerts, with their last result.",
  parameters: { type: "object", properties: {} },
  examples: [{ user: "what do you run on your own?", agent: "here are my routines…" }],
  async validate(runtime) {
    return Boolean(runtime.getService("routines"));
  },
  async handler(runtime) {
    const svc = getRoutines(runtime);
    const routines = await svc.list();
    if (!routines.length) return { ok: true, text: "No routines yet." };
    return {
      ok: true,
      text: routines.map(describeRoutine).join("\n"),
      data: { count: routines.length, active: svc.active },
    };
  },
};

export const runRoutineAction: Action = {
  name: "run_routine",
  operatorOnly: true,
  similes: ["run_now", "trigger_routine"],
  description: "Run a routine right now and return its result (does not wait for its schedule).",
  parameters: {
    type: "object",
    properties: { id: { type: "string", description: "Routine id, e.g. 'r1'." } },
    required: ["id"],
  },
  examples: [{ user: "run r1 now", agent: "running it…" }],
  async validate(runtime) {
    return Boolean(runtime.getService("routines"));
  },
  async handler(runtime, _state, params) {
    try {
      const res = await getRoutines(runtime).run(String(params.id ?? ""), { deliver: false });
      return { ok: res.ok, text: `${res.changed ? "Changed since the last run." : "Same as the last run."}\n${res.text}`, data: res.data };
    } catch (err) {
      return { ok: false, text: (err as Error).message };
    }
  },
};

export const stopRoutineAction: Action = {
  name: "stop_routine",
  operatorOnly: true,
  similes: ["unschedule_skill", "remove_routine", "cancel_routine"],
  description: "Stop and delete a routine by id. The skill itself stays.",
  parameters: {
    type: "object",
    properties: { id: { type: "string", description: "Routine id, e.g. 'r1'." } },
    required: ["id"],
  },
  examples: [{ user: "stop r2", agent: "stopped." }],
  async validate(runtime) {
    return Boolean(runtime.getService("routines"));
  },
  async handler(runtime, _state, params) {
    const id = String(params.id ?? "");
    const removed = await getRoutines(runtime).remove(id);
    return removed ? { ok: true, text: `Routine ${id} stopped.` } : { ok: false, text: `No routine ${id}.` };
  },
};
