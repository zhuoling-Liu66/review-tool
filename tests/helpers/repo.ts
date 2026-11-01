import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import YAML from 'yaml';

export interface TestRepoOptions {
  findings?: unknown[];
  mockResponse?: string;
  verifierResponse?: string;
  repairResponse?: string;
  checkFails?: boolean;
  highRisk?: boolean;
  budgetQuick?: number;
  noModels?: boolean;
  withLockBranch?: boolean;
  multiAgent?: 'on' | 'off' | 'auto';
  monthlyUsd?: number;
  roundsMax?: number;
  checks?: Record<string, unknown>;
  minSeverity?: string;
}

export interface TestRepo {
  dir: string;
  configPath: string;
  changedFile: string;
  cleanup: () => Promise<void>;
}

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await execa('git', ['-C', cwd, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'review-test',
      GIT_AUTHOR_EMAIL: 'review-test@example.com',
      GIT_COMMITTER_NAME: 'review-test',
      GIT_COMMITTER_EMAIL: 'review-test@example.com',
    },
    reject: false,
    all: true,
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.all}`);
  }
}

async function write(dir: string, relativePath: string, content: string): Promise<void> {
  const filePath = path.join(dir, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}

export async function createTestRepo(options: TestRepoOptions = {}): Promise<TestRepo> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'review-tool-test-'));
  const changedFile = options.highRisk ? 'auth/session.ts' : 'src/app.ts';

  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['config', 'core.autocrlf', 'false']);
  await git(dir, ['config', 'user.email', 'review-test@example.com']);
  await git(dir, ['config', 'user.name', 'review-test']);

  const baseSource =
    changedFile === 'auth/session.ts'
      ? `export function verifyToken(token: string): boolean {\n  return token.length > 0;\n}\n`
      : `export function checkToken(token: string): boolean {\n  return token.length > 0;\n}\n`;
  const headSource =
    changedFile === 'auth/session.ts'
      ? `export function verifyToken(token: string): boolean {\n  return token !== 'expired';\n}\n`
      : `export function checkToken(token: string): boolean {\n  return token !== 'expired';\n}\n`;

  await write(dir, changedFile, baseSource);
  await write(dir, 'tests/app.test.ts', `test('placeholder', () => { expect(true).toBe(true); });\n`);
  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-q', '-m', 'base']);
  await git(dir, ['checkout', '-q', '-b', 'feature']);
  await write(dir, changedFile, headSource);
  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-q', '-m', 'change']);

  if (options.withLockBranch) {
    await git(dir, ['checkout', '-q', 'main']);
    await git(dir, ['checkout', '-q', '-b', 'lock']);
    await write(dir, 'package-lock.json', '{"lockfileVersion": 3}\n');
    await git(dir, ['add', '.']);
    await git(dir, ['commit', '-q', '-m', 'lockfile']);
    await git(dir, ['checkout', '-q', 'feature']);
  }

  const findings =
    options.findings ??
    [
      {
        file: changedFile,
        line: 2,
        severity: 'important',
        category: 'correctness',
        claim: 'Token expiry is compared to a hard-coded string instead of the exp claim.',
        evidence: `The new code at ${changedFile}:2 uses token !== 'expired'; real expired tokens are not rejected.`,
        suggestion: 'Decode the token and compare exp with the current time.',
        confidence: 0.9,
      },
    ];

  const mockResponse = options.mockResponse ?? JSON.stringify({ findings });
  const checks =
    options.checks ??
    {
      tests: {
        cmd: options.checkFails ? 'node -e "process.exit(1)"' : 'node -e "process.exit(0)"',
        blocking: true,
        timeout_sec: 30,
      },
      skip_paths: ['dist/**', '**/*.lock'],
    };

  const config: Record<string, unknown> = {
    version: 1,
    providers: {
      mock: {
        type: 'mock',
        mock_response: mockResponse,
        ...(options.verifierResponse ? { mock_verifier_response: options.verifierResponse } : {}),
        ...(options.repairResponse ? { mock_repair_response: options.repairResponse } : {}),
      },
    },
    pricing: {
      'mock-model': { input: 1, output: 1 },
    },
    models: options.noModels
      ? {}
      : {
          quick: { provider: 'mock', name: 'mock-model', max_output_tokens: 1024 },
        },
    budget: {
      per_run_tokens: { quick: options.budgetQuick ?? 50_000 },
      hard_max_tokens: 600_000,
      ...(options.monthlyUsd !== undefined ? { monthly_usd: options.monthlyUsd } : {}),
    },
    checks,
    review: {
      min_severity_to_report: options.minSeverity ?? 'minor',
      ...(options.multiAgent ? { multi_agent: options.multiAgent } : {}),
    },
    rounds: {
      max: options.roundsMax ?? 3,
    },
  };

  await write(dir, '.review/config.yml', YAML.stringify(config));

  return {
    dir,
    configPath: path.join(dir, '.review', 'config.yml'),
    changedFile,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    },
  };
}
