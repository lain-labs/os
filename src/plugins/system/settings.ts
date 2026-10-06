import { createHash } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { envFile } from "../../env.js";
import type { ChainService } from "../chain/service.js";
import type { Action, IAgentRuntime, State } from "../../types.js";

/**
 * set_setting writes KEY=value lines into the settings file this process
 * loaded (.env, or LAINOS_ENV_FILE for a daemon) and applies them at once.
 *
 * A secret (a bot token, an API key, a private key — anything whose name says
 * so) is asked about before it is written: the first call only names what
 * would change, and the write happens on a second call made after the
 * operator has answered (a later message than the one that asked). A plain
 * setting the operator asked for (an RPC URL, a chain id) is written on the
 * first call — the request was the confirmation, and a second round trip for
 * it only cost the operator a turn. Only the operator may do either: the local
 * terminal, or a Telegram user on TELEGRAM_ALLOWED_USERS. Values are never
 * echoed back.
 */

const KEY_RE = /^[A-Z][A-Z0-9_]*$/;
/** Names whose values are secrets: these wait for an explicit yes. */
const SECRET_RE = /(KEY|TOKEN|SECRET|MNEMONIC|SEED|COOKIE|PASSWORD|PASS|_PK$|PRIVATE)/;

/** Writes that were proposed and wait for the operator's yes, by key. */
const pending = new Map<string, { digest: string; askedIn: string }>();

const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 12);

export function isOperator(state: State, allowedUsers: string | undefined): boolean {
  const who = state.message.userId;
  if (who === "user") return true; // the TUI / CLI on this machine
  if (!who.startsWith("tg:")) return false;
  const allowed = (allowedUsers ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^@/, "").toLowerCase())
    .filter(Boolean);
  return allowed.includes(who.slice(3).toLowerCase());
}

