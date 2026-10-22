/**
 * The paper wallets, as Lain and the operator see them: a report (balance,
 * positions at live value, equity and return since the start), the switch,
 * and the wallets themselves — opened, picked, lent to Lain or taken back.
 *
 * There are no separate paper buy/sell tools on purpose. While paper mode is
 * on, buy_token, sell_token, speculate_* and the trader loop simulate — so a
 * paper result is the result of the very code that would trade for real. A
 * trade that names a wallet is paper whatever the switch says.
 *
 * Who may touch which wallet is decided here, not in a prompt: Lain trades and
 * changes only the wallets marked as hers, and reads the rest. The operator's
 * own commands carry an {@link operatorState}, which the model cannot make.
 */
import { formatEther, formatUnits, isAddress, parseEther, parseUnits, type Address } from "viem";
import type { Action, IAgentRuntime, State } from "../../../types.js";
import { PAPER_COINS, paperCoinSymbol, type PaperAccount, type PaperActor, type PaperWallet } from "../paper.js";
import { getService, type ChainService } from "../service.js";

const operatorStates = new WeakSet<object>();

/** A State for something the operator typed (/paper …): it may use every wallet. */
export function operatorState(): State {
  const state = {} as State;
  operatorStates.add(state);
  return state;
}

export function isOperatorState(state: unknown): boolean {
  return typeof state === "object" && state !== null && operatorStates.has(state);
}

/** A wallet and its account on the active chain. */
type Target = { wallet: PaperWallet; book: PaperAccount };

async function open(svc: ChainService, wallet: PaperWallet): Promise<Target> {
  // Lain's current wallet is already open; asking for it again keeps tests and old callers simple.
  const book = wallet.name === svc.paper.current("lain") ? svc.paperBook : await svc.paperWallet(wallet.name);
  return { wallet, book };
}

function walletOrThrow(svc: ChainService, name: string): PaperWallet {
  const w = svc.paper.wallet(name);
  if (!w) throw new Error(`there is no paper wallet "${name}" (paper wallets: ${svc.paper.wallets().map((x) => x.name).join(", ")})`);
  return w;
}

function refuseForLain(w: PaperWallet): string {
  return `${w.name} is the operator's own paper wallet: you can read it (paper_trading status with wallet ${w.name}) but only they trade or change it`;
}

/**
 * Where a trade tool books: the wallet it names (always paper), or — naming none — Lain's
 * current wallet in paper mode and a real trade otherwise (book undefined either way, the
 * service decides). Lain may name only a wallet she trades.
 */
export async function tradeTarget(
  svc: ChainService,
  state: unknown,
  raw: unknown,
): Promise<{ book?: PaperAccount; wallet?: string; error?: string }> {
  const name = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!name) return svc.paperMode ? { wallet: svc.paper.current("lain") } : {};
  const w = svc.paper.wallet(name);
  if (!w) return { error: `There is no paper wallet "${name}" — paper_trading mode wallets lists them.` };
  if (!w.lain && !isOperatorState(state)) return { error: `${refuseForLain(w)}.` };
  if (!svc.configured) return { error: "No chain is configured, so there is nothing to paper-trade against." };
  return { book: await svc.paperWallet(w.name), wallet: w.name };
}

/** The `wallet` parameter every trade tool takes. */
export const WALLET_PARAM = {
  type: "string",
  description:
    "Paper wallet to trade in — one of yours (paper_trading mode wallets lists them). Naming one always simulates, whatever paper mode says. Omit for your current wallet in paper mode.",
} as const;

/** "main (lain) · mine (operator) · …", the current one starred. */
function walletsLine(svc: ChainService, current: string): string {
  return svc.paper
    .wallets()
    .map((w) => `${w.name}${w.name === current ? "*" : ""} (${w.lain ? "lain" : "operator"})`)
    .join(" · ");
}

/** How long a coin quote may take before the report goes out without values. */
const QUOTE_TIMEOUT_MS = 6_000;

