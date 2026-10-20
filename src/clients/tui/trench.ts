/**
 * The trench board: paper memecoin trenching as a live screen, drawn in place
 * of the transcript while it is open (/trench). Pure — a snapshot of the
 * engine plus the wall clock in, exactly `rows` lines out — so the app only
 * re-renders it, on every scan and on a short timer in between.
 *
 * What makes it move:
 *   - the tape drips: a scan brings five seconds of curve trades at once, and
 *     the board releases each at its own chain time, a few seconds late — a
 *     stream with the launchpad's real rhythm, not a jump every five seconds;
 *   - a position's line carries its return history as a sparkline and a gauge
 *     from its stop-loss to its take-profit;
 *   - fresh entries, exits and tape rows flash, and LIVE blinks with the clock.
 */
import type { TrenchPosition, TrenchSnapshot } from "../../plugins/trench/engine.js";
import { blank, concat, fitLine, fitLineBg, lineWidth, sp, truncateLine, type Line, type Span } from "./markdown.js";
import { lerpColor, type Theme } from "./theme.js";
import { bar, clockOf, gradient, journalSpans, pad, spark } from "./charts.js";

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** How long a fresh row stays lit, ms. */
const FLASH_MS = 4_000;

/** The board, exactly `rows` lines of `width` columns. `now` is ms; `frame` ticks with the redraw timer. */
export function boardLines(snap: TrenchSnapshot, theme: Theme, width: number, rows: number, now: number, frame: number): Line[] {
  const c = theme;
  const w = Math.max(40, width);
  const out: Line[] = [];
  const push = (l: Line) => out.push(fitLine(l, w));
  const pushBg = (l: Line, bg: string) => out.push(fitLineBg(l, w, bg));
  const section = (title: string, note = "") =>
    push(concat([sp(`── ${title} `, c.secondary)], note ? [sp(`${note} `, c.mutedDim)] : [], [sp("─".repeat(w), c.border)]));

  // ---- header: what this is, and that it is alive
  const live = snap.enabled && !snap.blocker;
  const beat = frame % 2 === 0;
  const status: Line = live
    ? [{ t: "● LIVE", c: beat ? c.ok : lerpColor(c.ok, c.mutedDim, 0.6), b: true }]
    : snap.enabled
      ? [sp(`◌ WAITING — ${snap.blocker}`, c.warn)]
      : [sp("○ OFF — /trench on starts it", c.warn)];
  const scanAgo = snap.lastTick ? Math.max(0, Math.round((now - snap.lastTick) / 1000)) : null;
  const recent = snap.pulse.slice(-12);
  const perMin = recent.length ? Math.round((recent.reduce((a, b) => a + b, 0) / recent.length) * (60_000 / snap.intervalMs)) : 0;
  const facts =
    `${snap.head !== null ? `block ${snap.head.toLocaleString("en-US")} · ` : ""}` +
    `${scanAgo !== null ? `scan ${scanAgo}s ago · ` : ""}${perMin} trades/min `;
  const title: Line = concat(
    gradient("⛏ TRENCHES", c),
    [sp("  paper · PONS v2 · Robinhood Chain   ", c.muted)],
    status,
  );
  // The launchpad's heartbeat: trades per scan, as a sparkline.
  const right: Line = concat([sp(facts, c.mutedDim)], spark(snap.pulse, 16, c.primary, c.mutedDim, 4));
  const gap = w - lineWidth(title) - lineWidth(right);
  push(gap >= 2 ? concat(title, blank(gap), right) : title);

  // ---- equity: the line that says whether this is working
  const equity = snap.equity.at(-1)?.wei ?? snap.cash + openValue(snap.positions);
  const ret = snap.start > 0n ? Number(((equity - snap.start) * 10_000n) / snap.start) / 100 : 0;
  const closed = snap.closed;
  const wins = closed.filter((t) => BigInt(t.pnl) > 0n).length;
  const net = closed.reduce((sum, t) => sum + BigInt(t.pnl), 0n);
  const sparkW = Math.max(10, Math.min(48, Math.floor(w / 4)));
  push(
    concat(
      [sp("equity ", c.mutedDim), { t: `${eth(equity)} ETH`, c: c.fg, b: true }, sp("  ", c.fg)],
      [{ t: signed(ret), c: ret >= 0 ? c.ok : c.err, b: true }],
      [sp("   ", c.fg)],
      // Scaled to at least ±0.5% of the start, so fee-sized noise stays a flat line.
      spark(snap.equity.map((e) => Number(e.wei) / 1e18), sparkW, ret >= 0 ? c.ok : c.err, c.mutedDim, (Number(snap.start) / 1e18) * 0.01),
      [
        sp(
          `   cash ${eth(snap.cash)} · in play ${eth(openValue(snap.positions))} · ` +
            `${wins}W/${closed.length - wins}L${closed.length ? ` (${Math.round((wins / closed.length) * 100)}% hit)` : ""} · ` +
            `net ${net >= 0n ? "+" : ""}${eth(net)} ETH`,
          c.muted,
        ),
      ],
    ),
  );
  if (snap.error) push([sp(`⚠ last scan failed: ${snap.error}`, c.warn)]);
  push(blank(w));

  // ---- budget the rest: positions and journal are fixed, radar and tape share what is left
  const fixedTail = 1; // the footer
  const posRows = Math.max(1, snap.positions.length);
  const journalRows = Math.min(4, Math.max(1, snap.journal.length));
  const left = rows - out.length - fixedTail - (1 + posRows + 1) - (1 + journalRows + 1);
  const radarRows = Math.max(0, Math.min(snap.radar.length || 1, Math.floor(left * 0.45)));
  const tapeRows = Math.max(0, left - (radarRows ? radarRows + 2 : 0) - 1);

  // ---- positions
  section("YOUR POSITIONS", `${snap.positions.length}/${snap.rules.maxOpen} · ${snap.rules.sizeNative} ETH each`);
  if (!snap.positions.length) {
    push(
      concat(
        [sp(`  ${live ? SPIN[frame % SPIN.length] : "·"} `, c.primary)],
        [sp(live ? "hunting — nothing clears the rules yet; the radar shows what is close" : "no open positions", c.muted)],
      ),
    );
  }
  for (const p of snap.positions) {
    const row = positionRow(p, snap, c, w);
    if (now - p.openedAt < FLASH_MS) pushBg(row, lerpColor(c.panelBg, c.ok, 0.22));
    else push(row);
  }
  push(blank(w));

  // ---- radar
  if (radarRows) {
    section("RADAR", `hottest curves, last ${snap.rules.windowMin}m · what the rules make of each`);
    const maxInflow = snap.radar.reduce((m, r) => (r.inflow > m ? r.inflow : m), 1n);
    if (!snap.radar.length) push([sp("  the launchpad is quiet", c.mutedDim)]);
    for (const r of snap.radar.slice(0, radarRows)) {
      const heat = Number((r.inflow * 100n) / maxInflow) / 100;
      const verdict: Span =
        r.verdict === "in"
          ? { t: "◆ IN", c: c.ok, b: true }
          : r.verdict === "next"
            ? { t: "▶ NEXT", c: c.warn, b: true }
            : sp(`· ${r.verdict}`, c.mutedDim);
      push(
        concat(
          [sp("  ", c.fg), { t: pad(r.symbol, 12), c: r.verdict === "in" ? c.ok : c.fg, b: r.verdict !== "too old" }],
          [sp(` ${String(r.buys).padStart(3)} buys ${String(r.buyers).padStart(3)} wallets `, c.muted)],
          [sp(`${`${r.inflow >= 0n ? "+" : ""}${eth(r.inflow)}`.padStart(8)} ETH `, r.inflow >= 0n ? c.ok : c.err)],
          bar(Math.max(0, heat), 10, lerpColor(c.warn, c.err, heat), c.border),
          [sp("  grad ", c.mutedDim)],
          r.progress === null ? [sp("  ?       ", c.mutedDim)] : bar(r.progress, 8, c.secondary, c.border),
          [sp(r.progress === null ? "" : ` ${String(Math.round(r.progress * 100)).padStart(2)}%`, c.muted)],
          [sp(`  ${r.ageMin === null ? "old" : `${Math.round(r.ageMin)}m`}`.padEnd(6), c.mutedDim)],
          [sp(" ", c.fg), verdict],
        ),
      );
    }
    push(blank(w));
  }

  // ---- tape: newest on top, each trade shown once its chain time is ~6 s past
  section("TAPE", "every buy and sell on the launchpad, as it happened");
  const lag = Math.ceil(snap.intervalMs / 1000) + 1;
  const visible = snap.tape.filter((t) => t.ts <= now / 1000 - lag);
  const held = new Set(snap.positions.map((p) => p.curve));
  const shown = visible.slice(-tapeRows).reverse();
  for (const t of shown) {
    const fresh = now / 1000 - lag - t.ts < 1.2;
    const buy = t.side === "buy";
    const ours = held.has(t.curve);
    const row = concat(
      [sp(`  ${clockOf(t.ts)}  `, c.mutedDim)],
      [{ t: buy ? "▲ BUY " : "▼ SELL", c: buy ? c.ok : c.err, b: fresh }],
      [sp("  ", c.fg), { t: pad(t.symbol, 12), c: ours ? c.warn : c.fg, b: ours }],
      [{ t: `${eth(t.quote).padStart(8)} ETH`, c: buy ? c.ok : c.err, b: t.quote >= 10n ** 17n }],
      [sp(`  ${t.wallet.slice(0, 6)}…${t.wallet.slice(-4)}`, c.mutedDim)],
      t.quote >= 5n * 10n ** 17n ? [{ t: buy ? "  ◆ big buy" : "  ◆ big sell", c: buy ? c.ok : c.err, b: true }] : [],
      ours ? [sp("  · held", c.warn)] : [],
    );
    if (fresh) pushBg(row, lerpColor(c.panelBg, buy ? c.ok : c.err, 0.14));
    else push(row);
  }
  for (let i = shown.length; i < tapeRows; i++) push(i === 0 ? [sp("  waiting for the first trades…", c.mutedDim)] : blank(w));

  // ---- journal
  push(blank(w));
  section("JOURNAL", "entries and exits");
  if (!snap.journal.length) push([sp("  nothing yet", c.mutedDim)]);
  for (const j of snap.journal.slice(-journalRows).reverse()) {
    const age = now - j.at;
    const row: Line = concat([sp(`  ${clockOf(j.at / 1000)}  `, c.mutedDim)], journalSpans(j.text, c));
    if (age < FLASH_MS * 1.5) {
      const tone = j.text.startsWith("🟥") ? c.err : j.text.startsWith("🟩") || j.text.startsWith("🟢") ? c.ok : c.warn;
      pushBg(row, lerpColor(c.panelBg, tone, 0.3 * (1 - age / (FLASH_MS * 1.5)) + 0.08));
    } else push(row);
  }

  // ---- fill to the bottom, then the footer
  while (out.length < rows - fixedTail) push(blank(w));
  out.length = Math.min(out.length, rows - fixedTail);
  push([
    sp(
      `esc closes · /trench set <rule> <value> · /trench rules · /trench close <sym|all> · ` +
        `exits: +${snap.rules.takeProfitPct}% half → trail ${snap.rules.trailPct}%, stop −${snap.rules.stopLossPct}%, ${snap.rules.maxHoldMin}m`,
      c.mutedDim,
    ),
  ]);
  return out.slice(0, rows).map((l) => truncateLine(l, w));
}

