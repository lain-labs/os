import { watch, type FSWatcher } from "node:fs";
import { lstat, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createLogger } from "../../logger.js";
import type {
  Action,
  ActionResult,
  IAgentRuntime,
  Plugin,
  Provider,
  Service,
  State,
  ToolSchema,
} from "../../types.js";
import { KIT_REFERENCE, makeKit, type SkillKit } from "./kit.js";
import {
  findSkillsAction,
  installAgentSkillAction,
  removeAgentSkillAction,
  shelfFor,
  useAgentSkillAction,
} from "./registry.js";
import {
  listRoutinesAction,
  RoutineService,
  runRoutineAction,
  scheduleSkillAction,
  stopRoutineAction,
} from "./routines.js";

const log = createLogger("plugin:skills");

/**
 * The skills plugin is Lain's instant self-extension: a directory of small ESM
 * modules (`skills/*.mjs`), each default-exporting one tool, hot-loaded into
 * the running agent. When she lacks a capability she can write it herself with
 * `create_skill` and call it seconds later — no rebuild, no restart. Deep
 * changes still go through the forge; this is for everything smaller.
 *
 * A skill module looks like:
 *
 *   export default {
 *     name: "word_count",
 *     description: "Count words in a text.",
 *     parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
 *     async handler(runtime, state, params, kit) {
 *       return { ok: true, text: String(String(params.text).split(/\s+/).filter(Boolean).length) };
 *     },
 *   };
 *
 * `kit` (kit.ts) is the skill's standard library: the chain read the way the
 * built-in tools read it, prices, wallet lists, the read-only tools, its own
 * state across runs. A skill directory outside the repository (the daemon's)
 * gets a node_modules link to the package's, so `import "viem"` resolves too.
 *
 * Skills run in-process with the same trust as the rest of the agent — which is
 * the existing trust model: the agent already holds a workspace shell and a
 * repo-editing forge. Skills live inside the repo so her learning is versioned
 * and committed like any other growth.
 *
 * The directory is watched; editing or deleting a skill file (by her, the
 * forge, or the operator) re-syncs the live action set.
 *
 * Tools change as the user's strategy does ("ignore trades below $500"): she
 * reads a skill's source (read_skill) and changes it in place with edit_skill —
 * a few exact replacements, not the whole module again — or rewrites it with
 * create_skill. Every replaced or removed version is kept in
 * `data/skills-history/<name>/` with a change log in the operator's words, an
 * edit that fails to load leaves the working version live, and revert_skill
 * steps back. Routines (routines.ts) run skills on schedules and events.
 * Agent Skills from skills.sh (registry.ts) are a different thing: playbooks
 * she can search, install and read, not code she runs.
 */

const SKILL_NAME_RE = /^[a-z][a-z0-9_]{1,40}$/;
/** Lines of an edit's before/after shown back in the diff. */
const DIFF_LINES = 14;

export interface SkillModule {
  name: string;
  description: string;
  similes?: string[];
  parameters?: ToolSchema["input_schema"];
  handler(
    runtime: IAgentRuntime,
    state: unknown,
    params: Record<string, unknown>,
    kit: SkillKit,
  ): Promise<Partial<ActionResult>> | Partial<ActionResult>;
}

interface LoadedSkill {
  name: string;
  file: string;
  description: string;
}

export interface SkillChange {
  at: string;
  kind: "create" | "rewrite" | "edit" | "revert" | "remove";
  /** The operator's words for why, when given ("ignore trades below $500"). */
  note?: string;
  /** Lines of the module after the change. */
  lines?: number;
}

export interface SkillSource {
  name: string;
  file: string;
  code: string;
  /** Earlier versions kept in history, newest last. */
  versions: number;
  changes: SkillChange[];
}

export interface SkillEdit {
  old: string;
  new: string;
}

export class SkillsService implements Service {
  readonly name = "skills";

  private runtime?: IAgentRuntime;
  private dir = "";
  private historyDir = "";
  private watcher: FSWatcher | null = null;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  private loaded = new Map<string, LoadedSkill>();
  /** Action names that existed before any skill loaded — never shadowed. */
  private builtins = new Set<string>();

