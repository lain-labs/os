#!/usr/bin/env -S npx tsx
import "dotenv/config";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

type Severity = "high" | "medium" | "low";

interface Transcript {
  id: string;
  userText?: string;
  startedAt: string;
  modelCalls?: Array<{
    phase?: string;
    error?: string;
    response?: { toolCalls?: Array<{ name: string; input?: Record<string, unknown> }> };
  }>;
  toolResults?: Array<{ name: string; ok: boolean; summary?: string }>;
  final?: { endedAt: string; model?: string; text?: string };
  bytes: number;
}

interface MemoryRecord {
  id?: string;
  role?: string;
  content?: string;
  createdAt?: number;
}

interface Issue {
  kind: string;
  severity: Severity;
  turnId: string;
  startedAt: string;
  evidence: string;
}

interface Options {
  dataDir: string;
  json: boolean;
  output?: string;
  sinceHours?: number;
  slowMs: number;
}

const CORRECTION_RE = /^\s*(?:no(?:[,.!:; ]|$)|not (?:like that|that|working|recorded)|that's not it|again|why did you|fix (?:it|that)|add to that|too (?:much|little))/i;
const SECRET_KEY_RE = /(KEY|TOKEN|SECRET|MNEMONIC|COOKIE|PASSWORD|PK|PRIVATE)/i;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const transcriptDir = join(options.dataDir, "model-transcripts");
  const cutoff = options.sinceHours
    ? Date.now() - options.sinceHours * 3_600_000
    : Number.NEGATIVE_INFINITY;
  const secretValues = Object.entries(process.env)
    .filter(([key, value]) => SECRET_KEY_RE.test(key) && value && value.length >= 8)
    .map(([, value]) => value as string);
  const scrub = (value: unknown, max = 240) => redact(String(value ?? ""), secretValues, max);

  let malformed = 0;
  const transcripts: Transcript[] = [];
  const entries = await readdir(transcriptDir, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(transcriptDir, entry.name);
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as Omit<Transcript, "bytes">;
      if (Date.parse(parsed.startedAt) < cutoff) continue;
      transcripts.push({ ...parsed, bytes: (await stat(path)).size });
    } catch {
      malformed += 1;
    }
  }
  transcripts.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));

  let memory: MemoryRecord[] = [];
  try {
    const parsed = JSON.parse(await readFile(join(options.dataDir, "memory.json"), "utf8")) as {
      memories?: MemoryRecord[];
    };
    memory = (parsed.memories ?? []).filter((item) => (item.createdAt ?? 0) >= cutoff);
  } catch {
    // Transcripts alone are sufficient; memory only adds correction signals.
  }

  const issues: Issue[] = [];
  const toolStats = new Map<string, { calls: number; failed: number }>();
  const modelStats = new Map<string, number>();
  const durations: number[] = [];
  let modelCalls = 0;
  let toolCalls = 0;
  let rawDialogueChars = 0;

  for (const turn of transcripts) {
    const turnId = safeId(turn.id);
    const calls = turn.modelCalls ?? [];
    const results = turn.toolResults ?? [];
    modelCalls += calls.length;
    toolCalls += results.length;
    rawDialogueChars += (turn.userText?.length ?? 0) + (turn.final?.text?.length ?? 0);

    const model = turn.final?.model ?? "unfinished";
    modelStats.set(model, (modelStats.get(model) ?? 0) + 1);
    if (!turn.final) {
      issues.push(issue("incomplete_turn", "high", turnId, turn.startedAt, scrub(turn.userText)));
    } else {
      const ms = Date.parse(turn.final.endedAt) - Date.parse(turn.startedAt);
      if (Number.isFinite(ms) && ms >= 0) durations.push(ms);
      if (ms > options.slowMs) {
        issues.push(
          issue(
            "slow_turn",
            "low",
            turnId,
            turn.startedAt,
            `${Math.round(ms / 1000)}s; ${scrub(turn.userText)}`,
          ),
        );
      }
      if (!turn.final.text?.trim() || turn.final.text.trim() === "...") {
        issues.push(issue("empty_final_reply", "high", turnId, turn.startedAt, scrub(turn.userText)));
      }
    }

    if (calls.length > 3) {
      issues.push(
        issue(
          "excessive_model_rounds",
          "low",
          turnId,
          turn.startedAt,
          `${calls.length} calls; ${scrub(turn.userText)}`,
        ),
      );
    }
    for (const call of calls) {
      if (call.error) {
        issues.push(issue("model_error", "high", turnId, turn.startedAt, scrub(call.error)));
      }
      if (call.phase === "empty-reply-retry") {
        issues.push(issue("empty_reply_retry", "medium", turnId, turn.startedAt, scrub(turn.userText)));
      }
    }

    const seenCalls = new Set<string>();
    for (const call of calls.flatMap((item) => item.response?.toolCalls ?? [])) {
      const key = `${call.name}:${stableJson(call.input ?? {})}`;
      if (seenCalls.has(key)) {
        issues.push(issue("repeated_tool_call", "medium", turnId, turn.startedAt, call.name));
      }
      seenCalls.add(key);
    }
    for (const result of results) {
      const stats = toolStats.get(result.name) ?? { calls: 0, failed: 0 };
      stats.calls += 1;
      if (!result.ok) {
        stats.failed += 1;
        issues.push(
          issue("tool_failure", "medium", turnId, turn.startedAt, `${result.name}: ${scrub(result.summary)}`),
        );
      }
      toolStats.set(result.name, stats);
    }
  }

  for (const item of memory) {
    if (item.role !== "user" || !CORRECTION_RE.test(item.content ?? "")) continue;
    issues.push(
      issue(
        "user_correction",
        "medium",
        safeId(item.id),
        new Date(item.createdAt ?? 0).toISOString(),
        scrub(item.content),
      ),
    );
  }

  issues.sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.startedAt.localeCompare(b.startedAt));
  const totalBytes = transcripts.reduce((sum, turn) => sum + turn.bytes, 0);
  const report = {
    generatedAt: new Date().toISOString(),
    window: options.sinceHours ? `last ${options.sinceHours}h` : "all retained data",
    summary: {
      transcripts: transcripts.length,
      completed: transcripts.filter((turn) => Boolean(turn.final)).length,
      malformed,
      memoryMessages: memory.length,
      modelCalls,
      toolCalls,
      transcriptBytes: totalBytes,
      rawDialogueChars,
      storageToDialogueRatio: rawDialogueChars ? Number((totalBytes / rawDialogueChars).toFixed(1)) : 0,
      latencyMs: {
        p50: percentile(durations, 0.5),
        p90: percentile(durations, 0.9),
        max: durations.length ? Math.max(...durations) : 0,
      },
      issues: countBy(issues.map((item) => item.kind)),
      models: Object.fromEntries([...modelStats.entries()].sort()),
      tools: Object.fromEntries([...toolStats.entries()].sort()),
    },
    issues,
    recommendations: recommendationsFor(issues),
  };

  const output = options.json ? `${JSON.stringify(report, null, 2)}\n` : markdown(report);
  if (options.output) {
    const target = resolve(options.output);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, output, "utf8");
    process.stdout.write(`${target}\n`);
  } else {
    process.stdout.write(output);
  }
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    dataDir: resolve(process.env.LAINOS_DATA_DIR ?? "./data"),
    json: false,
    slowMs: 45_000,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--json") options.json = true;
    else if (arg === "--data-dir") options.dataDir = resolve(requiredValue(args, ++i, arg));
    else if (arg === "--output") options.output = requiredValue(args, ++i, arg);
    else if (arg === "--since-hours") options.sinceHours = positiveNumber(requiredValue(args, ++i, arg), arg);
    else if (arg === "--slow-ms") options.slowMs = positiveNumber(requiredValue(args, ++i, arg), arg);
    else if (arg === "--help") {
      process.stdout.write(
        "Usage: npm run analyze:transcripts -- [--json] [--since-hours N] [--slow-ms N] [--data-dir PATH] [--output PATH]\n",
      );
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function positiveNumber(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${flag} must be a positive number`);
  return value;
}

function redact(input: string, secretValues: string[], max: number): string {
  let value = input
    .replace(/\b0x[a-fA-F0-9]{64}\b/g, "[redacted:private-key]")
    .replace(/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, "[redacted:bot-token]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[redacted:api-key]")
    .replace(/\b[A-Za-z0-9_=-]{20,}\.[A-Za-z0-9_=-]{20,}\.[A-Za-z0-9_=-]{20,}\b/g, "[redacted:token]")
    .replace(
      /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|COOKIE)[A-Z0-9_]*\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi,
      "$1[redacted]",
    );
  for (const secret of secretValues) value = value.split(secret).join("[redacted:env]");
  value = value.replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}...` : value;
}

function safeId(value?: string): string {
  return (value ?? "unknown").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 12) || "unknown";
}

