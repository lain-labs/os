/**
 * Trenching on paper: the rule-driven memecoin loop over PONS v2 launches on
 * Robinhood Chain (see engine.ts), and how Lain and the operator see it.
 */
import type { Action, IAgentRuntime, Plugin, Provider } from "../../types.js";
import type { ChainService } from "../chain/index.js";
import { DEFAULT_RULES, fmt, RULE_HELP, TrenchService, type TrenchRules } from "./engine.js";
import { PONS_CHAIN_ID } from "./pons.js";

export { TrenchService } from "./engine.js";
export type { TrenchEvent, TrenchRules } from "./engine.js";

function getTrench(runtime: IAgentRuntime): TrenchService {
  const svc = runtime.getService<TrenchService>("trench");
  if (!svc) throw new Error("trench service not started");
  return svc;
}

/** The whole picture: switch, cash, open positions at their last mark, closed trades, the rules. */
export async function trenchReport(runtime: IAgentRuntime, closedShown = 8): Promise<string> {
  const svc = getTrench(runtime);
  const chain = runtime.getService<ChainService>("chain");
  const rules = svc.rules;
  const blocker = svc.blocker();
  const lines: string[] = [];
  const tick = svc.lastTick ? `last scan ${Math.round((Date.now() - svc.lastTick) / 1000)}s ago` : "no scan yet";
  lines.push(
    `⛏ trenching on paper · PONS v2 · Robinhood Chain · ${svc.enabled ? `ON, every ${svc.interval / 1000}s, ${tick}` : "OFF"}` +
      (blocker && svc.enabled ? `\n  ⚠ ${blocker}` : "") +
      (svc.error ? `\n  ⚠ last scan failed: ${svc.error}` : ""),
  );

  const open = svc.positions;
  let openSpent = 0n;
  let openValue = 0n;
  for (const p of open) {
    openSpent += BigInt(p.cost);
    openValue += BigInt(p.markValue);
  }
  const closed = svc.closed;
  const wins = closed.filter((c) => BigInt(c.pnl) > 0n).length;
  const net = closed.reduce((sum, c) => sum + BigInt(c.pnl), 0n);
  const cash = chain?.paper ? (await chain.paper.account(PONS_CHAIN_ID)).cashWei : null;
  lines.push(
    `cash ${cash === null ? "?" : fmt(cash)} ETH · open ${open.length} (${fmt(openSpent)} → ${fmt(openValue)} ETH` +
      `${openSpent > 0n ? `, ${pct(openValue - openSpent, openSpent)}` : ""}) · closed ${closed.length}` +
      (closed.length ? `: ${wins} won / ${closed.length - wins} lost, net ${net >= 0n ? "+" : ""}${fmt(net)} ETH` : ""),
  );

  if (open.length) {
    lines.push("open:");
    for (const p of open) {
      const cost = BigInt(p.cost);
      const value = BigInt(p.markValue);
      lines.push(
        `  ${p.symbol.padEnd(12)} ${fmt(cost)} → ${fmt(value)} ETH  ${pct(value - cost, cost).padStart(7)}  ` +
          `${Math.round((Date.now() - p.openedAt) / 60_000)}m  ${Math.round(p.markProgress * 100)}% to graduation` +
          `${p.tpDone ? "  (half taken, trailing)" : ""}`,
      );
    }
  }
  if (closed.length) {
    lines.push(`closed (last ${Math.min(closedShown, closed.length)}):`);
    for (const c of closed.slice(-closedShown)) {
      lines.push(
        `  ${c.symbol.padEnd(12)} ${fmt(BigInt(c.spent))} → ${fmt(BigInt(c.proceeds))} ETH  ` +
          `${`${c.pnlPct >= 0 ? "+" : ""}${c.pnlPct.toFixed(1)}%`.padStart(7)}  ` +
          `${Math.round((c.closedAt - c.openedAt) / 60_000)}m  ${c.reason}`,
      );
    }
  }
  lines.push(`rules: ${describeRules(rules)}`);
  lines.push("fills are the curve's live math (1% fee + creator tax); our paper orders never move the curve, pay no gas, never get front-run.");
  return lines.join("\n");
}

export function describeRules(r: TrenchRules): string {
  return (
    `${r.sizeNative} ETH per entry, ≤${r.maxOpen} open · launched ≤${r.maxAgeMin}m ago · in ${r.windowMin}m: ` +
    `≥${r.minBuys} buys, ≥${r.minBuyers} wallets, ≥+${r.minInflowNative} ETH · ${r.minProgressPct}–${r.maxProgressPct}% to graduation · ` +
    `tax ≤${r.maxTaxPct}% · exits: +${r.takeProfitPct}% half off then trail ${r.trailPct}%, stop −${r.stopLossPct}%, ` +
    `${r.maxHoldMin}m max, graduation · ${r.cooldownMin}m cooldown`
  );
}

/**
 * on / off / close <sym|all> / set <rule> <value> / rules / status — shared by
 * the trench tool and the TUI's /trench.
 */