/** USD prices from CoinGecko for these symbols; an outage is said, never guessed around. */
async function coinQuotes(symbols: string[]): Promise<{ usd: Record<string, number>; error?: string }> {
  const ids = [...new Set(symbols.map((s) => PAPER_COINS[s]).filter(Boolean))];
  if (!ids.length) return { usd: {} };
  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=usd`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(QUOTE_TIMEOUT_MS),
    });
    if (!res.ok) return { usd: {}, error: `CoinGecko HTTP ${res.status}` };
    const body = (await res.json()) as Record<string, { usd?: number }>;
    const usd: Record<string, number> = {};
    for (const symbol of symbols) {
      const price = body[PAPER_COINS[symbol]]?.usd;
      if (typeof price === "number") usd[symbol] = price;
    }
    return { usd };
  } catch (err) {
    return { usd: {}, error: (err as Error).message.slice(0, 120) };
  }
}

/** A paper wallet on the active chain — Lain's current one unless named — valued at live sell-side quotes. */
export async function paperReport(svc: ChainService, target?: Target): Promise<{ text: string; data: Record<string, unknown> }> {
  const { wallet, book } = target ?? (await open(svc, walletOrThrow(svc, svc.paper.current("lain"))));
  const sym = svc.nativeSymbol;
  const lines: string[] = [];
  const positions: Record<string, unknown>[] = [];
  let valueWei = 0n;
  let basisWei = 0n;
  for (const pos of book.journal.positions()) {
    if (!isAddress(pos.token)) continue;
    const qty = BigInt(pos.qtyWei);
    const cost = BigInt(pos.costWei);
    let value: bigint | null = null;
    let decimals = 18;
    const venue = svc.venueFor(pos.token);
    try {
      decimals = (await svc.tokenInfo(pos.token as Address)).decimals;
      value = venue ? await venue.value(pos.token, qty) : (await svc.quoteNativeSell(pos.token as Address, qty)).amountOut;
    } catch {
      // No live pool: listed at zero, said so.
    }
    valueWei += value ?? 0n;
    basisWei += cost;
    const pct = cost > 0n && value !== null ? signedPct(value - cost, cost) : null;
    lines.push(
      `· ${pos.symbol}: ${units(qty, decimals)} ≈ ${value === null ? "? (no live pool)" : `${amt(value)} ${sym}`}` +
        ` (basis ${amt(cost)}${pct ? `, ${pct}` : ""}${venue ? `, ${venue.name}` : ""})`,
    );
    positions.push({
      token: pos.token,
      symbol: pos.symbol,
      amount: formatUnits(qty, decimals),
      valueNative: value === null ? null : formatEther(value),
      basisNative: formatEther(cost),
      unrealizedPct: pct,
    });
  }

  // Other coins, booked straight in: priced in USD (and in the chain's own
  // currency when that one has a quote too), kept out of the native equity.
  const coins = book.coins();
  const quotes = coins.length ? await coinQuotes([sym.toUpperCase(), ...coins.map((c) => c.symbol)]) : { usd: {} };
  const nativeUsd = quotes.usd[sym.toUpperCase()];
  const coinLines = coins.map((c) => {
    const price = quotes.usd[c.symbol];
    const usd = price === undefined ? null : Number(c.amount) * price;
    return (
      `· ${c.symbol} ${amtText(c.amount)}` +
      (usd === null ? " (no live quote)" : ` ≈ ${dollars(usd)}${nativeUsd ? ` ≈ ${(usd / nativeUsd).toFixed(6)} ${sym}` : ""}`)
    );
  });

  // The coins count toward equity at spot, in native; without a native price they can't.
  let coinsWei = 0n;
  let unpriced = 0;
  for (const c of coins) {
    const price = quotes.usd[c.symbol];
    if (price === undefined || !nativeUsd) unpriced += 1;
    else coinsWei += (parseUnits(c.amount, 18) * usdScale(price)) / usdScale(nativeUsd);
  }

  const cash = book.cashWei;
  const start = book.startWei;
  const deposits = book.depositsWei;
  const equity = cash + valueWei + coinsWei;
  // Booked coins are money put in, so the return is measured against start + deposits.
  const base = start + deposits;
  const trades = book.journal.recentTrades(500);
  const realizedWei = trades.reduce((sum, t) => sum + (t.realizedWei ? BigInt(t.realizedWei) : 0n), 0n);
  const since = stamp(book.startedAt).slice(0, 10);
  const pnl = equity - base;
  const header = [
    `📝 paper mode ${svc.paperMode ? "ON — every trade is simulated" : "OFF — trades are real"} · ` +
      `${svc.chain.name} (${svc.chain.id})`,
    `wallet ${wallet.name} — ${wallet.lain ? "Lain trades it" : "the operator's only, Lain never trades it"}` +
      (wallet.note ? ` · ${wallet.note}` : ""),
    `equity ${amt(equity)} ${sym} = ${amt(cash)} ${sym} cash + ${amt(valueWei)} ${sym} in ${positions.length} position(s)` +
      (coins.length ? ` + ${amt(coinsWei)} ${sym} in coins${unpriced ? ` (${unpriced} without a live price left out)` : ""}` : ""),
    // Balances set by hand are money put in or taken out, not profit or loss.
    `P&L ${pnl >= 0n ? "+" : ""}${amt(pnl)} ${sym} (${signedPct(pnl, base)}) since ${since} on ${amt(base)} ${sym} put in` +
      (deposits !== 0n
        ? ` (started with ${amt(start)}, ${deposits > 0n ? `+${amt(deposits)} added` : `${amt(-deposits)} taken out`} by hand)`
        : ""),
    `realised ${realizedWei >= 0n ? "+" : ""}${amt(realizedWei)} ${sym} · ` +
      `unrealised ${valueWei - basisWei >= 0n ? "+" : ""}${amt(valueWei - basisWei)} ${sym}`,
  ];
  const recent = trades.slice(-5).map(
    (t) =>
      `· ${stamp(t.ts).slice(5)} ${t.side} ${t.symbol} ` +
      `${amt(BigInt(t.nativeWei))} ${sym}` +
      (t.realizedWei ? ` (realised ${BigInt(t.realizedWei) >= 0n ? "+" : ""}${amt(BigInt(t.realizedWei))})` : "") +
      (t.reason ? ` — ${t.reason}` : ""),
  );
  const swaps = book.recentSwaps(5).map(
    (s) => `· ${stamp(s.ts).slice(5)} ${amtText(s.fromAmount)} ${s.from} → ${amtText(s.toAmount)} ${s.to} (${dollars(s.usd)})`,
  );
  const balances = { [sym]: formatEther(cash), ...Object.fromEntries(coins.map((c) => [c.symbol, c.amount])) };
  const text = [
    ...header,
    `balances: ${Object.entries(balances).map(([s, a]) => `${amtText(a)} ${s}`).join(" + ")}`,
    ...(coins.length
      ? ["other coins (on paper, at CoinGecko spot, not on a DEX):", ...coinLines, ...(quotes.error ? [`no live quote: ${quotes.error}`] : [])]
      : []),
    ...(lines.length ? ["positions:", ...lines] : ["no open paper positions."]),
    ...(recent.length ? ["recent paper trades:", ...recent] : []),
    ...(swaps.length ? ["recent coin swaps (spot price, no fee):", ...swaps] : []),
    `wallets: ${walletsLine(svc, wallet.name)}`,
    "fills are live pool quotes; a paper trade does not move the pool, pays no gas and is never front-run.",
  ].join("\n");
  return {
    text,
    data: {
      paperMode: svc.paperMode,
      wallet: wallet.name,
      lainTrades: wallet.lain,
      chainId: svc.chain.id,
      startNative: formatEther(start),
      cashNative: formatEther(cash),
      positionsValueNative: formatEther(valueWei),
      coinsValueNative: formatEther(coinsWei),
      depositsNative: formatEther(deposits),
      equityNative: formatEther(equity),
      pnlNative: formatEther(pnl),
      returnPct: signedPct(pnl, base),
      realizedNative: formatEther(realizedWei),
      unrealizedNative: formatEther(valueWei - basisWei),
      startedAt: new Date(book.startedAt).toISOString(),
      balances,
      coins: coins.map((c) => ({ ...c, priceUsd: quotes.usd[c.symbol] ?? null })),
      positions,
      recentTrades: trades.slice(-5),
      recentSwaps: book.recentSwaps(5),
    },
  };
}

/** Sell one paper coin for another — SOL for USDC, SOL for the paper ETH — at the live CoinGecko spot price. */
async function paperSwap(
  svc: ChainService,
  target: Target,
  swap: { from?: string; to?: string; amount?: string },
): Promise<{ ok: boolean; text: string; data?: Record<string, unknown> }> {
  const native = svc.nativeSymbol.toUpperCase();
  const coin = (raw: string | undefined) => {
    const s = (raw ?? "").trim().toUpperCase();
    return s === native || s === "NATIVE" ? native : paperCoinSymbol(s);
  };
  const from = coin(swap.from);
  const to = coin(swap.to);
  const known = [...new Set([native, ...Object.keys(PAPER_COINS)])].join(", ");
  if (!from) return { ok: false, text: `asset (the coin sold) must be one of ${known} — not "${swap.from ?? ""}".` };
  if (!to) return { ok: false, text: `to (the coin bought) must be one of ${known} — not "${swap.to ?? ""}".` };
  const amount = (swap.amount ?? "").trim().toLowerCase();
  if (!amount) return { ok: false, text: `How much ${from}? Give amount (a number or "all").` };
  const quotes = await coinQuotes([from, to]);
  const usd = { from: quotes.usd[from], to: quotes.usd[to] };
  if (usd.from === undefined || usd.to === undefined) {
    return {
      ok: false,
      text: `No live price for ${usd.from === undefined ? from : to}${quotes.error ? ` (${quotes.error})` : ""} — nothing was booked. Try again in a minute.`,
    };
  }
  try {
    const fill = await target.book.swapCoins({ from, to, amount, native, usd });
    const report = await paperReport(svc, target);
    return {
      ok: true,
      text:
        `Paper-swapped (wallet ${target.wallet.name}) ${amtText(fill.fromAmount)} ${from} → ${amtText(fill.toAmount)} ${to} at ${dollars(usd.from)}/${from}, ${dollars(usd.to)}/${to} ` +
        `(${dollars(fill.usd)}; CoinGecko spot, no fee or slippage — nothing sent).\n${report.text}`,
      data: { swap: fill, ...report.data },
    };
  } catch (err) {
    return { ok: false, text: `${(err as Error).message} — nothing was booked.` };
  }
}

/** Words /paper reads as its own verbs, so no wallet may be called one. */
const RESERVED = new Set(["status", "on", "off", "reset", "buy", "sell", "set", "add", "swap", "wallets", "new", "use", "lain", "drop"]);

/** Who asks, and which wallet: the one named, else the asker's current one. */
export type PaperAsk = { actor: PaperActor; wallet?: string; note?: string; lain?: boolean };

/**
 * Report a paper wallet, flip paper mode, reset a wallet, book or swap its coins, and
 * open, pick, lend or drop wallets. Shared by the paper_trading tool (actor lain) and the
 * TUI's /paper (actor operator), so both say the same thing and obey the same rules.
 */
export async function paperControl(
  svc: ChainService,
  mode: string,
  startNative?: string,
  coin?: { asset?: string; amount?: string; to?: string },
  ask: PaperAsk = { actor: "lain" },
): Promise<{ ok: boolean; text: string; data?: Record<string, unknown> }> {
  if (!svc.configured) return { ok: false, text: "No chain is configured, so there is nothing to paper-trade against." };
  const lain = ask.actor === "lain";
  const named = ask.wallet?.trim().toLowerCase() || undefined;
  let startWei: bigint | undefined;
  if (startNative?.trim()) {
    try {
      startWei = parseEther(startNative.trim());
    } catch {
      startWei = undefined;
    }
    if (!startWei || startWei <= 0n) return { ok: false, text: `startNative must be a positive amount, not "${startNative}".` };
  }

  if (mode === "wallets") return paperWallets(svc, ask.actor);
  if (mode === "new") {
    if (!named) return { ok: false, text: "Name the new wallet (wallet), e.g. momentum." };
    if (RESERVED.has(named)) return { ok: false, text: `"${named}" is a /paper word — call the wallet something else.` };
    const wallet = await svc.paper.createWallet({ name: named, lain: lain || ask.lain === true, note: ask.note, startWei });
    if (lain) await svc.useLainWallet(wallet.name);
    else await svc.paper.select("operator", wallet.name);
    const report = await paperReport(svc, await open(svc, wallet));
    return {
      ok: true,
      text: `Opened paper wallet ${wallet.name} with ${amt(BigInt(wallet.startWei))} ${svc.nativeSymbol} — ${wallet.lain ? "Lain trades it" : "yours alone, Lain never trades it"}; it is ${lain ? "my" : "your"} current wallet now.\n${report.text}`,
      data: report.data,
    };
  }
  if (mode === "use") {
    if (!named) return { ok: false, text: "Which wallet? paper_trading mode wallets lists them." };
    const wallet = walletOrThrow(svc, named);
    if (lain && !wallet.lain) return { ok: false, text: `${refuseForLain(wallet)}.` };
    if (lain) await svc.useLainWallet(wallet.name);
    else await svc.paper.select("operator", wallet.name);
    const report = await paperReport(svc, await open(svc, wallet));
    return { ok: true, text: `${lain ? "My" : "Your"} current paper wallet is ${wallet.name} now.\n${report.text}`, data: report.data };
  }
  if (mode === "lain" || mode === "drop") {
    if (lain) return { ok: false, text: "Only the operator lends a wallet to me, takes one back or drops one (/paper lain, /paper drop)." };
    if (!named) return { ok: false, text: `Which wallet? usage: /paper ${mode} <wallet>${mode === "lain" ? " on|off" : ""}` };
    if (mode === "drop") {
      const gone = await svc.paper.removeWallet(named);
      await svc.useLainWallet(svc.paper.current("lain"));
      return { ok: true, text: `Dropped paper wallet ${gone.name} — its files are kept under paper/wallets/.removed.\nwallets: ${walletsLine(svc, svc.paper.current("operator"))}` };
    }
    const wallet = await svc.paper.setLain(named, ask.lain === true);
    await svc.useLainWallet(svc.paper.current("lain"));
    return {
      ok: true,
      text: `${wallet.name}: ${wallet.lain ? "Lain trades it now (her take-profit loop manages it too)" : "yours alone now — Lain reads it but never trades it"}.\nwallets: ${walletsLine(svc, svc.paper.current("operator"))}`,
    };
  }

  const wallet = walletOrThrow(svc, named ?? svc.paper.current(ask.actor));
  const changes = mode !== "status" && mode !== "on" && mode !== "off";
  if (lain && changes && !wallet.lain) return { ok: false, text: `${refuseForLain(wallet)}.` };
  const target = await open(svc, wallet);

  if (mode === "swap" || mode === "sell" || mode === "exchange") {
    // Lain naming no wallet with the switch off may mean real money: not a paper swap.
    if (lain && !named && !svc.paperMode) {
      return { ok: false, text: "Paper mode is off, so there is no paper swap unless a wallet is named — a real one is the operator's call." };
    }
    return paperSwap(svc, target, { from: coin?.asset, to: coin?.to, amount: coin?.amount });
  }
  if (mode === "set" || mode === "add" || mode === "deposit") {
    const native = svc.nativeSymbol.toUpperCase();
    const asked = (coin?.asset ?? "").trim().toUpperCase();
    const amount = (coin?.amount ?? "").trim();
    if (asked === native || asked === "NATIVE") {
      // The chain's own currency is the paper cash: set exactly, counted as money put in.
      try {
        const { before, after } = await target.book.bookCash(amount, mode === "set" ? "set" : "add");
        const report = await paperReport(svc, target);
        const change =
          before === after
            ? `${native} cash is already ${amt(after)} in ${wallet.name} — nothing changed.`
            : `${native} cash: ${amt(before)} → ${amt(after)} in ${wallet.name}, booked on paper — nothing sent.`;
        return { ok: true, text: `${change}\n${report.text}`, data: report.data };
      } catch (err) {
        return { ok: false, text: `${(err as Error).message}.` };
      }
    }
    const symbol = paperCoinSymbol(asked);
    if (!symbol) {
      const known = [...new Set([native, ...Object.keys(PAPER_COINS)])].join(", ");
      return { ok: false, text: `asset must be one of ${known} — not "${coin?.asset ?? ""}".` };
    }
    try {
      const { before, after } = await target.book.bookCoin(symbol, amount, mode === "set" ? "set" : "add");
      // Booked coins are a deposit, valued now, so the return does not count them as profit.
      const delta = parseUnits(after, 18) - parseUnits(before, 18);
      let unvalued = false;
      if (delta !== 0n) {
        const quotes = await coinQuotes([symbol, native]);
        const [price, nativeUsd] = [quotes.usd[symbol], quotes.usd[native]];
        if (price === undefined || !nativeUsd) unvalued = true;
        else await target.book.recordDeposit((delta * usdScale(price)) / usdScale(nativeUsd));
      }
      const report = await paperReport(svc, target);
      const change =
        before === after
          ? `${symbol} is already ${after} in ${wallet.name} — nothing changed.`
          : `${symbol}: ${before} → ${after} in ${wallet.name}, booked on paper — nothing sent` +
            (unvalued ? " (no live price, so the return counts it as profit, not a deposit)." : ".");
      return { ok: true, text: `${change}\n${report.text}`, data: report.data };
    } catch (err) {
      return { ok: false, text: `${(err as Error).message}.` };
    }
  }
  const note: string[] = [];
  if (mode === "on" || mode === "off") {
    await svc.paper.setEnabled(mode === "on");
    note.push(
      mode === "on"
        ? `Paper mode is on: buy_token, sell_token, speculate_* and the take-profit loop now simulate against live pools — nothing is sent. Lain's trades go into ${svc.paper.current("lain")} unless they name a wallet.`
        : "Paper mode is off: trades are real again (a trade that names a paper wallet still is not).",
    );
  }
  if (mode === "reset" || (mode === "on" && startWei)) {
    if (lain && !wallet.lain) return { ok: false, text: `${refuseForLain(wallet)}.` };
    await target.book.reset(startWei);
    note.push(`Paper wallet ${wallet.name} starts over with ${amt(target.book.startWei)} ${svc.nativeSymbol}.`);
  } else if (changes) {
    return { ok: false, text: `mode must be status, wallets, new, use, on, off, reset, set, add or swap — not "${mode}".` };
  }
  const report = await paperReport(svc, target);
  return { ok: true, text: [...note, report.text].join("\n"), data: report.data };
}

