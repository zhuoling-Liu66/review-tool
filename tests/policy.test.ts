import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type ReviewConfig } from '../src/config';
import { ConfigError } from '../src/errors';
import { evaluatePolicy } from '../src/policy';
import type { ChangedFile, DiffInfo } from '../src/types';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeConfig(): Promise<ReviewConfig> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'review-policy-test-'));
  dirs.push(dir);
  await mkdir(path.join(dir, '.review'), { recursive: true });
  await writeFile(path.join(dir, '.review', 'config.yml'), 'version: 1\n', 'utf8');
  return (await loadConfig(dir)).config;
}

function makeDiff(files: ChangedFile[]): DiffInfo {
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  return {
    repoRoot: '/repo',
    baseRef: 'main',
    headRef: 'HEAD',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    mergeBase: 'a'.repeat(40),
    patch: '',
    files,
    changedRanges: Object.fromEntries(files.map((file) => [file.path, [{ start: 1, end: 2 }]])),
    totalAdditions: additions,
    totalDeletions: deletions,
  };
}

function file(filePath: string, status = 'M', additions = 1, deletions = 1): ChangedFile {
  return { path: filePath, status, additions, deletions, binary: false };
}

describe('risk policy', () => {
  it('marks docs-only changes as low', async () => {
    const policy = evaluatePolicy(makeDiff([file('docs/readme.md')]), await makeConfig());
    expect(policy.tier).toBe('low');
    expect(policy.requiresHuman).toBe(false);
  });

  it('uses medium as the default for source changes', async () => {
    const policy = evaluatePolicy(makeDiff([file('src/app.ts')]), await makeConfig());
    expect(policy.tier).toBe('medium');
    expect(policy.reasons).toContain('default_medium');
  });

  it('makes CI workflow changes high and requires a human', async () => {
    const policy = evaluatePolicy(
      makeDiff([file('.github/workflows/ci.yml')]),
      await makeConfig(),
    );
    expect(policy.tier).toBe('high');
    expect(policy.requiresHuman).toBe(true);
    expect(policy.sensitiveHits).toContain('.github/workflows/ci.yml');
  });

  it('makes dependency changes at least medium', async () => {
    const policy = evaluatePolicy(makeDiff([file('package.json')]), await makeConfig());
    expect(policy.tier).toBe('medium');
    expect(policy.reasons.some((reason) => reason.startsWith('dependency_change'))).toBe(true);
  });

  it('makes deleted tests medium', async () => {
    const policy = evaluatePolicy(
      makeDiff([file('tests/app.test.ts', 'D')]),
      await makeConfig(),
    );
    expect(policy.tier).toBe('medium');
    expect(policy.reasons.some((reason) => reason.startsWith('test_deleted'))).toBe(true);
  });

  it('flags large diffs and can raise low to medium', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'review-policy-large-'));
    dirs.push(dir);
    await mkdir(path.join(dir, '.review'), { recursive: true });
    await writeFile(
      path.join(dir, '.review', 'config.yml'),
      [
        'version: 1',
        'tiers:',
        '  low:',
        '    paths: ["src/**"]',
        '  diff_size: { warn: 100, medium_at: 200, high_at: 500 }',
        '',
      ].join('\n'),
      'utf8',
    );
    const config = (await loadConfig(dir)).config;
    const policy = evaluatePolicy(makeDiff([file('src/app.ts', 'M', 250, 0)]), config);
    expect(policy.tier).toBe('medium');
    expect(policy.reasons.some((reason) => reason.startsWith('large_diff'))).toBe(true);
  });

  it('allows Standard and Deep and rejects unknown modes', async () => {
    const config = await makeConfig();
    const standard = evaluatePolicy(makeDiff([file('src/app.ts')]), config, {
      mode: 'standard',
    });
    expect(standard.mode).toBe('standard');
    expect(standard.budgetTokens).toBe(200_000);
    const deep = evaluatePolicy(makeDiff([file('src/app.ts')]), config, {
      mode: 'deep',
    });
    expect(deep.mode).toBe('deep');
    expect(deep.budgetTokens).toBe(500_000);
    expect(() =>
      evaluatePolicy(makeDiff([file('src/app.ts')]), config, { mode: 'turbo' as never }),
    ).toThrow(ConfigError);
  });

  it('records an explicit high-risk override', async () => {
    const config = await makeConfig();
    const policy = evaluatePolicy(
      makeDiff([file('.github/workflows/ci.yml')]),
      config,
      { overrideHighReason: 'manual emergency recovery' },
    );
    expect(policy.tier).toBe('medium');
    expect(policy.requiresHuman).toBe(false);
    expect(policy.reasons).toContain('override_high:manual emergency recovery');
  });

  it('clamps an oversized budget to the hard maximum', async () => {
    const config = await makeConfig();
    const policy = evaluatePolicy(makeDiff([file('src/app.ts')]), config, {
      budgetTokens: 1_000_000,
    });
    expect(policy.budgetTokens).toBe(600_000);
    expect(policy.reasons.some((reason) => reason.startsWith('budget_clamped'))).toBe(true);
  });

  it('respects diff-size thresholds at their boundaries', async () => {
    const defaultConfig = await makeConfig();
    const at400 = evaluatePolicy(makeDiff([file('src/app.ts', 'M', 400, 0)]), defaultConfig);
    const at401 = evaluatePolicy(makeDiff([file('src/app.ts', 'M', 401, 0)]), defaultConfig);
    expect(at400.reasons.some((reason) => reason.startsWith('large_diff'))).toBe(false);
    expect(at401.reasons.some((reason) => reason.startsWith('large_diff'))).toBe(true);

    const dir = await mkdtemp(path.join(os.tmpdir(), 'review-policy-bounds-'));
    dirs.push(dir);
    await mkdir(path.join(dir, '.review'), { recursive: true });
    await writeFile(
      path.join(dir, '.review', 'config.yml'),
      [
        'version: 1',
        'tiers:',
        '  low:',
        '    paths: ["src/**"]',
        '  diff_size: { warn: 400, medium_at: 800, high_at: 1200 }',
        '',
      ].join('\n'),
      'utf8',
    );
    const config = (await loadConfig(dir)).config;
    expect(evaluatePolicy(makeDiff([file('src/app.ts', 'M', 800, 0)]), config).tier).toBe('low');
    expect(evaluatePolicy(makeDiff([file('src/app.ts', 'M', 801, 0)]), config).tier).toBe('medium');
    const at1200 = evaluatePolicy(makeDiff([file('src/app.ts', 'M', 1200, 0)]), config);
    const at1201 = evaluatePolicy(makeDiff([file('src/app.ts', 'M', 1201, 0)]), config);
    expect(at1200.reasons).not.toContain('large_diff_high_hint');
    expect(at1201.reasons).toContain('large_diff_high_hint');
  });
});
