/**
 * Arena smoke: the paper desk's dollar fills become arena trades the league
 * accepts — whole-unit quantities, USD as the quote, a sale closing what the
 * buys opened, markets without a chain token left out.
 */
import { decimalString, deskTrades } from "../src/plugins/arena/index.js";
import { bookValue, fill, freshBook, leagueTrade, parseDecision } from "../src/plugins/arena/book.js";

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

// The arena book: Lain's own paper bankroll on the arena's board.
const board = [
  { key: "So11111111111111111111111111111111111111112", symbol: "SOL", chain: "solana", address: "So11111111111111111111111111111111111111112", usd: 100, changePct: 3, liquidityUsd: 25_000_000 },
  { key: "thin", symbol: "THIN", chain: "solana", address: "thin", usd: 1, liquidityUsd: 100 },
];
check("a decision is read from the model's JSON, with prose around it", parseDecision('ok: {"action":"buy","token":"So11111111111111111111111111111111111111112","bps":5000,"reason":"momentum"}')?.bps === 5000);
check("nonsense is no decision", parseDecision("I think SOL looks good") === null && parseDecision('{"action":"yolo"}') === null);
const book = freshBook(1000);
const bought = fill(book, { action: "buy", token: "So11111111111111111111111111111111111111112", bps: 5000, reason: "momentum" }, board, 1);
check("a buy spends that share of cash, with fee and slippage", typeof bought !== "string" && book.cash === 500 && Math.abs(book.positions.So11111111111111111111111111111111111111112!.qty - (500 * 0.997) / 100.5) < 1e-9);
check("a thin pool is refused", typeof fill(book, { action: "buy", token: "thin", bps: 2500, reason: "x" }, board, 2) === "string");
check("cannot sell what it does not hold", typeof fill(book, { action: "sell", token: "thin", bps: 10000, reason: "x" }, board, 3) === "string");
const up = board.map((t) => (t.symbol === "SOL" ? { ...t, usd: 120 } : t));
check("the book is marked to the board", Math.round(bookValue(book, up)) === Math.round(500 + book.positions.So11111111111111111111111111111111111111112!.qty * 120));
const sold = fill(book, { action: "sell", token: "So11111111111111111111111111111111111111112", bps: 10000, reason: "take profit" }, up, 4);
check("selling all closes the position and books the gain", typeof sold !== "string" && !book.positions.So11111111111111111111111111111111111111112 && (sold.realizedUsd ?? 0) > 0 && book.cash > 1000);
const shaped = typeof sold !== "string" ? leagueTrade(sold) : null;
check("a book trade goes to the league as paper in USD with its reason", shaped?.paper === true && (shaped?.quote as { symbol: string }).symbol === "USD" && String(shaped?.reason).startsWith("arena book: take profit"));

let failed = 0;
for (const [name, pass] of results) {
  console.log(`${pass ? "ok  " : "FAIL"} ${name}`);
  if (!pass) failed++;
}
console.log(failed ? `\n${failed} failed` : `\nall ${results.length} passed`);
process.exit(failed ? 1 : 0);
