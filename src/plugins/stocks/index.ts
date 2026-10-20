/**
 * The stock desk plugin: paper trading of Robinhood's tokenized stocks, BTC
 * and ETH on Robinhood Chain (engine.ts), and how Lain and the operator reach it.
 */
import type { Action, IAgentRuntime, Plugin, Provider } from "../../types.js";
import { ASSETS } from "./robinhood.js";
import { DEFAULT_DESK_RULES, DESK_RULE_HELP, StockDeskService, type DeskRules } from "./engine.js";

export { StockDeskService } from "./engine.js";
export type { DeskEvent, DeskSnapshot } from "./engine.js";

function getDesk(runtime: IAgentRuntime): StockDeskService {
  const svc = runtime.getService<StockDeskService>("stocks");
  if (!svc) throw new Error("stock desk not started");
  return svc;
}

const money = (microUsd: bigint) => `$${(Number(microUsd) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The desk as text: account, positions, the market against Wall Street, the rules. */
export async function deskReport(runtime: IAgentRuntime): Promise<string> {
  const svc = getDesk(runtime);
  const snap = await svc.snapshot();
  const open = snap.positions.reduce((s, p) => s + BigInt(p.mark), 0n);
  const equity = snap.cash + open;
  const ret = snap.start > 0n ? Number(((equity - snap.start) * 10_000n) / snap.start) / 100 : 0;
  const lines = [
    `📈 stock desk (paper) · Robinhood tokens on Robinhood Chain · auto-trading ${snap.enabled ? "ON" : "OFF"} · Wall Street ${snap.session}` +
      (snap.blocker ? `\n  ⚠ ${snap.blocker}` : ""),
    `equity ${money(equity)} (${ret >= 0 ? "+" : ""}${ret.toFixed(2)}%) = ${money(snap.cash)} cash + ${money(open)} in ${snap.positions.length} position(s)`,
  ];
  for (const p of snap.positions) {
    const cost = BigInt(p.cost);
    const r = cost > 0n ? Number(((BigInt(p.mark) - cost) * 10_000n) / cost) / 100 : 0;
    lines.push(`  ${p.symbol.padEnd(6)} ${money(cost)} → ${money(BigInt(p.mark))} (${r >= 0 ? "+" : ""}${r.toFixed(2)}%) · ${p.by}${p.why ? ` · ${p.why}` : ""}`);
  }
  if (snap.quotes.length) {
    lines.push("market (on chain vs Wall Street):");
    for (const q of snap.quotes) {
      lines.push(
        `  ${q.symbol.padEnd(6)} ${q.price === null ? "?" : `$${q.price.toFixed(2)}`.padStart(10)}` +
          `${q.street ? `  WS $${q.street.price.toFixed(2)}` : "  WS —"}` +
          `${q.premiumPct !== null ? `  ${q.premiumPct >= 0 ? "+" : ""}${q.premiumPct.toFixed(2)}%` : ""}` +
          `${q.costPct !== null ? `  cost ${q.costPct.toFixed(2)}%` : ""}  · ${q.verdict}`,
      );
    }
  }
  const last = snap.closed.slice(-5);
  if (last.length) {
    lines.push("recent exits:");
    for (const c of last) lines.push(`  ${c.symbol.padEnd(6)} ${c.pnlPct >= 0 ? "+" : ""}${c.pnlPct.toFixed(2)}% — ${c.reason}`);
  }
  lines.push(`rules: ${describeDeskRules(snap.rules)}`);
  lines.push("fills: the live Uniswap pools, every hop's fee, in-tick math; nothing is sent.");
  return lines.join("\n");
}

export function describeDeskRules(r: DeskRules): string {
  return (
    `$${r.sizeUsd} per entry, ≤${r.maxOpen} open · buy when the discount to Wall Street beats the round trip by ${r.minEdgePct}% ` +
    `(on a Wall St price ≤${r.maxStreetAgeMin}m old) · exit at ${r.exitPremiumPct >= 0 ? "+" : ""}${r.exitPremiumPct}% premium, ` +
    `+${r.takeProfitPct}% / −${r.stopLossPct}%, ${r.maxHoldHours}h max · ${r.cooldownMin}m cooldown`
  );
}

/**
 * buy <sym> <$> · sell <sym> [all|qty|$] · close <sym|all> · on · off ·
 * set <rule> <value> · rules · reset [$] · status — shared by the tool and /stocks.
 */
export async function deskCommand(runtime: IAgentRuntime, args: string[], by = "operator"): Promise<string> {
  const svc = getDesk(runtime);
  const [sub = "status", ...rest] = args.map((a) => a.trim()).filter(Boolean);
  const blocker = svc.blocker();
  switch (sub.toLowerCase()) {
    case "buy": {
      if (blocker) return blocker;
      const [sym, amount] = rest;
      const dollars = Number((amount ?? "").replace(/[$,]/g, ""));
      if (!sym || !(dollars > 0)) return `usage: /stocks buy <${ASSETS.map((a) => a.symbol).join("|")}> <dollars>`;
      return svc.buy(sym, dollars, by);
    }
    case "sell":
      if (blocker) return blocker;
      return rest[0] ? svc.sell(rest[0], rest[1] ?? "all", by) : "usage: /stocks sell <symbol> [all|<qty>|$<dollars>]";
    case "close":
      return rest[0] ? svc.closeAll(rest[0], by) : "usage: /stocks close <symbol|all>";
    case "on":
      await svc.setEnabled(true);
      return blocker ? `auto-trading is on, but it waits: ${blocker}.` : "stock desk auto-trading is ON — it buys tokens trading below Wall Street beyond their round-trip cost.";
    case "off":
      await svc.setEnabled(false);
      return "stock desk auto-trading is OFF; open positions stay (their exits still run), manual orders still work.";
    case "set": {
      const [key, value] = rest;
      if (!key || value === undefined) return `usage: /stocks set <rule> <value|default> — ${Object.keys(DEFAULT_DESK_RULES).join(", ")}`;
      return (await svc.setRule(key, value)) ?? `rule set. ${describeDeskRules(svc.rules)}`;
    }
    case "rules":
      return (Object.keys(DEFAULT_DESK_RULES) as (keyof DeskRules)[])
        .map((k) => `  ${k.padEnd(16)} ${String(svc.rules[k]).padStart(6)}   ${DESK_RULE_HELP[k]}`)
        .join("\n");
    case "reset": {
      const dollars = rest[0] ? Number(rest[0].replace(/[$,]/g, "")) : undefined;
      if (dollars !== undefined && !(dollars > 0)) return "usage: /stocks reset [starting dollars]";
      await svc.reset(dollars);
      return `the desk starts over with ${money(svc.cash)}.`;
    }
    case "status":
      return deskReport(runtime);
    default:
      return "unknown — /stocks buy|sell|close|on|off|set|rules|reset|status";
  }
}

const stockDeskAction: Action = {
  name: "stock_desk",
  similes: ["stocks", "stock_paper_trading", "buy_stock", "sell_stock", "robinhood_stocks", "tokenized_stocks", "buy_bitcoin", "crypto_paper_trading"],
  description:
    "Paper trading of Robinhood's tokenized stocks, BTC (Coinbase's cbBTC) and ETH on Robinhood Chain (" +
    ASSETS.map((a) => a.symbol).join(", ") +
    ") at the fills their Uniswap pools would give — nothing is ever sent. Other coins (SOL, XRP, BNB…) have no real market on the chain. " +
    "command 'status' (default) reports the dollar account, positions and each token's price against Wall Street; " +
    "'buy' takes symbol + usd; 'sell' takes symbol + amount ('all', a token amount, or '$250'); 'close' a symbol or 'all'; " +
    "'on'/'off' switch the automatic strategy (it buys tokens trading below Wall Street beyond their round-trip cost) — only when asked; " +
    "'set' changes a rule (rule + value), 'rules' lists them, 'reset' starts the account over (usd). " +
    `Rules: ${Object.entries(DESK_RULE_HELP).map(([k, v]) => `${k} (${v})`).join(", ")}.`,
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", enum: ["status", "buy", "sell", "close", "on", "off", "set", "rules", "reset"] },
      symbol: { type: "string", description: "For buy/sell/close: e.g. NVDA, or 'all' for close." },
      usd: { type: "number", description: "For buy: dollars to spend. For reset: the new starting balance." },
      amount: { type: "string", description: "For sell: 'all', a token amount, or dollars like '$250'." },
      rule: { type: "string" },
      value: { type: "string" },
    },
  },
  examples: [
    { user: "buy $500 of NVDA on paper", agent: "Filling it at the live pool…" },
    { user: "how is the stock desk doing?", agent: "Pulling up the desk…" },
  ],
  async validate(runtime) {
    return Boolean(runtime.getService("stocks"));
  },
  async handler(runtime, _state, params) {
    const command = String(params.command ?? "status").toLowerCase();
    const sym = String(params.symbol ?? "");
    const args =
      command === "buy" ? ["buy", sym, String(params.usd ?? "")]
      : command === "sell" ? ["sell", sym, String(params.amount ?? "all")]
      : command === "close" ? ["close", sym]
      : command === "set" ? ["set", String(params.rule ?? ""), String(params.value ?? "")]
      : command === "reset" ? ["reset", ...(params.usd ? [String(params.usd)] : [])]
      : [command];
    try {
      return { ok: true, text: await deskCommand(runtime, args, "lain") };
    } catch (err) {
      return { ok: false, text: `stock desk: ${(err as Error).message}` };
    }
  },
};

/** Lain knows what the desk holds — from its last marks, no chain reads per turn. */
const stockDeskProvider: Provider = {
  name: "stocks",
  async get(runtime) {
    const svc = runtime.getService<StockDeskService>("stocks");
    if (!svc || (!svc.enabled && !svc.positions.length)) return "";
    const open = svc.positions
      .map((p) => {
        const cost = BigInt(p.cost);
        const r = cost > 0n ? Number(((BigInt(p.mark) - cost) * 10_000n) / cost) / 100 : 0;
        return `${p.symbol} ${r >= 0 ? "+" : ""}${r.toFixed(2)}%`;
      })
      .join(", ");
    return (
      `Your paper stock desk trades Robinhood's tokenized stocks, BTC and ETH on Robinhood Chain` +
      `${svc.enabled ? " (auto-trading on: buys tokens below Wall Street beyond cost)" : ""}. Open: ${open || "none"}. ` +
      `The stock_desk tool reports it and places paper orders when the operator asks.`
    );
  },
};

export const stocksPlugin: Plugin = {
  name: "stocks",
  description: "Paper stock desk: Robinhood's tokenized stocks, BTC and ETH on Robinhood Chain, filled at their live Uniswap pools.",
  services: [new StockDeskService()],
  providers: [stockDeskProvider],
  actions: [stockDeskAction],
};
