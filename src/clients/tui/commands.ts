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
import { CODER_EFFORTS, formatForgeJob, formatForgeJobs, type ForgeService } from "../../plugins/forge/index.js";
import { describeSnapshot, type MetaMaskService } from "../../plugins/metamask/index.js";
import type { ScoutService } from "../../plugins/scout/index.js";
import { describeWatch, type SentinelService } from "../../plugins/sentinel/index.js";
import { openUrl } from "../../setup/login-gate.js";
import { CHAT_PROVIDER_CHOICES } from "../../models/routing.js";
import { TASK_ORDER, TASKS } from "../../models/tasks.js";
import { PAPER_COINS } from "../../plugins/chain/paper.js";
import {
  BUILTIN_NETWORKS,
  currentProfile,
  describeNetworks,
  listNetworks,
  saveNetwork,
  slug,
  switchNetwork,
} from "../../plugins/chain/networks.js";
import { writeSettings } from "../../plugins/system/settings.js";
import { digestCommand } from "../../plugins/digest/index.js";
import { paperCommand } from "../../plugins/chain/actions/paper.js";
import { trenchCommand } from "../../plugins/trench/index.js";
import { deskCommand } from "../../plugins/stocks/index.js";
import { backtestCommand } from "../../plugins/backtest/index.js";
import { describeSkills } from "../../plugins/skills/index.js";
import { formatListings, registryIo, searchSkillsSh, shelfFor } from "../../plugins/skills/registry.js";

/** Where /login points — same host install.sh offers a free API key from. */
const LAIN_OS_URL = "https://lain-os.com";

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
  /** Print Markdown as one of lain's own replies (rendered, copyable). */
  reply: (markdown: string) => void;
  copyOut: (text: string, what: string) => void;
  lastReply: () => string;
  clear: () => void;
  freeze: () => void;
  /** Switch between the scrollback view and the full-screen one. */
  setView: (view?: string) => void;
  togglePulse: () => void;
  openPicker: (which: "skin" | "effort" | "cursor" | "agent") => void;
  /** Open a live board (trench, stocks) in place of the transcript, or close it (null). */
  openBoard: (kind: "trench" | "stocks" | null) => void;
  /** /model: the current agent's models (searchable), or straight to the one `query` names. */
  switchModel: (query?: string) => void;
  /** A one-off arrow-key list; `onPick` gets the chosen value. */
  choose: (
    title: string,
    options: { value: string; label: string; hint?: string }[],
    onPick: (value: string) => void,
    index?: number,
  ) => void;
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
  /**
   * Its arguments are a secret (a token): masked in the composer as they are typed, kept out of
   * the input history, and handled here — never sent to the model.
   */
  secret?: boolean;
  /**
   * What the next word can be, given the words already typed after the name — what Tab
   * completes. Free text (an amount, a model id) has no entry; nothing is offered there.
   */
  complete?: (done: string[], runtime?: IAgentRuntime) => readonly Choice[];
  run: (ctx: CommandCtx) => void;
};

/** One entry of the completion menu: the word it puts in, and a line about it. */
export type Choice = { name: string; desc: string };

const choices = (rows: Record<string, string>): Choice[] => Object.entries(rows).map(([name, desc]) => ({ name, desc }));

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

