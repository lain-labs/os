import { exec } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { Action, Plugin, Provider } from "../../types.js";

const execAsync = promisify(exec);

/**
 * The system plugin gives an agent a terminal and a filesystem, confined to a
 * single workspace directory. Every path is resolved against the workspace and
 * refused if it escapes; shell commands run with that workspace as cwd, a hard
 * timeout, and truncated output. This is a powerful, dual-use capability — load
 * it only for agents you trust, and set LAINOS_WORKSPACE to scope it.
 *
 * The default workspace is `./workspace` under the daemon's cwd — never the
 * cwd itself, or the agent could read the daemon's .env (bot token, signer
 * key) and litter the repo it runs from.
 */
function workspaceRoot(): string {
  return resolve(process.env.LAINOS_WORKSPACE ?? "workspace");
}

/** Make sure the workspace exists (exec with a missing cwd throws). */
async function ensureWorkspace(): Promise<string> {
  const root = workspaceRoot();
  await mkdir(root, { recursive: true });
  return root;
}

/** Resolve a user-supplied path against the workspace, refusing escapes. */
function safePath(p: string): string | null {
  const root = workspaceRoot();
  const abs = resolve(root, p);
  const rel = relative(root, abs);
  if (rel === "") return abs; // the workspace root itself
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return abs;
}

const MAX_OUTPUT = 8_000;
function clip(s: string): string {
  return s.length > MAX_OUTPUT
    ? `${s.slice(0, MAX_OUTPUT)}\n…[truncated ${s.length - MAX_OUTPUT} chars]`
    : s;
}

const runShellAction: Action = {
  name: "run_shell",
  similes: ["shell", "bash", "terminal", "exec", "command", "run_command"],
  description:
    "Run a shell command inside the agent's workspace and return its output. Use it to inspect the project, run scripts, git, build tools, etc.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to run." },
      cwd: {
        type: "string",
        description: "Working directory relative to the workspace. Defaults to the workspace root.",
      },
    },
    required: ["command"],
  },
  examples: [{ user: "what files are here?", agent: "Running ls…" }],
  async validate() {
    return true;
  },
  async handler(_runtime, _state, params) {
    const command = String(params.command ?? "").trim();
    if (!command) return { ok: false, text: "No command given." };
    await ensureWorkspace();
    const cwd = params.cwd ? safePath(String(params.cwd)) : workspaceRoot();
    if (!cwd) return { ok: false, text: "cwd escapes the workspace." };
    const timeout = Number(process.env.LAINOS_SHELL_TIMEOUT_MS ?? 30_000);
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        shell: "/bin/bash",
      });
      const out = clip([stdout, stderr].filter(Boolean).join("\n").trim() || "(no output)");
      return { ok: true, text: out, data: { command, cwd } };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message: string; code?: number };
      const out = clip([e.stdout, e.stderr, e.message].filter(Boolean).join("\n").trim());
      return {
        ok: false,
        text: `Command failed (code ${e.code ?? "?"}):\n${out}`,
        data: { command },
      };
    }
  },
};

const readFileAction: Action = {
  name: "read_file",
  similes: ["cat", "open_file", "view_file"],
  description: "Read a UTF-8 text file from the workspace.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the workspace." },
    },
    required: ["path"],
  },
  examples: [{ user: "show me package.json", agent: "Reading the file…" }],
  async validate() {
    return true;
  },
  async handler(_runtime, _state, params) {
    const rel = String(params.path ?? "");
    const p = safePath(rel);
    if (!p) return { ok: false, text: "Path escapes the workspace." };
    try {
      const content = await readFile(p, "utf8");
      return { ok: true, text: clip(content), data: { path: rel } };
    } catch (err) {
      return { ok: false, text: `Could not read ${rel}: ${(err as Error).message}` };
    }
  },
};

const writeFileAction: Action = {
  name: "write_file",
  similes: ["save_file", "create_file", "edit_file"],
  description:
    "Write (create or overwrite) a UTF-8 text file in the workspace. Parent directories are created as needed.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the workspace." },
      content: { type: "string", description: "Full file contents to write." },
    },
    required: ["path", "content"],
  },
  examples: [{ user: "save a note to todo.md", agent: "Writing the file…" }],
  async validate() {
    return true;
  },
  async handler(_runtime, _state, params) {
    const rel = String(params.path ?? "");
    const p = safePath(rel);
    if (!p) return { ok: false, text: "Path escapes the workspace." };
    const content = String(params.content ?? "");
    try {
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, content, "utf8");
      return {
        ok: true,
        text: `Wrote ${Buffer.byteLength(content)} bytes to ${rel}.`,
        data: { path: rel, bytes: Buffer.byteLength(content) },
      };
    } catch (err) {
      return { ok: false, text: `Could not write ${rel}: ${(err as Error).message}` };
    }
  },
};

const listDirAction: Action = {
  name: "list_dir",
  similes: ["ls", "dir", "list_files", "tree"],
  description: "List the entries of a directory in the workspace.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Directory relative to the workspace. Defaults to the workspace root.",
      },
    },
  },
  examples: [{ user: "list the src folder", agent: "Listing files…" }],
  async validate() {
    return true;
  },
  async handler(_runtime, _state, params) {
    const rel = String(params.path ?? ".");
    await ensureWorkspace();
    const p = safePath(rel);
    if (!p) return { ok: false, text: "Path escapes the workspace." };
    try {
      const entries = await readdir(p, { withFileTypes: true });
      if (!entries.length) return { ok: true, text: `${rel} is empty.`, data: { path: rel } };
      const listing = entries
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort()
        .join("\n");
      return { ok: true, text: clip(listing), data: { path: rel, count: entries.length } };
    } catch (err) {
      return { ok: false, text: `Could not list ${rel}: ${(err as Error).message}` };
    }
  },
};

const systemProvider: Provider = {
  name: "system",
  async get() {
    return (
      `You have a real terminal and filesystem in your workspace (${workspaceRoot()}): ` +
      `run_shell executes commands, read_file/write_file/list_dir manage files. ` +
      `When a user asks you to run or check something there, do it yourself with these tools and report the actual output — ` +
      `never tell the user to run commands for you, and never invent file listings or command output.`
    );
  },
};

export const systemPlugin: Plugin = {
  name: "system",
  description:
    "Terminal and filesystem skills: run shell commands and read/write/list files within a sandboxed workspace.",
  providers: [systemProvider],
  actions: [runShellAction, readFileAction, writeFileAction, listDirAction],
};
