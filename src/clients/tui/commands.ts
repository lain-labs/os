/**
 * The slash commands, as one table.
 *
 * A command used to exist in three places that had to agree by hand — the
 * autocomplete menu, the `/help` text and a `switch` — and they drifted:
 * `/theme` worked but was documented nowhere. Here a command is one record
 * that carries its own menu line, its own help line and its own body, so the
 * menu and the help are *derived* and cannot fall behind.
 *
 * Bodies talk to the app only through `CommandCtx`, which is why this module
 * imports no React and can be read top to bottom.
 */
import { GLYPH } from "./theme.js";
import { turnText, type Turn } from "./layout.js";
import type { IAgentRuntime } from "../../types.js";
import type { ChainService } from "../../plugins/chain/index.js";
import type { ForgeService } from "../../plugins/forge/index.js";
import type { ScoutService } from "../../plugins/scout/index.js";
import type { SentinelService } from "../../plugins/sentinel/index.js";

/** Everything a command body may reach. Nothing else is in scope. */
export type CommandCtx = {
  /** The first word after the command name, exactly as typed. */
  arg?: string;
  /** Every word after the command name — `/tasks digest openrouter:…`. */
  args: string[];
  runtime: IAgentRuntime;
  history: Turn[];
  provider: string;
  model: string;
  switchable: boolean;
  /** Print a system turn into the transcript. */
  say: (text: string) => void;
  copyOut: (text: string, what: string) => void;
  lastReply: () => string;
  clear: () => void;
  freeze: () => void;
  togglePulse: () => void;
  openPicker: (which: "skin" | "effort" | "cursor" | "model") => void;
  switchProvider: (name: string) => void;
  /** Close the current session and open a fresh one (the old one is kept). */
  newSession: () => void;
  /** Reopen a past session — no ref opens the picker. */
  resumeSession: (ref?: string) => void;
  /** Summarise a session (this one, unless a ref is given). */
  recapSession: (ref?: string) => void;
  /** Print the recent sessions, newest first. */
  listSessions: () => void;
  /** Print the task routing table, or point one kind of work elsewhere. */
  taskRoutes: (task?: string, route?: string) => void;
  exit: () => void;
};

export type Command = {
  /** With the slash, as it is typed. */
  name: string;
  /** One line in the autocomplete menu. */
  desc: string;
  /** One line in `/help`, when it needs to say more than `desc`. */
  help?: string;
  /** Extra spellings that dispatch here but stay out of the menu. */
  aliases?: string[];
  run: (ctx: CommandCtx) => void;
};

/** Bucket a skill (action) name into a stylish category. */
export function skillCategory(name: string): "wallet" | "tx" | "memory" | "system" | "chain" {
  if (/balance|overview|token/.test(name)) return "wallet";
  if (/send|transfer/.test(name)) return "tx";
  if (/remember|recall|memor/.test(name)) return "memory";
  if (/shell|exec|file|dir|^ls$|read|write|list/.test(name)) return "system";
  if (/tx/.test(name)) return "tx";
  return "chain";
}
const SKILL_ORDER = ["chain", "wallet", "tx", "memory", "system"] as const;

