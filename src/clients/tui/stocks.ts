/**
 * The stock desk board: Robinhood's tokenized stocks on Robinhood Chain as a
 * live trading screen, drawn in place of the transcript while open (/stocks).
 * Pure, like the trench board: a desk snapshot and the clock in, exactly
 * `rows` lines out.
 *
 * The market table is the heart of it: each token's on-chain price (flashing
 * on every tick), its last fifteen minutes, the trend move, Wall Street's price
 * and a gauge of where the token sits against it — cheaper to the left, richer
 * to the right — then what a round trip costs, the volume, and the verdict.
 */
import type { DeskPosition, DeskQuote, DeskSnapshot } from "../../plugins/stocks/engine.js";
import { blank, concat, fitLine, fitLineBg, lineWidth, sp, truncateLine, type Line, type Span } from "./markdown.js";
import { lerpColor, type Theme } from "./theme.js";
import { clockOf, gradient, journalSpans, pad, spark } from "./charts.js";

const FLASH_MS = 4_000;
/** The premium gauge spans ±this percent. */
const GAUGE_SPAN = 1;

export function stocksBoardLines(snap: DeskSnapshot, theme: Theme, width: number, rows: number, now: number, frame: number): Line[] {
  const c = theme;
  const w = Math.max(60, width);
  const out: Line[] = [];
  const push = (l: Line) => out.push(fitLine(l, w));
  const pushBg = (l: Line, bg: string) => out.push(fitLineBg(l, w, bg));
  const section = (title: string, note = "") =>
    push(concat([sp(`── ${title} `, c.secondary)], note ? [sp(`${note} `, c.mutedDim)] : [], [sp("─".repeat(w), c.border)]));

  // ---- header: the desk, that it is live, and Wall Street's clock
  const live = !snap.blocker && snap.lastTick > 0 && now - snap.lastTick < snap.intervalMs * 4;
  const beat = frame % 2 === 0;
  const street = sessionLabel(snap, now);
  const title: Line = concat(
    gradient("◆ STOCK DESK", c),
    [sp("  paper · Robinhood tokens on Robinhood Chain   ", c.muted)],
    snap.blocker
      ? [sp(`◌ ${snap.blocker}`, c.warn)]
      : live
        ? [{ t: "● LIVE", c: beat ? c.ok : lerpColor(c.ok, c.mutedDim, 0.6), b: true }]
        : [sp("◌ connecting…", c.warn)],
    [sp("   Wall St ", c.mutedDim), { t: street.text, c: street.open ? c.ok : c.warn, b: true }],
  );
  const scanAgo = snap.lastTick ? Math.max(0, Math.round((now - snap.lastTick) / 1000)) : null;
  const right: Line = concat(
    [sp(`${snap.head !== null ? `block ${snap.head.toLocaleString("en-US")} · ` : ""}${scanAgo !== null ? `scan ${scanAgo}s ago ` : ""}`, c.mutedDim)],
    spark(snap.pulse, 12, c.primary, c.mutedDim, 4),
  );
  const gap = w - lineWidth(title) - lineWidth(right);
  push(gap >= 2 ? concat(title, blank(gap), right) : title);

  // ---- equity
  const openValue = snap.positions.reduce((s, p) => s + BigInt(p.mark), 0n);
  const equity = snap.cash + openValue;
  const ret = snap.start > 0n ? Number(((equity - snap.start) * 10_000n) / snap.start) / 100 : 0;
  const wins = snap.closed.filter((t) => BigInt(t.pnl) > 0n).length;
  const net = snap.closed.reduce((s, t) => s + BigInt(t.pnl), 0n);
  push(
    concat(
      [sp("equity ", c.mutedDim), { t: usd(equity), c: c.fg, b: true }, sp("  ", c.fg), { t: signed(ret), c: ret >= 0 ? c.ok : c.err, b: true }, sp("   ", c.fg)],
      spark(snap.equity.map((e) => Number(e.usd) / 1e6), Math.max(10, Math.min(36, Math.floor(w / 5))), ret >= 0 ? c.ok : c.err, c.mutedDim, (Number(snap.start) / 1e6) * 0.002),
      [sp(`   cash ${usd(snap.cash)} · in play ${usd(openValue)} · ${wins}W/${snap.closed.length - wins}L · net ${net >= 0n ? "+" : "−"}${usd(net < 0n ? -net : net)}   `, c.muted)],
      snap.enabled
        ? [{ t: "AUTO ON", c: c.ok, b: true }]
        : [{ t: "AUTO OFF", c: c.warn, b: true }],
    ),
  );
  if (snap.error) push([sp(`⚠ last scan failed: ${snap.error}`, c.warn)]);
  push(blank(w));

  // ---- the market
  section("MARKET", "on chain vs Wall Street · fills at the live pools");
  push(
    [
      sp(
        `  ${"ASSET".padEnd(7)}${"ON CHAIN".padStart(11)}  ${`${snap.rules.trendWindowMin}m`.padEnd(16)} ${"TREND".padStart(7)}  ${"WALL ST".padStart(10)}  ` +
          `${"cheaper ◂ PREMIUM ▸ richer".padEnd(26)}  ${"COST".padStart(5)}  ${"VOL 5m".padStart(7)}  SIGNAL`,
        c.mutedDim,
      ),
    ],
  );
  const flashOn = now - snap.lastTick < 1_500;
  for (const q of snap.quotes) {
    const row = marketRow(q, snap, c, flashOn);
    if (q.verdict.startsWith("buy")) pushBg(row, lerpColor(c.panelBg, c.warn, 0.18));
    else push(row);
  }
  push(blank(w));

  // ---- positions
  const posRows = Math.max(1, snap.positions.length);
  section("POSITIONS", `${snap.positions.length}/${snap.rules.maxOpen} · $${snap.rules.sizeUsd} per auto entry · /stocks buy NVDA 500`);
  if (!snap.positions.length) {
    push([sp(`  ${snap.enabled ? "waiting for an edge — the SIGNAL column says how close each token is" : "no positions — /stocks buy <sym> <$>, or /stocks on for the strategies"}`, c.muted)]);
  }
  for (const p of snap.positions) {
    const row = positionRow(p, snap, c, now);
    if (now - p.openedAt < FLASH_MS) pushBg(row, lerpColor(c.panelBg, c.ok, 0.22));
    else push(row);
  }
  push(blank(w));

  // ---- tape and journal share what is left
  const journalRows = Math.min(4, Math.max(1, snap.journal.length));
  const tapeRows = Math.max(0, rows - out.length - 1 - (1 + journalRows + 1) - 1 - (posRows - snap.positions.length > 0 ? 0 : 0));
  section("TAPE", "swaps in the stock pools (ETH only above $5k)");
  const lag = Math.ceil(snap.intervalMs / 1000) + 1;
  // Dust (a few dollars of routing) is not a trade worth a row.
  const visible = snap.tape.filter((t) => t.ts <= now / 1000 - lag && t.usd >= 10);
  const held = new Set(snap.positions.map((p) => p.symbol));
  const shown = visible.slice(-Math.max(0, tapeRows)).reverse();
  for (const t of shown) {
    const fresh = now / 1000 - lag - t.ts < 1.2;
    const buy = t.side === "buy";
    const whale = t.usd >= 50_000;
    const row = concat(
      [sp(`  ${clockOf(t.ts)}  `, c.mutedDim)],
      [{ t: buy ? "▲ BUY " : "▼ SELL", c: buy ? c.ok : c.err, b: fresh }],
      [sp("  ", c.fg), { t: pad(t.symbol, 6), c: held.has(t.symbol) ? c.warn : c.fg, b: true }],
      [sp(` ${fmtQty(t.qty).padStart(11)}  `, c.muted)],
      [{ t: `$${compact(t.usd)}`.padStart(9), c: buy ? c.ok : c.err, b: t.usd >= 10_000 }],
      whale ? [{ t: "  ◆ whale", c: buy ? c.ok : c.err, b: true }] : [],
      held.has(t.symbol) ? [sp("  · held", c.warn)] : [],
    );
    if (fresh) pushBg(row, lerpColor(c.panelBg, buy ? c.ok : c.err, 0.14));
    else push(row);
  }
  for (let i = shown.length; i < tapeRows; i++) push(i === 0 ? [sp("  waiting for the first swaps…", c.mutedDim)] : blank(w));

  push(blank(w));
  section("JOURNAL", "entries and exits");
  if (!snap.journal.length) push([sp("  nothing yet", c.mutedDim)]);
  for (const j of snap.journal.slice(-journalRows).reverse()) {
    const age = now - j.at;
    const row: Line = concat([sp(`  ${clockOf(j.at / 1000)}  `, c.mutedDim)], journalSpans(j.text, c));
    if (age < FLASH_MS * 1.5) {
      const tone = j.text.startsWith("🟥") ? c.err : c.ok;
      pushBg(row, lerpColor(c.panelBg, tone, 0.3 * (1 - age / (FLASH_MS * 1.5)) + 0.08));
    } else push(row);
  }

  while (out.length < rows - 1) push(blank(w));
  out.length = Math.min(out.length, rows - 1);
  push([
    sp(
      `esc closes · /stocks buy <sym> <$> · /stocks sell <sym> [all|$] · /stocks on|off · /stocks set <rule> <v> · /stocks rules · ` +
        `basis: ≥${snap.rules.minEdgePct}% past cost · trend: +${snap.rules.trendPct}%/${snap.rules.trendWindowMin}m, trail ${snap.rules.trailPct}%`,
      c.mutedDim,
    ),
  ]);
  return out.slice(0, rows).map((l) => truncateLine(l, w));
}