export async function trenchCommand(runtime: IAgentRuntime, args: string[]): Promise<string> {
  const svc = getTrench(runtime);
  const [sub = "status", ...rest] = args.map((a) => a.trim()).filter(Boolean);
  switch (sub.toLowerCase()) {
    case "on": {
      await svc.setEnabled(true);
      const blocker = svc.blocker();
      return blocker
        ? `trenching is on, but it waits: ${blocker}.`
        : "trenching on paper is ON — scanning PONS launches; entries and exits will appear as they happen.\n" + (await trenchReport(runtime, 3));
    }
    case "off":
      await svc.setEnabled(false);
      return "trenching is OFF. Open paper positions stay as they are (/trench close all to exit them).";
    case "close":
      return rest[0] ? svc.close(rest[0]) : "usage: /trench close <symbol|all>";
    case "set": {
      const [key, value] = rest;
      if (!key || value === undefined) return `usage: /trench set <rule> <value|default> — rules: ${Object.keys(DEFAULT_RULES).join(", ")}`;
      const err = await svc.setRule(key, value);
      return err ?? `rule set. ${describeRules(svc.rules)}`;
    }
    case "rules":
      return (Object.keys(DEFAULT_RULES) as (keyof TrenchRules)[])
        .map((k) => `  ${k.padEnd(16)} ${String(svc.rules[k]).padStart(6)}   ${RULE_HELP[k]}${svc.rules[k] !== DEFAULT_RULES[k] ? `  (default ${DEFAULT_RULES[k]})` : ""}`)
        .join("\n");
    case "status":
      return trenchReport(runtime);
    default:
      return `unknown /trench ${sub} — on, off, status, close <symbol|all>, set <rule> <value>, rules`;
  }
}

const trenchAction: Action = {
  name: "trench",
  similes: ["trenching", "memecoin_trading", "pons_trading", "meme_paper_trading", "trench_status"],
  description:
    "Paper trenching of PONS v2 memecoins on Robinhood Chain: a rule-driven loop enters fresh launches with momentum and exits on take-profit/trailing stop, stop-loss, time and graduation — all on paper, nothing is ever sent. " +
    "command 'status' (default) reports open positions with live PnL, closed trades and the rules; 'on'/'off' start and stop it (only when the operator asks); " +
    "'close' exits a position (symbol, or 'all'); 'set' changes one rule (rule + value, or value 'default'); 'rules' lists them. " +
    `Rules: ${Object.entries(RULE_HELP).map(([k, v]) => `${k} (${v})`).join(", ")}.`,
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", enum: ["status", "on", "off", "close", "set", "rules"], description: "Default status." },
      symbol: { type: "string", description: "For close: the position's symbol, or 'all'." },
      rule: { type: "string", description: "For set: the rule name, e.g. stopLossPct." },
      value: { type: "string", description: "For set: the new value, or 'default'." },
    },
  },
  examples: [
    { user: "how's the trenching going?", agent: "Pulling up the paper positions…" },
    { user: "tighten the stop to 20%", agent: "Setting stopLossPct to 20." },
  ],
  async validate(runtime) {
    return Boolean(runtime.getService("trench"));
  },
  async handler(runtime, _state, params) {
    const command = String(params.command ?? "status").toLowerCase();
    const args =
      command === "close"
        ? ["close", String(params.symbol ?? "")]
        : command === "set"
          ? ["set", String(params.rule ?? ""), String(params.value ?? "")]
          : [command];
    try {
      return { ok: true, text: await trenchCommand(runtime, args) };
    } catch (err) {
      return { ok: false, text: `trench: ${(err as Error).message}` };
    }
  },
};

/** While the loop runs, Lain knows what it holds — from the last marks, no chain reads per turn. */
const trenchProvider: Provider = {
  name: "trench",
  async get(runtime) {
    const svc = runtime.getService<TrenchService>("trench");
    if (!svc?.enabled) return "";
    const open = svc.positions
      .map((p) => {
        const cost = BigInt(p.cost);
        return `${p.symbol} ${pct(BigInt(p.markValue) - cost, cost)}`;
      })
      .join(", ");
    const last = svc.closed.at(-1);
    return (
      `Your paper trench loop is running on PONS memecoins (Robinhood Chain) — rules decide entries and exits, you watch and comment. ` +
      `Open: ${open || "none"}.` +
      (last ? ` Last closed: ${last.symbol} ${last.pnlPct >= 0 ? "+" : ""}${last.pnlPct.toFixed(1)}% (${last.reason}).` : "") +
      ` The trench tool reports it, closes positions and changes rules when the operator asks.`
    );
  },
};

function pct(delta: bigint, base: bigint): string {
  if (base <= 0n) return "n/a";
  const bps = Number((delta * 10_000n) / base);
  return `${bps >= 0 ? "+" : ""}${(bps / 100).toFixed(1)}%`;
}

export const trenchPlugin: Plugin = {
  name: "trench",
  description: "Paper trenching: a rule-driven loop over PONS v2 memecoin launches on Robinhood Chain, booked into the paper account.",
  services: [new TrenchService()],
  providers: [trenchProvider],
  actions: [trenchAction],
};