/** `/paper` word by word: the verb, then what that verb takes. */
function paperChoices(done: string[], runtime?: IAgentRuntime): readonly Choice[] {
  const [verb, ...rest] = done.map((w) => w.toLowerCase());
  const chain = runtime?.getService<ChainService>("chain");
  const wallets = (asWord: boolean) =>
    (chain?.paper?.wallets() ?? []).map((w) => ({
      name: w.name,
      desc: `${asWord ? "wallet · " : ""}${w.lain ? "Lain trades it" : "yours alone"}${w.note ? ` · ${w.note}` : ""}`,
    }));
  if (!verb) {
    return [
      ...choices({
        status: "your current wallet",
        wallets: "every wallet, side by side",
        new: "<name> [start] [lain] [note…] — open a wallet",
        use: "<wallet> — switch your current wallet",
        lain: "<wallet> on|off — let Lain trade it, or not",
        drop: "<wallet> — take a wallet off the desk",
        on: "paper mode on — Lain's trades simulate",
        off: "paper mode off — Lain's trades are real",
        reset: "start the current wallet over [start]",
        buy: "<token> <native amount>",
        sell: "<token> <amount|all>",
        set: "<coin> <amount> — exactly that much",
        add: "<coin> <amount> — on top",
        swap: "<amount|all> <coin> <coin> — at the spot price",
      }),
      ...wallets(true),
    ];
  }
  if (verb === "use" || verb === "drop") return rest.length ? [] : wallets(false);
  if (verb === "lain") return !rest.length ? wallets(false) : rest.length === 1 ? choices({ on: "Lain trades it", off: "yours alone" }) : [];
  const native = chain?.configured ? chain.nativeSymbol.toUpperCase() : "ETH";
  const coins = (except: string[]) =>
    [...new Set([native, ...Object.keys(PAPER_COINS)])]
      .filter((c) => !except.includes(c.toLowerCase()))
      .map((c) => ({ name: c, desc: c === native ? "the paper cash" : "coin" }));
  if (verb === "set" || verb === "add") return rest.length ? [] : coins([]);
  if (verb === "swap") {
    if (!rest.length) return choices({ all: "the whole balance of the coin" });
    return rest.length === 1 ? coins([]) : rest.length === 2 ? coins([rest[1]]) : [];
  }
  if (verb === "buy" || verb === "sell") {
    if (!rest.length) return Object.keys(chain?.tokens ?? {}).map((t) => ({ name: t, desc: "token" }));
    return verb === "sell" && rest.length === 1 ? choices({ all: "the whole position" }) : [];
  }
  return [];
}

