import { spawn } from "node:child_process";
import { mkdir, open, readFile, rename, truncate } from "node:fs/promises";
import { join, resolve } from "node:path";

const NAME = "sma50_paper";
const ASSETS = ["SOL", "ETH"];
const STEP = 4 * 60 * 60 * 1000;
const FEE = 0.003;
const ZONE = "Europe/Moscow";
const TIMES = ["03:00", "07:00", "11:00", "15:00", "19:00", "23:00"];
const SOURCE = "https://data-api.binance.vision/api/v3/klines";

async function optionalText(file) {
  try { return await readFile(file, "utf8"); }
  catch (err) { if (err.code === "ENOENT") return null; throw err; }
}

async function syncDir(dir) {
  const handle = await open(dir, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function append(file, text) {
  const handle = await open(file, "a", 0o600);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
}

async function atomicWrite(file, text, dir) {
  const handle = await open(`${file}.tmp`, "w", 0o600);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
  await rename(`${file}.tmp`, file);
  await syncDir(dir);
}

// A kernel lock survives hot reload and serializes different processes. Closing
// the parent's pipe (including on a crash) releases it; no stale PID lock exists.
async function withLock(dir, work) {
  await mkdir(dir, { recursive: true });
  const child = spawn("flock", ["--exclusive", "--timeout", "45", join(dir, "lock"),
    "cat"],
  { stdio: ["pipe", "pipe", "ignore"] });
  const exited = new Promise((done) => child.once("close", done));
  await new Promise((done, fail) => {
    child.once("error", fail);
    child.stdin.once("error", fail);
    child.once("close", () => fail(new Error("Could not acquire the SMA50 paper lock (flock required).")));
    child.stdout.once("data", done);
    child.stdin.write("locked\n");
  });
  try { return await work(); }
  finally { child.stdin.end(); await exited; }
}

function seed(now) {
  return {
    version: 1, createdAt: new Date(now).toISOString(), firstCheckAt: null,
    lastCandleClose: null, tradeCount: 0, marks: {},
    balances: { SOL: { coin: 1, usdc: 0 }, ETH: { coin: 1, usdc: 0 } },
  };
}

function validateState(state) {
  if (state?.version !== 1 || !Number.isInteger(state.tradeCount) || state.tradeCount < 0 ||
      (state.lastCandleClose !== null && (!Number.isSafeInteger(state.lastCandleClose) || state.lastCandleClose % STEP))) {
    throw new Error("Invalid SMA50 paper checkpoint; refusing to reset balances.");
  }
  for (const asset of ASSETS) {
    const b = state.balances?.[asset];
    if (!b || !Number.isFinite(b.coin) || !Number.isFinite(b.usdc) || b.coin < 0 || b.usdc < 0 ||
        (b.coin > 0) === (b.usdc > 0)) throw new Error(`Invalid isolated ${asset} balance.`);
    if (state.lastCandleClose !== null && !(Number.isFinite(state.marks?.[asset]?.price) && state.marks[asset].price > 0)) {
      throw new Error(`Invalid ${asset} valuation checkpoint.`);
    }
  }
}

// checks.jsonl is the commit log. state.json and trades.jsonl are projections,
// repaired from it before any new decision. A trade and its candle checkpoint
// therefore become durable together, even if the process dies between files.
async function recover(dir, initialize, now) {
  const file = join(dir, "checks.jsonl");
  let text = await optionalText(file);
  if (text === null || text === "") {
    if (await optionalText(join(dir, "state.json")) !== null || await optionalText(join(dir, "trades.jsonl")) !== null) {
      throw new Error("Missing SMA50 commit log with existing projections; refusing to reseed.");
    }
    if (!initialize) throw new Error("SMA50 paper is not configured. Call mode=setup first.");
    const event = { kind: "init", state_after: seed(now), trades: [] };
    await append(file, `${JSON.stringify(event)}\n`);
    await syncDir(dir);
    text = `${JSON.stringify(event)}\n`;
  }
  const boundary = text.lastIndexOf("\n") + 1;
  if (!boundary) throw new Error("Incomplete SMA50 initialization; refusing to reseed.");
  const events = text.slice(0, boundary).trimEnd().split("\n").map((line) => JSON.parse(line));
  let previous = null;
  const trades = [];
  for (const [i, event] of events.entries()) {
    validateState(event.state_after);
    const s = event.state_after;
    if (!Array.isArray(event.trades) || (i === 0 ? event.kind !== "init" || s.lastCandleClose !== null || s.tradeCount !== 0 :
      event.kind !== "check" || s.lastCandleClose === null || (previous !== null && s.lastCandleClose <= previous))) {
      throw new Error("Invalid SMA50 commit sequence.");
    }
    const seen = new Set();
    for (const t of event.trades) {
      if (!ASSETS.includes(t.asset) || seen.has(t.asset) || !["buy", "sell"].includes(t.action) ||
        t.time !== new Date(s.lastCandleClose).toISOString() ||
        ![t.price, t.sma50, t.amount_in, t.amount_out].every((n) => Number.isFinite(n) && n > 0) ||
        t.holding_after?.[t.asset] !== s.balances[t.asset].coin || t.holding_after?.USDC !== s.balances[t.asset].usdc) {
        throw new Error("Invalid SMA50 trade in commit log.");
      }
      seen.add(t.asset);
      trades.push(t);
    }
    if (s.tradeCount !== trades.length) throw new Error("SMA50 trade count disagrees with commit log.");
    previous = s.lastCandleClose;
  }
  // Only a final unterminated record may be discarded after a torn write.
  if (boundary !== text.length) {
    await truncate(file, Buffer.byteLength(text.slice(0, boundary)));
    const handle = await open(file, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
  }
  const ledger = { state: events.at(-1).state_after, trades };
  await project(dir, ledger);
  return ledger;
}

async function project(dir, ledger) {
  const file = join(dir, "trades.jsonl");
  const expected = ledger.trades.map((t) => `${JSON.stringify(t)}\n`).join("");
  const existing = await optionalText(file);
  if (existing !== expected) {
    if (existing !== null && expected.startsWith(existing)) await append(file, expected.slice(existing.length));
    else await atomicWrite(file, expected, dir);
  }
  await atomicWrite(join(dir, "state.json"), `${JSON.stringify(ledger.state, null, 2)}\n`, dir);
}

async function fetchJson(url) {
  const response = await fetch(url, { method: "GET", signal: AbortSignal.timeout(20_000), redirect: "error" });
  if (!response.ok) throw new Error(`Public candle feed returned HTTP ${response.status}.`);
  return response.json();
}

async function market(asset, cutoff, getJson) {
  const url = new URL(SOURCE);
  url.search = new URLSearchParams({ symbol: `${asset}USDC`, interval: "4h", limit: "61", endTime: String(cutoff - 1) });
  const rows = await getJson(url.href);
  if (!Array.isArray(rows)) throw new Error(`Invalid ${asset}/USDC candle response.`);
  const closed = [];
  for (const row of rows) {
    if (!Array.isArray(row)) throw new Error(`Malformed ${asset}/USDC candle.`);
    const [start, price, end] = [Number(row[0]), Number(row[4]), Number(row[6])];
    if (!Number.isSafeInteger(start) || start < 0 || start % STEP || end !== start + STEP - 1) {
      throw new Error(`Invalid ${asset}/USDC 4H candle timestamps.`);
    }
    if (end >= cutoff) continue; // Never let a forming candle into either SMA.
    if (!Number.isFinite(price) || price <= 0) throw new Error(`Invalid ${asset}/USDC close.`);
    closed.push({ start, price });
  }
  // Reject gaps, duplicates and disorder rather than silently changing the SMA.
  for (let i = 1; i < closed.length; i++) {
    if (closed[i].start !== closed[i - 1].start + STEP) throw new Error(`Non-contiguous ${asset}/USDC candles.`);
  }
  if (closed.length < 60 || closed.at(-1).start + STEP !== cutoff) {
    throw new Error(`Need at least 60 closed ${asset}/USDC candles ending at ${new Date(cutoff).toISOString()}.`);
  }
  const mean = (bars) => bars.reduce((sum, bar) => sum + bar.price, 0) / 50;
  return {
    price: closed.at(-1).price, previousClose: closed.at(-2).price,
    sma50: mean(closed.slice(-50)), previousSma50: mean(closed.slice(-51, -1)),
  };
}

async function check(dir, ledger, now, getJson) {
  const cutoff = Math.floor(now / STEP) * STEP;
  if (ledger.state.lastCandleClose !== null && ledger.state.lastCandleClose >= cutoff) return { checked: false, trades: [] };
  // Validate both markets before committing either isolated balance.
  const results = await Promise.allSettled(ASSETS.map((asset) => market(asset, cutoff, getJson)));
  const failure = results.find((r) => r.status === "rejected");
  if (failure) throw failure.reason;
  const next = structuredClone(ledger.state);
  const trades = [];
  for (const [i, asset] of ASSETS.entries()) {
    const m = results[i].value;
    const b = next.balances[asset];
    let action;
    let amountIn;
    let amountOut;
    if (b.coin > 0 && m.previousClose < m.previousSma50 && m.price < m.sma50) {
      action = "sell";
      amountIn = b.coin;
      amountOut = amountIn * m.price * (1 - FEE);
      b.coin = 0;
      b.usdc = amountOut;
    } else if (b.usdc > 0 && m.previousClose > m.previousSma50 && m.price > m.sma50) {
      action = "buy";
      amountIn = b.usdc;
      amountOut = amountIn / m.price * (1 - FEE);
      b.usdc = 0;
      b.coin = amountOut;
    }
    next.marks[asset] = m;
    if (action) {
      if (!Number.isFinite(amountOut) || amountOut <= 0) throw new Error("Invalid simulated fill.");
      trades.push({ time: new Date(cutoff).toISOString(), asset, action, price: m.price, sma50: m.sma50,
        amount_in: amountIn, amount_out: amountOut, holding_after: { [asset]: b.coin, USDC: b.usdc } });
    }
  }
  next.lastCandleClose = cutoff;
  next.firstCheckAt ??= new Date(now).toISOString();
  next.tradeCount += trades.length;
  validateState(next);
  await append(join(dir, "checks.jsonl"), `${JSON.stringify({ kind: "check", state_after: next, trades })}\n`);
  await syncDir(dir);
  ledger.state = next;
  ledger.trades.push(...trades);
  await project(dir, ledger);
  return { checked: true, trades };
}

function report(state) {
  if (!state.firstCheckAt) return "SMA50 paper: first market check has not succeeded; launch is not confirmed.";
  const lines = [`SMA50 paper only · valuation at ${new Date(state.lastCandleClose).toISOString()}`];
  for (const asset of ASSETS) {
    const b = state.balances[asset];
    const equivalent = b.coin + b.usdc / state.marks[asset].price;
    lines.push(`${asset}: ${b.coin.toFixed(8)} ${asset} + ${b.usdc.toFixed(6)} allocated USDC = ${equivalent.toFixed(8)} ${asset}; ` +
      `hold benchmark 1 ${asset}; difference ${(equivalent - 1).toFixed(8)} ${asset} (${((equivalent - 1) * 100).toFixed(4)}%).`);
  }
  lines.push(`Total trades: ${state.tradeCount}.`);
  return lines.join("\n");
}

function specifications() {
  return [...TIMES.map((at) => ({ mode: "check", at })), { mode: "report", at: "23:05" }];
}

function matching(r, spec) {
  return r.skill === NAME && r.params?.mode === spec.mode && r.trigger.kind === "daily" &&
    r.trigger.at === spec.at && r.trigger.timeZone === ZONE;
}

async function configure(runtime, state) {
  const routines = runtime.getService("routines");
  if (!routines) throw new Error("The routines service is required for setup.");
  let existing = await routines.list();
  for (const spec of specifications()) {
    const matches = existing.filter((r) => matching(r, spec));
    if (matches.some((r) => r.paused) || matches.length > 1) throw new Error(`Resolve paused or duplicate SMA50 routine at ${spec.at}.`);
    if (!matches.length) {
      const chatId = state?.roomId?.startsWith("tg-") ? Number(state.roomId.slice(3)) : undefined;
      await routines.add({ skill: NAME, params: { mode: spec.mode },
        trigger: { kind: "daily", at: spec.at, timeZone: ZONE }, notify: spec.mode === "report" ? "always" : "change",
        reporter: state?.message?.userId ?? "wish14", chatId: Number.isFinite(chatId) ? chatId : undefined,
        note: "wish14: isolated SMA50 paper strategy" });
    }
  }
  existing = await routines.list();
  if (!specifications().every((s) => existing.filter((r) => matching(r, s) && !r.paused).length === 1)) {
    throw new Error("SMA50 schedule verification failed.");
  }
  return routines.active === true;
}

// Dependency injection is for the offline smoke test; tool arguments cannot
// override the feed, clock, assets, seed, fees, period or trading rules.
export async function runPaper(runtime, state, params = {}, deps = {}) {
  const mode = params.mode ?? "status";
  if (!["setup", "check", "report", "status"].includes(mode) || Object.keys(params).some((k) => k !== "mode")) {
    return { ok: false, text: "Use only mode=setup|check|report|status; strategy rules are fixed." };
  }
  const now = deps.now ?? Date.now();
  const dir = resolve(runtime.getSetting("LAINOS_DATA_DIR") ?? "./data", "sma50-paper-wish14");
  try {
    return await withLock(dir, async () => {
      const ledger = await recover(dir, mode === "setup", now);
      let active;
      if (mode === "setup") active = await configure(runtime, state);
      let result;
      try {
        if (mode === "setup" || mode === "check") result = await check(dir, ledger, now, deps.fetchJson ?? fetchJson);
      } catch (err) {
        return { ok: false, text: `SMA50 paper market check failed: ${err.message} Launch is not confirmed by this run.`,
          data: { configured: mode === "setup", launched: false } };
      }
      if (mode === "report" && ledger.state.lastCandleClose !== Math.floor(now / STEP) * STEP) {
        return { ok: false, text: "Daily SMA50 paper report withheld: the latest closed candle has not been checked." };
      }
      const schedules = await runtime.getService("routines")?.list() ?? [];
      const configured = specifications().every((s) => schedules.filter((r) => matching(r, s) && !r.paused).length === 1);
      active ??= runtime.getService("routines")?.active === true;
      const launched = configured && active && !!ledger.state.firstCheckAt;
      const head = mode === "setup" ? (launched ? "SMA50 paper launch confirmed: schedules verified and first check succeeded." :
        "SMA50 paper configured; daemon execution is not confirmed in this process.") :
        mode === "check" ? (result.checked ? "Closed candle checked." : "This candle was already checked; no repeat decision.") :
          `SMA50 paper: ${launched ? "launch confirmed" : "launch not confirmed"}.`;
      return { ok: true, text: `${head}\n${report(ledger.state)}`,
        data: { configured, launched, firstCheckAt: ledger.state.firstCheckAt, lastCandleClose: ledger.state.lastCandleClose,
          tradeCount: ledger.state.tradeCount, balances: ledger.state.balances, trades: result?.trades ?? [],
          fingerprint: mode === "report" ? ledger.state : ledger.state.tradeCount } };
    });
  } catch (err) {
    return { ok: false, text: `SMA50 paper: ${err.message}` };
  }
}

export default {
  name: NAME,
  description: "Fixed wish14 SMA50 paper strategy for SOL/USDC and ETH/USDC, each seeded with one coin and its own USDC. " +
    "setup installs persistent 03/07/11/15/19/23:00 Europe/Moscow checks plus a 23:05 daily report and performs the first check. " +
    "Use status to confirm configuration and the first successful check before saying it launched. Never uses wallets or real trading tools.",
  parameters: { type: "object", additionalProperties: false,
    properties: { mode: { type: "string", enum: ["setup", "check", "report", "status"] } } },
  handler: runPaper,
};
