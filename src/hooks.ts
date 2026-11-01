import { chmod, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getCheckEntries } from './checks.js';
import type { ReviewConfig } from './config.js';
import { ReviewError } from './errors.js';
import { getHooksDir } from './git.js';

export type HookStage = 'pre-commit' | 'pre-push';

export interface HooksInstallResult {
  hooksDir: string;
  installed: HookStage[];
  skipped: Array<{ stage: HookStage; reason: string }>;
}

export interface HooksUninstallResult {
  hooksDir: string;
  removed: HookStage[];
  restored: HookStage[];
  untouched: HookStage[];
}

const MARKER = '# managed-by: review-tool hooks install';
const PRE_COMMIT_PATTERN = /format|fmt|lint|eslint|prettier/i;

function selectChecks(config: ReviewConfig, stage: HookStage): Array<[string, { cmd: string }]> {
  const blocking = getCheckEntries(config).filter(([, check]) => check.blocking);
  if (stage === 'pre-commit') {
    return blocking
      .filter(([name]) => PRE_COMMIT_PATTERN.test(name))
      .map(([name, check]) => [name, { cmd: check.cmd }]);
  }
  return blocking.map(([name, check]) => [name, { cmd: check.cmd }]);
}

function renderHook(stage: HookStage, checks: Array<[string, { cmd: string }]>): string {
  const lines = [
    '#!/bin/sh',
    MARKER,
    'set -e',
    'cd "$(git rev-parse --show-toplevel)"',
    '',
    `echo "[review] ${stage}: running ${checks.length} check(s)"`,
  ];
  for (const [name, check] of checks) {
    lines.push(`echo "[review] ${stage}: ${name}"`);
    lines.push(check.cmd);
  }
  lines.push('');
  return lines.join('\n');
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function isManagedHook(filePath: string): Promise<boolean> {
  try {
    const text = await readFile(filePath, 'utf8');
    return text.includes(MARKER);
  } catch {
    return false;
  }
}

async function backupExistingHook(repoRoot: string, stage: HookStage, hookPath: string): Promise<void> {
  const backupDir = path.join(repoRoot, '.review', 'hooks-backup');
  await mkdir(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `${stage}.${Date.now()}`);
  await copyFile(hookPath, backupPath);
}

async function writeHook(
  repoRoot: string,
  hooksDir: string,
  stage: HookStage,
  checks: Array<[string, { cmd: string }]>,
  force: boolean,
): Promise<void> {
  const hookPath = path.join(hooksDir, stage);
  if (await pathExists(hookPath)) {
    if (!(await isManagedHook(hookPath))) {
      if (!force) {
        throw new ReviewError(
          `Existing hook ${hookPath} is not managed by review-tool. Re-run with --force to back it up and replace it.`,
          2,
        );
      }
      await backupExistingHook(repoRoot, stage, hookPath);
    }
  }
  await writeFile(hookPath, renderHook(stage, checks), { encoding: 'utf8', mode: 0o755 });
  try {
    await chmod(hookPath, 0o755);
  } catch {
    // Windows may not expose POSIX modes; Git for Windows still runs the hook.
  }
}

export async function installHooks(
  repoRoot: string,
  config: ReviewConfig,
  force = false,
): Promise<HooksInstallResult> {
  const hooksDir = await getHooksDir(repoRoot);
  await mkdir(hooksDir, { recursive: true });
  const installed: HookStage[] = [];
  const skipped: Array<{ stage: HookStage; reason: string }> = [];

  for (const stage of ['pre-commit', 'pre-push'] as const) {
    const checks = selectChecks(config, stage);
    if (checks.length === 0) {
      skipped.push({
        stage,
        reason:
          stage === 'pre-commit'
            ? 'No blocking format/lint checks found in config.'
            : 'No blocking checks found in config.',
      });
      continue;
    }
    await writeHook(repoRoot, hooksDir, stage, checks, force);
    installed.push(stage);
  }

  return { hooksDir, installed, skipped };
}

async function latestBackup(repoRoot: string, stage: HookStage): Promise<string | null> {
  const backupDir = path.join(repoRoot, '.review', 'hooks-backup');
  let entries: string[];
  try {
    entries = await readdir(backupDir);
  } catch {
    return null;
  }
  const candidates = entries.filter((entry) => entry.startsWith(`${stage}.`)).sort();
  return candidates.length ? path.join(backupDir, candidates[candidates.length - 1]!) : null;
}

export async function uninstallHooks(repoRoot: string): Promise<HooksUninstallResult> {
  const hooksDir = await getHooksDir(repoRoot);
  const removed: HookStage[] = [];
  const restored: HookStage[] = [];
  const untouched: HookStage[] = [];

  for (const stage of ['pre-commit', 'pre-push'] as const) {
    const hookPath = path.join(hooksDir, stage);
    if (!(await pathExists(hookPath)) || !(await isManagedHook(hookPath))) {
      untouched.push(stage);
      continue;
    }
    const backup = await latestBackup(repoRoot, stage);
    if (backup) {
      await rename(backup, hookPath);
      restored.push(stage);
    } else {
      await rm(hookPath, { force: true });
      removed.push(stage);
    }
  }

  return { hooksDir, removed, restored, untouched };
}