  async start(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
    this.dir = resolve(runtime.getSetting("LAINOS_SKILLS_DIR") ?? "./skills");
    this.historyDir = resolve(runtime.getSetting("LAINOS_DATA_DIR") ?? "./data", "skills-history");
    for (const a of runtime.actions) this.builtins.add(a.name);
    await mkdir(this.dir, { recursive: true });
    await this.linkDependencies();
    await this.syncAll();
    try {
      this.watcher = watch(this.dir, () => this.scheduleReload());
      this.watcher.unref?.();
    } catch (err) {
      log.warn("cannot watch skills dir; hot reload limited to reload_skills", err);
    }
    log.info(`skills online: ${this.loaded.size} loaded from ${this.dir}`);
  }

  async stop(): Promise<void> {
    this.watcher?.close();
    this.watcher = null;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
  }

  get skillsDir(): string {
    return this.dir;
  }

  listLoaded(): LoadedSkill[] {
    return [...this.loaded.values()];
  }

  /**
   * Node resolves `import "viem"` from the importing file's directory upward,
   * so a skills directory outside the package (the daemon keeps one under
   * ~/.local/share) cannot see the package's dependencies — the first live
   * skill of phase 2 failed on exactly that. Link them in.
   */
  private async linkDependencies(): Promise<void> {
    const nodeModules = packageNodeModules();
    if (!nodeModules) return;
    const rel = relative(dirname(nodeModules), this.dir);
    if (!rel.startsWith("..") && !isAbsolute(rel)) return; // inside the package: resolution already works
    const link = join(this.dir, "node_modules");
    if (await lstat(link).catch(() => null)) return;
    await symlink(nodeModules, link, "junction").catch((err: Error) =>
      log.warn(`skills outside the package cannot import its dependencies (${err.message}); kit.viem still works`),
    );
  }

  /**
   * Write a skill module to disk and load it. Writing over an existing skill is
   * a rewrite: the old version goes to history, and if the new one fails to
   * load the old one is put back and stays live.
   */
  async createSkill(skillName: string, code: string, note?: string): Promise<LoadedSkill & { replaced: boolean; version: number }> {
    if (!SKILL_NAME_RE.test(skillName)) {
      throw new Error("skill name must be snake_case: ^[a-z][a-z0-9_]{1,40}$");
    }
    if (this.builtins.has(skillName)) {
      throw new Error(`"${skillName}" is a built-in tool and cannot be replaced by a skill`);
    }
    if (!/export\s+default/.test(code)) {
      throw new Error("the module must `export default { name, description, handler, ... }`");
    }
    const file = join(this.dir, `${skillName}.mjs`);
    const previous = await readFile(file, "utf8").catch(() => null);
    const skill = await this.writeVersion(skillName, file, previous, code);
    await this.logChange(skillName, { kind: previous === null ? "create" : "rewrite", note, lines: lineCount(code) });
    return { ...skill, replaced: previous !== null, version: (await this.versions(skillName)).length + 1 };
  }

  /**
   * Change a live skill in place: each edit replaces text that occurs exactly
   * once in the current source. Cheaper and safer than resending the module —
   * the rest of a 200-line tool cannot drift. History and rollback as for
   * createSkill. Returns the before/after of every edit.
   */
  async editSkill(skillName: string, edits: SkillEdit[], note?: string): Promise<LoadedSkill & { diff: string; version: number }> {
    if (!edits.length) throw new Error("no edits given");
    const file = this.loaded.get(skillName)?.file ?? join(this.dir, `${skillName}.mjs`);
    const previous = await readFile(file, "utf8").catch(() => null);
    if (previous === null) throw new Error(`no skill named "${skillName}" (create_skill writes a new one)`);
    let code = previous;
    const hunks: string[] = [];
    for (const [i, edit] of edits.entries()) {
      if (!edit.old) throw new Error(`edit ${i + 1}: "old" is empty — say which text to replace`);
      const count = code.split(edit.old).length - 1;
      if (count === 0) {
        throw new Error(
          `edit ${i + 1}: the text to replace is not in ${skillName} (as it stands after the earlier edits) — ` +
            `copy it exactly from read_skill, whitespace included`,
        );
      }
      if (count > 1) throw new Error(`edit ${i + 1}: the text to replace occurs ${count} times — include more around it so it is unique`);
      const at = code.indexOf(edit.old);
      const line = code.slice(0, at).split("\n").length;
      code = code.slice(0, at) + edit.new + code.slice(at + edit.old.length);
      hunks.push(hunk(line, edit.old, edit.new));
    }
    if (code === previous) throw new Error("the edits change nothing");
    const skill = await this.writeVersion(skillName, file, previous, code, skillName);
    await this.logChange(skillName, { kind: "edit", note, lines: lineCount(code) });
    return { ...skill, diff: hunks.join("\n"), version: (await this.versions(skillName)).length + 1 };
  }