function issue(kind: string, severity: Severity, turnId: string, startedAt: string, evidence: string): Issue {
  return { kind, severity, turnId, startedAt, evidence };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort());
}

function severityRank(value: Severity): number {
  return value === "high" ? 0 : value === "medium" ? 1 : 2;
}

function recommendationsFor(issues: Issue[]): string[] {
  const kinds = new Set(issues.map((item) => item.kind));
  const recommendations: string[] = [];
  if (kinds.has("tool_failure") || kinds.has("repeated_tool_call")) {
    recommendations.push("Review failing/repeated actions and make their result contracts explicit and verifiable.");
  }
  if (kinds.has("user_correction")) {
    recommendations.push("Promote confirmed user corrections and preferences into scoped durable memory.");
  }
  if (kinds.has("slow_turn") || kinds.has("excessive_model_rounds")) {
    recommendations.push("Add deterministic routes for common workflows and reduce repeated prompt/tool-schema payloads.");
  }
  if (kinds.has("model_error") || kinds.has("empty_final_reply") || kinds.has("empty_reply_retry")) {
    recommendations.push("Inspect provider failures and empty replies before changing prompts or model routing.");
  }
  if (!recommendations.length) recommendations.push("No deterministic failure signal found; sample completed turns for qualitative review.");
  return recommendations;
}