function marketRow(q: DeskQuote, snap: DeskSnapshot, c: Theme, flashOn: boolean): Line {
  const h = q.history;
  const prev = h.length >= 2 ? h[h.length - 2]! : null;
  const last = h.at(-1) ?? null;
  const moved = prev !== null && last !== null ? Math.sign(last - prev) : 0;
  const priceColor = moved > 0 ? c.ok : moved < 0 ? c.err : c.fg;
  const window = Math.max(2, Math.round((snap.rules.trendWindowMin * 60_000) / snap.intervalMs));
  const recent = downsample(h.slice(-window), 16);
  const trendTone = q.trendPct === null ? c.mutedDim : q.trendPct >= 0 ? c.ok : c.err;
  const streetAge = q.street ? Math.round((Date.now() / 1000 - q.street.at) / 60) : null;
  const verdict: Span = q.verdict === "in"
    ? { t: "◆ IN", c: c.ok, b: true }
    : q.verdict.startsWith("buy")
      ? { t: `▶ ${q.verdict.toUpperCase()}`, c: c.warn, b: true }
      : q.verdict.startsWith("trend") || q.verdict.includes("signal")
        ? sp(`· ${q.verdict}`, c.secondary)
        : sp(`· ${q.verdict}`, c.mutedDim);
  return concat(
    [sp("  ", c.fg), { t: pad(q.symbol, 7), c: c.fg, b: true }],
    [{ t: (q.price === null ? "?" : money(q.price)).padStart(11), c: priceColor, b: flashOn && moved !== 0 }],
    [sp("  ", c.fg)],
    spark(recent, 16, trendTone, c.mutedDim, last ? last * 0.002 : 0),
    [{ t: (q.trendPct === null ? "—" : signed(q.trendPct)).padStart(8), c: trendTone }],
    [sp("  ", c.fg)],
    q.street
      ? [sp(money(q.street.price).padStart(10), c.fg), sp(streetAge !== null && streetAge > 2 ? ` ${ageLabel(streetAge)}` : "", c.mutedDim)]
      : [sp("—".padStart(10), c.mutedDim)],
    [sp(streetAge !== null && streetAge > 2 ? " " : "    ", c.fg)],
    premiumGauge(q.premiumPct, c),
    [sp(`  ${q.costPct === null ? "  —" : `${q.costPct.toFixed(2)}%`.padStart(5)}`, c.mutedDim)],
    [sp(`  ${`$${compact(q.volume5m)}`.padStart(7)}  `, q.volume5m > 0 ? c.muted : c.mutedDim)],
    [verdict],
  );
}