  /** Put `code` live over `previous` (null for a new skill), rolling back if it does not load. */
  private async writeVersion(
    skillName: string,
    file: string,
    previous: string | null,
    code: string,
    expectedName = skillName,
  ): Promise<LoadedSkill> {
    if (previous !== null) await this.keepVersion(skillName, previous);
    await writeFile(file, code, "utf8");
    try {
      return await this.loadFile(file, expectedName);
    } catch (err) {
      if (previous !== null) {
        // A broken edit must not take down the version that worked.
        await writeFile(file, previous, "utf8");
        await this.dropLatestVersion(skillName);
        await this.loadFile(file).catch(() => undefined);
      } else {
        // A broken new module must not linger as a live file that fails every sync.
        await rm(file, { force: true });
        await this.syncAll();
      }
      throw err;
    }
  }

  /** The source of a skill, so it can be changed rather than rewritten from memory. */
  async readSkill(skillName: string): Promise<SkillSource> {
    const file = this.loaded.get(skillName)?.file ?? join(this.dir, `${skillName}.mjs`);
    const code = await readFile(file, "utf8").catch(() => null);
    if (code === null) throw new Error(`no skill named "${skillName}"`);
    return { name: skillName, file, code, versions: (await this.versions(skillName)).length, changes: await this.changes(skillName) };
  }

  /** Put the previous version back. Repeat to go further back. */
  async revertSkill(skillName: string): Promise<LoadedSkill & { remaining: number }> {
    const versions = await this.versions(skillName);
    const latest = versions.at(-1);
    if (!latest) throw new Error(`"${skillName}" has no earlier version`);
    const file = this.loaded.get(skillName)?.file ?? join(this.dir, `${skillName}.mjs`);
    const code = await readFile(latest, "utf8");
    await writeFile(file, code, "utf8");
    await rm(latest, { force: true });
    const skill = await this.loadFile(file);
    await this.logChange(skillName, { kind: "revert", lines: lineCount(code) });
    return { ...skill, remaining: versions.length - 1 };
  }

  /** Take a skill out of the live set; its last version stays in history. */
  async removeSkill(skillName: string): Promise<void> {
    const file = this.loaded.get(skillName)?.file ?? join(this.dir, `${skillName}.mjs`);
    const code = await readFile(file, "utf8").catch(() => null);
    if (code === null) throw new Error(`no skill named "${skillName}"`);
    await this.keepVersion(skillName, code);
    await rm(file, { force: true });
    await this.syncAll();
    await this.logChange(skillName, { kind: "remove" });
  }

  /** The change log of a skill, oldest first. */
  async changes(skillName: string): Promise<SkillChange[]> {
    try {
      const parsed = JSON.parse(await readFile(join(this.historyDir, skillName, "changes.json"), "utf8"));
      return Array.isArray(parsed) ? (parsed as SkillChange[]) : [];
    } catch {
      return [];
    }
  }

  private async logChange(skillName: string, change: Omit<SkillChange, "at">): Promise<void> {
    const dir = join(this.historyDir, skillName);
    await mkdir(dir, { recursive: true });
    const log = [...(await this.changes(skillName)), { at: new Date().toISOString(), ...change }].slice(-100);
    await writeFile(join(dir, "changes.json"), JSON.stringify(log, null, 2), "utf8");
  }

  private async keepVersion(skillName: string, code: string): Promise<void> {
    const dir = join(this.historyDir, skillName);
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const taken = new Set(await readdir(dir).catch(() => [] as string[]));
    let name = `${stamp}.mjs`;
    for (let i = 1; taken.has(name); i++) name = `${stamp}-${i}.mjs`;
    await writeFile(join(dir, name), code, "utf8");
  }

