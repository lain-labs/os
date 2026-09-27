import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "./logger.js";

const log = createLogger("soul");

/**
 * Load the agent's soul — a markdown constitution prepended verbatim to the
 * system prompt. Resolution order: LAINOS_SOUL_PATH, ./soul.md in the working
 * directory, then soul.md at the package root (reachable from both src/ under
 * tsx and dist/src/ after a build). Missing or empty files yield undefined,
 * which leaves the prompt exactly as before.
 */
export function loadSoul(
  getSetting: (key: string) => string | undefined,
): string | undefined {
  const explicit = getSetting("LAINOS_SOUL_PATH");
  if (explicit && !existsSync(explicit)) {
    log.warn(`LAINOS_SOUL_PATH set but no file at ${explicit}`);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    explicit,
    resolve("soul.md"),
    resolve(here, "../soul.md"),
    resolve(here, "../../soul.md"),
  ].filter((p): p is string => Boolean(p));

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8").trim();
    if (!text) continue;
    log.info(`soul loaded from ${path}`);
    return text;
  }
  return undefined;
}
