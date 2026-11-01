import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { runReview } from '../src/pipeline';
import { recordOutcome, collectOutcomes } from '../src/outcomes';
import { collectMetrics, renderMetricsMarkdown } from '../src/metrics';
import { createTestRepo, type TestRepo } from './helpers/repo';

const repos: TestRepo[] = [];

afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()));
});

describe('outcomes and metrics', () => {
  it('records a finding resolution and aggregates it', async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    const result = await runReview({ repoPath: repo.dir, baseRef: 'main' });
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    const findingId = manifest.findings[0].id as string;

    await recordOutcome(repo.dir, result.runId, findingId, 'fixed', {
      reason: 'Added exp validation',
    });
    const outcomes = await collectOutcomes(repo.dir, 30);
    expect(outcomes.resolved).toBe(1);
    expect(outcomes.byStatus.fixed).toBe(1);
    expect(outcomes.open).toBe(0);

    const metrics = await collectMetrics(repo.dir, 30);
    expect(metrics.runs).toBe(1);
    expect(metrics.findings).toBe(1);
    expect(metrics.costUsd).toBeGreaterThan(0);
    expect(renderMetricsMarkdown(metrics)).toContain('Review metrics');
  });

  it('supports shadow runs that never block', async () => {
    const repo = await createTestRepo({ highRisk: true });
    repos.push(repo);
    const result = await runReview({
      repoPath: repo.dir,
      baseRef: 'main',
      shadow: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.status).toBe('completed');
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    expect(manifest.shadow).toBe(true);
    expect(manifest.approval.required).toBe(false);
  });
});
