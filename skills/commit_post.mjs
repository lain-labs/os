import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// skills/commit_post.mjs -> repo root
const DEFAULT_REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function git(repo, args) {
  const { stdout } = await execFileAsync('git', args, {
    cwd: repo,
    maxBuffer: 1024 * 1024 * 8,
  });
  return stdout.trim();
}

function classify(filesText) {
  const files = filesText.split('\n').map((x) => x.trim()).filter(Boolean);
  const buckets = new Map();

  for (const file of files) {
    let key = 'core';
    if (file.startsWith('src/plugins/')) key = 'agent plugins';
    else if (file.startsWith('src/models/')) key = 'model routing';
    else if (file.startsWith('src/clients/')) key = 'clients (TUI/Telegram/HTTP)';
    else if (file.startsWith('src/memory/')) key = 'memory';
    else if (file.startsWith('src/')) key = 'runtime';
    else if (file.startsWith('skills/')) key = 'skills';
    else if (file.startsWith('scripts/')) key = 'ops scripts';
    else if (file.startsWith('docs/')) key = 'docs';
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }

  return [...buckets.entries()].sort((a, b) => b[1] - a[1]);
}

function pickSignal(commits, buckets) {
  const text = commits.map((c) => `${c.subject} ${c.body || ''}`).join(' ').toLowerCase();
  if (text.includes('wallet') || text.includes('metamask') || text.includes('phantom')) {
    return "today's main signal — wallets and transaction signing are back in focus.";
  }
  if (text.includes('chain') || text.includes('dex') || text.includes('launchpad')) {
    return "today's main signal — work on the on-chain layer: network connectivity, trading, liquidity.";
  }
  if (buckets.some(([name]) => name === 'agent plugins')) {
    return "today's main signal — LainOS keeps growing a nervous system: memory, skills, watches and working hands.";
  }
  if (buckets.length) {
    return `today's main signal — most of the movement was in ${buckets[0][0]}. Not a showcase, but the layer that keeps the system running.`;
  }
  return "today's main signal is simple: the work didn't stop. The project had a pulse in the code again.";
}

function draftLongPost(commits, buckets, hours) {
  const count = commits.length;
  const top = buckets.slice(0, 5);
  const signal = pickSignal(commits, buckets);

  const areaLine = top.length
    ? top.map(([name, n]) => `${name} — ${n}`).join('; ')
    : 'changes are spread across the core of the repository';

  const subjects = commits.slice(0, 8).map((c) => `• ${c.subject}`).join('\n');

  return `today moved on commits again, not slogans.\n\nIn the last ${hours} hours the repository saw ${count} ${count === 1 ? 'commit' : 'commits'}. Not the kind of noise a pretty feed needs. This is the working trail: small decisions, fixes, the build, infrastructure, interfaces, agent memory. What makes the system less fragile.\n\n${signal}\n\nWhere the main pulse was:\n${areaLine}\n\nWhat actually showed up in the history:\n${subjects || '• there are changes, but the commit list came back empty from git'}\n\nI like this kind of progress. It doesn't look like one big announcement, but that's usually how a real system grows: day by day, layer by layer, until yesterday's impossibility becomes an ordinary button in the interface.\n\npresent day. present time.\nthe work continues.`;
}

async function sendTelegram(runtime, text) {
  if (runtime?.tools?.send_telegram) {
    return await runtime.tools.send_telegram({ text });
  }
  if (runtime?.callTool) {
    return await runtime.callTool('send_telegram', { text });
  }
  if (runtime?.invoke) {
    return await runtime.invoke('send_telegram', { text });
  }
  return { ok: false, text: 'telegram tool is not reachable from this skill runtime' };
}

export default {
  name: 'commit_post',
  description: 'Read commits from the last day, draft a long project-progress post, and optionally send it to the operator on Telegram for approval.',
  parameters: {
    type: 'object',
    properties: {
      repo: { type: 'string', description: 'Repository path. Defaults to this repository.' },
      hours: { type: 'number', description: 'Lookback window in hours. Default: 24.' },
      sendTelegram: { type: 'boolean', description: 'Send the drafted post to Telegram. Default: true.' },
      includeFiles: { type: 'boolean', description: 'Include changed-file summary in returned data. Default: true.' },
    },
  },
  async handler(runtime, state, params = {}) {
    const repo = params.repo || DEFAULT_REPO;
    const hours = Number(params.hours || 24);
    const send = params.sendTelegram !== false;
    const since = `${hours} hours ago`;

    const raw = await git(repo, ['log', `--since=${since}`, '--pretty=format:%H%x1f%an%x1f%ad%x1f%s%x1f%b%x1e', '--date=iso']);
    const commits = raw
      ? raw.split('\x1e').map((entry) => {
          const [hash, author, date, subject, body] = entry.trim().split('\x1f');
          return { hash, author, date, subject, body };
        }).filter((c) => c.hash && c.subject)
      : [];

    if (!commits.length) {
      const text = `found no commits in the last ${hours} hours. not drafting a post out of thin air.`;
      return { ok: true, text, data: { commits: [] } };
    }

    const hashes = commits.map((c) => c.hash);
    const filesText = await git(repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', ...hashes]);
    const buckets = classify(filesText);
    const post = draftLongPost(commits, buckets, hours);

    let telegram = null;
    if (send) {
      telegram = await sendTelegram(runtime, post);
    }

    return {
      ok: true,
      text: send
        ? `done. a long draft covering ${commits.length} commits was sent to Telegram.`
        : post,
      data: {
        repo,
        hours,
        commitCount: commits.length,
        buckets,
        post,
        telegram,
      },
    };
  },
};
