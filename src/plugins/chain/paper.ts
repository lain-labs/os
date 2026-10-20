/**
 * Paper trading: the same trades against the same live pools, with nothing
 * sent. While paper mode is on, every trading path — buy_token, sell_token,
 * speculate_token, speculate_basket and the trader loop — sizes itself against
 * a virtual native balance and books its fills into a journal of its own. The
 * real wallet and its journal are never touched.
 *
 * A fill is the live quote at that moment: the pool's real reserves, its real
 * fee and price impact. What a paper result cannot show is said plainly in the
 * report — the pool does not move after a paper trade, no gas is paid, nobody
 * front-runs the swap.
 *
 * One account per chain id (a token address means nothing on another chain),
 * under data/paper/<chainId>/. The mode is one switch per process, stored in
 * data/paper/mode.json so a restart keeps it; LAINOS_PAPER is the default
 * until somebody flips it.
 *
 * Accounts come in named wallets, so several theories or portfolios run side
 * by side (data/paper/wallets.json; wallet <name> lives under
 * data/paper/wallets/<name>/<chainId>/). `main` is the original account, at
 * its old path, and always Lain's: her take-profit loop and the trench trade
 * there. Every other wallet says whether Lain trades it — the operator trades
 * them all, and a wallet that is the operator's alone is one Lain can read but
 * never trade. Lain and the operator each have a current wallet: the one a
 * trade goes into when it names none.
 *
 * Besides the chain's own currency an account can hold other coins — SOL next
 * to the paper ETH — booked straight in by the operator, never bought on a
 * DEX. They sit in the same account.json, so every report of the account
 * (/paper, paper_trading) shows them, and a reset clears them with the rest.
 * They trade among themselves and against the paper cash at the live spot
 * price (swapCoins): "sell 1 SOL for USDC" stays on paper too.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { formatUnits, parseEther, parseUnits } from "viem";
import { createLogger } from "../../logger.js";
import { TradeJournal } from "./journal.js";

const log = createLogger("plugin:chain:paper");

/** The virtual balance a fresh paper account starts from, when nothing says otherwise. */
export const DEFAULT_PAPER_START_NATIVE = "1";

/** Coin symbol → CoinGecko id: the coins a paper account can book and price. */
export const PAPER_COINS: Readonly<Record<string, string>> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  XMR: "monero",
  LTC: "litecoin",
  TRX: "tron",
  TON: "the-open-network",
  BNB: "binancecoin",
  USDT: "tether",
  USDC: "usd-coin",
};

const COIN_ALIASES: Readonly<Record<string, string>> = {
  BITCOIN: "BTC",
  ETHER: "ETH",
  ETHEREUM: "ETH",
  SOLANA: "SOL",
  MONERO: "XMR",
  LITECOIN: "LTC",
  TRON: "TRX",
  TONCOIN: "TON",
  TETHER: "USDT",
};

/** Coin amounts are exact decimal strings, computed in 18-decimal units. */
const COIN_DECIMALS = 18;

/** "solana" → "SOL"; null for a coin the paper account cannot hold. */
export function paperCoinSymbol(raw: string): string | null {
  const s = raw.trim().toUpperCase();
  const symbol = COIN_ALIASES[s] ?? s;
  return PAPER_COINS[symbol] ? symbol : null;
}

interface AccountFile {
  /** Virtual native balance the account started (or was last reset) with, wei. */
  startWei: string;
  /** Virtual native balance now, wei. */
  cashWei: string;
  startedAt: number;
  /** Other coins booked on paper: symbol → exact decimal amount. */
  coins?: Record<string, string>;
  /** Coin swaps, oldest first, capped at {@link MAX_SWAPS}. */
  swaps?: CoinSwap[];
  /**
   * What coins booked straight in (set/add) were worth in native when booked, wei — money
   * put in, not earned, so the return leaves it out. Negative when a booking took coins away.
   */
  depositsWei?: string;
}

/** One coin swap booked on paper at the spot price. */
export interface CoinSwap {
  ts: number;
  hash: string;
  from: string;
  fromAmount: string;
  to: string;
  toAmount: string;
  /** USD value of what was sold, at the price used. */
  usd: number;
}

const MAX_SWAPS = 20;

/** A fill booked into a paper account — what an action reports in place of a tx. */
export interface PaperFill {
  hash: string;
  realizedWei?: bigint;
}

/** One chain's virtual balance and its journal. */
export class PaperAccount {
  readonly journal: TradeJournal;
  private readonly file: string;
  private state: AccountFile;
  private fills = 0;