/** Every wallet in one line each: who trades it, cash, positions, coins, what it is for. */
async function paperWallets(svc: ChainService, actor: PaperActor): Promise<{ ok: boolean; text: string; data: Record<string, unknown> }> {
  const sym = svc.nativeSymbol;
  const rows: Record<string, unknown>[] = [];
  const lines: string[] = [];
  for (const w of svc.paper.wallets()) {
    const { book } = await open(svc, w);
    const positions = book.journal.positions().filter((p) => isAddress(p.token));
    const basis = positions.reduce((sum, p) => sum + BigInt(p.costWei), 0n);
    const coins = book.coins();
    const marks = [w.name === svc.paper.current("lain") ? "Lain's current" : "", w.name === svc.paper.current("operator") ? "operator's current" : ""].filter(Boolean);
    lines.push(
      `· ${w.name} — ${w.lain ? "Lain trades it" : "operator only"}${marks.length ? ` [${marks.join(", ")}]` : ""}: ` +
        `${amt(book.cashWei)} ${sym} cash` +
        (positions.length ? ` + ${positions.length} position(s), basis ${amt(basis)} ${sym}` : "") +
        (coins.length ? ` + ${coins.map((c) => `${amtText(c.amount)} ${c.symbol}`).join(", ")}` : "") +
        ` (started with ${amt(book.startWei)})` +
        (w.note ? ` — ${w.note}` : ""),
    );
    rows.push({ name: w.name, lain: w.lain, note: w.note ?? null, cashNative: formatEther(book.cashWei), positions: positions.length, coins });
  }
  const how =
    actor === "operator"
      ? "/paper <wallet> shows one · /paper use <wallet> · /paper new <name> [start] [lain] [note…] · /paper lain <wallet> on|off · /paper drop <wallet>"
      : "status with wallet shows one in full; new opens one for you; use picks your current one. Operator-only wallets are read-only to you.";
  return { ok: true, text: [`paper wallets on ${svc.chain.name} (${svc.chain.id}):`, ...lines, how].join("\n"), data: { wallets: rows } };
}

