import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import picomatch from 'picomatch';
import type { CheckConfig, ReviewConfig } from './config.js';
import type { ChangedFile, CheckResult } from './types.js';
import { redactSecrets } from './util/redact.js';
import { sanitizeUnsafeCharacters } from './util/injection.js';

function matchesAny(filePath: string, patterns: string[]): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return patterns.some((pattern) => picomatch(pattern, { dot: true })(normalized));
}

export function getCheckEntries(config: ReviewConfig): Array<[string, CheckConfig]> {
  return Object.entries(config.checks).filter(
    (entry): entry is [string, CheckConfig] => {
      const [name, value] = entry;
      return name !== 'skip_paths' && typeof value === 'object' && value !== null && 'cmd' in value;
    },
  );
}

function safeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_');
}

function firstLine(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? '';
}

export async function runChecks(
  repoRoot: string,
  config: ReviewConfig,
  changedFiles: ChangedFile[],
  runDir: string,
): Promise<CheckResult[]> {
  const entries = getCheckEntries(config);
  if (entries.length === 0) return [];

  const changedPaths = changedFiles.map((file) => file.path);
  const allSkipped =
    changedPaths.length === 0 || changedPaths.every((file) => matchesAny(file, config.checks.skip_paths));

  if (allSkipped) {
    return entries.map(([name, check]) => ({
      name,
      command: check.cmd,
      status: 'skipped',
      blocking: check.blocking,
      exitCode: null,
      durationMs: 0,
      timedOut: false,
      summary:
        changedPaths.length === 0
          ? 'No changed files'
          : 'All changed files match checks.skip_paths',
    }));
  }

  const checksDir = path.join(runDir, 'checks');
  await mkdir(checksDir, { recursive: true });

  const results: CheckResult[] = [];
  for (const [name, check] of entries) {
    const startedAt = Date.now();
    let result: CheckResult;
    try {
      const execution = await execa(check.cmd, [], {
        cwd: repoRoot,
        shell: true,
        reject: false,
        all: true,
        timeout: check.timeout_sec * 1000,
        env: process.env,
        maxBuffer: 16 * 1024 * 1024,
      });
      const durationMs = Date.now() - startedAt;
      const output = sanitizeUnsafeCharacters(redactSecrets(execution.all ?? `${execution.stdout}\n${execution.stderr}`)).text;
      const logPath = path.join(checksDir, `${safeFileName(name)}.log`);
      await writeFile(
        logPath,
        [
          `command: ${check.cmd}`,
          `exit_code: ${execution.exitCode ?? 'null'}`,
          `timed_out: ${execution.timedOut}`,
          `duration_ms: ${durationMs}`,
          '',
          output.slice(0, 1_000_000),
        ].join('\n'),
        'utf8',
      );
      const failed = execution.timedOut || execution.exitCode !== 0;
      result = {
        name,
        command: check.cmd,
        status: execution.timedOut ? 'error' : failed ? 'fail' : 'pass',
        blocking: check.blocking,
        exitCode: execution.exitCode ?? null,
        durationMs,
        timedOut: execution.timedOut,
        summary: execution.timedOut
          ? `Timed out after ${check.timeout_sec}s`
          : failed
            ? firstLine(execution.stderr) || firstLine(execution.stdout) || `Exit ${execution.exitCode}`
            : 'Passed',
        logPath,
      };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      result = {
        name,
        command: check.cmd,
        status: 'error',
        blocking: check.blocking,
        exitCode: null,
        durationMs,
        timedOut: false,
        summary: `Failed to run: ${(error as Error).message}`,
      };
    }
    results.push(result);
  }

  return results;
}

export function hasBlockingFailure(checks: CheckResult[]): boolean {
  return checks.some((check) => check.blocking && (check.status === 'fail' || check.status === 'error'));
}
