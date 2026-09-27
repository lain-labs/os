/**
 * Commits as raw material for a post.
 *
 * The operator's rule: posts are assembled from what was actually built. A
 * commit log is the only record of that which is written down without anyone
 * being asked to write it — but it is written *for engineers*, so it is
 * evidence and never copy. The service hands the log to the writer as
 * material; the prompt is what forbids it from reaching the reader as-is
 * ("Fixed CI" was a real post, and the strategy report names it as a failure).
 *
 * The paths a commit touched are kept because they say which product the
 * change belongs to — the wallet, the console, the bridge — which is exactly
 * the fact a subject line usually leaves out.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Commit {
  hash: string;
  /** YYYY-MM-DD, author date. */
  date: string;
  subject: string;
  body: string;
  /** Top two path segments of what it touched, deduplicated. */
  areas: string[];
}

const RECORD = "\x1e";
const FIELD = "\x1f";
const AREA_CAP = 4;

/**
 * Parse `git log --format=%x1e%H%x1f%ad%x1f%s%x1f%b%x1f --name-only`.
 * Pure, so the shape of the log is pinned by tests and not by a live repo.
 */
export function parseGitLog(raw: string): Commit[] {
  const out: Commit[] = [];
  for (const record of raw.split(RECORD)) {
    if (!record.trim()) continue;
    const [hash = "", date = "", subject = "", body = "", files = ""] = record.split(FIELD);
    if (!hash.trim() || !subject.trim()) continue;
    const areas: string[] = [];
    for (const line of files.split("\n")) {
      const path = line.trim();
      if (!path) continue;
      const area = path.split("/").slice(0, 2).join("/");
      if (area && !areas.includes(area)) areas.push(area);
    }
    out.push({
      hash: hash.trim(),
      date: date.trim(),
      subject: subject.trim(),
      body: body.trim(),
      areas: areas.slice(0, AREA_CAP),
    });
  }
  return out;
}

/** The material block handed to the writer, newest first. */
export function commitsText(commits: Commit[], limit = 40): string {
  if (!commits.length) return "";
  return commits
    .slice(0, limit)
    .map((c) => {
      const where = c.areas.length ? ` [${c.areas.join(", ")}]` : "";
      const body = c.body ? `\n  ${c.body.split("\n").slice(0, 4).join("\n  ")}` : "";
      return `- ${c.date} ${c.subject}${where}${body}`;
    })
    .join("\n");
}

/**
 * Read the repository's recent history. A failure here is never fatal: a post
 * with a thesis and no evidence is still a post, while a daemon that stops
 * writing because git moved is not.
 */
export async function readCommits(
  repo: string,
  opts: { sinceDays: number; limit?: number },
): Promise<Commit[]> {
  const since = new Date(Date.now() - Math.max(1, opts.sinceDays) * 86_400_000);
  const { stdout } = await run(
    "git",
    [
      "-C",
      repo,
      "log",
      "--no-merges",
      "--date=short",
      `--since=${since.toISOString().slice(0, 10)}`,
      `--max-count=${opts.limit ?? 60}`,
      `--format=${RECORD}%H${FIELD}%ad${FIELD}%s${FIELD}%b${FIELD}`,
      "--name-only",
    ],
    { maxBuffer: 8 * 1024 * 1024, timeout: 20_000 },
  );
  return parseGitLog(stdout);
}