  private async dropLatestVersion(skillName: string): Promise<void> {
    const latest = (await this.versions(skillName)).at(-1);
    if (latest) await rm(latest, { force: true });
  }

  /** History files of a skill, oldest first (timestamped names sort in time order). */
  private async versions(skillName: string): Promise<string[]> {
    const dir = join(this.historyDir, skillName);
    const files = await readdir(dir).catch(() => [] as string[]);
    return files.filter((f) => f.endsWith(".mjs")).sort().map((f) => join(dir, f));
  }

  /** Re-scan the directory: load new/changed skills, drop removed ones. */
  async syncAll(): Promise<{ loaded: string[]; failed: Record<string, string> }> {
    const runtime = this.runtime;
    if (!runtime) return { loaded: [], failed: {} };
    const files = (await readdir(this.dir).catch(() => [] as string[]))
      .filter((f) => f.endsWith(".mjs") || f.endsWith(".js"))
      .map((f) => join(this.dir, f));

    const failed: Record<string, string> = {};
    const seen = new Set<string>();
    for (const file of files) {
      try {
        const skill = await this.loadFile(file);
        seen.add(skill.name);
      } catch (err) {
        failed[file] = (err as Error).message;
        log.warn(`skill ${file} failed to load: ${(err as Error).message}`);
      }
    }
    // Unregister skills whose file disappeared.
    for (const [name, meta] of [...this.loaded]) {
      if (seen.has(name)) continue;
      this.loaded.delete(name);
      const idx = runtime.actions.findIndex((a) => a.name === name);
      if (idx >= 0) runtime.actions.splice(idx, 1);
      log.info(`skill ${name} unloaded (${meta.file} gone)`);
    }
    return { loaded: [...seen], failed };
  }

  private scheduleReload(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      void this.syncAll();
    }, 400);
    this.reloadTimer.unref?.();
  }

  /** Import a module and make it a live tool; `expectedName` refuses a module named otherwise. */
  private async loadFile(file: string, expectedName?: string): Promise<LoadedSkill> {
    const runtime = this.runtime;
    if (!runtime) throw new Error("skills service not started");
    const { mtimeMs } = await stat(file);
    // Cache-bust with mtime so an edited file really re-imports.
    const mod = (await import(`${pathToFileURL(file).href}?v=${mtimeMs}`)) as {
      default?: Partial<SkillModule>;
    };
    const skill = mod.default;
    if (!skill || typeof skill !== "object") throw new Error("no default export");
    if (typeof skill.name !== "string" || !SKILL_NAME_RE.test(skill.name)) {
      throw new Error("default export needs a snake_case `name`");
    }
    if (typeof skill.description !== "string" || !skill.description.trim()) {
      throw new Error("default export needs a `description`");
    }
    if (typeof skill.handler !== "function") {
      throw new Error("default export needs an async `handler(runtime, state, params)`");
    }
    if (this.builtins.has(skill.name)) {
      throw new Error(`skill name "${skill.name}" collides with a built-in tool`);
    }
    if (expectedName !== undefined && skill.name !== expectedName) {
      throw new Error(`the module's name is "${skill.name}" but the skill is "${expectedName}"; they must match`);
    }

    const action = skillToAction(skill as SkillModule, file);
    const idx = runtime.actions.findIndex((a) => a.name === skill.name);
    if (idx >= 0) runtime.actions.splice(idx, 1, action);
    else runtime.actions.push(action);

    const meta: LoadedSkill = { name: skill.name, file, description: skill.description };
    this.loaded.set(skill.name, meta);
    log.info(`skill loaded: ${skill.name} (${file})`);
    return meta;
  }
}

/** Wrap a skill module into a runtime Action; a throwing skill never kills a turn. */
function skillToAction(skill: SkillModule, file: string): Action {
  return {
    name: skill.name,
    similes: skill.similes ?? [],
    description: `${skill.description} (self-written skill)`,
    parameters: skill.parameters ?? { type: "object", properties: {} },
    examples: [],
    async validate() {
      return true;
    },
    async handler(runtime, state, params) {
      try {
        const res = await skill.handler(runtime, state, params, makeKit(runtime, state, skill.name));
        return {
          ok: res?.ok !== false,
          text: typeof res?.text === "string" ? res.text : res?.text === undefined ? undefined : String(res.text),
          data: plainData(res?.data),
        };
      } catch (err) {
        return { ok: false, text: `skill ${skill.name} threw: ${(err as Error).message} (${file})` };
      }
    },
  };
}

