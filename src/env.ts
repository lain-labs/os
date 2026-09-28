/**
 * Load .env into process.env — as a side effect, on import, before anything
 * else in the app runs.
 *
 * Plain `dotenv/config` (what this used to be) only ever looks in
 * `process.cwd()`. That's wrong for an installed global command: `lain`,
 * `lain-cli` and `lain-serve` are shims that `exec` node directly without
 * `cd`-ing into the install directory first (see install.sh), so
 * process.cwd() is wherever the operator's shell happened to be when they
 * typed the command — almost never the install directory. The practical
 * effect: every .env setting (provider keys, chain RPC, everything) was
 * silently ignored unless you happened to run `lain` from inside its own
 * install directory. Confirmed empirically against a real `curl | sh`
 * install: running from any other cwd, process.env.OPENROUTER_API_KEY (and
 * everything else in .env) came back undefined despite a correctly
 * populated .env sitting right there in the install directory.
 *
 * Fixed the same way soul.ts resolves soul.md: search candidate paths
 * relative to *this file's own compiled location* (reachable from both
 * src/ under tsx and dist/src/ after a build), not the working directory.
 *
 * Deliberately NOT falling back to process.cwd() at all, even as a lower
 * priority: the first version of this fix kept `resolve(".env")` as a
 * candidate "for anyone who deliberately wants that", and it immediately
 * did the wrong thing for real — running `lain-cli` from inside an
 * unrelated project that happens to have its own .env (extremely common)
 * silently loaded *that* file, and login-gate.ts's writer (same candidate
 * list) then wrote a Lain OS key straight into that unrelated project's
 * .env. A globally-installed command has no business ever touching a
 * random cwd's .env; the install directory is the only correct answer.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));

const candidates = [
  resolve(here, "../.env"), // src/env.ts (tsx dev mode)
  resolve(here, "../../.env"), // dist/src/env.js (built)
];

for (const path of candidates) {
  if (existsSync(path)) {
    loadDotenv({ path });
    break;
  }
}