  constructor(
    dir: string,
    private readonly defaultStartWei: bigint,
  ) {
    this.file = join(dir, "account.json");
    this.journal = new TradeJournal(join(dir, "trades.json"));
    this.state = fresh(defaultStartWei);
  }

  async load(): Promise<void> {
    await this.journal.load();
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as Partial<AccountFile>;
      if (typeof parsed.startWei === "string" && typeof parsed.cashWei === "string") {
        const coins = Object.fromEntries(
          Object.entries(parsed.coins ?? {}).filter(([sym, amount]) => PAPER_COINS[sym] && typeof amount === "string"),
        );
        this.state = {
          startWei: parsed.startWei,
          cashWei: parsed.cashWei,
          startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : Date.now(),
          ...(Object.keys(coins).length ? { coins } : {}),
          ...(Array.isArray(parsed.swaps) && parsed.swaps.length ? { swaps: parsed.swaps.slice(-MAX_SWAPS) } : {}),
          ...(typeof parsed.depositsWei === "string" && /^-?\d+$/.test(parsed.depositsWei) ? { depositsWei: parsed.depositsWei } : {}),
        };
        return;
      }
    } catch {
      // A first paper trade on this chain: the account opens with the default.
    }
    await this.persist();
  }

  get cashWei(): bigint {
    return BigInt(this.state.cashWei);
  }

  get startWei(): bigint {
    return BigInt(this.state.startWei);
  }

  get startedAt(): number {
    return this.state.startedAt;
  }

  /** Native value of the coins booked straight in, at booking time (see AccountFile.depositsWei). */
  get depositsWei(): bigint {
    return BigInt(this.state.depositsWei ?? "0");
  }

  async recordDeposit(wei: bigint): Promise<void> {
    if (wei === 0n) return;
    this.state.depositsWei = (this.depositsWei + wei).toString();
    await this.persist();
  }

  /** The other coins on this account, in booking order. */
  coins(): { symbol: string; amount: string }[] {
    return Object.entries(this.state.coins ?? {}).map(([symbol, amount]) => ({ symbol, amount }));
  }

  /**
   * Make a coin's balance exactly `amount` ("0" removes it), or add `amount`
   * on top. Setting is the default on purpose: a resent "so I have 1 SOL"
   * must not become 2.
   */
  async bookCoin(symbol: string, amount: string, mode: "set" | "add" = "set"): Promise<{ before: string; after: string }> {
    if (!PAPER_COINS[symbol]) throw new Error(`${symbol} is not a coin the paper account can hold`);
    if (!/^\d+(\.\d{1,18})?$/.test(amount)) throw new Error(`amount must be a plain number like 1 or 0.5, not "${amount}"`);
    const coins = { ...(this.state.coins ?? {}) };
    const before = parseUnits(coins[symbol] ?? "0", COIN_DECIMALS);
    const after = mode === "set" ? parseUnits(amount, COIN_DECIMALS) : before + parseUnits(amount, COIN_DECIMALS);
    if (after === 0n) delete coins[symbol];
    else coins[symbol] = formatUnits(after, COIN_DECIMALS);
    this.state.coins = Object.keys(coins).length ? coins : undefined;
    await this.persist();
    return { before: formatUnits(before, COIN_DECIMALS), after: formatUnits(after, COIN_DECIMALS) };
  }

  /** A coin's balance in 18-decimal units; `native` names the coin that is the paper cash. */
  coinUnits(symbol: string, native: string): bigint {
    if (symbol === native) return this.cashWei;
    return parseUnits(this.state.coins?.[symbol] ?? "0", COIN_DECIMALS);
  }

  /**
   * Sell `amount` of one coin for another at USD spot prices, both sides in
   * one write. `native` is the chain's own currency, which lives in the cash
   * balance (wei, the same 18 decimals as the coins). The bought amount is
   * rounded down to 8 decimals: a spot price has no more precision than that.
   */
  async swapCoins(input: {
    from: string;
    to: string;
    amount: string;
    native: string;
    usd: { from: number; to: number };
  }): Promise<CoinSwap> {
    const { from, to, native } = input;
    for (const symbol of [from, to]) {
      if (symbol !== native && !PAPER_COINS[symbol]) throw new Error(`${symbol} is not a coin the paper account can hold`);
    }
    if (from === to) throw new Error("that swaps a coin for itself");
    const held = this.coinUnits(from, native);
    let sold: bigint;
    if (input.amount === "all") sold = held;
    else if (/^\d+(\.\d{1,18})?$/.test(input.amount)) sold = parseUnits(input.amount, COIN_DECIMALS);
    else throw new Error(`amount must be a plain number like 1 or 0.5, or "all" — not "${input.amount}"`);
    if (sold <= 0n) throw new Error(held === 0n ? `the paper account holds no ${from}` : "amount must be above zero");
    if (sold > held) throw new Error(`the paper account holds ${formatUnits(held, COIN_DECIMALS)} ${from}, less than ${input.amount}`);
    if (!(input.usd.from > 0) || !(input.usd.to > 0)) throw new Error("both coins need a live price");
    const scale = (p: number) => BigInt(Math.round(p * 1e8));
    const step = 10n ** 10n;
    const bought = ((sold * scale(input.usd.from)) / scale(input.usd.to) / step) * step;
    if (bought <= 0n) throw new Error(`${input.amount} ${from} is worth less than 0.00000001 ${to}`);

    const coins = { ...(this.state.coins ?? {}) };
    const move = (symbol: string, delta: bigint) => {
      if (symbol === native) {
        this.state.cashWei = (this.cashWei + delta).toString();
        return;
      }
      const next = parseUnits(coins[symbol] ?? "0", COIN_DECIMALS) + delta;
      if (next === 0n) delete coins[symbol];
      else coins[symbol] = formatUnits(next, COIN_DECIMALS);
    };
    move(from, -sold);
    move(to, bought);
    this.state.coins = Object.keys(coins).length ? coins : undefined;
    const swap: CoinSwap = {
      ts: Date.now(),
      hash: this.nextHash(),
      from,
      fromAmount: formatUnits(sold, COIN_DECIMALS),
      to,
      toAmount: formatUnits(bought, COIN_DECIMALS),
      usd: Number(formatUnits(sold, COIN_DECIMALS)) * input.usd.from,
    };
    this.state.swaps = [...(this.state.swaps ?? []), swap].slice(-MAX_SWAPS);
    await this.persist();
    return swap;
  }

  /** The latest coin swaps, oldest first. */
  recentSwaps(n = 5): CoinSwap[] {
    return (this.state.swaps ?? []).slice(-n);
  }

  /**
   * Make the paper cash exactly `amount` (native, decimal), or add `amount` on top — money
   * put in or taken out by hand, so the change is a deposit, not profit. Exact: no price needed.
   */
  async bookCash(amount: string, mode: "set" | "add" = "set"): Promise<{ before: bigint; after: bigint }> {
    if (!/^\d+(\.\d{1,18})?$/.test(amount)) throw new Error(`amount must be a plain number like 1 or 0.5, not "${amount}"`);
    const before = this.cashWei;
    const after = mode === "set" ? parseEther(amount) : before + parseEther(amount);
    this.state.cashWei = after.toString();
    this.state.depositsWei = (this.depositsWei + after - before).toString();
    await this.persist();
    return { before, after };
  }

  /** Token units held on paper (raw), 0 when there is no position. */
  holding(token: string): bigint {
    const pos = this.journal.positionOf(token);
    return pos ? BigInt(pos.qtyWei) : 0n;
  }

  async buy(input: { token: string; symbol: string; qtyWei: bigint; nativeWei: bigint; reason?: string }): Promise<PaperFill> {
    if (input.nativeWei > this.cashWei) {
      throw new Error("the paper balance cannot cover this buy");
    }
    const hash = this.nextHash();
    this.state.cashWei = (this.cashWei - input.nativeWei).toString();
    await this.journal.recordBuy({ ...input, txHash: hash });
    await this.persist();
    return { hash };
  }

  async sell(input: { token: string; symbol: string; qtyWei: bigint; nativeWei: bigint; reason?: string }): Promise<PaperFill> {
    if (input.qtyWei > this.holding(input.token)) {
      throw new Error(`the paper account holds less ${input.symbol} than that`);
    }
    const hash = this.nextHash();
    this.state.cashWei = (this.cashWei + input.nativeWei).toString();
    const realizedWei = await this.journal.recordSell({ ...input, txHash: hash });
    await this.persist();
    return { hash, realizedWei };
  }

  /** Start over: a new virtual balance, no positions, no history, no other coins. */
  async reset(startWei = this.defaultStartWei): Promise<void> {
    this.state = fresh(startWei);
    await this.journal.clear();
    await this.persist();
  }

  private nextHash(): string {
    this.fills += 1;
    return `paper-${Date.now().toString(36)}-${this.fills}`;
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(this.file, JSON.stringify(this.state, null, 2), "utf8");
    } catch (err) {
      log.warn("could not persist the paper account", err);
    }
  }
}

