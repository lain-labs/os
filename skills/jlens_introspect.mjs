// Jacobian lens over a local stand-in model: what a text was disposed to say,
// layer by layer, and where a reply's own tokens rank in that disposition.
// The work happens in scripts/jlens/jlens_sidecar.py, a separate Python
// process spawned per call and never in the reply path. See
// scripts/jlens/README.md for installing the weights and fitting the lens.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TIMEOUT_MS = 180_000;
// Only these reach the child: the sidecar never sees API keys or tokens.
const PASSED_SETTINGS = ["MODEL", "DTYPE", "MAX_LEN", "THREADS", "LENS"];

function settingOf(runtime, key) {
  const value = runtime.getSetting?.(key);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readConfig(home) {
  try {
    return JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  } catch {
    return {};
  }
}

function runSidecar(python, args, env, request, timeoutMs) {
  return new Promise((done) => {
    const child = spawn(python, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ ok: false, error: `the sidecar took longer than ${Math.round(timeoutMs / 1000)} s and was stopped` });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-2000)));
    child.on("error", (err) => {
      clearTimeout(timer);
      done({
        ok: false,
        error: `cannot start ${python}: ${err.message}`,
        step: "set LAINOS_JLENS_PYTHON to a Python with torch and transformers (scripts/jlens/README.md)",
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const line = stdout.trim().split("\n").at(-1) ?? "";
      try {
        done(JSON.parse(line));
      } catch {
        const tail = stderr.trim().split("\n").slice(-3).join(" | ");
        done({ ok: false, error: `the sidecar exited ${code} without a result${tail ? `: ${tail}` : ""}` });
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export default {
  name: "jlens_introspect",
  description:
    "Introspection side channel (Jacobian lens) on a small LOCAL open-weights stand-in model, not on the model that writes Lain's replies. " +
    "mode 'introspect': per-layer top-k tokens the stand-in is disposed to say next at one position of `text`, plus the layer where its actual next token emerges. " +
    "mode 'compare': feed a `prompt` and what was actually `said`; returns where each said token ranks in the lens readout per layer (median rank, overlap@k, perplexity shift) and appends the result to the jlens journal (not the trading journal). " +
    "mode 'status': what is installed and the next setup step. " +
    "The result is evidence about the stand-in's dispositions with stated caveats; never rewrite, retract or replace a reply because of it, and never base a trade on it.",
  parameters: {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["introspect", "compare", "status"], description: "Default: compare when `said` is given, else introspect." },
      text: { type: "string", description: "introspect: the text to read the lens on." },
      position: { type: "number", description: "introspect: token position to read (default -1, the last)." },
      prompt: { type: "string", description: "compare: the message that was answered." },
      said: { type: "string", description: "compare: the reply that was actually sent." },
      layers: { type: "array", items: { type: "number" }, description: "Layers to read (default all; negative counts from the end)." },
      topk: { type: "number", description: "Tokens per layer for introspect (default 5); k of overlap@k for compare (default 10)." },
      journal: { type: "boolean", description: "compare: append to the jlens journal (default true)." },
    },
  },
  async handler(runtime, _state, params = {}) {
    const mode = params.mode ?? (params.said !== undefined ? "compare" : "introspect");
    if (!["introspect", "compare", "status"].includes(mode)) {
      return { ok: false, text: `unknown mode "${mode}"; use introspect, compare or status` };
    }
    const home = settingOf(runtime, "LAINOS_JLENS_HOME") ?? join(homedir(), ".local", "share", "lainos", "jlens");
    const config = readConfig(home);
    const python = settingOf(runtime, "LAINOS_JLENS_PYTHON") ?? config.python ?? "python3";
    // A skills directory outside the checkout (the daemon's) cannot reach the
    // sidecar relatively; `fetch` records its path in config.json.
    const candidates = [
      settingOf(runtime, "LAINOS_JLENS_SIDECAR"),
      fileURLToPath(new URL("../scripts/jlens/jlens_sidecar.py", import.meta.url)),
      config.sidecar,
      resolve("scripts/jlens/jlens_sidecar.py"),
    ].filter(Boolean);
    const sidecar = candidates.find((path) => existsSync(path));
    if (!sidecar) {
      return { ok: false, text: `jlens sidecar not found (tried ${candidates.join(", ")}); set LAINOS_JLENS_SIDECAR to scripts/jlens/jlens_sidecar.py of the LainOS checkout.` };
    }

    const env = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? homedir(),
      LANG: process.env.LANG ?? "C.UTF-8",
      LAINOS_JLENS_HOME: home,
      HF_HUB_OFFLINE: "1",
      TRANSFORMERS_OFFLINE: "1",
    };
    for (const key of PASSED_SETTINGS) {
      const value = settingOf(runtime, `LAINOS_JLENS_${key}`);
      if (value) env[`LAINOS_JLENS_${key}`] = value;
    }

    const args = ["-I", sidecar, mode];
    if (mode !== "status") args.push("--json");
    if (mode === "compare" && params.journal !== false) {
      const dataDir = resolve(settingOf(runtime, "LAINOS_DATA_DIR") ?? "./data");
      args.push("--journal", join(dataDir, "jlens", "journal.jsonl"));
    }
    const request = {};
    for (const key of ["text", "position", "prompt", "said", "layers", "topk"]) {
      if (params[key] !== undefined) request[key] = params[key];
    }
    if (mode === "compare") request.source = "chat";

    const timeoutMs = Number(settingOf(runtime, "LAINOS_JLENS_TIMEOUT_MS")) || TIMEOUT_MS;
    const res = await runSidecar(python, args, env, request, timeoutMs);
    if (!res.ok) {
      const text = res.summary ?? `jlens: ${res.error}${res.step ? `\nNext step: ${res.step}` : ""}`;
      return { ok: false, text, data: { error: res.error, step: res.step ?? null } };
    }
    const { summary, ...data } = res;
    return { ok: true, text: summary, data };
  },
};
