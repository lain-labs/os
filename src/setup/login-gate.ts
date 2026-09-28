/**
 * Required login gate for the interactive entrypoints (TUI, CLI REPL).
 *
 * LainOS answers nothing real without a model provider. Rather than let a
 * fresh install quietly fall back to the offline mock model (which looks
 * like it's working but never actually reasons about anything), the
 * interactive entrypoints block here until either a Lain OS API key is
 * entered or *some* other provider is already configured — deliberately not
 * skippable, by product decision, even though nothing downstream technically
 * requires it.
 *
 * Never call this from the daemon (serve.ts): a background process with no
 * human attached must not block on stdin. It already no-ops without a TTY.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { resolveClaudeBin, resolveCodexBin, resolveOpenCodeBin } from "../models/index.js";

const LAIN_OS_URL = "https://lain.cyberia.church";

/** Best-effort cross-platform "open this in the default browser". Never throws. */
export function openUrl(url: string): void {
  try {
    const p = platform();
    const cmd = p === "darwin" ? "open" : p === "win32" ? "cmd" : "xdg-open";
    const args = p === "win32" ? ["/c", "start", '""', url] : [url];
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {
      /* headless/no GUI/command missing — the caller already printed the URL as text */
    });
    child.unref();
  } catch {
    // same — printing the URL is the guaranteed fallback, this is a bonus.
  }
}

function hasAnyProvider(): boolean {
  if (process.env.LAINOS_MODEL_PROVIDER?.trim()) return true;
  if (process.env.OPENROUTER_API_KEY?.trim()) return true;
  if (process.env.ANTHROPIC_API_KEY?.trim()) return true;
  if (resolveClaudeBin(process.env.LAINOS_CLAUDE_BIN)) return true;
  if (resolveCodexBin(process.env.LAINOS_CODEX_BIN)) return true;
  if (resolveOpenCodeBin(process.env.LAINOS_OPENCODE_BIN)) return true;
  return false;
}

/** Walk up from `from` to the nearest directory containing a package.json. */
function packageRoot(from: string): string {
  let dir = from;
  for (;;) {
    if (existsSync(resolve(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return from; // hit the filesystem root — give up, use the start point
    dir = parent;
  }
}

/**
 * Same candidate search as src/env.ts for reading. For *writing* (when no
 * .env exists anywhere yet — install.sh normally creates one first, so this
 * is the rare fallback), depth-guessing breaks between tsx (src/setup/) and
 * a build (dist/src/setup/), so it finds the package root instead, which is
 * correct either way.
 */
function envFilePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(".env"), resolve(here, "../../.env"), resolve(here, "../../../.env")];
  const existing = candidates.find(existsSync);
  return existing ?? resolve(packageRoot(here), ".env");
}

function persistKey(key: string): void {
  const path = envFilePath();
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const kept = existing
    .split("\n")
    .filter((line) => !/^(LAINOS_MODEL_PROVIDER|OPENROUTER_API_KEY|OPENROUTER_BASE_URL)=/.test(line));
  const next = [
    ...kept,
    "LAINOS_MODEL_PROVIDER=openrouter",
    `OPENROUTER_API_KEY=${key}`,
    `OPENROUTER_BASE_URL=${LAIN_OS_URL}/v1`,
    "",
  ].join("\n");
  writeFileSync(path, next);
}

export async function ensureLogin(): Promise<void> {
  if (hasAnyProvider()) return;
  if (!stdin.isTTY) return; // nothing to block on — let provider resolution fall to mock

  console.log();
  console.log("LainOS needs a Lain OS API key before it can do anything real — this is required.");
  console.log(`Opening ${LAIN_OS_URL}/register in your browser…`);
  console.log("(If nothing opens, visit that link yourself — free signup credits included.)");
  console.log();
  openUrl(`${LAIN_OS_URL}/register`);

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    for (;;) {
      const key = (await rl.question("Paste your Lain API key: ")).trim();
      if (key.startsWith("lain_") && key.length > 5) {
        process.env.LAINOS_MODEL_PROVIDER = "openrouter";
        process.env.OPENROUTER_API_KEY = key;
        process.env.OPENROUTER_BASE_URL ||= `${LAIN_OS_URL}/v1`;
        persistKey(key);
        console.log("Saved — continuing.\n");
        return;
      }
      if (key === "") {
        console.log("a key is required to continue.");
      } else {
        console.log('that does not look like a Lain API key (should start with "lain_"). Try again.');
      }
    }
  } finally {
    rl.close();
  }
}