/** The wallet that was the only paper account before there were wallets: Lain's, for good. */
export const MAIN_WALLET = "main";

/** A named paper wallet: its own cash, positions and coins on every chain it trades. */
export interface PaperWallet {
  name: string;
  /** Lain trades it. The operator trades every wallet; with this off, only the operator does. */
  lain: boolean;
  /** What it is for — the theory it tests, the portfolio it holds. */
  note?: string;
  /** What each of its chain accounts opens with, wei. */
  startWei: string;
  createdAt: number;
}

/** Who acts on a wallet: Lain through her tools, or the operator through /paper. */
export type PaperActor = "lain" | "operator";

interface WalletsFile {
  wallets: PaperWallet[];
  current: Record<PaperActor, string>;
}

const WALLET_NAME = /^[a-z0-9][a-z0-9_-]{0,23}$/;

/** The paper switch for this process, its wallets and the accounts it has opened. */
export class PaperDesk {
  private on: boolean;
  private readonly accounts = new Map<string, PaperAccount>();
  private readonly modeFile: string;
  private readonly walletsFile: string;
  private book: WalletsFile;

  constructor(
    private readonly dir: string,
    readonly defaultStartWei: bigint,
    defaultOn: boolean,
  ) {
    this.modeFile = join(dir, "mode.json");
    this.walletsFile = join(dir, "wallets.json");
    this.on = defaultOn;
    this.book = this.freshBook();
  }

