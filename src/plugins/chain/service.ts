/**
 * The long-lived chain client: one public client for reads, an optional wallet
 * client for writes, and the trade journal that gives every position a
 * native-currency cost basis. Actions never touch viem directly — they come
 * through here.
 */
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  formatUnits,
  http,
  isAddress,
  type Address,
  type Chain,
  type PublicClient,
  type WalletClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createLogger } from "../../logger.js";
import { TradeJournal } from "./journal.js";
import type { IAgentRuntime, Service } from "../../types.js";
import { loadChainConfig, loadChainTokens, loadDexConfig, ZERO_ADDRESS, type ChainDexConfig } from "./chain.js";
import { ERC20_ABI, FACTORY_ABI, PAIR_ABI, ROUTER_ABI } from "./abi.js";
import {
  getAmountOut,
  maxBigint,
  minBigint,
  minOutForSlippage,
  optimalLiquidityAmounts,
  parsePositiveUnits,
  priceImpactBps,
  sameAddress,
} from "./math.js";
import { DEFAULT_LIQUIDITY_GAS_RESERVE_NATIVE, parseConfigNative } from "./config.js";

const log = createLogger("plugin:chain");

export interface NativeBuyQuote {
  token: Address;
  symbol: string;
  decimals: number;
  amountInWei: bigint;
  amountOut: bigint;
  pair: Address;
  reserveNative: bigint;
  reserveToken: bigint;
  priceImpactBps: number;
  path: [Address, Address];
}

export interface NativeSellQuote {
  token: Address;
  symbol: string;
  decimals: number;
  /** Token amount sold, raw units. */
  amountInWei: bigint;
  /** Expected native-currency out, wei. */
  amountOut: bigint;
  pair: Address;
  reserveNative: bigint;
  reserveToken: bigint;
  priceImpactBps: number;
  path: [Address, Address];
}

export interface LiquidityAsset {
  kind: "native" | "erc20";
  token: Address;
  symbol: string;
  decimals: number;
  raw: string;
}

export interface DexLiquidityQuote {
  assetA: LiquidityAsset;
  assetB: LiquidityAsset;
  amountADesired: bigint;
  amountBDesired: bigint;
  amountAUsed: bigint;
  amountBUsed: bigint;
  amountARefund: bigint;
  amountBRefund: bigint;
  amountAMin: bigint;
  amountBMin: bigint;
  pair: Address;
  reserveA: bigint;
  reserveB: bigint;
  totalSupply: bigint;
  expectedLp: bigint;
  poolShareBps: number;
  slippageBps: number;
  confirmation: string | null;
  confirmationReason: string | null;
}

/**
 * Long-lived chain client; exposes read/write helpers to actions.
 *
 * The chain itself is optional: an operator who hasn't set CHAIN_RPC_URL/
 * CHAIN_ID yet still gets a working agent (chat, telegram, forge, ...) — only
 * the chain-dependent tools fail, with a clear "not configured" message,
 * instead of the whole daemon refusing to boot.
 */
export class ChainService implements Service {
  readonly name = "chain";
  public walletClient?: WalletClient;
  public agentAddress?: Address;
  public nativeSymbol = "ETH";
  public explorerUrl?: string;
  public explorerApiUrl?: string;
  public tokens: Record<string, Address> = {};

  /** Every DEX trade is journaled here with its native-currency cost basis. */
  public journal!: TradeJournal;

  private _publicClient?: PublicClient;
  private _chain?: Chain;
  private _dex?: ChainDexConfig;
  private rpc = "";
  private walletFile = "";

  async start(runtime: IAgentRuntime): Promise<void> {
    const dataDir = runtime.getSetting("LAINOS_DATA_DIR") ?? "./data";
    this.walletFile = join(dataDir, "wallet.json");
    this.journal = new TradeJournal(join(dataDir, "trades.json"));
    await this.journal.load();
    await this.configure(runtime);
  }

  /**
   * Re-read every CHAIN_* setting and rebuild the clients — a network switch
   * (switch_network, /network, set_setting on a CHAIN_ key) takes effect at
   * once instead of leaving every chain tool failing until a restart. The
   * journal and the stored wallet are not touched. Returns the reason the
   * chain is unconfigured, or null when it is up.
   */
  async reload(runtime: IAgentRuntime): Promise<string | null> {
    return this.configure(runtime);
  }

