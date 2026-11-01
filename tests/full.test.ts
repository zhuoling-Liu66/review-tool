import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { runFullScan } from '../src/full';
import { createTestRepo, type TestRepo } from './helpers/repo';

const repos: TestRepo[] = [];

afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()));
});

describe('full project review', () => {
  it('estimates without calling models', async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    const result = await runFullScan({
      repoPath: repo.dir,
      dryRun: true,
      mode: 'quick',
    });
    expect(result.status).toBe('planned');
    expect(result.estimated.files).toBeGreaterThan(0);
    expect(result.estimated.batches).toBeGreaterThan(0);
    expect(result.estimated.priced).toBe(true);
    expect(result.actual.tokens).toBe(0);
  });

  it('reviews module batches, writes state and can resume without re-running', async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    const first = await runFullScan({
      repoPath: repo.dir,
      yes: true,
      mode: 'quick',
    });
    expect(first.status).toBe('completed');
    expect(first.actual.findings).toBe(1);
    expect(first.actual.tokens).toBeGreaterThan(0);
    const state = JSON.parse(await readFile(first.statePath, 'utf8'));
    expect(state.status).toBe('completed');
    expect(state.batches.every((batch: { status: string }) => batch.status === 'done')).toBe(true);
    const report = await readFile(first.reportPath, 'utf8');
    expect(report).toContain('Full review');

    const resumed = await runFullScan({
      repoPath: repo.dir,
      scanId: first.scanId,
      yes: true,
      mode: 'quick',
    });
    expect(resumed.status).toBe('completed');
    expect(resumed.actual.findings).toBe(1);
    expect(resumed.actual.tokens).toBe(first.actual.tokens);
  });
});