/** One open position: return, its history, money in and now, the stop→target gauge, progress, age. */
function positionRow(p: TrenchPosition, snap: TrenchSnapshot, c: Theme, w: number): Line {
  const cost = BigInt(p.cost);
  const value = BigInt(p.markValue);
  const ret = cost > 0n ? Number(((value - cost) * 10_000n) / cost) / 100 : 0;
  const tone = ret >= 0 ? c.ok : c.err;
  const held = Math.round((Date.now() - p.openedAt) / 60_000);
  const gauge: Line = p.tpDone
    ? [sp("½ taken · trailing ", c.ok), sp(`${snap.rules.trailPct}% off high`, c.mutedDim)]
    : stopGauge(ret, snap.rules.stopLossPct, snap.rules.takeProfitPct, c);
  return concat(
    [sp("  ", c.fg), { t: pad(p.symbol, 12), c: c.fg, b: true }],
    [{ t: signed(ret).padStart(8), c: tone, b: true }, sp("  ", c.fg)],
    spark(p.marks ?? [], Math.max(8, Math.min(20, Math.floor(w / 10))), tone, c.mutedDim, 4),
    [sp(`  ${eth(cost)} → `, c.muted), { t: eth(value), c: tone }, sp(" ETH  ", c.muted)],
    gauge,
    [sp("  grad ", c.mutedDim)],
    bar(p.markProgress, 8, c.secondary, c.border),
    [sp(` ${String(Math.round(p.markProgress * 100)).padStart(2)}%  ${held}m`, c.muted)],
  );
}

