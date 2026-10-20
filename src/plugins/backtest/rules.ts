/**
 * The rule language backtest strategies are written in — small enough to
 * check before a run, wide enough for the strategies people actually test:
 *
 *   ema(close, 12) > ema(close, 26) and rsi(close, 14) < 70
 *   close > highest(high, 20)[1]
 *   cross_below(macd(close, 12, 26), macd_signal(close, 12, 26, 9))
 *
 * Series are open, high, low, close, volume; x[n] is x n bars ago. Arithmetic
 * + - * /, comparisons > < >= <= == !=, and / or / not (&& || ! too).
 * Periods count bars of the run's interval.
 *
 * A rule compiles to one series over the whole history at once. Every
 * function looks only at the bar it is on and the bars before it, and x[n]
 * takes no negative n — nothing in a rule can see the future.
 */

export interface Market {
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
  volume: Float64Array;
}

type Node =
  | { k: "num"; v: number }
  | { k: "series"; name: keyof Market }
  | { k: "call"; fn: string; args: Node[] }
  | { k: "bin"; op: string; a: Node; b: Node }
  | { k: "neg"; a: Node }
  | { k: "not"; a: Node }
  | { k: "ago"; a: Node; n: number };

type Arg = "series" | "period" | "number";

interface Fn {
  args: Arg[];
  /** Bars of history the function needs before its first trustworthy value, given its constant arguments. */
  warmup: (consts: number[]) => number;
  /** The result is a condition (1/0), not a price-like number. */
  bool?: boolean;
  about: string;
  run: (series: Float64Array[], consts: number[], m: Market) => Float64Array;
}

const NaNs = (n: number) => new Float64Array(n).fill(NaN);

function sma(x: Float64Array, n: number): Float64Array {
  const out = NaNs(x.length);
  let sum = 0;
  let bad = 0;
  for (let i = 0; i < x.length; i++) {
    if (Number.isNaN(x[i]!)) bad++;
    else sum += x[i]!;
    if (i >= n) {
      if (Number.isNaN(x[i - n]!)) bad--;
      else sum -= x[i - n]!;
    }
    if (i >= n - 1 && bad === 0) out[i] = sum / n;
  }
  return out;
}

/** Exponential smoothing at `alpha`, seeded with the mean of its first n values. */
function smooth(x: Float64Array, n: number, alpha: number): Float64Array {
  const out = NaNs(x.length);
  let state = NaN;
  let seed = 0;
  let count = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i]!;
    if (Number.isNaN(v)) {
      if (count < n) {
        seed = 0;
        count = 0;
      }
      continue;
    }
    if (count < n) {
      seed += v;
      count++;
      if (count === n) out[i] = state = seed / n;
      continue;
    }
    out[i] = state = state + alpha * (v - state);
  }
  return out;
}

const ema = (x: Float64Array, n: number) => smooth(x, n, 2 / (n + 1));
/** Wilder's smoothing — what RSI and ATR are defined with. */
const rma = (x: Float64Array, n: number) => smooth(x, n, 1 / n);

function rolling(x: Float64Array, n: number, f: (window: Float64Array) => number): Float64Array {
  const out = NaNs(x.length);
  for (let i = n - 1; i < x.length; i++) {
    const w = x.subarray(i - n + 1, i + 1);
    if (!w.some(Number.isNaN)) out[i] = f(w);
  }
  return out;
}