  private async configure(runtime: IAgentRuntime): Promise<string | null> {
    const getSetting = (key: string) => runtime.getSetting(key);
    this._chain = undefined;
    this._publicClient = undefined;
    this._dex = undefined;
    this.walletClient = undefined;
    this.agentAddress = undefined;
    this.tokens = {};
    this.explorerUrl = undefined;
    this.explorerApiUrl = undefined;
    this.nativeSymbol = getSetting("CHAIN_NATIVE_SYMBOL") || "ETH";

    let chainConfig;
    try {
      chainConfig = loadChainConfig(getSetting);
    } catch (err) {
      const reason = (err as Error).message;
      log.warn(`chain plugin not configured — chain tools will fail until it is (${reason})`);
      return reason;
    }
    const { chain, nativeSymbol, explorerUrl } = chainConfig;
    this._chain = chain;
    this.nativeSymbol = nativeSymbol;
    this.explorerUrl = explorerUrl;
    this.explorerApiUrl = getSetting("CHAIN_EXPLORER_API_URL")?.trim() || (explorerUrl ? `${explorerUrl}/api/v2` : undefined);
    this.tokens = loadChainTokens(getSetting);
    try {
      this._dex = loadDexConfig(getSetting);
    } catch (err) {
      // A half-configured DEX disables trading, not the whole chain.
      log.warn(`DEX disabled: ${(err as Error).message}`);
    }

    this.rpc = chain.rpcUrls.default.http[0]!;
    this._publicClient = createPublicClient({
      chain,
      transport: http(this.rpc),
    });

    const pk = runtime.getSetting("CHAIN_AGENT_PK");
    if (pk && /^0x[0-9a-fA-F]{64}$/.test(pk)) {
      this.activateSigner(pk as `0x${string}`);
      log.info(`signer enabled for ${this.agentAddress}`);
      return null;
    }
    const stored = await this.loadStoredWallet();
    if (stored) {
      this.activateSigner(stored);
      log.info(`signer restored from ${this.walletFile} for ${this.agentAddress}`);
    } else {
      log.info("read-only mode (no key configured; create_wallet can make one).");
    }
    return null;
  }

  /** True once CHAIN_RPC_URL/CHAIN_ID have been loaded successfully. */
  get configured(): boolean {
    return Boolean(this._chain && this._publicClient);
  }

  get chain(): Chain {
    if (!this._chain) {
      throw new Error("no chain configured — set CHAIN_RPC_URL and CHAIN_ID.");
    }
    return this._chain;
  }

  get publicClient(): PublicClient {
    if (!this._publicClient) {
      throw new Error("no chain configured — set CHAIN_RPC_URL and CHAIN_ID.");
    }
    return this._publicClient;
  }

  /** The configured DEX (factory/router/wrapped-native); throws if not set. */
  get dex(): ChainDexConfig {
    if (!this._dex) {
      throw new Error(
        "no DEX configured — set CHAIN_DEX_FACTORY, CHAIN_DEX_ROUTER and CHAIN_DEX_WRAPPED_NATIVE to enable trading/liquidity.",
      );
    }
    return this._dex;
  }

  private activateSigner(pk: `0x${string}`): void {
    const account = privateKeyToAccount(pk);
    this.agentAddress = account.address;
    // The address is valid without a configured chain — only the write
    // client (which needs an RPC to send to) requires one.
    if (!this.configured) return;
    this.walletClient = createWalletClient({
      account,
      chain: this.chain,
      transport: http(this.rpc),
    });
  }

  private async loadStoredWallet(): Promise<`0x${string}` | null> {
    try {
      const parsed = JSON.parse(await readFile(this.walletFile, "utf8")) as {
        privateKey?: string;
      };
      if (parsed.privateKey && /^0x[0-9a-fA-F]{64}$/.test(parsed.privateKey)) {
        return parsed.privateKey as `0x${string}`;
      }
    } catch {
      // No stored wallet yet.
    }
    return null;
  }

