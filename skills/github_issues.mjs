import { execFileSync } from 'node:child_process';
import { fetch } from 'undici';

function parseRepo(value) {
  if (!value) return null;
  const s = value.trim().replace(/\.git$/, '');
  const m = s.match(/github\.com[/:]([^/]+)\/([^/]+)$/i) || s.match(/^([^/\s]+)\/([^/\s]+)$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

export default {
  name: 'github_issues',
  description: 'List public GitHub issues from the current repository or an owner/repo override, excluding pull requests.',
  parameters: {
    type: 'object',
    properties: {
      repo: { type: 'string', description: 'Optional owner/repo or GitHub repository URL.' },
      repoPath: { type: 'string', description: 'Optional local repository path.' },
      state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Issue state. Default: open.' },
      limit: { type: 'number', description: 'Maximum issues to return, 1-100. Default: 30.' }
    }
  },
  async handler(runtime, state, params = {}) {
    let repo = parseRepo(params.repo);
    if (!repo) {
      try {
        const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
          cwd: params.repoPath || process.cwd(), encoding: 'utf8', timeout: 5000
        }).trim();
        repo = parseRepo(remote);
      } catch {}
    }
    if (!repo) return { ok: false, text: 'Could not determine the GitHub repository.', data: null };
    const issueState = params.state || 'open';
    const limit = Math.max(1, Math.min(100, Number(params.limit) || 30));
    const url = `https://api.github.com/repos/${repo}/issues?state=${issueState}&per_page=100&sort=updated&direction=desc`;
    const response = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'LainOS' } });
    if (!response.ok) return { ok: false, text: `GitHub returned ${response.status} for ${repo}.`, data: { repo, status: response.status } };
    const raw = await response.json();
    const issues = raw.filter(item => !item.pull_request).slice(0, limit).map(item => ({
      number: item.number,
      title: item.title,
      state: item.state,
      author: item.user?.login || null,
      comments: item.comments,
      labels: (item.labels || []).map(label => typeof label === 'string' ? label : label.name),
      updatedAt: item.updated_at,
      url: item.html_url
    }));
    const text = issues.length
      ? `${repo}: ${issues.length} issue\n` + issues.map(i => `#${i.number} — ${i.title} (${i.state}, comments: ${i.comments})\n${i.url}`).join('\n')
      : `${repo}: no issues found with state ${issueState}.`;
    return { ok: true, text, data: { repo, state: issueState, issues } };
  }
};