export const paperTradingAction: Action = {
  name: "paper_trading",
  // paper_assets was the self-written tool that kept other coins in a ledger
  // of its own, which /paper never read; its calls land here now.
  similes: ["paper_mode", "paper_trade", "paper_portfolio", "simulated_trading", "practice_trading", "paper_assets", "paper_wallet", "paper_deposit", "paper_swap"],
  description:
    "Paper wallets for trading by hand — buy_token/sell_token/speculate_token simulated against live DEX pools with a virtual native balance, nothing sent. " +
    "Not your demo account: the $100 paper desk that trades backtested strategies by itself is paper_desk — use that for how your paper/demo trading is doing. " +
    "There are several paper wallets, each with its own cash, positions and coins — one per theory or portfolio. You trade and change only the wallets marked as yours (main always is); a wallet that is the operator's own you may read (status with `wallet`) but never trade, reset or change — that is enforced. " +
    "'wallets' lists them; 'new' opens a wallet of yours (`wallet` = its name, startNative, `note` = the theory it tests) and makes it your current one; 'use' picks your current wallet — where your trades go when they name none. buy_token, sell_token, speculate_token and speculate_basket take `wallet` too. " +
    "mode 'status' (default) reports a wallet (yours unless `wallet` names one): balances (native cash and other coins), positions at live value, equity and return since the start, recent paper trades. " +
    "'on' / 'off' switches paper mode for ALL trading — while it is on, buy_token, sell_token, speculate_token, speculate_basket and the auto take-profit loop simulate, so keep using those tools to paper-trade. " +
    "'reset' starts the account over with startNative (also accepted with 'on'). Turn it on or off only when the operator asks. " +
    `'set' makes a balance exactly \`amount\` ("add 1 SOL so I have 1 SOL" → set SOL 1; repeating it changes nothing); 'add' puts \`amount\` on top — only for an explicit "add N more". Both work for the native cash too (set ETH 1) and for the coins ${Object.keys(PAPER_COINS).join(", ")}; booked straight in, never bought on a DEX, and counted as money put in, not profit. ` +
    "'swap' sells `amount` (or 'all') of `asset` for the coin `to` at the live CoinGecko spot price, the native cash included — \"sell 1 SOL for USDC\" → swap asset SOL to USDC amount 1. In paper mode this is the only way to trade these coins: never a MetaMask or other real-wallet tool.",
  parameters: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["status", "wallets", "new", "use", "on", "off", "reset", "set", "add", "swap"],
        description: "status (default), wallets, new, use, on, off, reset, set, add or swap.",
      },
      wallet: {
        type: "string",
        description: "The paper wallet: whose status, which one to open (new) or pick (use), which one reset/set/add/swap act on. Omit for your current wallet.",
      },
      note: { type: "string", description: "For new: what the wallet is for — the theory or portfolio, one line." },
      startNative: {
        type: "string",
        description: "Virtual starting balance in native currency for new, reset (or on), e.g. '5'. Default LAINOS_PAPER_START_NATIVE or 1.",
      },
      asset: { type: "string", description: "For set/add: the coin, e.g. SOL. For swap: the coin sold." },
      to: { type: "string", description: "For swap: the coin bought, e.g. USDC or ETH." },
      amount: {
        type: "string",
        description: "For set/add: a plain amount, e.g. '1' or '0.5'; set 0 removes the coin. For swap: how much of `asset` to sell, or 'all'.",
      },
    },
  },
  examples: [
    { user: "turn on paper trading", agent: "Switching to paper — trades simulate from here." },
    { user: "how's the paper portfolio doing?", agent: "Valuing the paper account against live pools…" },
    { user: "sell one SOL for USDC", agent: "Paper-swapped 1 SOL → 104.87 USDC at the spot price." },
    { user: "test a momentum idea on paper, separately", agent: "Opened paper wallet momentum with 1 ETH — trading it from here." },
  ],
  async validate() {
    return true;
  },
  async handler(runtime, _state, params) {
    const svc = getService(runtime);
    const mode = String(params.mode ?? "status").trim().toLowerCase() || "status";
    const start = params.startNative === undefined || params.startNative === null ? undefined : String(params.startNative);
    const text = (v: unknown) => (v === undefined || v === null ? undefined : String(v));
    const coin = { asset: text(params.asset), amount: text(params.amount), to: text(params.to) };
    try {
      return await paperControl(svc, mode, start, coin, { actor: "lain", wallet: text(params.wallet), note: text(params.note) });
    } catch (err) {
      return { ok: false, text: `Paper trading: ${(err as Error).message}.` };
    }
  },
};