  /**
   * Create the agent's own wallet: generate a keypair, persist it to the data
   * dir (0600, gitignored), and activate the signer. The private key never
   * leaves this service — callers only ever get the address.
   */
  async createWallet(): Promise<{ address: Address; created: boolean }> {
    if (this.agentAddress) return { address: this.agentAddress, created: false };
    const pk = generatePrivateKey();
    const address = privateKeyToAccount(pk).address;
    await mkdir(dirname(this.walletFile), { recursive: true });
    await writeFile(this.walletFile, JSON.stringify({ address, privateKey: pk }, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(this.walletFile, 0o600); // mode above is ignored if the file pre-existed
    this.activateSigner(pk);
    log.info(`wallet created for ${address} (key in ${this.walletFile})`);
    return { address, created: true };
  }

  /** Link to a transaction on the configured explorer, or undefined if none is set. */
  explorerTxUrl(hash: string): string | undefined {
    return this.explorerUrl ? `${this.explorerUrl}/tx/${hash}` : undefined;
  }

  /** Link to an address on the configured explorer, or undefined if none is set. */
  explorerAddressUrl(address: string): string | undefined {
    return this.explorerUrl ? `${this.explorerUrl}/address/${address}` : undefined;
  }

  /** The RPC endpoint in use, or "" when unconfigured. */
  get rpcUrl(): string {
    return this.configured ? this.rpc : "";
  }

  resolveToken(token: string): Address | undefined {
    if (isAddress(token)) return token as Address;
    return this.tokens[token.toUpperCase()];
  }

  async nativeBalance(address: Address): Promise<string> {
    const wei = await this.publicClient.getBalance({ address });
    return formatEther(wei);
  }

  async tokenBalance(
    token: Address,
    address: Address,
  ): Promise<{ amount: string; symbol: string }> {
    const [raw, decimals, symbol] = await Promise.all([
      this.publicClient.readContract({
        address: token,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [address],
      }),
      this.publicClient.readContract({
        address: token,
        abi: ERC20_ABI,
        functionName: "decimals",
      }),
      this.publicClient
        .readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" })
        .catch(() => "TOKEN"),
    ]);
    return { amount: formatUnits(raw as bigint, Number(decimals)), symbol: symbol as string };
  }

  async tokenInfo(
    token: Address,
  ): Promise<{ symbol: string; decimals: number; supply: string }> {
    const [symbol, decimals, supplyRaw] = await Promise.all([
      this.publicClient
        .readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" })
        .catch(() => "TOKEN"),
      this.publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" }),
      this.publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "totalSupply" }),
    ]);
    const dec = Number(decimals);
    return { symbol: symbol as string, decimals: dec, supply: formatUnits(supplyRaw as bigint, dec) };
  }

  async quoteNativeBuy(token: Address, amountInWei: bigint): Promise<NativeBuyQuote> {
    if (amountInWei <= 0n) throw new Error("amount must be positive");
    const dex = this.dex;
    if (sameAddress(token, dex.wrappedNative)) {
      throw new Error("wrapping the native currency is not a DEX swap; use the DEX's own wrap flow");
    }

    const pair = (await this.publicClient.readContract({
      address: dex.factory,
      abi: FACTORY_ABI,
      functionName: "getPair",
      args: [dex.wrappedNative, token],
    })) as Address;
    if (sameAddress(pair, ZERO_ADDRESS)) throw new Error("no pair with the wrapped native token was found");

    const [[reserve0, reserve1], token0, info] = await Promise.all([
      this.publicClient.readContract({
        address: pair,
        abi: PAIR_ABI,
        functionName: "getReserves",
      }) as Promise<readonly [bigint, bigint, number]>,
      this.publicClient.readContract({
        address: pair,
        abi: PAIR_ABI,
        functionName: "token0",
      }) as Promise<Address>,
      this.tokenInfo(token),
    ]);

    const nativeIs0 = sameAddress(token0, dex.wrappedNative);
    const reserveNative = nativeIs0 ? reserve0 : reserve1;
    const reserveToken = nativeIs0 ? reserve1 : reserve0;
    if (reserveNative <= 0n || reserveToken <= 0n) throw new Error("pool has no usable reserves");

    const amountOut = getAmountOut(amountInWei, reserveNative, reserveToken);
    if (amountOut <= 0n) throw new Error("trade is too small for this pool");

    return {
      token,
      symbol: info.symbol,
      decimals: info.decimals,
      amountInWei,
      amountOut,
      pair,
      reserveNative,
      reserveToken,
      priceImpactBps: priceImpactBps(amountInWei, reserveNative, reserveToken, amountOut),
      path: [dex.wrappedNative, token],
    };
  }

