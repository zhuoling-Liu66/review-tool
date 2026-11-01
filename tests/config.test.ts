import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../src/errors';
import { loadConfig, parseTokenBudget } from '../src/config';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeConfig(text: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'review-config-test-'));
  dirs.push(dir);
  await mkdir(path.join(dir, '.review'), { recursive: true });
  await writeFile(path.join(dir, '.review', 'config.yml'), text, 'utf8');
  return dir;
}

describe('config', () => {
  it('applies defaults for a minimal config', async () => {
    const dir = await makeConfig('version: 1\n');
    const loaded = await loadConfig(dir);
    expect(loaded.config.checks.skip_paths.length).toBeGreaterThan(0);
    expect(loaded.config.budget.per_run_tokens.quick).toBe(50_000);
    expect(loaded.config.review.min_severity_to_report).toBe('minor');
    expect(loaded.configHash.startsWith('sha256:')).toBe(true);
  });

  it('rejects a missing config', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'review-config-missing-'));
    dirs.push(dir);
    await expect(loadConfig(dir)).rejects.toBeInstanceOf(ConfigError);
  });

  it('rejects a model that references an unknown provider', async () => {
    const dir = await makeConfig(
      [
        'version: 1',
        'models:',
        '  quick: { provider: missing, name: model }',
        '',
      ].join('\n'),
    );
    await expect(loadConfig(dir)).rejects.toThrow(/unknown provider/i);
  });

  it('parses token budgets', () => {
    expect(parseTokenBudget('50000')).toBe(50_000);
    expect(parseTokenBudget('50k')).toBe(50_000);
    expect(parseTokenBudget('1.5m')).toBe(1_500_000);
    expect(() => parseTokenBudget('nope')).toThrow(ConfigError);
  });
});
