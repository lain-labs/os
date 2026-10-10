import { watch, type FSWatcher } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createLogger } from "../../logger.js";
import type {
  Action,
  ActionResult,
  IAgentRuntime,
  Plugin,
  Provider,
  Service,
  ToolSchema,
} from "../../types.js";
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
 *     async handler(runtime, state, params) {
 *       return { ok: true, text: String(String(params.text).split(/\s+/).filter(Boolean).length) };
 *     },
 *   };
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
 * reads a skill's source (read_skill) and writes the new version under the same
 * name. Every replaced or removed version is kept in `data/skills-history/`,
 * an edit that fails to load leaves the working version live, and revert_skill
 * steps back. Routines (routines.ts) run skills on schedules and events.
 */

const SKILL_NAME_RE = /^[a-z][a-z0-9_]{1,40}$/;

export interface SkillModule {
  name: string;
  description: string;
  similes?: string[];
  parameters?: ToolSchema["input_schema"];
  handler(
    runtime: IAgentRuntime,
    state: unknown,
    params: Record<string, unknown>,
  ): Promise<Partial<ActionResult>> | Partial<ActionResult>;
}

interface LoadedSkill {
  name: string;
  file: string;
  description: string;
}

export interface SkillSource {
  name: string;
  file: string;
  code: string;
  /** Earlier versions kept in history, newest last. */
  versions: number;
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
   * Write a skill module to disk and load it. Writing over an existing skill is
   * an edit: the old version goes to history, and if the new one fails to load
   * the old one is put back and stays live.
   */
  async createSkill(skillName: string, code: string): Promise<LoadedSkill & { replaced: boolean }> {
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
    if (previous !== null) await this.keepVersion(skillName, previous);
    await writeFile(file, code, "utf8");
    try {
      const skill = await this.loadFile(file, skillName);
      return { ...skill, replaced: previous !== null };
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
    return { name: skillName, file, code, versions: (await this.versions(skillName)).length };
  }

  /** Put the previous version back. Repeat to go further back. */
  async revertSkill(skillName: string): Promise<LoadedSkill & { remaining: number }> {
    const versions = await this.versions(skillName);
    const latest = versions.at(-1);
    if (!latest) throw new Error(`"${skillName}" has no earlier version`);
    const file = this.loaded.get(skillName)?.file ?? join(this.dir, `${skillName}.mjs`);
    await writeFile(file, await readFile(latest, "utf8"), "utf8");
    await rm(latest, { force: true });
    return { ...(await this.loadFile(file)), remaining: versions.length - 1 };
  }

  /** Take a skill out of the live set; its last version stays in history. */
  async removeSkill(skillName: string): Promise<void> {
    const file = this.loaded.get(skillName)?.file ?? join(this.dir, `${skillName}.mjs`);
    const code = await readFile(file, "utf8").catch(() => null);
    if (code === null) throw new Error(`no skill named "${skillName}"`);
    await this.keepVersion(skillName, code);
    await rm(file, { force: true });
    await this.syncAll();
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
        const res = await skill.handler(runtime, state, params);
        return {
          ok: res?.ok !== false,
          text: res?.text,
          data: res?.data,
        };
      } catch (err) {
        return { ok: false, text: `skill ${skill.name} threw: ${(err as Error).message} (${file})` };
      }
    },
  };
}

function getSkills(runtime: IAgentRuntime): SkillsService {
  const svc = runtime.getService<SkillsService>("skills");
  if (!svc) throw new Error("skills service not started");
  return svc;
}

// ------------------------------------------------------------------ actions