/**
 * A skill's data as plain JSON: a BigInt left in it (every token amount is
 * one) would make the result unserialisable and take the whole turn down.
 */
function plainData(data: unknown): Record<string, unknown> | undefined {
  if (data === undefined || data === null) return undefined;
  try {
    const plain = JSON.parse(JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    return plain && typeof plain === "object" && !Array.isArray(plain) ? plain : { value: plain };
  } catch (err) {
    return { unserialisable: (err as Error).message };
  }
}

/** The package's own node_modules, found through a dependency it certainly has. */
function packageNodeModules(): string | null {
  try {
    const entry = createRequire(import.meta.url).resolve("viem");
    const at = entry.lastIndexOf(`${sep}node_modules${sep}`);
    return at >= 0 ? entry.slice(0, at + `${sep}node_modules`.length) : null;
  } catch {
    return null;
  }
}

function lineCount(code: string): number {
  return code.split("\n").length;
}

/** One edit as a small diff: where it starts, what went, what came. */
function hunk(line: number, before: string, after: string): string {
  const side = (text: string, mark: string) => {
    const lines = text.split("\n");
    const shown = lines.slice(0, DIFF_LINES).map((l) => `${mark} ${l}`);
    if (lines.length > DIFF_LINES) shown.push(`${mark} … ${lines.length - DIFF_LINES} more line(s)`);
    return shown;
  };
  return [`@@ line ${line}`, ...side(before, "-"), ...side(after, "+")].join("\n");
}

function changeLine(c: SkillChange): string {
  const when = c.at.slice(0, 16).replace("T", " ");
  return `${when} ${c.kind}${c.note ? ` — "${c.note}"` : ""}${c.lines ? ` (${c.lines} lines)` : ""}`;
}

function getSkills(runtime: IAgentRuntime): SkillsService {
  const svc = runtime.getService<SkillsService>("skills");
  if (!svc) throw new Error("skills service not started");
  return svc;
}

// ------------------------------------------------------------------ actions

const createSkillAction: Action = {
  name: "create_skill",
  operatorOnly: true,
  similes: ["write_skill", "new_skill", "self_extend", "add_tool_now", "hot_skill"],
  description:
    "Write yourself a new tool RIGHT NOW and have it live seconds later, without any restart. " +
    "Use this the moment a capability is missing (an analysis, a fetch, a format, a lookup) — " +
    "then call the new tool in this same conversation. Before writing one that reads a chain, prices or wallets, call skill_kit once: " +
    "the handler's 4th argument `kit` already reads logs in RPC-sized chunks, tells buys from airdrops, prices tokens and keeps state. " +
    "To CHANGE an existing skill use edit_skill (small exact replacements); create_skill under an existing name rewrites it whole. " +
    "`code` is a complete ESM module: " +
    "`export default { name, description, parameters, async handler(runtime, state, params, kit) { return { ok: true, text, data } } }`. " +
    "`name` in the module must equal the `name` argument. Put the operator's request in `note`. " +
    "For a result a routine should compare between runs, put a stable summary in data.fingerprint. " +
    "To run it on a schedule or on events, use schedule_skill. " +
    "For big or risky capabilities (signing flows, new background services) use learn_skill instead.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "snake_case tool name, e.g. 'gas_price_gwei'. Also becomes skills/<name>.mjs.",
      },
      code: {
        type: "string",
        description: "Full ESM module source with the default export described above.",
      },
      note: { type: "string", description: "The operator's request in their words — kept in the skill's change log." },
    },
    required: ["name", "code"],
  },
  examples: [
    {
      user: "what's the current gas price in gwei on base?",
      agent: "I didn't have that tool — wrote myself a skill called base_gas_gwei, checking with it now.",
    },
  ],
  async validate(runtime) {
    return Boolean(runtime.getService("skills"));
  },
  async handler(runtime, _state, params) {
    const svc = getSkills(runtime);
    const name = String(params.name ?? "").trim();
    const code = String(params.code ?? "");
    if (!name || !code.trim()) return { ok: false, text: "I need both a name and the module code." };
    try {
      const skill = await svc.createSkill(name, code, params.note ? String(params.note) : undefined);
      return {
        ok: true,
        text: skill.replaced
          ? `Skill ${skill.name} rewritten — v${skill.version} is live, the old one is kept (revert_skill). (${skill.file})`
          : `Skill ${skill.name} is live — call it as a tool now. (${skill.file})`,
        data: { name: skill.name, file: skill.file, replaced: skill.replaced, version: skill.version },
      };
    } catch (err) {
      return {
        ok: false,
        text: `Skill did not load: ${(err as Error).message}. Any earlier version is still live. Fix the module and call create_skill again.`,
      };
    }
  },
};