const stdev = (x: Float64Array, n: number) =>
  rolling(x, n, (w) => {
    const mean = w.reduce((s, v) => s + v, 0) / n;
    return Math.sqrt(w.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
  });

function rsi(x: Float64Array, n: number): Float64Array {
  const gain = NaNs(x.length);
  const loss = NaNs(x.length);
  for (let i = 1; i < x.length; i++) {
    const d = x[i]! - x[i - 1]!;
    gain[i] = d > 0 ? d : Number.isNaN(d) ? NaN : 0;
    loss[i] = d < 0 ? -d : Number.isNaN(d) ? NaN : 0;
  }
  const g = rma(gain, n);
  const l = rma(loss, n);
  return g.map((gv, i) => (Number.isNaN(gv) || Number.isNaN(l[i]!) ? NaN : l[i] === 0 ? 100 : 100 - 100 / (1 + gv / l[i]!)));
}

function atr(m: Market, n: number): Float64Array {
  const tr = NaNs(m.close.length);
  for (let i = 1; i < tr.length; i++) {
    const pc = m.close[i - 1]!;
    tr[i] = Math.max(m.high[i]! - m.low[i]!, Math.abs(m.high[i]! - pc), Math.abs(m.low[i]! - pc));
  }
  return rma(tr, n);
}

const macd = (x: Float64Array, fast: number, slow: number) => {
  const f = ema(x, fast);
  const s = ema(x, slow);
  return f.map((v, i) => v - s[i]!);
};

function cross(a: Float64Array, b: Float64Array, up: boolean): Float64Array {
  const out = new Float64Array(a.length);
  for (let i = 1; i < a.length; i++) {
    const was = a[i - 1]! - b[i - 1]!;
    const now = a[i]! - b[i]!;
    out[i] = up ? (was <= 0 && now > 0 ? 1 : 0) : was >= 0 && now < 0 ? 1 : 0;
  }
  return out;
}

const FNS: Record<string, Fn> = {
  sma: { args: ["series", "period"], warmup: ([n]) => n!, about: "simple moving average", run: ([x], [n]) => sma(x!, n!) },
  ema: { args: ["series", "period"], warmup: ([n]) => 3 * n!, about: "exponential moving average", run: ([x], [n]) => ema(x!, n!) },
  rsi: { args: ["series", "period"], warmup: ([n]) => 3 * n! + 1, about: "Wilder's RSI, 0–100", run: ([x], [n]) => rsi(x!, n!) },
  atr: { args: ["period"], warmup: ([n]) => 3 * n! + 1, about: "average true range (uses high, low, close)", run: (_, [n], m) => atr(m, n!) },
  stdev: { args: ["series", "period"], warmup: ([n]) => n!, about: "standard deviation", run: ([x], [n]) => stdev(x!, n!) },
  highest: { args: ["series", "period"], warmup: ([n]) => n!, about: "highest value of the last n bars, this one included", run: ([x], [n]) => rolling(x!, n!, (w) => Math.max(...w)) },
  lowest: { args: ["series", "period"], warmup: ([n]) => n!, about: "lowest value of the last n bars, this one included", run: ([x], [n]) => rolling(x!, n!, (w) => Math.min(...w)) },
  roc: {
    args: ["series", "period"],
    warmup: ([n]) => n! + 1,
    about: "percent change over n bars",
    run: ([x], [n]) => x!.map((v, i) => (i >= n! ? (v / x![i - n!]! - 1) * 100 : NaN)),
  },
  macd: { args: ["series", "period", "period"], warmup: ([, slow]) => 3 * slow!, about: "MACD line: ema(fast) − ema(slow)", run: ([x], [f, s]) => macd(x!, f!, s!) },
  macd_signal: {
    args: ["series", "period", "period", "period"],
    warmup: ([, slow, sig]) => 3 * slow! + 3 * sig!,
    about: "MACD signal line: ema of the MACD line",
    run: ([x], [f, s, g]) => ema(macd(x!, f!, s!), g!),
  },
  bb_upper: {
    args: ["series", "period", "number"],
    warmup: ([n]) => n!,
    about: "Bollinger upper band: sma + k·stdev",
    run: ([x], [n, k]) => {
      const mid = sma(x!, n!);
      const sd = stdev(x!, n!);
      return mid.map((v, i) => v + k! * sd[i]!);
    },
  },
  bb_lower: {
    args: ["series", "period", "number"],
    warmup: ([n]) => n!,
    about: "Bollinger lower band: sma − k·stdev",
    run: ([x], [n, k]) => {
      const mid = sma(x!, n!);
      const sd = stdev(x!, n!);
      return mid.map((v, i) => v - k! * sd[i]!);
    },
  },
  cross_above: { args: ["series", "series"], warmup: () => 1, bool: true, about: "a crosses above b on this bar", run: ([a, b]) => cross(a!, b!, true) },
  cross_below: { args: ["series", "series"], warmup: () => 1, bool: true, about: "a crosses below b on this bar", run: ([a, b]) => cross(a!, b!, false) },
  abs: { args: ["series"], warmup: () => 0, about: "absolute value", run: ([x]) => x!.map(Math.abs) },
  min: { args: ["series", "series"], warmup: () => 0, about: "the smaller of two", run: ([a, b]) => a!.map((v, i) => Math.min(v, b![i]!)) },
  max: { args: ["series", "series"], warmup: () => 0, about: "the larger of two", run: ([a, b]) => a!.map((v, i) => Math.max(v, b![i]!)) },
};

const SERIES = ["open", "high", "low", "close", "volume"] as const;

/** One line per function, for the tool's description and /backtest help. */
export function ruleHelp(): string {
  const sig = (name: string, f: Fn) => `${name}(${f.args.map((a, i) => (a === "series" ? (i === 0 && f.args.length > 1 ? "x" : "y") : a === "period" ? "n" : "k")).join(", ")})`;
  return Object.entries(FNS)
    .map(([name, f]) => `${sig(name, f)} ${f.about}`)
    .join("; ");
}

// ------------------------------------------------------------------ parser

type Token = { t: "num"; v: number } | { t: "id"; v: string } | { t: "op"; v: string };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const num = /^\d+(\.\d+)?|^\.\d+/.exec(src.slice(i));
    if (num) {
      out.push({ t: "num", v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) {
      out.push({ t: "id", v: id[0].toLowerCase() });
      i += id[0].length;
      continue;
    }
    const op = /^(>=|<=|==|!=|&&|\|\||[-+*/()<>,[\]!])/.exec(src.slice(i));
    if (op) {
      out.push({ t: "op", v: op[0] });
      i += op[0].length;
      continue;
    }
    throw new Error(`unexpected "${ch}" at ${i + 1}`);
  }
  return out;
}

class Parser {
  private i = 0;
  constructor(private readonly toks: Token[]) {}

  parse(): Node {
    if (!this.toks.length) throw new Error("the rule is empty");
    const node = this.or();
    if (this.i < this.toks.length) throw new Error(`unexpected "${this.toks[this.i]!.v}" after a complete expression`);
    return node;
  }

  private peek(...vals: string[]): boolean {
    const t = this.toks[this.i];
    return Boolean(t && t.t !== "num" && vals.includes(t.v));
  }

  private take(...vals: string[]): string | null {
    if (!this.peek(...vals)) return null;
    return String(this.toks[this.i++]!.v);
  }

  private expect(v: string): void {
    if (!this.take(v)) throw new Error(`expected "${v}"${this.toks[this.i] ? ` before "${this.toks[this.i]!.v}"` : " at the end"}`);
  }

  private or(): Node {
    let a = this.and();
    while (this.take("or", "||")) a = { k: "bin", op: "or", a, b: this.and() };
    return a;
  }

  private and(): Node {
    let a = this.not();
    while (this.take("and", "&&")) a = { k: "bin", op: "and", a, b: this.not() };
    return a;
  }

  private not(): Node {
    if (this.take("not", "!")) return { k: "not", a: this.not() };
    return this.cmp();
  }

  private cmp(): Node {
    const a = this.sum();
    const op = this.take(">=", "<=", "==", "!=", ">", "<");
    return op ? { k: "bin", op, a, b: this.sum() } : a;
  }

  private sum(): Node {
    let a = this.prod();
    for (let op = this.take("+", "-"); op; op = this.take("+", "-")) a = { k: "bin", op, a, b: this.prod() };
    return a;
  }

  private prod(): Node {
    let a = this.unary();
    for (let op = this.take("*", "/"); op; op = this.take("*", "/")) a = { k: "bin", op, a, b: this.unary() };
    return a;
  }

  private unary(): Node {
    if (this.take("-")) {
      const a = this.unary();
      return a.k === "num" ? { k: "num", v: -a.v } : { k: "neg", a };
    }
    return this.postfix();
  }

  private postfix(): Node {
    let a = this.primary();
    while (this.take("[")) {
      const t = this.toks[this.i++];
      if (!t || t.t !== "num" || !Number.isInteger(t.v)) throw new Error("x[n] takes a whole number of bars ago, like close[1]");
      this.expect("]");
      a = { k: "ago", a, n: t.v };
    }
    return a;
  }

  private primary(): Node {
    const t = this.toks[this.i++];
    if (!t) throw new Error("the rule ends too early");
    if (t.t === "num") return { k: "num", v: t.v };
    if (t.t === "op") {
      if (t.v !== "(") throw new Error(`unexpected "${t.v}"`);
      const inner = this.or();
      this.expect(")");
      return inner;
    }
    if (this.take("(")) {
      const args: Node[] = [];
      if (!this.take(")")) {
        do args.push(this.or());
        while (this.take(","));
        this.expect(")");
      }
      return { k: "call", fn: t.v, args };
    }
    if ((SERIES as readonly string[]).includes(t.v)) return { k: "series", name: t.v as keyof Market };
    if (FNS[t.v]) throw new Error(`${t.v} is a function — ${t.v}(${FNS[t.v]!.args.join(", ")})`);
    throw new Error(`unknown name "${t.v}" — series are ${SERIES.join(", ")}`);
  }
}

// ---------------------------------------------------------------- checking

const BOOL_OPS = new Set(["and", "or", ">", "<", ">=", "<=", "==", "!="]);

function isCondition(n: Node): boolean {
  return n.k === "not" || (n.k === "bin" && BOOL_OPS.has(n.op)) || (n.k === "call" && Boolean(FNS[n.fn]?.bool)) || (n.k === "ago" && isCondition(n.a));
}

function check(n: Node): void {
  if (n.k === "call") {
    const f = FNS[n.fn];
    if (!f) throw new Error(`unknown function "${n.fn}" — known: ${Object.keys(FNS).join(", ")}`);
    if (n.args.length !== f.args.length) throw new Error(`${n.fn} takes ${f.args.length} argument(s): ${n.fn}(${f.args.join(", ")})`);
    n.args.forEach((a, i) => {
      const want = f.args[i]!;
      if (want === "series") return check(a);
      if (a.k !== "num") throw new Error(`${n.fn}: argument ${i + 1} must be a plain number, not an expression`);
      if (want === "period" && (!Number.isInteger(a.v) || a.v < 1 || a.v > 5000)) throw new Error(`${n.fn}: a period is a whole number of bars from 1 to 5000, not ${a.v}`);
    });
  } else if (n.k === "bin") {
    check(n.a);
    check(n.b);
    if ((n.op === "and" || n.op === "or") && (!isCondition(n.a) || !isCondition(n.b))) throw new Error(`"${n.op}" joins conditions, e.g. rsi(close, 14) < 30 ${n.op} close > sma(close, 200)`);
  } else if (n.k === "neg" || n.k === "ago") check(n.a);
  else if (n.k === "not") {
    check(n.a);
    if (!isCondition(n.a)) throw new Error(`"not" negates a condition, e.g. not (close > sma(close, 50))`);
  }
}

function warmupOf(n: Node): number {
  switch (n.k) {
    case "num":
    case "series":
      return 0;
    case "ago":
      return n.n + warmupOf(n.a);
    case "neg":
    case "not":
      return warmupOf(n.a);
    case "bin":
      return Math.max(warmupOf(n.a), warmupOf(n.b));
    case "call": {
      const f = FNS[n.fn]!;
      const consts = n.args.filter((_, i) => f.args[i] !== "series").map((a) => (a as { v: number }).v);
      const inner = n.args.filter((_, i) => f.args[i] === "series").map(warmupOf);
      return f.warmup(consts) + Math.max(0, ...inner);
    }
  }
}

function key(n: Node): string {
  switch (n.k) {
    case "num":
      return String(n.v);
    case "series":
      return n.name;
    case "call":
      return `${n.fn}(${n.args.map(key).join(",")})`;
    case "bin":
      return `(${key(n.a)}${n.op}${key(n.b)})`;
    case "neg":
      return `-${key(n.a)}`;
    case "not":
      return `!${key(n.a)}`;
    case "ago":
      return `${key(n.a)}[${n.n}]`;
  }
}

// --------------------------------------------------------------- evaluation

/** Series already computed for one market, shared by every rule run on it. */
export type SeriesCache = Map<string, Float64Array>;

function evaluate(n: Node, m: Market, cache: SeriesCache): Float64Array {
  const k = key(n);
  const hit = cache.get(k);
  if (hit) return hit;
  const len = m.close.length;
  let out: Float64Array;
  switch (n.k) {
    case "num":
      out = new Float64Array(len).fill(n.v);
      break;
    case "series":
      out = m[n.name];
      break;
    case "neg":
      out = evaluate(n.a, m, cache).map((v) => -v);
      break;
    case "not":
      // A condition still warming up (x[n] of one, early on) is not true, and neither is its negation.
      out = evaluate(n.a, m, cache).map((v) => (v === 0 ? 1 : 0));
      break;
    case "ago": {
      const a = evaluate(n.a, m, cache);
      out = NaNs(len);
      for (let i = n.n; i < len; i++) out[i] = a[i - n.n]!;
      break;
    }
    case "bin": {
      const a = evaluate(n.a, m, cache);
      const b = evaluate(n.b, m, cache);
      const op = BIN[n.op]!;
      out = new Float64Array(len);
      for (let i = 0; i < len; i++) out[i] = op(a[i]!, b[i]!);
      break;
    }
    case "call": {
      const f = FNS[n.fn]!;
      const series = n.args.filter((_, i) => f.args[i] === "series").map((a) => evaluate(a, m, cache));
      const consts = n.args.filter((_, i) => f.args[i] !== "series").map((a) => (a as { v: number }).v);
      out = f.run(series, consts, m);
      break;
    }
  }
  cache.set(k, out);
  return out;
}

/** Conditions are 1 or 0; a comparison with a missing value (warm-up) is false. */
const truth = (a: number, b: number, ok: boolean) => (Number.isNaN(a) || Number.isNaN(b) ? 0 : ok ? 1 : 0);
const BIN: Record<string, (a: number, b: number) => number> = {
  "+": (a, b) => a + b,
  "-": (a, b) => a - b,
  "*": (a, b) => a * b,
  "/": (a, b) => (b === 0 ? NaN : a / b),
  ">": (a, b) => truth(a, b, a > b),
  "<": (a, b) => truth(a, b, a < b),
  ">=": (a, b) => truth(a, b, a >= b),
  "<=": (a, b) => truth(a, b, a <= b),
  "==": (a, b) => truth(a, b, a === b),
  "!=": (a, b) => truth(a, b, a !== b),
  and: (a, b) => (a === 1 && b === 1 ? 1 : 0),
  or: (a, b) => (a === 1 || b === 1 ? 1 : 0),
};

export interface Rule {
  source: string;
  /** Bars of history the rule needs before it can be trusted. */
  warmup: number;
  /** The condition on every bar: 1 where it holds, 0 elsewhere. */
  run(m: Market, cache: SeriesCache): Float64Array;
}

/** Parse and check a condition; throws a message that says what to write instead. */
export function compileRule(source: string): Rule {
  const ast = new Parser(tokenize(source)).parse();
  check(ast);
  if (!isCondition(ast)) {
    throw new Error("a rule must be a condition — a comparison (close > sma(close, 50)), cross_above/cross_below, or and/or/not of those");
  }
  return { source, warmup: warmupOf(ast), run: (m, cache) => evaluate(ast, m, cache) };
}
