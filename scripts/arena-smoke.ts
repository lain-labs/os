/**
 * Arena smoke: the paper desk's dollar fills become arena trades the league
 * accepts — whole-unit quantities, USD as the quote, a sale closing what the
 * buys opened, markets without a chain token left out.
 */
import { decimalString, deskTrades } from "../src/plugins/arena/index.js";

const results: [string, boolean][] = [];
const check = (name: string, pass: boolean) => results.push([name, pass]);
const DECIMAL = /^[0-9]{1,30}(\.[0-9]{1,18})?$/;

const trades = deskTrades([
  { key: "LAIN:2:sell", market: "LAIN", side: "sell", at: 2, px: 0.000035, usd: 21.1, strategy: "rsi", reason: "exit", pnlUsd: 1.1 },
  { key: "LAIN:1:buy", market: "LAIN", side: "buy", at: 1, px: 0.0000329, usd: 20, strategy: "rsi", reason: "entry rule" },
  { key: "XMR:1:buy", market: "XMR", side: "buy", at: 1, px: 600, usd: 20, strategy: "rsi", reason: "entry rule" },
  { key: "BTC:3:buy", market: "BTC", side: "buy", at: 3, px: 84020.29, usd: 20, strategy: "dip", reason: "entry rule" },
]);

check("XMR has no chain token, so it stays off the board", trades.every((t) => t.symbol !== "XMR") && trades.length === 3);
check("fills go out oldest first", trades[0]?.id === "desk:LAIN:1:buy" && trades[1]?.id === "desk:LAIN:2:sell");
check("a sale closes exactly what the buy opened", trades[0]?.qty === trades[1]?.qty);
check("dollars are the quote", trades.every((t) => t.quote.symbol === "USD" && DECIMAL.test(t.quote.amount ?? "")));
check("quantities are decimals the league accepts", trades.every((t) => DECIMAL.test(t.qty ?? "")));
check("no float noise in amounts", trades[1]?.quote.amount === "21.1");
check("a sale carries its realized dollars", trades[1]?.realized === "1.100000");
check("every desk trade is paper", trades.every((t) => t.paper));
check("LAIN is priced on Robinhood Chain", trades[0]?.chain === "robinhood" && trades[0]?.token === "0x2b79a071a75dd40f1aca68146d7978204efd156a");
check("nothing below zero or too small to write", decimalString(-1) === null && decimalString(1e-20) === null);

let failed = 0;
for (const [name, pass] of results) {
  console.log(`${pass ? "ok  " : "FAIL"} ${name}`);
  if (!pass) failed++;
}
console.log(failed ? `\n${failed} failed` : `\nall ${results.length} passed`);
process.exit(failed ? 1 : 0);