  /** Quote selling an ERC20 back into the native currency via its wrapped-native pair. */
  async quoteNativeSell(token: Address, amountInWei: bigint): Promise<NativeSellQuote> {
    if (amountInWei <= 0n) throw new Error("amount must be positive");
    const dex = this.dex;
    if (sameAddress(token, dex.wrappedNative)) {
      throw new Error("unwrapping the wrapped native token is not a DEX swap; use the DEX's own wrap flow");
    }

    const pair = (await this.publicClient.readContract({
      address: dex.factory,
      abi: FACTORY_ABI,
      functionName: "getPair",
      args: [dex.wrappedNative, token],
    })) as Address;
    if (sameAddress(pair, ZERO_ADDRESS)) throw new Error("no pair with the wrapped native token was found");

    const [[reserve0, reserve1], token0, info] = await Promise.all([
      this.publicClient.readContract({
        address: pair,
        abi: PAIR_ABI,
        functionName: "getReserves",
      }) as Promise<readonly [bigint, bigint, number]>,
      this.publicClient.readContract({
        address: pair,
        abi: PAIR_ABI,
        functionName: "token0",
      }) as Promise<Address>,
      this.tokenInfo(token),
    ]);

    const nativeIs0 = sameAddress(token0, dex.wrappedNative);
    const reserveNative = nativeIs0 ? reserve0 : reserve1;
    const reserveToken = nativeIs0 ? reserve1 : reserve0;
    if (reserveNative <= 0n || reserveToken <= 0n) throw new Error("pool has no usable reserves");

    const amountOut = getAmountOut(amountInWei, reserveToken, reserveNative);
    if (amountOut <= 0n) throw new Error("trade is too small for this pool");

    return {
      token,
      symbol: info.symbol,
      decimals: info.decimals,
      amountInWei,
      amountOut,
      pair,
      reserveNative,
      reserveToken,
      priceImpactBps: priceImpactBps(amountInWei, reserveToken, reserveNative, amountOut),
      path: [token, dex.wrappedNative],
    };
  }

