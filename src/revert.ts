import { execa } from 'execa';
import { ReviewError } from './errors.js';

export interface RevertOptions {
  mergeSha?: string;
  prNumber?: number;
}

async function gitQuery(repoRoot: string, args: string[]): Promise<{ ok: boolean; text: string }> {
  const result = await execa('git', ['-C', repoRoot, ...args], {
    reject: false,
    all: true,
  });
  return { ok: result.exitCode === 0, text: result.stdout.trim() };
}

export async function resolveMergeCommit(
  repoRoot: string,
  options: RevertOptions,
): Promise<string> {
  if (options.mergeSha) {
    const exists = await gitQuery(repoRoot, [
      'cat-file',
      '-e',
      `${options.mergeSha}^{commit}`,
    ]);
    if (!exists.ok) throw new ReviewError(`Merge commit not found: ${options.mergeSha}`, 2);
    return options.mergeSha;
  }
  if (options.prNumber) {
    const gh = await execa(
      'gh',
      [
        'pr',
        'view',
        String(options.prNumber),
        '--json',
        'mergeCommit',
        '--jq',
        '.mergeCommit.oid',
      ],
      { cwd: repoRoot, reject: false, all: true },
    );
    if (gh.exitCode === 0 && gh.stdout.trim()) return gh.stdout.trim();
    const fallback = await gitQuery(repoRoot, [
      'log',
      '--merges',
      '--all',
      `--grep=#${options.prNumber}`,
      '--format=%H',
      '-1',
    ]);
    if (fallback.ok && fallback.text) return fallback.text;
    throw new ReviewError(
      `Could not resolve merge commit for PR #${options.prNumber}. Pass --merge <sha>.`,
      2,
    );
  }
  throw new ReviewError('Provide --merge <sha> or --pr <number>.', 2);
}

export function formatRevertCommand(mergeSha: string): string {
  return `git revert -m 1 ${mergeSha}`;
}