/** Render the registered skills grouped by category, with descriptions. */
export function skillsList(actions: readonly { name: string; description: string }[]): string {
  if (!actions.length) return "no chain skills are registered.";
  const groups: Record<string, { name: string; description: string }[]> = {};
  for (const a of actions) (groups[skillCategory(a.name)] ??= []).push(a);
  const pad = Math.min(22, Math.max(...actions.map((a) => a.name.length)));
  const lines: string[] = [`skills · ${actions.length} chain abilities`, ""];
  for (const cat of SKILL_ORDER) {
    const items = groups[cat];
    if (!items) continue;
    lines.push(cat);
    for (const a of items) lines.push(`  ${a.name.padEnd(pad)}  ${a.description}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export const COMMANDS: readonly Command[] = [
  {
    name: "/help",
    desc: "show commands",
    help: "this list",
    run: (ctx) => ctx.say(helpText()),
  },
  {
    name: "/skills",
    desc: "list chain skills",
    help: "list the chain skills Lain can use",
    run: (ctx) => ctx.say(skillsList(ctx.runtime.actions)),
  },
  {
    name: "/facts",
    desc: "durable facts lain remembers",
    help: "durable facts Lain has learned",
    run: (ctx) => {
      void ctx.runtime.memory.facts(30).then((facts) => {
        ctx.say(
          facts.length
            ? `durable facts (${facts.length}):\n${facts.map((f) => `  · ${f}`).join("\n")}`
            : "no durable facts yet — say “remember that …” to teach me.",
        );
      });
    },
  },
  {
    name: "/watches",
    desc: "active background watches",
    help: "active background balance watches",
    run: (ctx) => {
      const sentinel = ctx.runtime.getService<SentinelService>("sentinel");
      const chain = ctx.runtime.getService<ChainService>("chain");
      const nativeSymbol = chain?.nativeSymbol ?? "native";
      const watches = sentinel?.listWatches() ?? [];
      ctx.say(
        watches.length
          ? `active watches (${watches.length}):\n${watches
              .map(
                (w) =>
                  `  ${w.id}  ${w.token ? w.token.toUpperCase() : nativeSymbol} of ${w.address}` +
                  `  ${w.kind === "change" ? "on change" : `${w.kind} ${w.threshold}`}` +
                  `${w.note ? `  — ${w.note}` : ""}${w.lastValue !== undefined ? `  (last ${w.lastValue})` : ""}`,
              )
              .join("\n")}`
          : `no background watches. ask lain: “watch 0x… and warn me below 5 ${nativeSymbol}”.`,
      );
    },
  },
  {
    name: "/wishes",
    desc: "the forge wishboard",
    help: "the forge wishboard (holder requests → branches)",
    run: (ctx) => {
      const forge = ctx.runtime.getService<ForgeService>("forge");
      const wishes = forge?.listWishes() ?? [];
      const fprovider = forge?.forgeProvider();
      const providerLine = fprovider
        ? `forge provider: ${fprovider.selected} (${fprovider.available ? "ready" : "unavailable"})\n`
        : "";
      ctx.say(
        wishes.length
          ? `${providerLine}wishboard (${wishes.length}):\n${wishes
              .map((w) => `  ${w.id} [${w.status}] ${w.title} — ${w.reporter}${w.branch ? `, ${w.branch}` : ""}`)
              .join("\n")}`
          : `${providerLine}the wishboard is empty — tell lain what you wish for.`,
      );
    },
  },
  {
    name: "/research",
    desc: "scout research topics",
    help: "topics the scout researches (digests on schedule)",
    run: (ctx) => {
      const scout = ctx.runtime.getService<ScoutService>("scout");
      const topics = scout?.listTopics() ?? [];
      ctx.say(
        topics.length
          ? `research topics (${topics.length}):\n${topics
              .map(
                (t) =>
                  `  ${t.id} "${t.query}" every ${Math.round(t.intervalMs / 3_600_000)}h` +
                  `${t.note ? ` — ${t.note}` : ""}`,
              )
              .join("\n")}`
          : "no research topics — try: “watch Solana and only tell me what matters”.",
      );
    },
  },
  {
    name: "/pulse",
    desc: "toggle whale transfer notices",
    run: (ctx) => ctx.togglePulse(),
  },
  {
    name: "/skin",
    desc: "pick a colour skin (arrows)",
    help: "pick a colour skin with the arrow keys",
    aliases: ["/theme"],
    run: (ctx) => ctx.openPicker("skin"),
  },
  {
    name: "/effort",
    desc: "set reply depth (arrows)",
    help: "set reply depth (low … max) with the arrow keys",
    run: (ctx) => ctx.openPicker("effort"),
  },
  {
    name: "/cursor",
    desc: "cursor style + blink (arrows)",
    help: "cursor style — block/line, blink/steady",
    run: (ctx) => ctx.openPicker("cursor"),
  },
  {
    name: "/new",
    desc: "start a fresh session",
    help: "start a fresh session — the old one is saved, /resume brings it back",
    aliases: ["/clear", "/reset"],
    run: (ctx) => ctx.newSession(),
  },
  {
    name: "/resume",
    desc: "reopen a past session (arrows)",
    help: "reopen a past session — /resume, or /resume <id|n>",
    run: (ctx) => ctx.resumeSession(ctx.arg),
  },
  {
    name: "/recap",
    desc: "summarise this session",
    help: "summarise this session — or /recap <id|n> for an older one",
    run: (ctx) => ctx.recapSession(ctx.arg),
  },
  {
    name: "/sessions",
    desc: "past sessions, newest first",
    help: "past sessions, newest first (the number is what /resume takes)",
    run: (ctx) => ctx.listSessions(),
  },
  {
    name: "/tasks",
    desc: "who answers which kind of work",
    help: "the task routing table — /tasks <kind> <provider[:model]> to change one",
    run: (ctx) => ctx.taskRoutes(ctx.args[0], ctx.args.slice(1).join(" ") || undefined),
  },
  {
    name: "/wipe",
    desc: "clear the screen (session intact)",
    help: "clear the screen — the session and its memory stay",
    run: (ctx) => ctx.clear(),
  },
  {
    name: "/copy",
    desc: "copy the last reply — /copy all | code",
    help: "copy lain's last reply — /copy all (transcript), /copy code",
    run: (ctx) => {
      const what = ctx.arg?.toLowerCase();
      if (what === "all") {
        const whole = ctx.history
          .map((t) => ({ role: t.role, body: turnText(t) }))
          .filter((t) => t.body)
          .map((t) => `${t.role}: ${t.body}`)
          .join("\n\n");
        ctx.copyOut(whole, "the whole transcript");
      } else if (what === "code") {
        // The last fenced block of the most recent reply that has one.
        let fenced = "";
        for (const t of [...ctx.history].reverse()) {
          if (t.role !== "lain") continue;
          const blocks = [...turnText(t).matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]);
          if (blocks.length) {
            fenced = blocks[blocks.length - 1];
            break;
          }
        }
        ctx.copyOut(fenced, "the last code block");
      } else {
        ctx.copyOut(ctx.lastReply(), "lain's last reply");
      }
    },
  },
  {
    name: "/select",
    desc: "freeze the frame to select text (ctrl+s)",
    help: "freeze the frame so the mouse can select text (ctrl+s)",
    run: (ctx) => ctx.freeze(),
  },
  {
    name: "/model",
    desc: "switch claude/codex/opencode (arrows)",
    help: "switch the chat model (arrows) — or /model claude|codex|opencode",
    run: (ctx) => {
      // "/model" opens the picker; "/model codex" switches straight away.
      if (ctx.arg) ctx.switchProvider(ctx.arg);
      else if (ctx.switchable) ctx.openPicker("model");
      else ctx.say(`provider ${ctx.provider} ${GLYPH.dot} model ${ctx.model}`);
    },
  },
  {
    name: "/exit",
    desc: "leave the wired (or ctrl+c twice)",
    help: "leave the wired — or press ctrl+c twice",
    aliases: ["/quit"],
    run: (ctx) => ctx.exit(),
  },
];

/** Every spelling that dispatches, without its slash. */
const BY_NAME = new Map<string, Command>();
for (const c of COMMANDS) for (const n of [c.name, ...(c.aliases ?? [])]) BY_NAME.set(n.slice(1), c);

/** What the autocomplete menu draws — names and one-line descriptions. */
export const COMMAND_MENU: readonly { name: string; desc: string }[] = COMMANDS.map((c) => ({
  name: c.name,
  desc: c.desc,
}));

/** Menu entries whose name starts with what has been typed so far. */
export function suggestionsFor(value: string): readonly { name: string; desc: string }[] {
  if (!value.startsWith("/") || value.includes(" ")) return [];
  return COMMAND_MENU.filter((c) => c.name.startsWith(value.toLowerCase()));
}

/** The prose parts of `/help` — everything that is not one command. */
const HELP_TAIL = [
  "",
  "writing several lines:",
  "  alt+enter      new line — works in every terminal, including this one",
  "  ctrl+j         the same thing, for terminals that eat alt",
  "  shift+enter    the same thing where the terminal can say it (kitty protocol)",
  "  \\ then enter   a trailing backslash turns Enter into a line break",
  "  paste          pasted text keeps its line breaks and never sends by itself",
  "",
  "copying text out:",
  "  drag           select any part of the screen with the mouse — releasing",
  "                 copies it. The terminal cannot do this while the app reads",
  "                 the mouse, so the app does it.",
  "  ctrl+y         copy lain's last reply",
  "  click a name   copy that whole message · click a code block, copy the code",
  "  ctrl+s         freeze the frame and hand the mouse back to the terminal,",
  "                 for selecting into the terminal's own scrollback",
  "",
  "editing: ← → move · home/end (or ctrl+a/ctrl+e) · ctrl+←/→ word",
  "         ⌫ delete back · del delete forward · alt+b/alt+f word",
  "         ctrl+w / alt+⌫ del word · alt+d del word fwd · ctrl+u/ctrl+k kill line",
  "         ↑ ↓ walk the composer's lines, then recall history (kept between runs)",
  "",
  "scrollback: the transcript scrolls inside the app — PgUp/PgDn page,",
  "            ctrl+↑/↓ one line, or just roll the mouse wheel.",
  "            click a ⚙ tool row to expand/collapse it.",
];

/** `/help`, built from the table so a new command documents itself. */
export function helpText(): string {
  const rows = COMMANDS.map((c) => {
    const label = [c.name, ...(c.aliases ?? [])].join(" ");
    return `  ${label.padEnd(15)}${c.help ?? c.desc}`;
  });
  return ["commands:", ...rows, ...HELP_TAIL].join("\n");
}

/** Dispatch a typed line. Unknown names answer in the transcript. */
export function runCommand(text: string, ctx: Omit<CommandCtx, "arg" | "args">): void {
  const words = text.trim().split(/\s+/);
  const name = words[0].slice(1).toLowerCase();
  const cmd = BY_NAME.get(name);
  if (!cmd) {
    ctx.say(`unknown command: /${name}  (try /help)`);
    return;
  }
  const args = words.slice(1);
  cmd.run({ ...ctx, arg: args[0], args });
}