/** SL ────●──┊────── TP: where the return sits between the stop and the target. */
function stopGauge(ret: number, sl: number, tp: number, c: Theme): Line {
  const width = 16;
  const span = sl + tp || 1;
  const at = Math.round(((Math.max(-sl, Math.min(tp, ret)) + sl) / span) * (width - 1));
  const zero = Math.round((sl / span) * (width - 1));
  const cells: Span[] = [];
  for (let i = 0; i < width; i++) {
    if (i === at) cells.push({ t: "●", c: ret >= 0 ? c.ok : c.err, b: true });
    else if (i === zero) cells.push(sp("┊", c.mutedDim));
    else cells.push(sp("─", i < zero ? lerpColor(c.border, c.err, 0.5) : lerpColor(c.border, c.ok, 0.5)));
  }
  return concat([sp("SL ", c.err)], cells, [sp(" TP", c.ok)]);
}

function openValue(positions: readonly TrenchPosition[]): bigint {
  return positions.reduce((sum, p) => sum + BigInt(p.markValue), 0n);
}

/** ETH with four decimals. */
function eth(wei: bigint): string {
  const neg = wei < 0n;
  const abs = neg ? -wei : wei;
  const whole = abs / 10n ** 18n;
  const frac = ((abs % 10n ** 18n) / 10n ** 14n).toString().padStart(4, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

function signed(pct: number): string {
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(Math.abs(pct) < 1 ? 2 : 1)}%`;
}
