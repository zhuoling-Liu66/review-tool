import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestRepo, type TestRepo } from './helpers/repo';

const repos: TestRepo[] = [];
const cliPath = path.resolve('src/cli.ts');

afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()));
});

async function runCli(args: string[]) {
  return execa(process.execPath, ['--import', 'tsx', cliPath, ...args], {
    cwd: process.cwd(),
    reject: false,
    all: true,
  });
}

describe('CLI', () => {
  it('validates a config', async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    const result = await runCli(['config', 'validate', '--repo', repo.dir]);
    expect(result.exitCode).toBe(0);
    expect(result.all).toContain('Config valid');
    expect(result.all).toContain('Models: quick');
  });

  it('runs a review, prints the report and verifies the ledger', async () => {
    const repo = await createTestRepo();
    repos.push(repo);

    const run = await runCli([
      'run',
      '--repo',
      repo.dir,
      '--base',
      'main',
      '--head',
      'feature',
    ]);
    expect(run.exitCode).toBe(0);
    expect(run.all).toContain('Run r_');
    expect(run.all).toContain('Findings: 1 reported');

    const artifacts = await readdir(path.join(repo.dir, '.review', 'artifacts'));
    expect(artifacts).toHaveLength(1);
    const runId = artifacts[0]!;
    const report = await runCli(['report', '--repo', repo.dir, '--run', runId]);
    expect(report.exitCode).toBe(0);
    expect(report.all).toContain('AI Review Report');

    const sarif = await runCli([
      'report',
      '--repo',
      repo.dir,
      '--run',
      runId,
      '--format',
      'sarif',
    ]);
    expect(sarif.exitCode).toBe(0);
    const sarifData = JSON.parse(sarif.stdout);
    expect(sarifData.version).toBe('2.1.0');
    expect(sarifData.runs[0].results.length).toBeGreaterThanOrEqual(1);

    const ledger = await runCli(['ledger', 'verify', '--repo', repo.dir]);
    expect(ledger.exitCode).toBe(0);
    expect(ledger.all).toContain('Ledger valid');
  });

  it('returns exit 2 for an unsupported mode', async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    const result = await runCli([
      'run',
      '--repo',
      repo.dir,
      '--base',
      'main',
      '--mode',
      'turbo',
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.all).toContain('not supported');
  });

  it('prints the run manifest as JSON', async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    const result = await runCli([
      'run',
      '--repo',
      repo.dir,
      '--base',
      'main',
      '--head',
      'feature',
      '--json',
    ]);
    expect(result.exitCode).toBe(0);
    const manifest = JSON.parse(result.stdout);
    expect(manifest.mode).toBe('quick');
    expect(manifest.status).toBe('completed');
    expect(manifest.findings).toHaveLength(1);
  });

  it('runs Standard through the CLI', async () => {
    const repo = await createTestRepo({
      verifierResponse: JSON.stringify({
        verdict: 'confirm',
        reason: 'CLI Standard verification.',
        confidence: 0.9,
      }),
    });
    repos.push(repo);
    const result = await runCli([
      'run',
      '--repo',
      repo.dir,
      '--base',
      'main',
      '--head',
      'feature',
      '--mode',
      'standard',
      '--json',
    ]);
    expect(result.exitCode).toBe(0);
    const manifest = JSON.parse(result.stdout);
    expect(manifest.mode).toBe('standard');
    expect(manifest.findings[0].votes.confirm).toBe(3);
  });
});
