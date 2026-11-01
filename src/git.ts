import { execa } from 'execa';
import path from 'node:path';
import { ReviewError } from './errors.js';
import type { ChangedFile, DiffInfo, LineRange } from './types.js';

const GIT_TIMEOUT_MS = 120_000;

async function runGit(cwd: string, args: string[], timeout = GIT_TIMEOUT_MS) {
  return execa('git', ['-C', cwd, ...args], {
    cwd,
    reject: false,
    all: true,
    timeout,
    maxBuffer: 64 * 1024 * 1024,
  });
}

async function gitOrThrow(cwd: string, args: string[]): Promise<string> {
  const result = await runGit(cwd, args);
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new ReviewError(`git ${args.join(' ')} failed (${result.exitCode}): ${detail}`, 2);
  }
  return result.stdout.trim();
}

export async function getRepoRoot(repoPath: string): Promise<string> {
  const result = await runGit(repoPath, ['rev-parse', '--show-toplevel']);
  if (result.exitCode !== 0) {
    throw new ReviewError(`Not a git repository: ${repoPath}`, 2);
  }
  return result.stdout.trim();
}

export async function getHooksDir(repoRoot: string): Promise<string> {
  const result = await runGit(repoRoot, ['rev-parse', '--git-path', 'hooks']);
  if (result.exitCode !== 0) {
    throw new ReviewError(`Cannot resolve git hooks directory: ${result.stderr}`, 2);
  }
  const hooksPath = result.stdout.trim();
  return path.isAbsolute(hooksPath) ? hooksPath : path.resolve(repoRoot, hooksPath);
}

export async function resolveCommit(repoRoot: string, ref: string): Promise<string> {
  return gitOrThrow(repoRoot, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
}

export async function readFileAtCommit(
  repoRoot: string,
  commit: string,
  filePath: string,
): Promise<string | null> {
  const result = await runGit(repoRoot, ['show', `${commit}:${filePath}`]);
  if (result.exitCode !== 0) return null;
  return result.stdout;
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function parseChangedFileStatuses(output: string): Array<{ path: string; status: string }> {
  const files: Array<{ path: string; status: string }> = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const status = parts[0] ?? '';
    if (!status) continue;
    const statusChar = status[0] ?? '?';
    const filePath = parts.length > 2 ? parts[parts.length - 1] : parts[1];
    if (!filePath) continue;
    files.push({ path: normalizePath(filePath), status: statusChar });
  }
  return files;
}

function parseNumstat(output: string): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const map = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const firstTab = line.indexOf('\t');
    const secondTab = line.indexOf('\t', firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const additionsRaw = line.slice(0, firstTab);
    const deletionsRaw = line.slice(firstTab + 1, secondTab);
    const filePath = normalizePath(line.slice(secondTab + 1));
    const binary = additionsRaw === '-' || deletionsRaw === '-';
    map.set(filePath, {
      additions: binary ? 0 : Number(additionsRaw) || 0,
      deletions: binary ? 0 : Number(deletionsRaw) || 0,
      binary,
    });
  }
  return map;
}

function parseChangedRanges(rawPatch: string): Record<string, LineRange[]> {
  const ranges: Record<string, LineRange[]> = {};
  let currentFile: string | null = null;

  for (const line of rawPatch.split(/\r?\n/)) {
    if (line.startsWith('+++ ')) {
      const rawPath = line.slice(4).trim();
      if (rawPath === '/dev/null') {
        currentFile = null;
      } else {
        currentFile = normalizePath(rawPath.replace(/^b\//, ''));
        ranges[currentFile] ??= [];
      }
      continue;
    }
    if (line.startsWith('diff --git ')) {
      currentFile = null;
      continue;
    }
    if (!currentFile || !line.startsWith('@@ ')) continue;
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) continue;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (!Number.isFinite(start) || !Number.isFinite(count) || count <= 0) continue;
    (ranges[currentFile] ??= []).push({ start, end: start + count - 1 });
  }

  for (const [filePath, fileRanges] of Object.entries(ranges)) {
    fileRanges.sort((a, b) => a.start - b.start);
    const merged: LineRange[] = [];
    for (const range of fileRanges) {
      const previous = merged[merged.length - 1];
      if (previous && range.start <= previous.end + 1) {
        previous.end = Math.max(previous.end, range.end);
      } else {
        merged.push({ ...range });
      }
    }
    ranges[filePath] = merged;
  }

  return ranges;
}

export async function getDiff(
  repoRoot: string,
  baseRef: string,
  headRef: string,
): Promise<DiffInfo> {
  const baseSha = await resolveCommit(repoRoot, baseRef);
  const headSha = await resolveCommit(repoRoot, headRef);
  const mergeBase = await gitOrThrow(repoRoot, ['merge-base', baseSha, headSha]);

  const [patch, rawPatch, nameStatusOutput, numstatOutput] = await Promise.all([
    gitOrThrow(repoRoot, ['diff', '--no-color', '--unified=3', mergeBase, headSha]),
    gitOrThrow(repoRoot, ['diff', '--no-color', '--unified=0', mergeBase, headSha]),
    gitOrThrow(repoRoot, ['diff', '--name-status', '--find-renames', mergeBase, headSha]),
    gitOrThrow(repoRoot, ['diff', '--numstat', '--find-renames', mergeBase, headSha]),
  ]);

  const statuses = parseChangedFileStatuses(nameStatusOutput);
  const numstat = parseNumstat(numstatOutput);
  const files: ChangedFile[] = statuses.map((entry) => {
    const stats = numstat.get(entry.path);
    return {
      path: entry.path,
      status: entry.status,
      additions: stats?.additions ?? 0,
      deletions: stats?.deletions ?? 0,
      binary: stats?.binary ?? false,
    };
  });

  const totalAdditions = files.reduce((sum, file) => sum + file.additions, 0);
  const totalDeletions = files.reduce((sum, file) => sum + file.deletions, 0);

  return {
    repoRoot,
    baseRef,
    headRef,
    baseSha,
    headSha,
    mergeBase,
    patch,
    files,
    changedRanges: parseChangedRanges(rawPatch),
    totalAdditions,
    totalDeletions,
  };
}