/** dotenv reads an unquoted `#` or space as the end of the value. */
function encode(value: string): string | null {
  if (/[\r\n]/.test(value)) return null;
  if (!/[\s#"'`\\]/.test(value)) return value;
  if (value.includes("'")) return null;
  return `'${value}'`;
}

/** The file with KEY set to `line`: the first live KEY= line replaced, or one appended. */
export function isSecretKey(key: string): boolean {
  return SECRET_RE.test(key);
}

function withKey(text: string, key: string, line: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.trimStart().startsWith(`${key}=`));
  if (at >= 0) lines[at] = line;
  else {
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    lines.push(line, "");
  }
  return lines.join("\n");
}

/**
 * Write several settings into the loaded settings file and apply them to this
 * process. Shared by set_setting and the network switch. When a CHAIN_ key
 * changes, the chain service is rebuilt so every chain tool sees the new
 * network at once. Throws when there is no file or a value cannot be encoded.
 */
export async function writeSettings(
  runtime: IAgentRuntime,
  entries: Record<string, string>,
): Promise<{ file: string; chainReload?: string | null }> {
  if (!envFile) throw new Error("this process loaded no settings file, so there is nowhere to write");
  let text = await readFile(envFile, "utf8").catch(() => "");
  for (const [key, value] of Object.entries(entries)) {
    if (!KEY_RE.test(key)) throw new Error(`"${key}" is not a setting name (UPPER_SNAKE_CASE)`);
    const encoded = value === "" ? "" : encode(value);
    if (encoded === null) throw new Error(`${key}: the value has a line break or a single quote`);
    text = withKey(text, key, `${key}=${encoded}`);
  }
  await writeFile(envFile, text, { mode: 0o600 });
  await chmod(envFile, 0o600);
  for (const [key, value] of Object.entries(entries)) runtime.setSetting(key, value);
  let chainReload: string | null | undefined;
  if (Object.keys(entries).some((k) => k.startsWith("CHAIN_"))) {
    const chain = runtime.getService<ChainService>("chain");
    if (chain) chainReload = await chain.reload(runtime);
  }
  return { file: envFile, chainReload };
}

export const setSettingAction: Action = {
  name: "set_setting",
  similes: ["set_env", "write_env", "set_secret", "configure", "set_settings"],
  description:
    "Write settings (KEY=value) into this process's own settings file and apply them now — one key, or several at once via `values`. " +
    "Plain settings the operator asked for (RPC URLs, chain ids, names) are written on the first call. " +
    "Secrets (names with KEY/TOKEN/SECRET/PK/PASSWORD…) take two steps: the first call only proposes; ask the operator " +
    "\"write KEY into FILE?\"; after they say yes, call again with the same values and confirmed: true. " +
    "To move to another chain prefer switch_network. Operator only. Values are never echoed back.",
  parameters: {
    type: "object",
    properties: {
      key: { type: "string", description: "Setting name, UPPER_SNAKE_CASE (single-key form)." },
      value: { type: "string", description: "The value, exactly as the operator gave it (single-key form)." },
      values: {
        type: "object",
        description: "Several settings at once: { KEY: value, … }. Use instead of key/value.",
        additionalProperties: { type: "string" },
      },
      confirmed: {
        type: "boolean",
        description: "Secrets only: true on the second call, after the operator explicitly said yes to this write.",
      },
    },
  },
  examples: [{ user: "вот токен бота, впиши сам", agent: "Записать TELEGRAM_BOT_TOKEN в daemon.env?" }],
  async validate() {
    return true;
  },
  async handler(runtime, state, params) {
    const entries: Record<string, string> = {};
    if (params.values && typeof params.values === "object") {
      for (const [k, v] of Object.entries(params.values as Record<string, unknown>)) entries[k.trim()] = String(v ?? "").trim();
    }
    if (params.key) entries[String(params.key).trim()] = String(params.value ?? "").trim();
    const keys = Object.keys(entries);
    if (!keys.length) return { ok: false, text: "Nothing to write: give key/value or values." };
    for (const key of keys) {
      if (!KEY_RE.test(key)) return { ok: false, text: `"${key}" is not a setting name (UPPER_SNAKE_CASE).` };
      if (isSecretKey(key) && !entries[key]) return { ok: false, text: `Empty value for ${key}.` };
      if (encode(entries[key]) === null && entries[key] !== "") {
        return { ok: false, text: `${key}: the value has a line break or a single quote; it can't go into .env as is.` };
      }
    }
    if (!isOperator(state, runtime.getSetting("TELEGRAM_ALLOWED_USERS"))) {
      return { ok: false, text: "Only the operator can change settings." };
    }
    if (!envFile) return { ok: false, text: "This process loaded no settings file, so there is nowhere to write." };

    // Secrets wait for a yes given in a later message than the question.
    const secrets = keys.filter(isSecretKey);
    const d = digest(secrets.map((k) => `${k}=${entries[k]}`).join("\n"));
    const askKey = secrets.join(",");
    const ask = secrets.length ? pending.get(askKey) : undefined;
    if (secrets.length && (!params.confirmed || !ask || ask.digest !== d || ask.askedIn === state.message.id)) {
      if (!ask || ask.digest !== d) pending.set(askKey, { digest: d, askedIn: state.message.id });
      const had = secrets.filter((k) => Boolean(runtime.getSetting(k)));
      return {
        ok: false,
        text:
          `Not written yet: ${secrets.join(", ")} ${secrets.length > 1 ? "are secrets" : "is a secret"} and need${secrets.length > 1 ? "" : "s"} the operator's yes. ` +
          `Ask them, in their language: "${had.length ? "replace" : "write"} ${secrets.join(", ")} in ${envFile}?" — and stop this turn. ` +
          `When they answer yes, call set_setting again with the same values and confirmed: true.`,
        data: { keys, file: envFile, replaces: had, confirmationRequired: true },
      };
    }
    if (secrets.length) pending.delete(askKey);

    let written;
    try {
      written = await writeSettings(runtime, entries);
    } catch (err) {
      return { ok: false, text: `Could not write ${envFile}: ${(err as Error).message}` };
    }
    const chainNote =
      written.chainReload === undefined
        ? ""
        : written.chainReload === null
          ? " The chain tools were reloaded onto the new network."
          : ` The chain tools are still not configured: ${written.chainReload}`;
    return {
      ok: true,
      text:
        `${keys.join(", ")} written to ${written.file} (mode 600) and applied to this process.${chainNote} ` +
        `A service started at boot elsewhere (the daemon's Telegram bot) picks it up on its restart.`,
      data: { keys, file: written.file },
    };
  },
};
