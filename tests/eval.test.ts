import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runEval } from '../src/eval';
import { createTestRepo, type TestRepo } from './helpers/repo';

const repos: TestRepo[] = [];

afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()));
});

describe('eval harness', () => {
  it('matches expected findings and writes a baseline', async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    const casesDir = path.join(repo.dir, '.review', 'eval', 'cases');
    await mkdir(casesDir, { recursive: true });
    await writeFile(
      path.join(casesDir, 'c1.json'),
      JSON.stringify({
        case_id: 'c1',
        base: 'main',
        head: 'feature',
        expected_findings: [
          {
            file: 'src/app.ts',
            line: 2,
            category: 'correctness',
            must_match: 'hard-coded',
          },
        ],
      }),
      'utf8',
    );

    const summary = await runEval({
      repoPath: repo.dir,
      casesDir,
      updateBaseline: true,
    });
    expect(summary.cases).toBe(1);
    expect(summary.recall).toBe(1);
    expect(summary.results[0]?.matched).toBe(1);
    expect(summary.costUsd).toBeGreaterThan(0);
    const baseline = JSON.parse(
      await readFile(path.join(repo.dir, '.review', 'eval', 'baseline.json'), 'utf8'),
    );
    expect(baseline.recall).toBe(1);
  });

  it('counts false positives on a clean case', async () => {
    const repo = await createTestRepo({ mockResponse: '{"findings":[]}' });
    repos.push(repo);
    const casesDir = path.join(repo.dir, '.review', 'eval', 'cases');
    await mkdir(casesDir, { recursive: true });
    await writeFile(
      path.join(casesDir, 'clean.json'),
      JSON.stringify({
        case_id: 'clean',
        base: 'main',
        head: 'feature',
        clean: true,
        expected_findings: [],
      }),
      'utf8',
    );
    const summary = await runEval({ repoPath: repo.dir, casesDir });
    expect(summary.cleanFalsePositives).toBe(0);
    expect(summary.recall).toBe(1);
  });
});
