/**
 * Conclave — GitHub URL resolver for review tasks
 *
 * Supports:
 *   - PR URLs: https://github.com/{owner}/{repo}/pull/{n}
 *             -> fetches https://github.com/{owner}/{repo}/pull/{n}.diff
 *   - File URLs: https://github.com/{owner}/{repo}/blob/{ref}/{path}
 *              -> fetches https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}
 *   - Raw file URLs: https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}
 *
 * Public repos need no token. Private repos require GITHUB_TOKEN env var or a PAT
 * stored in the org vault under provider 'github'.
 */

export interface GitHubResolution {
  owner: string;
  repo: string;
  type: 'pr' | 'file';
  ref?: string;
  path?: string;
  prNumber?: number;
  title: string;
  body: string;
  diffOrContent: string;
  truncated: boolean;
  apiUrl: string;
}

const MAX_DIFF_CHARS = 12000;
const MAX_FILE_CHARS = 16000;

function parseGitHubUrl(url: string): {
  owner: string;
  repo: string;
  type: 'pr' | 'file';
  ref?: string;
  path?: string;
  prNumber?: number;
} | null {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;

    const [owner, repo] = parts;

    if (parts[2] === 'pull' && /^\d+$/.test(parts[3] ?? '')) {
      return { owner, repo, type: 'pr', prNumber: parseInt(parts[3], 10) };
    }

    if (parts[2] === 'blob' && parts.length >= 5) {
      const ref = parts[3];
      const path = parts.slice(4).join('/');
      return { owner, repo, type: 'file', ref, path };
    }

    if (u.hostname === 'raw.githubusercontent.com' && parts.length >= 4) {
      const ref = parts[2];
      const path = parts.slice(3).join('/');
      return { owner, repo, type: 'file', ref, path };
    }

    return null;
  } catch {
    return null;
  }
}

function buildAuthHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function fetchGitHub(
  url: string,
  token?: string,
  timeoutMs = 30000,
): Promise<{ ok: boolean; status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: buildAuthHeaders(token),
      signal: controller.signal,
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const marker = '\n\n[...truncated by Conclave; original too large for review context]';
  return { text: text.slice(0, maxChars - marker.length) + marker, truncated: true };
}

export async function resolveGitHubUrl(
  url: string,
  token?: string,
): Promise<GitHubResolution> {
  const parsed = parseGitHubUrl(url);
  if (!parsed) {
    throw new Error(`Unsupported GitHub URL: ${url}. Expected /pull/N or /blob/REF/PATH or raw.githubusercontent.com.`);
  }

  const { owner, repo, type, ref, path, prNumber } = parsed;

  if (type === 'pr') {
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;
    const diffUrl = `https://github.com/${owner}/${repo}/pull/${prNumber}.diff`;

    const [meta, diff] = await Promise.all([
      fetchGitHub(apiUrl, token),
      fetchGitHub(diffUrl, token),
    ]);

    if (!meta.ok) {
      throw new Error(`GitHub API error ${meta.status}: ${meta.text.slice(0, 200)}`);
    }
    if (!diff.ok) {
      throw new Error(`GitHub diff error ${diff.status}: ${diff.text.slice(0, 200)}`);
    }

    let title = `PR ${owner}/${repo}#${prNumber}`;
    let body = '';
    try {
      const metaJson = JSON.parse(meta.text);
      title = metaJson.title ?? title;
      body = metaJson.body ?? '';
    } catch {
      // ignore meta parse failure
    }

    const { text: diffOrContent, truncated } = truncate(diff.text, MAX_DIFF_CHARS);

    return {
      owner,
      repo,
      type,
      prNumber,
      title,
      body,
      diffOrContent,
      truncated,
      apiUrl,
    };
  }

  // file
  const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`;
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${ref}`;

  const res = await fetchGitHub(rawUrl, token);
  if (!res.ok) {
    throw new Error(`GitHub raw file error ${res.status}: ${res.text.slice(0, 200)}`);
  }

  const { text: diffOrContent, truncated } = truncate(res.text, MAX_FILE_CHARS);

  return {
    owner,
    repo,
    type,
    ref,
    path,
    title: `File ${owner}/${repo}/${path} @ ${ref}`,
    body: '',
    diffOrContent,
    truncated,
    apiUrl,
  };
}

export function parseGitHubPrForComment(url: string): {
  owner: string;
  repo: string;
  prNumber: number;
} | null {
  const parsed = parseGitHubUrl(url);
  if (!parsed || parsed.type !== 'pr' || !parsed.prNumber) return null;
  return { owner: parsed.owner, repo: parsed.repo, prNumber: parsed.prNumber };
}

export async function postPrReviewComment(
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
  token: string,
): Promise<void> {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...buildAuthHeaders(token),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitHub comment API error ${res.status}: ${text.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

export function formatGithubComment(task: {
  description?: string;
  weighted_overall?: number;
  reviews_received?: number;
  requested_reviews?: number;
  approved?: boolean;
}, reviews: Array<{
  principal_id?: string;
  agent_id?: string;
  weighted_overall: number;
  reviewer_confidence: number;
  approved?: boolean;
  comment?: string;
  suggestions?: string[];
}>): string {
  const header = `## Conclave Review Summary`;
  const overall = task.weighted_overall !== undefined
    ? `**Overall:** ${task.weighted_overall}/10`
    : '';
  const verdict = task.approved !== undefined
    ? `**Verdict:** ${task.approved ? '✅ Approved' : '❌ Needs work'}`
    : '';
  const count = `**Reviews:** ${task.reviews_received ?? reviews.length}/${task.requested_reviews ?? 3}`;

  const lines = [header, '', count];
  if (overall) lines.push(overall);
  if (verdict) lines.push(verdict);
  lines.push('');

  if (reviews.length > 0) {
    lines.push('### Key feedback');
    for (const r of reviews.slice(0, 3)) {
      const reviewer = r.principal_id ?? r.agent_id ?? 'reviewer';
      lines.push(`**${reviewer}** — ${r.weighted_overall}/10 (${r.approved ? 'approved' : 'not approved'})`);
      if (r.comment) lines.push(`> ${r.comment.slice(0, 300)}${r.comment.length > 300 ? '...' : ''}`);
      if (r.suggestions?.length) {
        for (const s of r.suggestions.slice(0, 2)) lines.push(`- ${s}`);
      }
      lines.push('');
    }
  }

  lines.push(`_Reviewed via [Conclave](https://github.com/Bigocb/conclave)_`);
  return lines.join('\n').slice(0, 65000); // GitHub issue comment limit is ~65535
}