const createSkillAction: Action = {
  name: "create_skill",
  similes: ["write_skill", "new_skill", "self_extend", "add_tool_now", "hot_skill"],
  description:
    "Write yourself a new tool RIGHT NOW and have it live seconds later, without any restart. " +
    "Use this the moment a small, self-contained capability is missing (a calculation, a fetch, a format, a lookup) — " +
    "then call the new tool in this same conversation. To CHANGE an existing skill (\"ignore trades below $500\"), read_skill first, " +
    "then call create_skill with the same name and the full new code — the old version is kept and revert_skill brings it back. " +
    "`code` is a complete ESM module: " +
    "`export default { name, description, parameters, async handler(runtime, state, params) { return { ok: true, text, data } } }`. " +
    "The module may import node builtins and installed deps (viem, undici). `name` in the module must equal the `name` argument. " +
    "For a skill whose result should be compared between runs, put a stable summary in data.fingerprint. " +
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
      const skill = await svc.createSkill(name, code);
      return {
        ok: true,
        text: skill.replaced
          ? `Skill ${skill.name} updated — the new version is live, the old one is kept (revert_skill). (${skill.file})`
          : `Skill ${skill.name} is live — call it as a tool now. (${skill.file})`,
        data: { name: skill.name, file: skill.file, replaced: skill.replaced },
      };
    } catch (err) {
      return {
        ok: false,
        text: `Skill did not load: ${(err as Error).message}. Any earlier version is still live. Fix the module and call create_skill again.`,
      };
    }
  },
};

const listSkillsAction: Action = {
  name: "list_skills",
  similes: ["my_skills", "show_skills", "skills"],
  description: "List the self-written hot-loaded skills currently live, with their files.",
  parameters: { type: "object", properties: {} },
  examples: [{ user: "which skills have you written for yourself?", agent: "checking my catalog…" }],
  async validate(runtime) {
    return Boolean(runtime.getService("skills"));
  },
  async handler(runtime) {
    const svc = getSkills(runtime);
    const skills = svc.listLoaded();
    if (!skills.length) {
      return { ok: true, text: `No self-written skills yet (dir: ${svc.skillsDir}).` };
    }
    return {
      ok: true,
      text: skills.map((s) => `${s.name} — ${s.description}`).join("\n"),
      data: { count: skills.length, dir: svc.skillsDir },
    };
  },
};

const reloadSkillsAction: Action = {
  name: "reload_skills",
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
    "Read the source code of one of your self-written skills. Always do this before changing a skill, so the edit builds on what is there.",
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
      return {
        ok: true,
        text: `${skill.file} (${skill.versions} earlier version(s) kept)\n\n${skill.code}`,
        data: { name: skill.name, file: skill.file, versions: skill.versions },
      };
    } catch (err) {
      return { ok: false, text: (err as Error).message };
    }
  },
};

const revertSkillAction: Action = {
  name: "revert_skill",
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
    const listing = skills.length
      ? `Live self-written skills: ${skills.map((s) => s.name).join(", ")}.`
      : "No self-written skills yet.";
    const routines = await runtime.getService<RoutineService>("routines")?.list().catch(() => []);
    const running = routines?.length
      ? ` Routines: ${routines.map((r) => `${r.id} ${r.skill}`).join(", ")}.`
      : "";
    return (
      `You can grow new tools at runtime: create_skill writes a module into ${svc.skillsDir} ` +
      `and it becomes a callable tool immediately — no restart. ${listing}${running} ` +
      `To change a tool, read_skill then create_skill under the same name; revert_skill undoes it. ` +
      `To keep a tool working on its own (every N hours, daily, on sentinel alerts), schedule_skill. ` +
      `Never end a turn claiming you lack a tool: write it (create_skill) or forge it (learn_skill) instead.`
    );
  },
};

export const skillsPlugin: Plugin = {
  name: "skills",
  description:
    "Instant self-extension: hot-loaded skill modules (skills/*.mjs) that she writes, reads, edits and reverts, " +
    "plus routines that run them on schedules and sentinel alerts.",
  services: [new SkillsService(), new RoutineService()],
  providers: [skillsProvider],
  actions: [
    createSkillAction,
    readSkillAction,
    revertSkillAction,
    removeSkillAction,
    listSkillsAction,
    reloadSkillsAction,
    scheduleSkillAction,
    listRoutinesAction,
    runRoutineAction,
    stopRoutineAction,
  ],
};