export const COMMANDS: readonly Command[] = [
  {
    name: "/help",
    desc: "show commands",
    help: "this list",
    run: (ctx) => ctx.say(helpText()),
  },
  {
    name: "/login",
    desc: "get/manage your Lain OS API key",
    help: "open the Lain OS dashboard to sign in and grab an API key",
    run: (ctx) => {
      openUrl(`${LAIN_OS_URL}/login`);
      ctx.say(`opening your browser to:\n  ${LAIN_OS_URL}/login`);
    },
  },
  {
    name: "/skills",
    desc: "her own tools, routines, skills.sh — /skills find <query>",
    help: "the tools Lain wrote for herself, her routines and installed Agent Skills — /skills find <query> searches skills.sh (pick one to install), /skills all lists every built-in tool",
    complete: (done) => (done.length ? [] : choices({ find: "search skills.sh — /skills find <query>", all: "every built-in tool" })),
    run: (ctx) => {
      const sub = ctx.args[0]?.toLowerCase();
      if (sub === "all") return ctx.say(skillsList(ctx.runtime.actions));
      if (sub === "find" || sub === "search") {
        const query = ctx.args.slice(1).join(" ").trim();
        if (!query) return ctx.say("usage: /skills find <query> — e.g. /skills find solidity audit");
        ctx.say(`searching skills.sh for “${query}”…`);
        void searchSkillsSh(query, { limit: 10 }, registryIo.fetch).then(
          (found) => {
            ctx.say(formatListings(query, found));
            if (!found.length) return;
            ctx.choose(
              "install one onto lain's shelf? (esc — no)",
              found.map((s) => ({ value: s.id, label: s.name, hint: `  ${s.source} · ${s.installs.toLocaleString("en-US")} installs` })),
              (id) =>
                void shelfFor(ctx.runtime)
                  .install(id, registryIo.fetch, found.find((s) => s.id === id))
                  .then(
                    (skill) => ctx.say(`installed ${skill.name} — ${skill.description || "no description"}\nlain opens it with use_agent_skill when a task fits.`),
                    (err: Error) => ctx.say(`not installed: ${err.message}`),
                  ),
            );
          },
          (err: Error) => ctx.say(`skills.sh search failed: ${err.message}`),
        );
        return;
      }
      void describeSkills(ctx.runtime).then(
        (text) => ctx.say(`${text}\n\n/skills find <query> — search skills.sh · /skills all — every built-in tool`),
        (err: Error) => ctx.say(`skills: ${err.message}`),
      );
    },
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
    help: "active background watches (balances, wallets, wallet groups)",
    run: (ctx) => {
      const sentinel = ctx.runtime.getService<SentinelService>("sentinel");
      const chain = ctx.runtime.getService<ChainService>("chain");
      const nativeSymbol = chain?.nativeSymbol ?? "native";
      const watches = sentinel?.listWatches() ?? [];
      ctx.say(
        watches.length
          ? `active watches (${watches.length}):\n${watches
              .map((w) => `  ${describeWatch(w, nativeSymbol)}`)
              .join("\n")}`
          : `no background watches. ask lain: “watch 0x… and warn me below 5 ${nativeSymbol}”.`,
      );
    },
  },
  {
    name: "/metamask",
    desc: "link your MetaMask Agent Wallet — /metamask <CLI token>",
    help: "the MetaMask Agent Wallet: /metamask shows it, /metamask <CLI token> links it (masked, never sent to the model), /metamask logout unlinks",
    secret: true,
    run: (ctx) => {
      const svc = ctx.runtime.getService<MetaMaskService>("metamask");
      if (!svc) return ctx.say("the metamask plugin is not loaded.");
      const arg = ctx.args.join(" ").trim();
      const report = (p: Promise<string>) => void p.then(ctx.say, (err: Error) => ctx.say(`metamask: ${err.message}`));
      if (!arg) {
        return report(svc.refresh().then((snap) => describeSnapshot(snap, "get a CLI token at developer.metamask.io/agentic/login, then /metamask <token>")));
      }
      if (arg === "logout") return report(svc.logout());
      ctx.say("linking your MetaMask Agent Wallet…");
      report(svc.connect(arg));
    },
  },
  {
    name: "/paper",
    desc: "paper wallets — /paper wallets|new|use|buy|sell|swap",
    help: "paper trading in named wallets, each its own cash, positions and coins: /paper shows your current wallet, /paper <wallet> another, /paper wallets lists them, /paper new <name> [start] [lain] [note…] opens one (yours alone unless lain), /paper use <wallet> switches, /paper lain <wallet> on|off lets Lain trade it or not, /paper drop <wallet>; in the current wallet: /paper buy <token> <amount> · /paper sell <token> <amount|all>, /paper set|add <coin> <amount>, /paper swap <amount|all> <coin> <coin>, /paper reset [start]; /paper on|off switches paper mode for Lain's trading",
    complete: paperChoices,
    run: (ctx) => {
      if (!ctx.runtime.getService("chain")) return ctx.say("the chain plugin is not loaded.");
      const verb = ctx.args[0]?.toLowerCase();
      if (verb === "buy" || verb === "sell") ctx.say(`paper ${verb}: quoting the live pool…`);
      void paperCommand(ctx.runtime, ctx.args).then(ctx.say, (err: Error) => ctx.say(`paper: ${err.message}`));
    },
  },
  {
    name: "/trench",
    desc: "live paper memecoin trenching — /trench on|off|status",
    help: "paper trenching of PONS memecoins on Robinhood Chain: /trench opens the live board (esc closes), /trench on · off, /trench status (as text), /trench close <symbol|all>, /trench set <rule> <value>, /trench rules",
    complete: (done) =>
      !done.length
        ? choices({ on: "start trenching", off: "stop", status: "as text", close: "<symbol|all>", set: "<rule> <value>", rules: "the rules now" })
        : done.length === 1 && done[0].toLowerCase() === "close"
          ? choices({ all: "every position" })
          : [],
    run: (ctx) => {
      if (!ctx.runtime.getService("trench")) return ctx.say("the trench plugin is not loaded.");
      const sub = ctx.args[0]?.toLowerCase();
      // The board is the way to watch; everything else answers in the transcript.
      if (!sub || sub === "watch" || sub === "board") return ctx.openBoard("trench");
      ctx.openBoard(sub === "on" ? "trench" : null);
      void trenchCommand(ctx.runtime, ctx.args).then(ctx.say, (err: Error) => ctx.say(`trench: ${err.message}`));
    },
  },
  {
    name: "/stocks",
    desc: "paper stock desk — Robinhood tokens, BTC, ETH, live board",
    help: "paper trading of Robinhood's tokenized stocks, BTC and ETH: /stocks opens the live board (esc closes), /stocks buy <sym> <$> · sell <sym> [all|$] · close <sym|all>, /stocks on · off (strategies), /stocks set <rule> <v>, /stocks rules, /stocks reset [$], /stocks status",
    complete: (done) =>
      done.length
        ? []
        : choices({
            buy: "<sym> <$>",
            sell: "<sym> [all|$]",
            close: "<sym|all>",
            on: "strategies on",
            off: "strategies off",
            set: "<rule> <value>",
            rules: "the rules now",
            reset: "start over [$]",
            status: "as text",
          }),
    aliases: ["/desk"],
    run: (ctx) => {
      if (!ctx.runtime.getService("stocks")) return ctx.say("the stocks plugin is not loaded.");
      const sub = ctx.args[0]?.toLowerCase();
      if (!sub || sub === "watch" || sub === "board") return ctx.openBoard("stocks");
      // Orders and the switch keep the board up — their fills show on it; the rest answer in text.
      ctx.openBoard(["buy", "sell", "close", "on", "off"].includes(sub) ? "stocks" : null);
      void deskCommand(ctx.runtime, ctx.args).then(ctx.say, (err: Error) => ctx.say(`stocks: ${err.message}`));
    },
  },
  {
    name: "/backtest",
    desc: "test strategies on years of history — /backtest btc 10y",
    help: "strategy backtests on years of history — on-chain Uniswap swaps on Ethereum (dex, the default for BTC/ETH) or Binance + Bitstamp (cex, ten years): /backtest [pair|0xpool] [5y|from [to]] [interval] [dex|cex] [preset…] [fee=] [slip=] [holdout=], /backtest presets — or ask Lain to write strategies and test them; live on paper: /backtest live <preset> [btc|eth] [interval] [$1000], /backtest live (status), /backtest stop <id|all>",
    complete: (done) =>
      done.length
        ? []
        : choices({ btc: "BTC history", eth: "ETH history", presets: "the strategies", live: "run one live on paper", stop: "<id|all>" }),
    aliases: ["/bt"],
    run: (ctx) => {
      if (!ctx.args.length || ["help", "presets", "rules", "live", "stop"].includes(ctx.args[0]!.toLowerCase())) {
        void backtestCommand(ctx.runtime, ctx.args.length ? ctx.args : ["help"]).then(ctx.say, (err: Error) => ctx.say(`backtest: ${err.message}`));
        return;
      }
      ctx.say("backtest: reading the history (the first run of a pool or pair downloads it; later ones read the cache)…");
      void backtestCommand(ctx.runtime, ctx.args, (p) => ctx.say(`backtest: ${p}`)).then(ctx.say, (err: Error) => ctx.say(`backtest: ${err.message}`));
    },
  },
  {
    name: "/network",
    desc: "which chain lain is on — switch (arrows)",
    help: "the active chain and the known ones — /network <name> switches, /network save <name> keeps the current one",
    complete: (done) =>
      done.length
        ? []
        : [
            ...BUILTIN_NETWORKS.map((n) => ({ name: n.name, desc: `${n.title} · id ${n.chainId}` })),
            { name: "save", desc: "keep the current chain — /network save <name>" },
          ],
    aliases: ["/chain", "/networks"],
    run: (ctx) => {
      const sub = ctx.args[0]?.toLowerCase();
      const report = (p: Promise<string>) => void p.then(ctx.say, (err: Error) => ctx.say(`network: ${err.message}`));
      const go = (name: string) =>
        report(switchNetwork(ctx.runtime, name, writeSettings).then((r) => r.text));
      if (sub === "save") {
        const name = slug(ctx.args.slice(1).join(" "));
        const current = currentProfile(ctx.runtime);
        if (!name) return ctx.say("usage: /network save <name>");
        if (!current) return ctx.say("no chain is configured — nothing to save.");
        return report(saveNetwork(ctx.runtime, { ...current, name }).then(() => `saved ${current.title} as "${name}".`));
      }
      if (ctx.args.length) return go(ctx.args.join(" "));
      void (async () => {
        ctx.say(await describeNetworks(ctx.runtime));
        const all = await listNetworks(ctx.runtime);
        const now = currentProfile(ctx.runtime);
        ctx.choose(
          "switch network",
          all.map((n) => ({ value: n.name, label: n.name, hint: `  ${n.title} · id ${n.chainId}` })),
          (v) => go(v),
          Math.max(0, all.findIndex((n) => n.chainId === now?.chainId && n.rpcUrl === now?.rpcUrl)),
        );
      })();
    },
  },
  {
    name: "/digest",
    desc: "portfolio digest now — /digest at 09:00 | off",
    help: "the portfolio digest: market moves, on-chain moves and news for every token — /digest at HH:MM schedules it, /digest off stops it",
    complete: (done) => (done.length ? [] : choices({ at: "schedule it — /digest at 09:00", off: "stop the schedule" })),
    aliases: ["/brief"],
    run: (ctx) => {
      if (!ctx.runtime.getService("digest")) return ctx.say("the digest plugin is not loaded.");
      const schedule = ctx.args.length > 0;
      if (!schedule) ctx.say("collecting the digest — a couple of minutes…");
      void digestCommand(ctx.runtime, ctx.args).then(
        (text) => (schedule ? ctx.say(text) : ctx.reply(text)),
        (err: Error) => ctx.say(`digest failed: ${err.message}`),
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
        ? `forge coder: ${forge!.coderLabel()} (${fprovider.available ? "ready" : "unavailable"}) · /coder changes it · /jobs shows the jobs\n`
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
    name: "/coder",
    desc: "who codes the forge's jobs — /coder codex gpt-6.1-sol low",
    help: "the forge's coding agent: /coder picks it (arrows), /coder <claude|codex|opencode> [model] [effort] sets it — e.g. /coder codex gpt-6.1-sol low; /coder codex default clears model and effort",
    complete: (done, runtime) => {
      const forge = runtime?.getService<ForgeService>("forge");
      if (!done.length) {
        const installed = forge?.forgeProvider().installed ?? ["claude", "codex", "opencode"];
        return installed.map((kind) => ({ name: kind, desc: forge ? forge.coderLabel(kind) : "coding agent" }));
      }
      // After the agent: an effort, or "default"; a model id is free text and may come first.
      const efforts = (CODER_EFFORTS as readonly string[]).filter((e) => !done.slice(1).includes(e));
      return [...efforts.map((e) => ({ name: e, desc: "reasoning effort" })), ...(done.length === 1 ? [{ name: "default", desc: "clear model and effort" }] : [])];
    },
    run: (ctx) => {
      const forge = ctx.runtime.getService<ForgeService>("forge");
      if (!forge) return ctx.say("the forge plugin is not loaded.");
      const apply = (agent: string, choice: { model?: string | null; effort?: string | null } = {}) =>
        void forge.setProvider(agent, choice).then(
          (r) =>
            ctx.say(
              typeof r === "string"
                ? `coder: ${r}`
                : `coder: ${forge.coderLabel(r.provider)} — new forge jobs run on it (saved).` +
                    (forge.forgeProvider().spent.some((l) => l.startsWith(`${r.provider} `)) ? `\n${r.provider} is out of quota right now — the forge hands its jobs to the next agent until then.` : ""),
            ),
          (err: Error) => ctx.say(`coder: ${err.message}`),
        );
      if (!ctx.args.length) {
        const p = forge.forgeProvider();
        if (!p.installed.length) return ctx.say("no coding agent is installed (claude, codex or opencode).");
        return ctx.choose(
          `coder — now ${forge.coderLabel()}`,
          p.installed.map((kind) => {
            const spent = p.spent.find((l) => l.startsWith(`${kind} `));
            return { value: kind, label: kind, hint: `  ${forge.coderLabel(kind)}${spent ? ` · ${spent.replace(/ \(.*$/, "").replace(`${kind} `, "")}` : ""}` };
          }),
          (agent) => apply(agent),
          Math.max(0, p.installed.indexOf(p.selected as never)),
        );
      }
      // "/coder codex gpt-6.1-sol low", "/coder codex/gpt-6.1-sol low", "/coder codex default".
      const [first, ...rest] = ctx.args;
      const [agent, inline] = first.split("/", 2);
      const choice: { model?: string | null; effort?: string | null } = inline ? { model: inline } : {};
      for (const word of rest) {
        const w = word.toLowerCase();
        if (w === "default") {
          choice.model = null;
          choice.effort = null;
        } else if ((CODER_EFFORTS as readonly string[]).includes(w)) choice.effort = w;
        else choice.model = word;
      }
      apply(agent, choice);
    },
  },
  {
    name: "/jobs",
    desc: "the forge's jobs — now, queue, how each ended",
    help: "the forge at a glance: who codes, what is built now, the queue, recent jobs with each agent's verdict — /jobs <id> shows one job and its transcript, /jobs all lists every job",
    complete: (done, runtime) => {
      if (done.length) return [];
      const jobs = runtime?.getService<ForgeService>("forge")?.listJobs() ?? [];
      return [
        { name: "all", desc: "every job" },
        ...jobs
          .slice(-8)
          .reverse()
          .map((j) => ({ name: j.id, desc: `${j.status} · ${j.agent}${j.wishId ? ` · ${j.wishId}` : ""}` })),
      ];
    },
    aliases: ["/forge"],
    run: (ctx) => {
      const forge = ctx.runtime.getService<ForgeService>("forge");
      if (!forge) return ctx.say("the forge plugin is not loaded.");
      const ref = ctx.arg?.toLowerCase();
      if (!ref || ref === "all") return ctx.say(formatForgeJobs(forge, { limit: ref === "all" ? 100 : undefined }));
      const id = /^\d+$/.test(ref) ? `job${ref}` : ref;
      const job = forge.listJobs().find((j) => j.id === id);
      if (!job) return ctx.say(`no job ${id} — /jobs lists them.`);
      void forge.jobLogTail(job, 30).then((tail) =>
        ctx.say(`${formatForgeJob(forge, job)}\n\ntranscript (${job.logFile}), last lines:\n${tail || "(empty)"}`),
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
    name: "/view",
    desc: "scroll (phone) or full-screen view",
    help: "/view scroll — native terminal scroll + select (phones); /view full — sidebar + mouse; /view auto",
    complete: (done) =>
      done.length ? [] : choices({ scroll: "native scroll + select (phones)", full: "sidebar + mouse", auto: "pick by the terminal" }),
    run: (ctx) => ctx.setView(ctx.arg),
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
    complete: (done) =>
      !done.length
        ? TASK_ORDER.map((k) => ({ name: k, desc: TASKS[k].label }))
        : done.length === 1
          ? [
              // A route names the provider kind ("anthropic"), not the switch name ("claude-api").
              ...CHAT_PROVIDER_CHOICES.map((c) => ({ name: c.kind, desc: c.desc })),
              { name: "openrouter", desc: "OpenRouter · provider:model" },
              { name: "default", desc: "back to the base route" },
            ]
          : [],
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
    complete: (done) => (done.length ? [] : choices({ all: "the whole transcript", code: "the last code block" })),
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
    name: "/agent",
    desc: "switch claude/codex/opencode (arrows)",
    help: "who answers: pick the agent with the arrows — or /agent claude|codex|opencode",
    complete: (done) => (done.length ? [] : CHAT_PROVIDER_CHOICES.map((c) => ({ name: c.name, desc: c.desc }))),
    run: (ctx) => {
      // "/agent" opens the picker; "/agent codex" switches straight away.
      if (ctx.arg) ctx.switchProvider(ctx.arg);
      else if (ctx.switchable) ctx.openPicker("agent");
      else ctx.say(`provider ${ctx.provider} ${GLYPH.dot} model ${ctx.model}`);
    },
  },
  {
    name: "/model",
    desc: "pick the model inside the agent (type to filter)",
    help: "the model the current agent runs — /model lists them (type to filter), /model <id> pins one, /model default clears",
    run: (ctx) => ctx.switchModel(ctx.args.join(" ") || undefined),
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

/**
 * What the menu offers for a line: command names while the first word is typed, then
 * whatever that command's `complete` says the next word can be. `from` is where the word
 * being completed starts, so Tab can replace it. A word typed out in full closes the menu,
 * and so does a cursor away from the end — completing mid-line would rewrite the wrong word.
 */
export type Completion = { kind: "command" | "arg"; items: readonly Choice[]; from: number };

const NO_COMPLETION: Completion = { kind: "command", items: [], from: 0 };

export function completionsFor(value: string, runtime?: IAgentRuntime, cursor = value.length): Completion {
  if (!value.startsWith("/") || value.includes("\n")) return NO_COMPLETION;
  const lastGap = value.search(/\s\S*$/);
  if (lastGap < 0) {
    return { kind: "command", items: COMMAND_MENU.filter((c) => c.name.startsWith(value.toLowerCase())), from: 0 };
  }
  if (cursor !== value.length) return NO_COMPLETION;
  const [name, ...done] = value.slice(0, lastGap).trim().split(/\s+/);
  const cmd = BY_NAME.get(name.slice(1).toLowerCase());
  if (!cmd?.complete || cmd.secret) return NO_COMPLETION;
  const from = lastGap + 1;
  const word = value.slice(from).toLowerCase();
  const items = cmd.complete(done, runtime).filter((c) => c.name.toLowerCase().startsWith(word));
  if (items.length === 1 && items[0].name.toLowerCase() === word) return NO_COMPLETION;
  return { kind: "arg", items, from };
}

/** The line once `choice` is accepted: it replaces the word being typed, and a space follows. */
export function acceptCompletion(value: string, completion: Completion, choice: Choice): string {
  return `${value.slice(0, completion.from)}${choice.name} `;
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
  "         tab completes: a command, then its next word (/paper sw → /paper swap)",
  "",
  "scrollback: the transcript scrolls inside the app — PgUp/PgDn page,",
  "            ctrl+↑/↓ one line, or just roll the mouse wheel.",
  "            click a ⚙ tool row or a ▸ thinking row to expand/collapse it.",
  "",
  "paper:  /paper — the paper account · /trench on — paper memecoin trenching, live",
  "        /stocks — the paper stock desk (Robinhood tokens, BTC, ETH), live · /stocks buy BTC 500",
  "        /backtest btc 10y — strategies tested on ten years of history · /backtest presets",
];

/** `/help`, built from the table so a new command documents itself. */
export function helpText(): string {
  const rows = COMMANDS.map((c) => {
    const label = [c.name, ...(c.aliases ?? [])].join(" ");
    return `  ${label.padEnd(15)}${c.help ?? c.desc}`;
  });
  return ["commands:", ...rows, ...HELP_TAIL].join("\n");
}

function secretCommand(text: string): RegExpExecArray | null {
  const m = /^\/(\S+)(\s+)([\s\S]*)$/.exec(text);
  return m && BY_NAME.get(m[1].toLowerCase())?.secret ? m : null;
}

/** A line whose arguments are a secret: it stays out of the input history. */
export function isSecretCommand(text: string): boolean {
  return secretCommand(text) !== null;
}

/**
 * The line as the composer shows it: a secret command's arguments masked character for
 * character, so wrapping and the cursor stay where they are. A subcommand being typed
 * ("logout") stays readable.
 */
export function maskSecrets(text: string): string {
  const m = secretCommand(text);
  if (!m || "logout".startsWith(m[3])) return text;
  return `/${m[1]}${m[2]}${m[3].replace(/\S/g, "•")}`;
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
