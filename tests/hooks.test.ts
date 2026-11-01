import { readFile } from 'node:fs/promises';
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

const hookChecks = {
  format: { cmd: 'node -e "process.exit(0)"', blocking: true, timeout_sec: 30 },
  lint: { cmd: 'node -e "process.exit(0)"', blocking: true, timeout_sec: 30 },
  typecheck: { cmd: 'node -e "process.exit(0)"', blocking: true, timeout_sec: 30 },
  tests: { cmd: 'node -e "process.exit(0)"', blocking: true, timeout_sec: 30 },
  skip_paths: ['dist/**'],
};

describe('hooks install', () => {
  it('installs executable pre-commit and pre-push hooks and uninstalls them', async () => {
    const repo = await createTestRepo({ checks: hookChecks });
    repos.push(repo);

    const install = await runCli(['hooks', 'install', '--repo', repo.dir]);
    expect(install.exitCode).toBe(0);
    expect(install.all).toContain('Installed: pre-commit, pre-push');

    const hooksDir = path.join(repo.dir, '.git', 'hooks');
    const preCommitPath = path.join(hooksDir, 'pre-commit');
    const prePushPath = path.join(hooksDir, 'pre-push');
    const preCommit = await readFile(preCommitPath, 'utf8');
    const prePush = await readFile(prePushPath, 'utf8');
    expect(preCommit).toContain('managed-by: review-tool hooks install');
    expect(preCommit).toContain('format');
    expect(preCommit).toContain('lint');
    expect(preCommit).not.toContain('tests');
    expect(prePush).toContain('tests');
    expect(prePush).toContain('typecheck');

    const hookRun = await execa('sh', [preCommitPath], {
      cwd: repo.dir,
      reject: false,
      all: true,
    });
    expect(hookRun.exitCode).toBe(0);

    const uninstall = await runCli(['hooks', 'uninstall', '--repo', repo.dir]);
    expect(uninstall.exitCode).toBe(0);
    expect(uninstall.all).toContain('Removed: pre-commit, pre-push');
    await expect(readFile(preCommitPath, 'utf8')).rejects.toThrow();
    await expect(readFile(prePushPath, 'utf8')).rejects.toThrow();
  });

  it('refuses to overwrite an unmanaged hook without --force', async () => {
    const repo = await createTestRepo({ checks: hookChecks });
    repos.push(repo);
    const preCommitPath = path.join(repo.dir, '.git', 'hooks', 'pre-commit');
    await import('node:fs/promises').then((fs) =>
      fs.writeFile(preCommitPath, '#!/bin/sh\necho user-hook\n', 'utf8'),
    );

    const result = await runCli(['hooks', 'install', '--repo', repo.dir]);
    expect(result.exitCode).toBe(2);
    expect(result.all).toContain('not managed by review-tool');
    const content = await readFile(preCommitPath, 'utf8');
    expect(content).toContain('user-hook');
  });
});
