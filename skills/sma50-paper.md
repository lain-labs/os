# Isolated SMA50 paper strategy (wish14)

The hot-loaded `sma50_paper` tool has four fixed modes: `setup`, `check`,
`report`, and `status`. It never imports a wallet, chain service, trading
service, swap tool, or existing paper portfolio. Its only network operation
is an unauthenticated GET for SOLUSDC or ETHUSDC 4H candles from Binance's
[public market-data-only API](https://developers.binance.com/docs/binance-spot-api-docs/faqs/market_data_only).
There is no real execution mode, parameter for prices or rules, or reset tool.

Call `sma50_paper` with `{"mode":"setup"}` in the live daemon. Setup is
idempotent: it stores six checks at 03:00, 07:00, 11:00, 15:00, 19:00, and
23:00 **Europe/Moscow**, plus a daily report at 23:05 in that zone. It also
checks the latest closed candle immediately. The scheduler honors the named
zone independently of the host timezone. This addition to the scheduler
requires the normal forge rebuild/restart; the skill itself hot-loads.

Do not announce a launch unless setup returns `data.launched: true`: the
seven schedules must be present and unpaused, the current process must run
routines, and the first real market check must have succeeded. An outage
leaves configured schedules available for their next slot and returns failure
without claiming a launch. `status` shows the first check and last candle.
Run setup in the requesting Telegram chat to route reports to that chat;
otherwise the existing routine delivery rules apply.

The initial allocation is exactly 1 SOL plus 0 USDC in the SOL bucket and
1 ETH plus 0 USDC in the ETH bucket. The two USDC allocations are never
combined. Every decision requires at least 60 contiguous, ordered, closed
4H candles, including the latest expected closed candle. Forming candles are
excluded. Invalid, stale, missing, duplicate, or unordered history prevents
both balances from changing.

Each of the two latest closes is compared with its own contemporaneous SMA50
(the arithmetic mean of the 50 closes ending at that candle). Two closes
strictly below their SMA sell the entire held coin. Two closes strictly above
their SMA buy with all USDC allocated to that coin. Equality and mixed
signals do nothing. The fill price is the last closed candle's close.
Selling receives `coin * price * 0.997` USDC; buying receives
`USDC / price * 0.997` coins. Both formulas charge exactly 0.3% on each fill.
No forecasts or news enter the strategy.

All data is confined to `LAINOS_DATA_DIR/sma50-paper-wish14/`:

- `checks.jsonl`: durable commit log, including unchanged candle decisions.
- `state.json`: current balances, marks, first check, last candle, trade count.
- `trades.jsonl`: one line per trade with `time`, `asset`, `action`, `price`,
  `sma50`, `amount_in`, `amount_out`, and `holding_after`.
- `lock`: Linux `flock` lock used across processes and skill reloads.

Trade time is the UTC candle closing boundary. `amount_in` is the full coin
amount on a sale or the full allocated USDC on a purchase. `amount_out` is
the amount received after fees. `holding_after` names the coin and USDC
remaining in that bucket. The commit log is fsynced before its state and trade
projections are updated. Recovery restores those projections and discards
only an unterminated final commit. Complete corrupt records fail closed;
missing commit history with surviving projections never reseeds a portfolio.
A process crash releases the kernel lock automatically.

Each candle is committed once, including a no-op. Restarting or manually
rechecking that candle cannot trade again or refetch its market history.
If the daemon misses a slot, it follows the existing scheduler's three-hour
late window. Older missed candles are not replayed as historical trades.
Failed requests remain unprocessed; the next scheduled slot can retry. As
with other routines, five consecutive failures pause a routine and report it.

The daily report values each bucket separately at the latest checked close:
`coin + allocated USDC / price`. It compares that amount with holding exactly
1 SOL or 1 ETH, reports the difference and percentage, and gives the combined
number of trades. A report with an unchecked current closed candle is
withheld rather than presenting an old valuation as current. The report
does not fetch prices or make decisions. Delivery uses the daemon's existing
routine subscribers, including Telegram and the TUI feed.

Offline verification (no credentials, real orders, or market requests):

```sh
node scripts/sma50-paper-smoke.mjs
node --import tsx scripts/sma50-schedule-smoke.ts
```