  async quoteAddLiquidity(input: {
    tokenA: string;
    tokenB: string;
    amountA: string;
    amountB: string;
    slippageBps: number;
    confirmThresholdWei: bigint;
  }): Promise<DexLiquidityQuote> {
    const dex = this.dex;
    const assetA = await this.resolveLiquidityAsset(input.tokenA);
    const assetB = await this.resolveLiquidityAsset(input.tokenB);
    if (assetA.kind === "native" && assetB.kind === "native") {
      throw new Error("liquidity needs one ERC20 side; native/native is invalid");
    }
    if (sameAddress(assetA.token, assetB.token)) {
      throw new Error("liquidity tokens must be different");
    }

    const amountADesired = parsePositiveUnits(input.amountA, assetA.decimals);
    const amountBDesired = parsePositiveUnits(input.amountB, assetB.decimals);
    if (amountADesired === null || amountBDesired === null) {
      throw new Error("amountA and amountB must be positive decimal amounts");
    }

    const pair = (await this.publicClient.readContract({
      address: dex.factory,
      abi: FACTORY_ABI,
      functionName: "getPair",
      args: [assetA.token, assetB.token],
    })) as Address;
    if (sameAddress(pair, ZERO_ADDRESS)) {
      throw new Error("no existing pair found; refusing first-liquidity creation");
    }

    const [[reserve0, reserve1], token0, totalSupply] = await Promise.all([
      this.publicClient.readContract({
        address: pair,
        abi: PAIR_ABI,
        functionName: "getReserves",
      }) as Promise<readonly [bigint, bigint, number]>,
      this.publicClient.readContract({
        address: pair,
        abi: PAIR_ABI,
        functionName: "token0",
      }) as Promise<Address>,
      this.publicClient.readContract({
        address: pair,
        abi: ERC20_ABI,
        functionName: "totalSupply",
      }) as Promise<bigint>,
    ]);
    const aIs0 = sameAddress(token0, assetA.token);
    const reserveA = aIs0 ? reserve0 : reserve1;
    const reserveB = aIs0 ? reserve1 : reserve0;
    if (reserveA <= 0n || reserveB <= 0n || totalSupply <= 0n) {
      throw new Error("pool has no usable reserves");
    }

    const [amountAUsed, amountBUsed] = optimalLiquidityAmounts(
      amountADesired,
      amountBDesired,
      reserveA,
      reserveB,
    );
    if (amountAUsed <= 0n || amountBUsed <= 0n) throw new Error("amounts are too small for this pool");
    const expectedLp = minBigint(
      (amountAUsed * totalSupply) / reserveA,
      (amountBUsed * totalSupply) / reserveB,
    );
    if (expectedLp <= 0n) throw new Error("liquidity amount is too small to mint LP tokens");

    const amountAMin = minOutForSlippage(amountAUsed, input.slippageBps);
    const amountBMin = minOutForSlippage(amountBUsed, input.slippageBps);
    const poolShareBps = Number(
      maxBigint((amountAUsed * 10_000n) / reserveA, (amountBUsed * 10_000n) / reserveB),
    );
    const nativeSpend = assetA.kind === "native"
      ? amountAUsed
      : assetB.kind === "native"
        ? amountBUsed
        : null;
    const confirmationReason =
      nativeSpend !== null && nativeSpend > input.confirmThresholdWei
        ? `native spend ${formatEther(nativeSpend)} ${this.nativeSymbol} exceeds ${formatEther(input.confirmThresholdWei)} ${this.nativeSymbol}`
        : nativeSpend === null
          ? "token-token liquidity has no native-currency spend threshold valuation"
          : null;
    const confirmation = confirmationReason
      ? `ADD_LP ${formatUnits(amountAUsed, assetA.decimals)} ${assetA.symbol} + ${formatUnits(amountBUsed, assetB.decimals)} ${assetB.symbol}`
      : null;

    return {
      assetA,
      assetB,
      amountADesired,
      amountBDesired,
      amountAUsed,
      amountBUsed,
      amountARefund: amountADesired - amountAUsed,
      amountBRefund: amountBDesired - amountBUsed,
      amountAMin,
      amountBMin,
      pair,
      reserveA,
      reserveB,
      totalSupply,
      expectedLp,
      poolShareBps,
      slippageBps: input.slippageBps,
      confirmation,
      confirmationReason,
    };
  }

  async addLiquidity(
    quote: DexLiquidityQuote,
    deadlineSeconds: number,
  ): Promise<{
    hash: `0x${string}`;
    status: "success" | "reverted";
    mintedLp: bigint;
    approveHashes: `0x${string}`[];
  }> {
    const dex = this.dex;
    if (!this.walletClient || !this.agentAddress) throw new Error("no signer configured");
    await this.assertLiquidityBalances(quote);
    const approveHashes: `0x${string}`[] = [];
    if (quote.assetA.kind === "erc20") {
      approveHashes.push(...(await this.approveIfNeeded(quote.assetA.token, quote.amountAUsed)));
    }
    if (quote.assetB.kind === "erc20") {
      approveHashes.push(...(await this.approveIfNeeded(quote.assetB.token, quote.amountBUsed)));
    }

    const beforeLp = (await this.publicClient.readContract({
      address: quote.pair,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [this.agentAddress],
    })) as bigint;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSeconds);