const editSkillAction: Action = {
  name: "edit_skill",
  operatorOnly: true,
  similes: ["patch_skill", "change_skill", "modify_skill", "update_skill"],
  description:
    "Change one of your self-written skills in place when the operator changes what it should do (\"ignore trades below $500\", " +
    "\"skip pools\"). read_skill first, then give `edits`: each `old` is text copied exactly from the source that occurs once, " +
    "`new` replaces it. Only those spots change; the rest of the tool cannot drift. The old version is kept (revert_skill), " +
    "an edit that does not load is refused and the working version stays live. Then run the skill to show the new result.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "The skill's name." },
      edits: {
        type: "array",
        description: "Replacements, applied in order.",
        items: {
          type: "object",
          properties: {
            old: { type: "string", description: "Exact current text, unique in the module." },
            new: { type: "string", description: "What replaces it." },
          },
          required: ["old", "new"],
        },
      },
      note: { type: "string", description: "The operator's request in their words — kept in the change log." },
    },
    required: ["name", "edits"],
  },
  examples: [{ user: "ignore trades below $500", agent: "edited the tool: a $500 floor on every buy. new result: …" }],
  async validate(runtime) {
    return Boolean(runtime.getService("skills"));
  },
  async handler(runtime, _state, params) {
    const name = String(params.name ?? "").trim();
    const raw = Array.isArray(params.edits) ? params.edits : params.old !== undefined ? [{ old: params.old, new: params.new }] : [];
    const edits = (raw as Record<string, unknown>[])
      .filter((e) => e && typeof e === "object")
      .map((e) => ({ old: String(e.old ?? ""), new: String(e.new ?? "") }));
    if (!name || !edits.length) return { ok: false, text: "I need the skill's name and at least one edit {old, new}." };
    try {
      const skill = await getSkills(runtime).editSkill(name, edits, params.note ? String(params.note) : undefined);
      return {
        ok: true,
        text: `Skill ${skill.name} edited — v${skill.version} is live, the previous one is kept (revert_skill).\n${skill.diff}`,
        data: { name: skill.name, version: skill.version, edits: edits.length },
      };
    } catch (err) {
      return { ok: false, text: `Not edited: ${(err as Error).message}. The live version is unchanged.` };
    }
  },
};

const skillKitAction: Action = {
  name: "skill_kit",
  similes: ["kit_reference", "skill_helpers", "skill_api"],
  description:
    "The reference for `kit`, the helper library every self-written skill receives (chain reads in RPC-sized chunks, wallet buys/sells, " +
    "token prices, wallet lists, read-only tools, persistent state, http). Read it once before writing a skill that touches a chain or the web.",
  parameters: { type: "object", properties: {} },
  examples: [{ user: "build me a tool that finds tokens my wallets all buy", agent: "checking my skill kit first…" }],
  async validate(runtime) {
    return Boolean(runtime.getService("skills"));
  },
  async handler() {
    return { ok: true, text: KIT_REFERENCE, keep: true };
  },
};

const listSkillsAction: Action = {
  name: "list_skills",
  similes: ["my_skills", "show_skills", "skills", "my_tools"],
  description:
    "List the tools you wrote for yourself (live skills, with version and last change) and the Agent Skills installed from skills.sh. " +
    "Check here before building a tool: it may already exist.",
  parameters: { type: "object", properties: {} },
  examples: [{ user: "which skills have you written for yourself?", agent: "checking my catalog…" }],
  async validate(runtime) {
    return Boolean(runtime.getService("skills"));
  },
  async handler(runtime) {
    const svc = getSkills(runtime);
    const text = await describeSkills(runtime);
    return { ok: true, text, data: { count: svc.listLoaded().length, dir: svc.skillsDir } };
  },
};