/**
 * The operator's `/paper` — a wallet's report, the switch, a reset, the wallets, and buy/sell
 * that go through the same buy_token / sell_token as Lain does. Everything acts on the
 * operator's current wallet and is paper always: a /paper command never spends real money.
 */
export async function paperCommand(runtime: IAgentRuntime, args: string[]): Promise<string> {
  const svc = getService(runtime);
  const [sub = "status", ...rest] = args.map((a) => a.trim()).filter(Boolean);
  const verb = sub.toLowerCase();
  const operator = (mode: string, extra: Omit<PaperAsk, "actor"> = {}, start?: string, coin?: Parameters<typeof paperControl>[3]) =>
    paperControl(svc, mode, start, coin, { actor: "operator", ...extra }).then((r) => r.text);
  try {
    if (verb === "buy" || verb === "sell") {
      const [token, amount] = rest;
      if (!token || !amount) return `usage: /paper ${verb} <token> <${verb === "buy" ? "native amount" : "token amount|all"}>`;
      const action = runtime.actions.find((a) => a.name === (verb === "buy" ? "buy_token" : "sell_token"));
      if (!action) return `${verb === "buy" ? "buy_token" : "sell_token"} is not loaded in this process.`;
      const wallet = svc.paper.current("operator");
      const params =
        verb === "buy" ? { token, amountNative: amount, wallet } : { token, amountToken: amount, reason: "operator /paper sell", wallet };
      const res = await action.handler(runtime, operatorState(), params);
      return res.text ?? (res.ok ? "done." : "failed.");
    }
    if (verb === "set" || verb === "add") {
      const [asset, amount] = rest;
      if (!asset || !amount) return `usage: /paper ${verb} <coin> <amount> — e.g. /paper set SOL 1`;
      return await operator(verb, {}, undefined, { asset, amount });
    }
    if (verb === "swap") {
      // "/paper swap 1 SOL USDC", "/paper swap SOL USDC 1", "/paper swap all SOL to ETH"
      const words = rest.filter((w) => !["to", "for", "into", "->", "→"].includes(w.toLowerCase()));
      const amount = words.find((w) => /^(\d+(\.\d+)?|all)$/i.test(w));
      const [from, to] = words.filter((w) => w !== amount);
      if (!amount || !from || !to) return "usage: /paper swap <amount|all> <coin> <coin> — e.g. /paper swap 1 SOL USDC";
      return await operator("swap", {}, undefined, { asset: from, to, amount });
    }
    if (verb === "new") {
      // "/paper new momentum 2 lain buys strength, sells weakness"
      const [name, ...more] = rest;
      if (!name) return "usage: /paper new <name> [start] [lain] [note…] — yours alone unless `lain`, e.g. /paper new dca 2 weekly buys only";
      const start = more[0] && /^\d+(\.\d+)?$/.test(more[0]) ? more.shift() : undefined;
      const lain = more[0]?.toLowerCase() === "lain" ? Boolean(more.shift()) : false;
      return await operator("new", { wallet: name, lain, note: more.join(" ") }, start);
    }
    if (verb === "use" || verb === "drop") {
      if (!rest[0]) return `usage: /paper ${verb} <wallet> — /paper wallets lists them`;
      return await operator(verb, { wallet: rest[0] });
    }
    if (verb === "lain") {
      const [name, flag = ""] = rest;
      if (!name || !["on", "off"].includes(flag.toLowerCase())) return "usage: /paper lain <wallet> on|off — let Lain trade it, or take it back";
      return await operator("lain", { wallet: name, lain: flag.toLowerCase() === "on" });
    }
    if (verb === "reset" || verb === "on") return await operator(verb, {}, rest[0]);
    if (verb === "status" || verb === "off" || verb === "wallets") return await operator(verb);
    // "/paper momentum" — one wallet's report, without switching to it.
    if (svc.paper.wallet(verb)) return await operator("status", { wallet: verb });
    return `unknown /paper ${verb} — /paper wallets lists the wallets, /help the commands.`;
  } catch (err) {
    return `paper: ${(err as Error).message}.`;
  }
}