    let hash: `0x${string}`;
    if (quote.assetA.kind === "native" || quote.assetB.kind === "native") {
      const nativeIsA = quote.assetA.kind === "native";
      const tokenAsset = nativeIsA ? quote.assetB : quote.assetA;
      const amountTokenDesired = nativeIsA ? quote.amountBUsed : quote.amountAUsed;
      const amountTokenMin = nativeIsA ? quote.amountBMin : quote.amountAMin;
      const amountNativeDesired = nativeIsA ? quote.amountAUsed : quote.amountBUsed;
      const amountNativeMin = nativeIsA ? quote.amountAMin : quote.amountBMin;
      hash = await this.walletClient.writeContract({
        account: this.walletClient.account!,
        chain: this.chain,
        address: dex.router,
        abi: ROUTER_ABI,
        functionName: "addLiquidityETH",
        args: [
          tokenAsset.token,
          amountTokenDesired,
          amountTokenMin,
          amountNativeMin,
          this.agentAddress,
          deadline,
        ],
        value: amountNativeDesired,
      });
    } else {
      hash = await this.walletClient.writeContract({
        account: this.walletClient.account!,
        chain: this.chain,
        address: dex.router,
        abi: ROUTER_ABI,
        functionName: "addLiquidity",
        args: [
          quote.assetA.token,
          quote.assetB.token,
          quote.amountAUsed,
          quote.amountBUsed,
          quote.amountAMin,
          quote.amountBMin,
          this.agentAddress,
          deadline,
        ],
      });
    }

    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    const afterLp = (await this.publicClient.readContract({
      address: quote.pair,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [this.agentAddress],
    })) as bigint;
    const mintedLp = afterLp > beforeLp ? afterLp - beforeLp : 0n;
    return {
      hash,
      status: receipt.status === "success" ? "success" : "reverted",
      mintedLp,
      approveHashes,
    };
  }

  private async resolveLiquidityAsset(raw: string): Promise<LiquidityAsset> {
    const normalized = raw.trim();
    const dex = this.dex;
    if (new RegExp(`^(NATIVE|${this.nativeSymbol})$`, "i").test(normalized)) {
      return {
        kind: "native",
        token: dex.wrappedNative,
        symbol: this.nativeSymbol,
        decimals: 18,
        raw: normalized,
      };
    }
    const token = this.resolveToken(normalized);
    if (!token) throw new Error(`unknown token "${raw}"`);
    if (sameAddress(token, dex.wrappedNative)) {
      throw new Error(`use NATIVE (or ${this.nativeSymbol}) for native liquidity instead of the wrapped native address`);
    }
    const info = await this.tokenInfo(token);
    return {
      kind: "erc20",
      token,
      symbol: info.symbol,
      decimals: info.decimals,
      raw: normalized,
    };
  }

  private async approveIfNeeded(token: Address, amount: bigint): Promise<`0x${string}`[]> {
    const dex = this.dex;
    if (!this.walletClient || !this.agentAddress) throw new Error("no signer configured");
    const allowance = (await this.publicClient.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [this.agentAddress, dex.router],
    })) as bigint;
    if (allowance >= amount) return [];
    const approveHash = await this.walletClient.writeContract({
      account: this.walletClient.account!,
      chain: this.chain,
      address: token,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [dex.router, amount],
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: approveHash });
    if (receipt.status !== "success") throw new Error(`router approval reverted: ${approveHash}`);
    return [approveHash];
  }

  private async assertLiquidityBalances(quote: DexLiquidityQuote): Promise<void> {
    if (!this.agentAddress) throw new Error("no signer configured");
    const nativeNeed =
      (quote.assetA.kind === "native" ? quote.amountAUsed : 0n) +
      (quote.assetB.kind === "native" ? quote.amountBUsed : 0n);
    const gasReserve = parseConfigNative(
      process.env.LAINOS_LIQUIDITY_GAS_RESERVE_NATIVE,
      DEFAULT_LIQUIDITY_GAS_RESERVE_NATIVE,
      "LAINOS_LIQUIDITY_GAS_RESERVE_NATIVE",
    );
    const nativeBalance = await this.publicClient.getBalance({ address: this.agentAddress });
    if (nativeBalance < nativeNeed + gasReserve) {
      throw new Error(
        `insufficient ${this.nativeSymbol}: need ${formatEther(nativeNeed)} plus ${formatEther(gasReserve)} gas reserve, hold ${formatEther(nativeBalance)}`,
      );
    }
    for (const [asset, need] of [
      [quote.assetA, quote.amountAUsed],
      [quote.assetB, quote.amountBUsed],
    ] as const) {
      if (asset.kind !== "erc20") continue;
      const balance = (await this.publicClient.readContract({
        address: asset.token,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [this.agentAddress],
      })) as bigint;
      if (balance < need) {
        throw new Error(
          `insufficient ${asset.symbol}: need ${formatUnits(need, asset.decimals)}, hold ${formatUnits(balance, asset.decimals)}`,
        );
      }
    }
  }

  /**
   * Execute a token → native-currency sell: ensure router allowance, then
   * swapExactTokensForETH with slippage protection. Returns the tx hash and
   * whether the receipt confirmed.
   */
  async sellExactTokens(
    quote: NativeSellQuote,
    minOut: bigint,
    deadlineSeconds: number,
  ): Promise<{ hash: `0x${string}`; status: "success" | "reverted" }> {
    const dex = this.dex;
    if (!this.walletClient || !this.agentAddress) throw new Error("no signer configured");
    const allowance = (await this.publicClient.readContract({
      address: quote.token,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [this.agentAddress, dex.router],
    })) as bigint;
    if (allowance < quote.amountInWei) {
      const approveHash = await this.walletClient.writeContract({
        account: this.walletClient.account!,
        chain: this.chain,
        address: quote.token,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [dex.router, quote.amountInWei],
      });
      const approveReceipt = await this.publicClient.waitForTransactionReceipt({
        hash: approveHash,
      });
      if (approveReceipt.status !== "success") {
        throw new Error(`router approval reverted: ${approveHash}`);
      }
    }
    const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSeconds);
    const hash = await this.walletClient.writeContract({
      account: this.walletClient.account!,
      chain: this.chain,
      address: dex.router,
      abi: ROUTER_ABI,
      functionName: "swapExactTokensForETH",
      args: [quote.amountInWei, minOut, quote.path, this.agentAddress, deadline],
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    return { hash, status: receipt.status === "success" ? "success" : "reverted" };
  }

  /** Raw ERC20 balance (wei-scale) plus decimals/symbol, for exact sells. */
  async rawTokenBalance(
    token: Address,
    address: Address,
  ): Promise<{ raw: bigint; decimals: number; symbol: string }> {
    const [raw, decimals, symbol] = await Promise.all([
      this.publicClient.readContract({
        address: token,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [address],
      }) as Promise<bigint>,
      this.publicClient.readContract({
        address: token,
        abi: ERC20_ABI,
        functionName: "decimals",
      }),
      this.publicClient
        .readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" })
        .catch(() => "TOKEN"),
    ]);
    return { raw, decimals: Number(decimals), symbol: symbol as string };
  }

  async nativePairTokens(limit: number): Promise<Address[]> {
    const dex = this.dex;
    const length = (await this.publicClient.readContract({
      address: dex.factory,
      abi: FACTORY_ABI,
      functionName: "allPairsLength",
    })) as bigint;
    const count = Math.min(Number(length), Math.max(0, limit));
    const pairs = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        this.publicClient.readContract({
          address: dex.factory,
          abi: FACTORY_ABI,
          functionName: "allPairs",
          args: [BigInt(i)],
        }) as Promise<Address>,
      ),
    );
    const seen = new Set<string>();
    const tokens: Address[] = [];
    await Promise.all(
      pairs.map(async (pair) => {
        try {
          const [token0, token1] = await Promise.all([
            this.publicClient.readContract({
              address: pair,
              abi: PAIR_ABI,
              functionName: "token0",
            }) as Promise<Address>,
            this.publicClient.readContract({
              address: pair,
              abi: PAIR_ABI,
              functionName: "token1",
            }) as Promise<Address>,
          ]);
          const token = sameAddress(token0, dex.wrappedNative)
            ? token1
            : sameAddress(token1, dex.wrappedNative)
              ? token0
              : null;
          if (!token) return;
          const key = token.toLowerCase();
          if (seen.has(key)) return;
          seen.add(key);
          tokens.push(token);
        } catch {
          // Ignore broken or transiently unreadable pairs.
        }
      }),
    );
    return tokens;
  }
}

export function getService(runtime: IAgentRuntime): ChainService {
  const svc = runtime.getService<ChainService>("chain");
  if (!svc) throw new Error("chain service not started");
  return svc;
}
