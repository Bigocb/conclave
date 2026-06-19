import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolveGitHubUrl, parseGitHubPrForComment, formatGithubComment } from '../utils/github.js';
import http from 'http';

/**
 * Start a tiny local HTTP server that mimics GitHub's API and raw endpoints.
 */
function startMockGitHubServer(): Promise<{ port: number; server: http.Server }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = req.url ?? '';
      if (url.includes('/repos/owner/repo/pulls/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ title: 'Test PR', body: 'PR body here' }));
      } else if (url.endsWith('.diff')) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('diff --git a/file.ts b/file.ts\n+added line');
      } else if (url.includes('/repos/owner/repo/contents/') || url.includes('raw.githubusercontent.com')) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('console.log("hello world");');
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' ? addr?.port ?? 0 : 0;
      resolve({ port, server });
    });
  });
}

describe('github resolver', () => {
  let mock: { port: number; server: http.Server } | undefined;

  beforeAll(async () => {
    mock = await startMockGitHubServer();
  });

  afterAll(() => {
    mock?.server.close();
  });

  it('parses a GitHub PR URL for comment metadata', () => {
    const info = parseGitHubPrForComment('https://github.com/owner/repo/pull/42');
    expect(info).toEqual({ owner: 'owner', repo: 'repo', prNumber: 42 });
  });

  it('returns null for non-PR URLs', () => {
    expect(parseGitHubPrForComment('https://github.com/owner/repo/blob/main/file.ts')).toBeNull();
  });

  it('formats a GitHub comment from task and reviews', () => {
    const body = formatGithubComment(
      { weighted_overall: 7.5, reviews_received: 3, requested_reviews: 3, approved: true },
      [
        {
          principal_id: 'prn_a',
          weighted_overall: 8,
          reviewer_confidence: 0.9,
          approved: true,
          comment: 'Looks good, minor nit.',
          suggestions: ['Use const'],
        },
      ],
    );
    expect(body).toContain('Conclave Review Summary');
    expect(body).toContain('7.5/10');
    expect(body).toContain('✅ Approved');
  });

  it('truncates a long GitHub comment', () => {
    const body = formatGithubComment(
      { weighted_overall: 5, reviews_received: 1, requested_reviews: 1 },
      [{ weighted_overall: 5, reviewer_confidence: 0.5, comment: 'x'.repeat(100000) }],
    );
    expect(body.length).toBeLessThanOrEqual(65000);
  });
});
