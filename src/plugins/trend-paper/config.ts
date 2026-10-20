/**
 * Trend paper's knobs, all in one place. Defaults are the operator's strategy;
 * <data>/trend-paper/config.json may override any of them (a partial object
 * with the same keys).
 *
 * The mode is not one of them. This desk is paper by construction — there is
 * no live code path to switch to — and a config that tries to name a mode is
 * refused rather than ignored, so nobody believes they turned something on.
 */

/** The only mode this module has. Not configurable, not exported as a variable anyone could reassign. */
export const MODE = "paper" as const;

export type AssetId = "LAIN" | "CYBER";
export const ASSETS: readonly AssetId[] = ["LAIN", "CYBER"];

export interface TrendPaperConfig {
  /** EMA length, closes of 1h bars. */
  emaPeriod: number;
  /** Closed bars in a row above the EMA to enter. */
  entryBars: number;
  /** The last entry bar's volume must reach this multiple of the median volume. */
  volumeMultiple: number;
  /** Bars before the signal bar whose median volume is the yardstick. */
  volumeLookback: number;
  /** No entry when the position would be more than this share of the pool's liquidity. */
  maxLiquidityShare: number;
  /** Sell part of the position once a close is this far above the entry (0.4 = +40 %). */
  partialProfit: number;
  /** Which share of the position the partial exit sells. */
  partialShare: number;
  /** Sell everything when a close falls this far below the entry (0.15 = close ≤ entry × 0.85). */
  stopLoss: number;
  /** Closed bars in a row below the EMA to sell everything. */
  exitBars: number;
  /** No entries for this long after a stop-loss exit. */
  cooldownHours: number;
  /** Cost of every fill, as a share of what it trades (0.01 = 1 %). */
  costRate: number;
  /** Starting capital per asset, in its quote coin (ETH for LAIN, SOL for CYBER). */
  capital: Record<AssetId, number>;
  /** Minutes after the hour the closed bar is read. */
  checkMinute: number;
  /** Daily report time, HH:MM in reportTimeZone. */
  reportAt: string;
  reportTimeZone: string;
}

export const DEFAULT_CONFIG: Readonly<TrendPaperConfig> = Object.freeze({
  emaPeriod: 20,
  entryBars: 2,
  volumeMultiple: 1.5,
  volumeLookback: 24,
  maxLiquidityShare: 0.02,
  partialProfit: 0.4,
  partialShare: 0.5,
  stopLoss: 0.15,
  exitBars: 2,
  cooldownHours: 6,
  costRate: 0.01,
  capital: Object.freeze({ LAIN: 0.1, CYBER: 1 }),
  checkMinute: 2,
  reportAt: "09:00",
  reportTimeZone: "Europe/Moscow",
});

const MODE_KEYS = /^(mode|live|paper|trading|execute|execution|dry_?run|real)$/i;
const COUNTS = new Set(["emaPeriod", "entryBars", "volumeLookback", "exitBars"]);
const SHARES = new Set(["maxLiquidityShare", "partialShare", "stopLoss", "costRate"]);

/**
 * The defaults with an override object laid over them. Unknown keys, a key
 * that names a mode, and values out of range all throw.
 */
export function resolveConfig(override: unknown = {}): TrendPaperConfig {
  if (override === null || typeof override !== "object" || Array.isArray(override)) {
    throw new Error("trend-paper config must be a JSON object");
  }
  const cfg: TrendPaperConfig = { ...DEFAULT_CONFIG, capital: { ...DEFAULT_CONFIG.capital } };
  for (const [key, value] of Object.entries(override)) {
    if (MODE_KEYS.test(key)) throw new Error(`trend-paper config: "${key}" is not a setting — the mode is fixed to ${MODE}`);
    if (!(key in DEFAULT_CONFIG)) throw new Error(`trend-paper config: unknown key "${key}"`);
    if (key === "capital") {
      if (value === null || typeof value !== "object") throw new Error("trend-paper config: capital is { LAIN, CYBER }");
      for (const [asset, amount] of Object.entries(value)) {
        if (!ASSETS.includes(asset as AssetId)) throw new Error(`trend-paper config: no asset "${asset}"`);
        if (typeof amount !== "number" || !(amount > 0)) throw new Error(`trend-paper config: capital.${asset} must be a positive number`);
        cfg.capital[asset as AssetId] = amount;
      }
    } else if (key === "reportAt") {
      if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error("trend-paper config: reportAt is HH:MM");
      cfg.reportAt = value;
    } else if (key === "reportTimeZone") {
      if (typeof value !== "string") throw new Error("trend-paper config: reportTimeZone is an IANA zone name");
      new Intl.DateTimeFormat("en-US", { timeZone: value });
      cfg.reportTimeZone = value;
    } else {
      const ok =
        typeof value === "number" &&
        Number.isFinite(value) &&
        (COUNTS.has(key) ? Number.isInteger(value) && value >= 1 : key === "checkMinute" ? Number.isInteger(value) && value >= 0 && value <= 59 : SHARES.has(key) ? value >= 0 && value < 1 : value > 0);
      if (!ok) throw new Error(`trend-paper config: ${key} = ${JSON.stringify(value)} is out of range`);
      (cfg as unknown as Record<string, number>)[key] = value as number;
    }
  }
  return cfg;
}
