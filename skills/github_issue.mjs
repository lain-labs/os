import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request } from 'undici';

const execFileAsync = promisify(execFile);

function parseRepo(value) {
  if (!value) return null;
  const s = value.trim().replace(/\.git$/, '');
  const ssh = s.match(/github\.com[:/]([^/]+)\/([^/]+)$/i);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  const short = s.match(/^([^/]+)\/([^/]+)$/);
  return short ? `${short[1]}/${short[2]}` : null;
}

function parseIssueUrl(value) {
  if (!value) return null;
  const m = value.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/i);
  return m ? { repo: `${m[1]}/${m[2]}`, number: Number(m[3]) } : null;
}

async function currentRepo(repoPath) {
  const cwd = repoPath || process.cwd();
  const { stdout } = await execFileAsync('git', ['config', '--get', 'remote.origin.url'], { cwd });
  const repo = parseRepo(stdout);
  if (!repo) throw new Error('Could not determine the GitHub repository from remote.origin.url');
  return repo;
}

async function github(path) {
  const response = await request(`https://api.github.com${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'LainOS-github-issue',
      'x-github-api-version': '2022-11-28'
    }
  });
  if (response.statusCode === 404) throw new Error('Issue or repository not found');
  if (response.statusCode >= 400) throw new Error(`GitHub API returned ${response.statusCode}`);
  return response.body.json();
}

export default {
  name: 'github_issue',
  description: 'Read a public GitHub issue by number from the current repository, or by URL/owner-repo, including comments.',
  parameters: {
    type: 'object',
    properties: {
      number: { type: 'number', description: 'Issue number in the current repository.' },
      url: { type: 'string', description: 'Full GitHub issue URL.' },
      repo: { type: 'string', description: 'Optional owner/repo override.' },
      repoPath: { type: 'string', description: 'Optional local repository path; defaults to the current working repository.' }
    },
    required: ['number']
  },
  async handler(runtime, state, params) {
    try {
      const fromUrl = parseIssueUrl(params.url);
      const repo = fromUrl?.repo || parseRepo(params.repo) || await currentRepo(params.repoPath);
      const number = fromUrl?.number || Number(params.number);
      if (!Number.isInteger(number) || number < 1) throw new Error('A valid issue number is required');

      const issue = await github(`/repos/${repo}/issues/${number}`);
      if (issue.pull_request) throw new Error(`#${number} is a pull request, not an issue`);
      const comments = issue.comments > 0
        ? await github(`/repos/${repo}/issues/${number}/comments?per_page=100`)
        : [];

      const lines = [
        `${repo} #${number}: ${issue.title}`,
        `Status: ${issue.state}${issue.state_reason ? ` (${issue.state_reason})` : ''}`,
        `Author: @${issue.user.login}`,
        `Link: ${issue.html_url}`,
        '',
        issue.body?.trim() || '(empty description)'
      ];

      if (comments.length) {
        lines.push('', `Comments (${comments.length}):`);
        for (const comment of comments) {
          lines.push('', `@${comment.user.login} · ${comment.created_at}`, comment.body?.trim() || '(empty)');
        }
      }

      return {
        ok: true,
        text: lines.join('\n'),
        data: {
          repo,
          number,
          title: issue.title,
          state: issue.state,
          author: issue.user.login,
          url: issue.html_url,
          body: issue.body || '',
          comments: comments.map(c => ({ author: c.user.login, createdAt: c.created_at, body: c.body || '' }))
        }
      };
    } catch (error) {
      return { ok: false, text: `Could not read the issue: ${error.message}`, data: null };
    }
  }
};