/** A USD price as an integer, for exact bigint conversions between coins. */
function usdScale(price: number): bigint {
  return BigInt(Math.round(price * 1e8));
}

/** A decimal string for a report line, trimmed like {@link amt}. */
function amtText(amount: string): string {
  return amount.replace(/(\.\d{6})\d+$/, "$1");
}

function dollars(n: number): string {
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: n >= 1 ? 2 : 6 })}`;
}

/** An amount for a report line: full precision belongs in `data`, not in a sentence. */
function amt(wei: bigint): string {
  return formatEther(wei).replace(/(\.\d{6})\d+$/, "$1");
}

/** A token amount for a report line: two decimals once it is a whole number of tokens, six below. */
function units(raw: bigint, decimals: number): string {
  const s = formatUnits(raw, decimals);
  return s.replace(new RegExp(`(\\.\\d{${raw >= 10n ** BigInt(decimals) ? 2 : 6}})\\d+$`), "$1");
}

/** Local wall-clock "YYYY-MM-DD HH:MM" — the operator's own clock, like the TUI's. */
function stamp(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function signedPct(delta: bigint, base: bigint): string {
  if (base <= 0n) return "n/a";
  const bps = Number((delta * 10_000n) / base);
  return `${bps >= 0 ? "+" : ""}${(bps / 100).toFixed(2)}%`;
}
