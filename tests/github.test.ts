import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { publishReview } from '../src/github';
import { runReview } from '../src/pipeline';
import { createTestRepo, type TestRepo } from './helpers/repo';

const repos: TestRepo[] = [];

afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()));
});

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('GitHub publishing', () => {
  it('updates an existing summary and creates one inline comment', async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    const result = await runReview({ repoPath: repo.dir, baseRef: 'main' });
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    const calls: Array<{ method: string; url: string; body?: string }> = [];

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ method, url, body: init?.body as string | undefined });
      if (url.includes('/issues/1/comments') && method === 'GET') {
        return response([{ id: 9, body: '<!-- review-tool:summary --> old summary' }]);
      }
      if (url.includes('/issues/comments/9') && method === 'PATCH') {
        return response({});
      }
      if (url.includes('/pulls/1/comments') && method === 'GET') {
        return response([]);
      }
      if (url.includes('/pulls/1/comments') && method === 'POST') {
        return response({});
      }
      return response({ error: 'unexpected' }, 500);
    };

    const published = await publishReview(manifest, {
      token: 'test-token',
      repository: 'org/repo',
      prNumber: 1,
      apiUrl: 'https://api.test',
      fetchImpl,
    });

    expect(published.summaryAction).toBe('updated');
    expect(published.inlineCreated).toBe(1);
    expect(published.errors).toEqual([]);
    const patch = calls.find((call) => call.method === 'PATCH');
    expect(patch?.body).toContain('AI review');
    const inline = calls.find(
      (call) => call.method === 'POST' && call.url.includes('/pulls/1/comments'),
    );
    expect(inline?.body).toContain(manifest.findings[0].fingerprint);
  });

  it('does not repost an existing inline finding', async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    const result = await runReview({ repoPath: repo.dir, baseRef: 'main' });
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    const fingerprint = manifest.findings[0].fingerprint;
    let posts = 0;

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/issues/1/comments') && method === 'GET') {
        return response([{ id: 9, body: '<!-- review-tool:summary --> old' }]);
      }
      if (url.includes('/issues/comments/9') && method === 'PATCH') {
        return response({});
      }
      if (url.includes('/pulls/1/comments') && method === 'GET') {
        return response([{ id: 5, body: `<!-- review-tool:${fingerprint} --> old` }]);
      }
      if (url.includes('/pulls/1/comments') && method === 'POST') {
        posts += 1;
        return response({});
      }
      return response({ error: 'unexpected' }, 500);
    };

    const published = await publishReview(manifest, {
      token: 'test-token',
      repository: 'org/repo',
      prNumber: 1,
      apiUrl: 'https://api.test',
      fetchImpl,
    });
    expect(published.inlineSkipped).toBe(1);
    expect(published.inlineCreated).toBe(0);
    expect(posts).toBe(0);
  });
});