  /** Read the stored switch (it wins over LAINOS_PAPER) and the wallets. */
  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.modeFile, "utf8")) as { enabled?: unknown };
      if (typeof parsed.enabled === "boolean") this.on = parsed.enabled;
    } catch {
      // Never flipped: the env default stands.
    }
    try {
      const parsed = JSON.parse(await readFile(this.walletsFile, "utf8")) as Partial<WalletsFile>;
      const wallets = (Array.isArray(parsed.wallets) ? parsed.wallets : []).filter(
        (w): w is PaperWallet => typeof w?.name === "string" && WALLET_NAME.test(w.name) && typeof w.startWei === "string",
      );
      const book = this.freshBook();
      for (const w of wallets) {
        // main opens with LAINOS_PAPER_START_NATIVE, as it always has.
        if (w.name === MAIN_WALLET) book.wallets[0] = { ...w, lain: true, startWei: this.defaultStartWei.toString() };
        else book.wallets.push({ ...w, lain: w.lain === true });
      }
      for (const actor of ["lain", "operator"] as const) {
        const name = parsed.current?.[actor];
        const w = book.wallets.find((x) => x.name === name);
        if (w && (actor === "operator" || w.lain)) book.current[actor] = w.name;
      }
      this.book = book;
    } catch {
      // No wallets yet: there is main, and both sides use it.
    }
  }

  /** Every wallet, main first. */
  wallets(): PaperWallet[] {
    return this.book.wallets.map((w) => ({ ...w }));
  }

  wallet(name: string): PaperWallet | undefined {
    const w = this.book.wallets.find((x) => x.name === name.trim().toLowerCase());
    return w ? { ...w } : undefined;
  }

  /** The wallet a trade by `actor` goes into when it names none. */
  current(actor: PaperActor): string {
    return this.book.current[actor];
  }

  /** Make `name` the actor's current wallet. Lain's must be one she trades. */
  async select(actor: PaperActor, name: string): Promise<PaperWallet> {
    const w = this.wallet(name);
    if (!w) throw new Error(`there is no paper wallet "${name}"`);
    if (actor === "lain" && !w.lain) throw new Error(`${w.name} is the operator's wallet — Lain does not trade it`);
    this.book.current[actor] = w.name;
    await this.persistWallets();
    return w;
  }

  async createWallet(input: { name: string; lain: boolean; note?: string; startWei?: bigint }): Promise<PaperWallet> {
    const name = input.name.trim().toLowerCase();
    if (!WALLET_NAME.test(name)) {
      throw new Error(`a wallet name is 1–24 of a-z, 0-9, - and _, starting with a letter or digit — not "${input.name}"`);
    }
    if (this.wallet(name)) throw new Error(`there already is a paper wallet "${name}"`);
    const startWei = input.startWei ?? this.defaultStartWei;
    if (startWei <= 0n) throw new Error("a wallet starts with a positive balance");
    const wallet: PaperWallet = {
      name,
      lain: input.lain,
      ...(input.note?.trim() ? { note: input.note.trim().slice(0, 200) } : {}),
      startWei: startWei.toString(),
      createdAt: Date.now(),
    };
    this.book.wallets.push(wallet);
    await this.persistWallets();
    return { ...wallet };
  }

  /** Let Lain trade a wallet, or take it back. main is hers for good. */
  async setLain(name: string, lain: boolean): Promise<PaperWallet> {
    const w = this.book.wallets.find((x) => x.name === name.trim().toLowerCase());
    if (!w) throw new Error(`there is no paper wallet "${name}"`);
    if (w.name === MAIN_WALLET && !lain) throw new Error("main is Lain's own wallet (her take-profit loop and the trench trade it)");
    w.lain = lain;
    if (!lain && this.book.current.lain === w.name) this.book.current.lain = MAIN_WALLET;
    await this.persistWallets();
    return { ...w };
  }

  /** Take a wallet off the desk. Its files are moved aside under wallets/.removed, not deleted. */
  async removeWallet(name: string): Promise<PaperWallet> {
    const w = this.wallet(name);
    if (!w) throw new Error(`there is no paper wallet "${name}"`);
    if (w.name === MAIN_WALLET) throw new Error("main cannot be removed — reset it instead");
    const from = join(this.dir, "wallets", w.name);
    try {
      await mkdir(join(this.dir, "wallets", ".removed"), { recursive: true });
      await rename(from, join(this.dir, "wallets", ".removed", `${w.name}-${Date.now()}`));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    this.book.wallets = this.book.wallets.filter((x) => x.name !== w.name);
    for (const actor of ["lain", "operator"] as const) {
      if (this.book.current[actor] === w.name) this.book.current[actor] = MAIN_WALLET;
    }
    for (const key of [...this.accounts.keys()]) if (key.startsWith(`${w.name}:`)) this.accounts.delete(key);
    await this.persistWallets();
    return w;
  }

  get enabled(): boolean {
    return this.on;
  }

  async setEnabled(on: boolean): Promise<void> {
    this.on = on;
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(
        this.modeFile,
        JSON.stringify({ enabled: on, updatedAt: new Date().toISOString() }, null, 2),
        "utf8",
      );
    } catch (err) {
      log.warn("could not persist paper mode", err);
    }
    log.info(on ? "paper mode on — trades are simulated" : "paper mode off — trades are real again");
  }

  /** A wallet's account on a chain, opened (and loaded) on first use. main's lives at the old path. */
  async account(chainId: number, wallet: string = MAIN_WALLET): Promise<PaperAccount> {
    const w = this.wallet(wallet);
    if (!w) throw new Error(`there is no paper wallet "${wallet}"`);
    const key = `${w.name}:${chainId}`;
    let account = this.accounts.get(key);
    if (!account) {
      const dir = w.name === MAIN_WALLET ? join(this.dir, String(chainId)) : join(this.dir, "wallets", w.name, String(chainId));
      account = new PaperAccount(dir, BigInt(w.startWei));
      await account.load();
      this.accounts.set(key, account);
    }
    return account;
  }

  private freshBook(): WalletsFile {
    return {
      wallets: [
        {
          name: MAIN_WALLET,
          lain: true,
          note: "Lain's own — her take-profit loop and the trench trade here",
          startWei: this.defaultStartWei.toString(),
          createdAt: 0,
        },
      ],
      current: { lain: MAIN_WALLET, operator: MAIN_WALLET },
    };
  }

  private async persistWallets(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.walletsFile, JSON.stringify(this.book, null, 2), "utf8");
  }
}

/** LAINOS_PAPER_START_NATIVE as wei; an unreadable value falls back to the default. */
export function paperStartWei(raw: string | undefined): bigint {
  const value = raw?.trim() || DEFAULT_PAPER_START_NATIVE;
  try {
    const wei = parseEther(value);
    if (wei > 0n) return wei;
  } catch {
    // fall through
  }
  log.warn(`LAINOS_PAPER_START_NATIVE="${value}" is not a positive amount — using ${DEFAULT_PAPER_START_NATIVE}`);
  return parseEther(DEFAULT_PAPER_START_NATIVE);
}

function fresh(startWei: bigint): AccountFile {
  return { startWei: startWei.toString(), cashWei: startWei.toString(), startedAt: Date.now() };
}