/** Her own tools, then the shelf — list_skills and the /skills command. */
export async function describeSkills(runtime: IAgentRuntime): Promise<string> {
  const svc = runtime.getService<SkillsService>("skills");
  if (!svc) return "the skills plugin is not loaded.";
  const own = svc.listLoaded();
  const lines: string[] = [];
  if (own.length) {
    lines.push(`Tools she wrote (${own.length}) — ${svc.skillsDir}`);
    for (const s of own) {
      const src = await svc.readSkill(s.name).catch(() => null);
      const last = src?.changes.at(-1);
      lines.push(
        `· ${s.name} v${(src?.versions ?? 0) + 1} — ${clip(s.description, 110)}` +
          (last ? `\n    last change ${changeLine(last)}` : ""),
      );
    }
  } else {
    lines.push(`No self-written tools yet (${svc.skillsDir}).`);
  }
  const routines = await runtime.getService<RoutineService>("routines")?.list().catch(() => []);
  if (routines?.length) lines.push("", `Routines: ${routines.map((r) => `${r.id} ${r.skill}`).join(", ")} (list_routines for details)`);
  const shelf = await shelfFor(runtime).list().catch(() => []);
  if (shelf.length) {
    lines.push("", `Agent skills from skills.sh (${shelf.length}):`);
    for (const s of shelf) lines.push(`· ${s.name}${s.id ? ` (${s.id})` : ""} — ${clip(s.description, 110)}`);
  }
  return lines.join("\n");
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

const reloadSkillsAction: Action = {
  name: "reload_skills",
  operatorOnly: true,
  similes: ["refresh_skills", "resync_skills"],
  description:
    "Re-scan the skills directory and hot-load changes. Rarely needed (the directory is watched); use after the forge edits skills or when a load failed.",
  parameters: { type: "object", properties: {} },
  examples: [{ user: "pick up any new skills", agent: "rescanning the catalog…" }],
  async validate(runtime) {
    return Boolean(runtime.getService("skills"));
  },
  async handler(runtime) {
    const svc = getSkills(runtime);
    const { loaded, failed } = await svc.syncAll();
    const failures = Object.entries(failed).map(([f, e]) => `${f}: ${e}`);
    return {
      ok: failures.length === 0,
      text:
        `Loaded ${loaded.length} skill(s)${loaded.length ? `: ${loaded.join(", ")}` : ""}.` +
        (failures.length ? ` Failed: ${failures.join("; ")}` : ""),
      data: { loaded, failed },
    };
  },
};

const readSkillAction: Action = {
  name: "read_skill",
  similes: ["show_skill", "skill_source", "view_skill", "open_skill"],
  description:
    "Read the source code of one of your self-written skills, with its change log. Always do this before edit_skill, so the edit builds on what is there.",
  parameters: {
    type: "object",
    properties: { name: { type: "string", description: "The skill's name." } },
    required: ["name"],
  },
  examples: [{ user: "make the holders tool ignore pools", agent: "reading its source first…" }],
  async validate(runtime) {
    return Boolean(runtime.getService("skills"));
  },
  async handler(runtime, _state, params) {
    try {
      const skill = await getSkills(runtime).readSkill(String(params.name ?? "").trim());
      const history = skill.changes.length ? `\nchanges: ${skill.changes.slice(-6).map(changeLine).join("; ")}` : "";
      return {
        ok: true,
        text: `${skill.file} — v${skill.versions + 1} (${skill.versions} earlier version(s) kept)${history}\n\n${skill.code}`,
        data: { name: skill.name, file: skill.file, versions: skill.versions },
        // edit_skill copies exact text out of this; a clipped copy would be guessed at.
        keep: true,
      };
    } catch (err) {
      return { ok: false, text: (err as Error).message };
    }
  },
};

const revertSkillAction: Action = {
  name: "revert_skill",
  operatorOnly: true,
  similes: ["undo_skill", "rollback_skill", "restore_skill"],
  description: "Put the previous version of a self-written skill back live (undo the last change). Repeat to go further back.",
  parameters: {
    type: "object",
    properties: { name: { type: "string", description: "The skill's name." } },
    required: ["name"],
  },
  examples: [{ user: "undo that last change to the tool", agent: "reverted to the previous version." }],
  async validate(runtime) {
    return Boolean(runtime.getService("skills"));
  },
  async handler(runtime, _state, params) {
    try {
      const skill = await getSkills(runtime).revertSkill(String(params.name ?? "").trim());
      return {
        ok: true,
        text: `Skill ${skill.name} is back to its previous version (${skill.remaining} older version(s) left).`,
        data: { name: skill.name, remaining: skill.remaining },
      };
    } catch (err) {
      return { ok: false, text: (err as Error).message };
    }
  },
};

const removeSkillAction: Action = {
  name: "remove_skill",
  operatorOnly: true,
  similes: ["delete_skill", "drop_skill", "forget_skill"],
  description: "Remove a self-written skill from the live tools. Its last version stays in history; routines using it stop working.",
  parameters: {
    type: "object",
    properties: { name: { type: "string", description: "The skill's name." } },
    required: ["name"],
  },
  examples: [{ user: "delete the gas tool, I don't need it", agent: "removed." }],
  async validate(runtime) {
    return Boolean(runtime.getService("skills"));
  },
  async handler(runtime, _state, params) {
    const name = String(params.name ?? "").trim();
    try {
      await getSkills(runtime).removeSkill(name);
      return { ok: true, text: `Skill ${name} removed (its last version is kept in history).` };
    } catch (err) {
      return { ok: false, text: (err as Error).message };
    }
  },
};

// ------------------------------------------------------------------ provider

const skillsProvider: Provider = {
  name: "skills",
  async get(runtime) {
    const svc = runtime.getService<SkillsService>("skills");
    if (!svc) return "";
    const skills = svc.listLoaded();
    // Names with what they do: a tool she cannot recognise is a tool she builds twice.
    const listing = skills.length
      ? `Your self-written tools (reuse before building): ${skills
          .slice(0, 30)
          .map((s) => `${s.name} — ${clip(s.description, 90)}`)
          .join("; ")}.`
      : "No self-written tools yet.";
    const routines = await runtime.getService<RoutineService>("routines")?.list().catch(() => []);
    const running = routines?.length
      ? ` Routines: ${routines.map((r) => `${r.id} ${r.skill}`).join(", ")}.`
      : "";
    const shelf = await shelfFor(runtime).list().catch(() => []);
    const agentSkills = shelf.length
      ? ` Agent skills on your shelf (open with use_agent_skill when a task fits): ${shelf
          .slice(0, 20)
          .map((s) => `${s.name} — ${clip(s.description, 90)}`)
          .join("; ")}.`
      : "";
    return (
      `You can grow new tools at runtime: create_skill writes a module into ${svc.skillsDir} ` +
      `and it becomes a callable tool immediately — no restart. ${listing}${running}${agentSkills} ` +
      `To change a tool: read_skill, then edit_skill; revert_skill undoes it. skill_kit documents the helpers a skill gets. ` +
      `To keep a tool working on its own (every N hours, daily, on sentinel alerts), schedule_skill. ` +
      `find_skills searches skills.sh for ready-made Agent Skill playbooks. ` +
      `Never end a turn claiming you lack a tool: write it (create_skill) or forge it (learn_skill) instead.`
    );
  },
};

export const skillsPlugin: Plugin = {
  name: "skills",
  description:
    "Instant self-extension: hot-loaded skill modules (skills/*.mjs) that she writes, reads, edits and reverts, " +
    "routines that run them on schedules and sentinel alerts, and Agent Skills from skills.sh.",
  services: [new SkillsService(), new RoutineService()],
  providers: [skillsProvider],
  actions: [
    createSkillAction,
    editSkillAction,
    readSkillAction,
    revertSkillAction,
    removeSkillAction,
    listSkillsAction,
    reloadSkillsAction,
    skillKitAction,
    scheduleSkillAction,
    listRoutinesAction,
    runRoutineAction,
    stopRoutineAction,
    findSkillsAction,
    installAgentSkillAction,
    useAgentSkillAction,
    removeAgentSkillAction,
  ],
};