function markdown(report: {
  generatedAt: string;
  window: string;
  summary: Record<string, unknown> & {
    transcripts: number;
    completed: number;
    modelCalls: number;
    toolCalls: number;
    transcriptBytes: number;
    rawDialogueChars: number;
    storageToDialogueRatio: number;
    latencyMs: { p50: number; p90: number; max: number };
  };
  issues: Issue[];
  recommendations: string[];
}): string {
  const lines = [
    "# LainOS dialogue analysis",
    "",
    `Generated: ${report.generatedAt}`,
    `Window: ${report.window}`,
    "",
    "## Summary",
    "",
    `- Turns: ${report.summary.transcripts} (${report.summary.completed} completed)`,
    `- Model/tool calls: ${report.summary.modelCalls}/${report.summary.toolCalls}`,
    `- Latency p50/p90/max: ${formatMs(report.summary.latencyMs.p50)} / ${formatMs(report.summary.latencyMs.p90)} / ${formatMs(report.summary.latencyMs.max)}`,
    `- Trace size: ${formatBytes(report.summary.transcriptBytes)} for ${report.summary.rawDialogueChars} dialogue chars (${report.summary.storageToDialogueRatio}x)`,
    `- Issues: ${report.issues.length}`,
    "",
    "## Issues",
    "",
  ];
  if (!report.issues.length) lines.push("No deterministic issue signals found.");
  for (const item of report.issues) {
    lines.push(`- **${item.severity} / ${item.kind}** (${item.startedAt}, ${item.turnId}): ${item.evidence || "no excerpt"}`);
  }
  lines.push("", "## Recommendations", "");
  for (const recommendation of report.recommendations) lines.push(`- ${recommendation}`);
  return `${lines.join("\n")}\n`;
}

function formatMs(value: number): string {
  return value ? `${(value / 1000).toFixed(1)}s` : "n/a";
}

function formatBytes(value: number): string {
  return value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

main().catch((error) => {
  process.stderr.write(`analyze-transcripts: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
