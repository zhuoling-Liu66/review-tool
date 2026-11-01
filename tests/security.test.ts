import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { runSecurityScans } from '../src/security';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup(command: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'review-security-test-'));
  dirs.push(dir);
  const runDir = path.join(dir, '.review', 'artifacts', 'r_test');
  await mkdir(path.join(dir, '.review'), { recursive: true });
  await mkdir(runDir, { recursive: true });
  await writeFile(
    path.join(dir, '.review', 'config.yml'),
    [
      'version: 1',
      'security:',
      '  gitleaks:',
      '    enabled: true',
      '    required: true',
      '    cmd: |',
      `      ${command}`,
      '',
    ].join('\n'),
    'utf8',
  );
  const loaded = await loadConfig(dir);
  const checks = await runSecurityScans(dir, loaded.config, runDir);
  return checks[0]!;
}

describe('security scanners', () => {
  it('passes a scan with an empty findings array', async () => {
    const result = await setup('node -e "console.log(JSON.stringify([]))"');
    expect(result.name).toBe('security:gitleaks');
    expect(result.status).toBe('pass');
    expect(result.blocking).toBe(true);
  });

  it('fails a scan that finds a secret', async () => {
    const result = await setup(
      'node -e "console.log(JSON.stringify([{Description:\\"leaked token\\"}]))"',
    );
    expect(result.status).toBe('fail');
    expect(result.summary).toContain('leaked token');
  });
});
