import { execa } from 'execa';
import { ReviewError } from './errors.js';

export interface ScanRange {
  base: string;
  head: string;
  commits: number;
}

export async function resolveScanRange(
  repoRoot: string,
  sinceDays: number,
): Promise<ScanRange> {
  const days = Math.max(1, Math.floor(sinceDays));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const result = await execa(
    'git',
    ['-C', repoRoot, 'log', `--since=${since}`, '--format=%H', 'HEAD'],
    { reject: false, all: true },
  );
  if (result.exitCode !== 0) {
    throw new ReviewError(`git log failed: ${result.stderr}`, 2);
  }
  const commits = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (commits.length === 0) {
    throw new ReviewError(`No commits found in the last ${days} day(s).`, 2);
  }
  const oldest = commits[commits.length - 1]!;
  const parent = await execa(
    'git',
    ['-C', repoRoot, 'rev-parse', '--verify', `${oldest}^`],
    { reject: false, all: true },
  );
  if (parent.exitCode !== 0) {
    throw new ReviewError(
      'The oldest commit in the scan window has no parent; choose a wider --since range.',
      2,
    );
  }
  return {
    base: parent.stdout.trim(),
    head: 'HEAD',
    commits: commits.length,
  };
}
