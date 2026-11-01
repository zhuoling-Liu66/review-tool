import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import type { ReviewConfig } from './config.js';
import type { CheckResult } from './types.js';
import { redactSecrets } from './util/redact.js';
import { sanitizeUnsafeCharacters } from './util/injection.js';

interface ScannerDefinition {
  name: 'gitleaks' | 'semgrep' | 'osv';
  defaultCommand: string;
  parse: (stdout: string, reportText: string | null) => { findings: number; detail: string } | null;
}

function safeJson(text: string): unknown {
  try {
    const start = text.indexOf('{');
    const arrayStart = text.indexOf('[');
    const startIndex =
      start < 0 ? arrayStart : arrayStart < 0 ? start : Math.min(start, arrayStart);
    if (startIndex < 0) return null;
    const lastObject = text.lastIndexOf('}');
    const lastArray = text.lastIndexOf(']');
    const end = Math.max(lastObject, lastArray);
    if (end <= startIndex) return null;
    return JSON.parse(text.slice(startIndex, end + 1));
  } catch {
    return null;
  }
}

function parseGitleaks(stdout: string, reportText: string | null): { findings: number; detail: string } | null {
  const parsed = safeJson(reportText ?? stdout);
  if (!Array.isArray(parsed)) return null;
  return {
    findings: parsed.length,
    detail: parsed.slice(0, 5).map((item) => String((item as { Description?: string }).Description ?? 'secret')).join('; '),
  };
}

function parseSemgrep(stdout: string, reportText: string | null): { findings: number; detail: string } | null {
  const parsed = safeJson(stdout || reportText || '') as { results?: unknown[] } | null;
  if (!parsed || !Array.isArray(parsed.results)) return null;
  return {
    findings: parsed.results.length,
    detail: parsed.results
      .slice(0, 5)
      .map((item) => String((item as { check_id?: string }).check_id ?? 'semgrep finding'))
      .join('; '),
  };
}

function parseOsv(stdout: string, reportText: string | null): { findings: number; detail: string } | null {
  const parsed = safeJson(stdout || reportText || '') as { results?: unknown[] } | null;
  if (!parsed || !Array.isArray(parsed.results)) return null;
  let count = 0;
  const details: string[] = [];
  for (const result of parsed.results) {
    const vulns = (result as { vulns?: unknown[] }).vulns;
    if (Array.isArray(vulns) && vulns.length > 0) {
      count += vulns.length;
      for (const vuln of vulns.slice(0, 3)) {
        details.push(String((vuln as { id?: string }).id ?? 'osv vulnerability'));
      }
    }
  }
  return { findings: count, detail: details.join('; ') };
}

const SCANNERS: ScannerDefinition[] = [
  {
    name: 'gitleaks',
    defaultCommand: 'gitleaks detect --source . --no-banner --report-format json --report-path .review/security/gitleaks.json --exit-code 0',
    parse: parseGitleaks,
  },
  {
    name: 'semgrep',
    defaultCommand: 'semgrep scan --json --config p/owasp-top-ten --quiet .',
    parse: parseSemgrep,
  },
  {
    name: 'osv',
    defaultCommand: 'osv-scanner --format json -r .',
    parse: parseOsv,
  },
];

export async function runSecurityScans(
  repoRoot: string,
  config: ReviewConfig,
  runDir: string,
): Promise<CheckResult[]> {
  const securityDir = path.join(runDir, 'security');
  await mkdir(securityDir, { recursive: true });
  const results: CheckResult[] = [];

  for (const scanner of SCANNERS) {
    const scannerConfig = config.security[scanner.name];
    if (!scannerConfig.enabled) continue;
    const reportPath = path.join(securityDir, `${scanner.name}.json`);
    const defaultCommand = scanner.defaultCommand.replace(
      '.review/security/gitleaks.json',
      path.relative(repoRoot, reportPath).replace(/\\/g, '/'),
    );
    const command = scannerConfig.cmd ?? defaultCommand;
    const startedAt = Date.now();
    try {
      const execution = await execa(command, [], {
        cwd: repoRoot,
        shell: true,
        reject: false,
        all: true,
        timeout: scannerConfig.timeout_sec * 1000,
        maxBuffer: 32 * 1024 * 1024,
      });
      let reportText: string | null = null;
      try {
        reportText = await readFile(reportPath, 'utf8');
      } catch {
        // stdout is used by semgrep/osv and by custom scanner commands.
      }
      const output = sanitizeUnsafeCharacters(
        redactSecrets(execution.all ?? `${execution.stdout}\n${execution.stderr}`),
      ).text;
      const logPath = path.join(securityDir, `${scanner.name}.log`);
      await writeFile(
        logPath,
        [
          `command: ${command}`,
          `exit_code: ${execution.exitCode ?? 'null'}`,
          `timed_out: ${execution.timedOut}`,
          '',
          output.slice(0, 1_000_000),
        ].join('\n'),
        'utf8',
      );
      const missingTool =
        execution.exitCode === 127 ||
        /not recognized as an internal|command not found|not found/i.test(output);
      if (missingTool && !scannerConfig.required) {
        results.push({
          name: `security:${scanner.name}`,
          command,
          status: 'skipped',
          blocking: scannerConfig.blocking,
          exitCode: execution.exitCode ?? null,
          durationMs: Date.now() - startedAt,
          timedOut: false,
          summary: `${scanner.name} is not installed; skipped (set required: true to block).`,
          logPath,
        });
        continue;
      }
      if (execution.timedOut || missingTool) {
        results.push({
          name: `security:${scanner.name}`,
          command,
          status: 'error',
          blocking: scannerConfig.blocking,
          exitCode: execution.exitCode ?? null,
          durationMs: Date.now() - startedAt,
          timedOut: execution.timedOut,
          summary: execution.timedOut
            ? `${scanner.name} timed out`
            : `${scanner.name} is required but not available`,
          logPath,
        });
        continue;
      }
      const parsed = scanner.parse(output, reportText);
      if (!parsed) {
        const failed = execution.exitCode !== 0;
        results.push({
          name: `security:${scanner.name}`,
          command,
          status: failed ? 'fail' : 'pass',
          blocking: scannerConfig.blocking,
          exitCode: execution.exitCode ?? null,
          durationMs: Date.now() - startedAt,
          timedOut: false,
          summary: failed
            ? `${scanner.name} exited ${execution.exitCode}; output could not be parsed`
            : 'No parseable findings; exit 0',
          logPath,
        });
        continue;
      }
      results.push({
        name: `security:${scanner.name}`,
        command,
        status: parsed.findings > 0 || execution.exitCode !== 0 ? 'fail' : 'pass',
        blocking: scannerConfig.blocking,
        exitCode: execution.exitCode ?? null,
        durationMs: Date.now() - startedAt,
        timedOut: false,
        summary:
          parsed.findings > 0
            ? `${parsed.findings} finding(s): ${parsed.detail}`
            : 'No findings',
        logPath,
      });
    } catch (error) {
      results.push({
        name: `security:${scanner.name}`,
        command,
        status: 'error',
        blocking: scannerConfig.blocking,
        exitCode: null,
        durationMs: Date.now() - startedAt,
        timedOut: false,
        summary: `Failed to run: ${(error as Error).message}`,
      });
    }
  }

  return results;
}