/** cheaper ◂──●──┊─────▸ richer, ±1 %, with the number after it. */
function premiumGauge(pct: number | null, c: Theme): Line {
  const width = 17;
  if (pct === null) return [sp(`${"·".repeat(width)}         `, c.mutedDim)];
  const clamped = Math.max(-GAUGE_SPAN, Math.min(GAUGE_SPAN, pct));
  const at = Math.round(((clamped + GAUGE_SPAN) / (2 * GAUGE_SPAN)) * (width - 1));
  const mid = Math.floor(width / 2);
  const tone = pct < 0 ? c.ok : pct > 0 ? c.err : c.fg;
  const cells: Span[] = [];
  for (let i = 0; i < width; i++) {
    if (i === at) cells.push({ t: "●", c: tone, b: true });
    else if (i === mid) cells.push(sp("┊", c.mutedDim));
    else cells.push(sp("─", i < mid ? lerpColor(c.border, c.ok, 0.45) : lerpColor(c.border, c.err, 0.45)));
  }
  return concat(cells, [{ t: ` ${signed(pct)}`.padEnd(9), c: tone, b: Math.abs(pct) >= 0.3 }]);
}

function positionRow(p: DeskPosition, snap: DeskSnapshot, c: Theme, now: number): Line {
  const cost = BigInt(p.cost);
  const mark = BigInt(p.mark);
  const ret = cost > 0n ? Number(((mark - cost) * 10_000n) / cost) / 100 : 0;
  const tone = ret >= 0 ? c.ok : c.err;
  const held = (now - p.openedAt) / 60_000;
  // A live backtested strategy books as "strategy s1": its id is the tag, its rules close it.
  const live = /^strategy (s\d+)$/.exec(p.by)?.[1];
  const tag = p.by === "auto" ? (p.strategy ?? "auto") : live ? `live ${live}` : `by ${p.by}`;
  const peak = p.peak ? BigInt(p.peak) : mark;
  const offPeak = peak > 0n ? Number(((peak - mark) * 10_000n) / peak) / 100 : 0;
  const tail: Line =
    p.strategy === "trend"
      ? [sp(`trail ${offPeak.toFixed(2)}% of ${snap.rules.trailPct}%`, offPeak >= snap.rules.trailPct * 0.7 ? c.warn : c.mutedDim)]
      : p.by === "auto"
        ? [sp(`TP +${snap.rules.takeProfitPct}% · SL −${snap.rules.stopLossPct}%`, c.mutedDim)]
        : [sp(live ? "closes on its rules · /backtest live" : "closes by hand", c.mutedDim)];
  return concat(
    [sp("  ", c.fg), { t: pad(p.symbol, 7), c: c.fg, b: true }, sp(pad(tag, 12), c.secondary)],
    [{ t: signed(ret).padStart(8), c: tone, b: true }, sp("  ", c.fg)],
    spark(p.marks, 14, tone, c.mutedDim, 0.4),
    [sp(`  ${usd(cost)} → `, c.muted), { t: usd(mark), c: tone }, sp(`  ${held < 60 ? `${Math.round(held)}m` : `${(held / 60).toFixed(1)}h`}  `, c.muted)],
    tail,
  );
}

function sessionLabel(snap: DeskSnapshot, now: number): { text: string; open: boolean } {
  if (snap.session === "open") return { text: "OPEN", open: true };
  const mins = Math.max(0, Math.round((snap.nextOpenMs - now) / 60_000));
  const until = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
  return { text: `${snap.session === "closed" ? "CLOSED" : snap.session === "pre" ? "PRE-MARKET" : "AFTER-HOURS"} · opens in ${until}`, open: false };
}

/** Pick `width` evenly spaced values. */
function downsample(values: number[], width: number): number[] {
  if (values.length <= width) return values;
  const step = (values.length - 1) / (width - 1);
  return Array.from({ length: width }, (_, i) => values[Math.round(i * step)]!);
}

function money(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function usd(microUsd: bigint): string {
  return money(Number(microUsd) / 1e6);
}

function compact(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : n.toFixed(0);
}

function fmtQty(n: number): string {
  return n >= 100 ? n.toFixed(1) : n >= 1 ? n.toFixed(3) : n.toPrecision(3);
}

function signed(pct: number): string {
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(Math.abs(pct) < 1 ? 2 : 1)}%`;
}

function ageLabel(mins: number): string {
  return mins >= 60 ? `${Math.round(mins / 60)}h` : `${mins}m`;
}
