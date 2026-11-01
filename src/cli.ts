#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Command, CommanderError } from 'commander';
import { loadConfig, parseTokenBudget } from './config.js';
import { approveRun } from './approval.js';
import { renderEvalMarkdown, runEval } from './eval.js';
import { ReviewError } from './errors.js';
import { gcArtifacts } from './gc.js';
import { runFullScan } from './full.js';
import { getRepoRoot } from './git.js';
import { githubOptionsFromEnv, publishReview } from './github.js';
import { installHooks, uninstallHooks } from './hooks.js';
import { verifyLedger } from './ledger.js';
import { getMonthlySpend } from './monthly-budget.js';
import { collectMetrics, renderMetricsMarkdown } from './metrics.js';
import { collectOutcomes, recordOutcome, type OutcomeStatus } from './outcomes.js';
import { runReview } from './pipeline.js';
import { resetRounds } from './rounds.js';
import { formatRevertCommand, resolveMergeCommit } from './revert.js';
import { resolveScanRange } from './scan.js';
import { buildSarif } from './sarif.js';
import type { Mode, RunManifest } from './types.js';

interface CommonOptions {
  repo: string;
  config?: string;
}

interface RunCliOptions extends CommonOptions {
  base: string;
  head: string;
  mode: string;
  budget?: string;
  intent?: string;
  ai: boolean;
  quiet?: boolean;
  json?: boolean;
  overrideHigh?: boolean;
  reason?: string;
  post?: boolean;
  requireApproval?: boolean;
  pr?: string;
  shadow?: boolean;
}

interface ChecksOptions extends CommonOptions {
  base: string;
  head: string;
  quiet?: boolean;
  json?: boolean;
}

interface ReportOptions extends CommonOptions {
  run: string;
  format?: string;
  out?: string;
}

interface ApproveOptions extends CommonOptions {
  run: string;
  external?: boolean;
  as?: string;
  soloOverride?: boolean;
  note?: string;
}

interface EvalCliOptions extends CommonOptions {
  cases?: string;
  mode?: string;
  updateBaseline?: boolean;
  json?: boolean;
  failOnRegression?: boolean;
}

interface FullCliOptions extends CommonOptions {
  mode?: string;
  dryRun?: boolean;
  yes?: boolean;
  resume?: boolean;
  scanId?: string;
  budget?: string;
  maxUsd?: string;
  maxFiles?: string;
  maxFilesPerBatch?: string;
  json?: boolean;
}

function resolveRepo(repo: string): string {
  return path.resolve(repo);
}

async function printRunResult(
  result: Awaited<ReturnType<typeof runReview>>,
  quiet: boolean | undefined,
  json?: boolean,
): Promise<void> {
  if (json) {
    const manifest = await readFile(result.manifestPath, 'utf8');
    process.stdout.write(manifest.endsWith('\n') ? manifest : `${manifest}\n`);
    return;
  }
  if (!quiet) console.log(result.terminalSummary);
}

async function runCommand(options: RunCliOptions): Promise<number> {
  if (options.overrideHigh && !options.reason?.trim()) {
    throw new ReviewError('--override-high requires --reason "<explanation>".', 2);
  }
  const prNumber = options.pr ? Number(options.pr) : undefined;
  if (prNumber !== undefined && (!Number.isInteger(prNumber) || prNumber <= 0)) {
    throw new ReviewError(`Invalid --pr value: ${options.pr}`, 2);
  }
  const result = await runReview({
    repoPath: resolveRepo(options.repo),
    baseRef: options.base,
    headRef: options.head,
    configPath: options.config,
    mode: options.mode as Mode,
    budgetTokens: options.budget ? parseTokenBudget(options.budget) : undefined,
    intent: options.intent,
    noAi: options.ai === false,
    overrideHighReason: options.overrideHigh ? options.reason?.trim() : undefined,
    requireApproval: options.requireApproval === true,
    prNumber,
    shadow: options.shadow === true,
  });
  if (options.post && !options.shadow) {
    try {
      const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8')) as RunManifest;
      const published = await publishReview(manifest, githubOptionsFromEnv());
      console.error(
        `GitHub: summary ${published.summaryAction}; inline ${published.inlineCreated} created, ${published.inlineSkipped} skipped`,
      );
      for (const error of published.errors) console.error(`GitHub warning: ${error}`);
    } catch (error) {
      console.error(
        `GitHub publish skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  await printRunResult(result, options.quiet, options.json);
  return result.exitCode;
}

async function checksCommand(options: ChecksOptions): Promise<number> {
  const result = await runReview({
    repoPath: resolveRepo(options.repo),
    baseRef: options.base,
    headRef: options.head,
    configPath: options.config,
    checksOnly: true,
  });
  await printRunResult(result, options.quiet, options.json);
  return result.exitCode;
}

async function reportCommand(options: ReportOptions): Promise<number> {
  if (!/^r_[A-Za-z0-9_]+$/.test(options.run)) {
    throw new ReviewError(`Invalid run id: ${options.run}`, 2);
  }
  const repoRoot = resolveRepo(options.repo);
  const artifactDir = path.join(repoRoot, '.review', 'artifacts', options.run);
  const format = (options.format ?? 'md').toLowerCase();
  let content: string;

  if (format === 'md' || format === 'markdown') {
    try {
      content = await readFile(path.join(artifactDir, 'report.md'), 'utf8');
    } catch {
      throw new ReviewError(`Report not found for run ${options.run} in ${repoRoot}`, 2);
    }
  } else if (format === 'json') {
    try {
      content = await readFile(path.join(artifactDir, 'manifest.json'), 'utf8');
    } catch {
      throw new ReviewError(`Manifest not found for run ${options.run} in ${repoRoot}`, 2);
    }
  } else if (format === 'sarif') {
    let manifestText: string;
    try {
      manifestText = await readFile(path.join(artifactDir, 'manifest.json'), 'utf8');
    } catch {
      throw new ReviewError(`Manifest not found for run ${options.run} in ${repoRoot}`, 2);
    }
    content = `${JSON.stringify(buildSarif(JSON.parse(manifestText)), null, 2)}\n`;
  } else {
    throw new ReviewError(`Unsupported report format "${options.format}". Use md, json, or sarif.`, 2);
  }

  if (options.out) {
    const outPath = path.resolve(options.out);
    await writeFile(outPath, content, 'utf8');
    console.log(`Wrote ${outPath}`);
  } else {
    process.stdout.write(content.endsWith('\n') ? content : `${content}\n`);
  }
  return 0;
}

async function validateConfigCommand(options: CommonOptions): Promise<number> {
  const loaded = await loadConfig(resolveRepo(options.repo), options.config);
  console.log(`Config valid: ${loaded.configPath}`);
  console.log(`Config hash: ${loaded.configHash}`);
  console.log(
    `Checks: ${Object.keys(loaded.config.checks).filter((key) => key !== 'skip_paths').length}`,
  );
  console.log(`Models: ${Object.keys(loaded.config.models).join(', ') || '(none)'}`);
  return 0;
}

async function ledgerVerifyCommand(options: { repo: string }): Promise<number> {
  const result = await verifyLedger(resolveRepo(options.repo));
  if (result.ok) {
    console.log(`Ledger valid (${result.count} events).`);
    return 0;
  }
  console.error(`Ledger invalid at event ${result.count}: ${result.error}`);
  return 1;
}

async function budgetCommand(options: CommonOptions): Promise<number> {
  const repoRoot = resolveRepo(options.repo);
  const loaded = await loadConfig(repoRoot, options.config);
  const monthly = await getMonthlySpend(repoRoot);
  const limit = loaded.config.budget.monthly_usd;
  const ratio = limit > 0 ? (monthly.spentUsd / limit) * 100 : 0;
  console.log(`Period: ${monthly.period}`);
  console.log(`Spent: $${monthly.spentUsd.toFixed(4)} / $${limit.toFixed(2)} (${ratio.toFixed(1)}%)`);
  console.log(`Priced: ${monthly.priced ? 'yes' : 'no (some calls unpriced)'}`);
  console.log(`Monthly hard stop: ${loaded.config.budget.monthly_hard_stop ? 'on' : 'off'}`);
  return 0;
}

async function gcCommand(options: CommonOptions & { days: string }): Promise<number> {
  const days = Number(options.days);
  if (!Number.isFinite(days) || days < 0) {
    throw new ReviewError(`Invalid --days value: ${options.days}`, 2);
  }
  const result = await gcArtifacts(resolveRepo(options.repo), days);
  console.log(`Artifacts directory: ${result.artifactsDir}`);
  console.log(`Removed: ${result.removed.length}; kept: ${result.kept}`);
  if (result.removed.length > 0) {
    console.log(result.removed.join('\n'));
  }
  return 0;
}

async function approveCommand(options: ApproveOptions): Promise<number> {
  const approval = await approveRun(resolveRepo(options.repo), options.run, {
    external: options.external === true,
    as: options.as,
    soloOverride: options.soloOverride === true,
    note: options.note,
    configPath: options.config,
  });
  console.log(
    `Approved ${approval.runId}: ${approval.approverType} by ${approval.approver} (head ${approval.headSha.slice(0, 12)})`,
  );
  return 0;
}

async function resetRoundsCommand(options: CommonOptions & { pr: string; reason: string }): Promise<number> {
  const prNumber = Number(options.pr);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new ReviewError(`Invalid --pr value: ${options.pr}`, 2);
  }
  await resetRounds(resolveRepo(options.repo), prNumber, options.reason);
  console.log(`Rounds reset for PR #${prNumber}.`);
  return 0;
}

async function revertCommand(
  options: CommonOptions & { merge?: string; pr?: string },
): Promise<number> {
  const prNumber = options.pr ? Number(options.pr) : undefined;
  if (options.pr && (!Number.isInteger(prNumber) || (prNumber ?? 0) <= 0)) {
    throw new ReviewError(`Invalid --pr value: ${options.pr}`, 2);
  }
  const mergeSha = await resolveMergeCommit(resolveRepo(options.repo), {
    mergeSha: options.merge,
    prNumber,
  });
  console.log(formatRevertCommand(mergeSha));
  console.log('Command printed only; review-tool does not execute or push reverts.');
  return 0;
}

async function evalCommand(options: EvalCliOptions): Promise<number> {
  const mode = options.mode as Mode | undefined;
  const summary = await runEval({
    repoPath: resolveRepo(options.repo),
    casesDir: options.cases,
    mode,
    updateBaseline: options.updateBaseline === true,
  });
  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    process.stdout.write(renderEvalMarkdown(summary));
  }
  if (
    options.failOnRegression &&
    summary.baseline &&
    summary.baseline.regressions.length > 0
  ) {
    return 1;
  }
  return 0;
}

async function outcomeCommand(
  options: CommonOptions & {
    run: string;
    finding: string;
    status: string;
    reason?: string;
    kind?: string;
  },
): Promise<number> {
  const allowed: OutcomeStatus[] = ['fixed', 'dismissed', 'accepted_risk', 'ignored'];
  if (!allowed.includes(options.status as OutcomeStatus)) {
    throw new ReviewError(`Invalid outcome status: ${options.status}`, 2);
  }
  await recordOutcome(resolveRepo(options.repo), options.run, options.finding, options.status as OutcomeStatus, {
    reason: options.reason,
    reasonKind: options.kind as 'error' | 'intentional' | 'minor' | undefined,
  });
  console.log(`Recorded ${options.status} for ${options.finding} in ${options.run}.`);
  return 0;
}

async function outcomesCommand(options: CommonOptions & { since?: string }): Promise<number> {
  const summary = await collectOutcomes(
    resolveRepo(options.repo),
    parseDays(options.since, 30),
  );
  console.log(JSON.stringify(summary, null, 2));
  return 0;
}

async function metricsCommand(options: CommonOptions & { since?: string; json?: boolean }): Promise<number> {
  const summary = await collectMetrics(
    resolveRepo(options.repo),
    parseDays(options.since, 30),
  );
  if (options.json) console.log(JSON.stringify(summary, null, 2));
  else console.log(renderMetricsMarkdown(summary));
  return 0;
}

async function scanCommand(
  options: CommonOptions & { since?: string; mode?: string; json?: boolean },
): Promise<number> {
  const repoRoot = await getRepoRoot(resolveRepo(options.repo));
  const range = await resolveScanRange(repoRoot, parseDays(options.since, 30));
  const result = await runReview({
    repoPath: repoRoot,
    baseRef: range.base,
    headRef: range.head,
    mode: (options.mode as Mode | undefined) ?? 'standard',
    evalMode: true,
    shadow: true,
    trigger: 'scan',
  });
  if (options.json) {
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    console.log(JSON.stringify({ scan: range, run: manifest }, null, 2));
  } else {
    console.log(`Scan window: ${range.commits} commit(s)`);
    console.log(result.terminalSummary);
  }
  return 0;
}

async function fullCommand(options: FullCliOptions): Promise<number> {
  const budgetTokens = options.budget ? parseTokenBudget(options.budget) : undefined;
  const maxUsd = options.maxUsd ? Number(options.maxUsd) : undefined;
  if (maxUsd !== undefined && (!Number.isFinite(maxUsd) || maxUsd <= 0)) {
    throw new ReviewError(`Invalid --max-usd value: ${options.maxUsd}`, 2);
  }
  const maxFiles = options.maxFiles ? Number(options.maxFiles) : undefined;
  if (maxFiles !== undefined && (!Number.isInteger(maxFiles) || maxFiles <= 0)) {
    throw new ReviewError(`Invalid --max-files value: ${options.maxFiles}`, 2);
  }
  const maxFilesPerBatch = options.maxFilesPerBatch
    ? Number(options.maxFilesPerBatch)
    : undefined;
  if (
    maxFilesPerBatch !== undefined &&
    (!Number.isInteger(maxFilesPerBatch) || maxFilesPerBatch <= 0)
  ) {
    throw new ReviewError(`Invalid --max-files-per-batch value: ${options.maxFilesPerBatch}`, 2);
  }

  const result = await runFullScan({
    repoPath: resolveRepo(options.repo),
    configPath: options.config,
    mode: (options.mode as Mode | undefined) ?? 'quick',
    dryRun: options.dryRun === true,
    yes: options.yes === true,
    resume: options.resume === true,
    scanId: options.scanId,
    budgetTokens,
    maxUsd,
    maxFiles,
    maxFilesPerBatch,
    log: (message) => console.error(message),
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `Full scan ${result.scanId}: ${result.status}; files ${result.estimated.files}; skipped ${result.estimated.skipped}; findings ${result.actual.findings}`,
    );
    console.log(
      `Estimate: ${result.estimated.inputTokens} input + ${result.estimated.outputTokens} output tokens; ${result.estimated.priced ? `$${result.estimated.costUsd.toFixed(4)}` : 'unpriced'}`,
    );
    console.log(`Report: ${result.reportPath}`);
    if (result.status === 'planned') {
      console.log('Dry run only; no model calls were made.');
    }
  }
  return result.exitCode;
}

function parseDays(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const match = /^(\d+)d$/.exec(value.trim());
  if (!match) throw new ReviewError(`Invalid duration "${value}". Use e.g. 30d.`, 2);
  return Number(match[1]);
}

async function hooksInstallCommand(
  options: CommonOptions & { force?: boolean },
): Promise<number> {  const repoRoot = await getRepoRoot(resolveRepo(options.repo));
  const loaded = await loadConfig(repoRoot, options.config);
  const result = await installHooks(repoRoot, loaded.config, options.force === true);
  console.log(`Hooks directory: ${result.hooksDir}`);
  console.log(
    `Installed: ${result.installed.length ? result.installed.join(', ') : '(none)'}`,
  );
  for (const skipped of result.skipped) {
    console.log(`Skipped ${skipped.stage}: ${skipped.reason}`);
  }
  return 0;
}

async function hooksUninstallCommand(options: CommonOptions): Promise<number> {
  const repoRoot = await getRepoRoot(resolveRepo(options.repo));
  const result = await uninstallHooks(repoRoot);
  console.log(`Hooks directory: ${result.hooksDir}`);
  console.log(`Removed: ${result.removed.length ? result.removed.join(', ') : '(none)'}`);
  console.log(`Restored: ${result.restored.length ? result.restored.join(', ') : '(none)'}`);
  console.log(`Untouched: ${result.untouched.length ? result.untouched.join(', ') : '(none)'}`);
  return 0;
}

function addCommonOptions(command: Command): Command {
  return command
    .option('--repo <path>', 'target git repository', process.cwd())
    .option('--config <path>', 'config path relative to the repository');
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('review')
    .description('Risk-tiered AI code review pipeline (Quick / Standard / Deep)')
    .version('0.1.0')
    .exitOverride();

  addCommonOptions(
    program
      .command('run')
      .description('Run deterministic checks and a Quick, Standard, or Deep AI review')
      .option('--base <ref>', 'base git ref', 'main')
      .option('--head <ref>', 'head git ref', 'HEAD')
      .option('--mode <mode>', 'review mode: quick, standard, or deep', 'quick')
      .option('--budget <tokens>', 'token budget, e.g. 50000 or 50k')
      .option('--intent <text>', 'optional change intent summary')
      .option('--no-ai', 'skip AI review (checks-only; exits incomplete)')
      .option('--json', 'print the run manifest as JSON')
      .option('--post', 'publish summary/inline comments to the current GitHub PR')
      .option('--override-high', 'explicitly lower the high-risk tier (requires --reason)')
      .option('--reason <text>', 'reason recorded for --override-high')
      .option('--require-approval', 'require an approval record for low/medium tiers too')
      .option('--pr <number>', 'PR number for round tracking/convergence')
      .option('--shadow', 'run and record results without blocking or approval')
      .option('--quiet', 'suppress terminal summary'),
  ).action(async (options: RunCliOptions) => {
    process.exitCode = await runCommand(options);
  });

  addCommonOptions(
    program
      .command('checks')
      .description('Run deterministic checks only')
      .option('--base <ref>', 'base git ref', 'main')
      .option('--head <ref>', 'head git ref', 'HEAD')
      .option('--json', 'print the run manifest as JSON')
      .option('--quiet', 'suppress terminal summary'),
  ).action(async (options: ChecksOptions) => {
    process.exitCode = await checksCommand(options);
  });

  addCommonOptions(
    program
      .command('report')
      .description('Print a saved report')
      .requiredOption('--run <id>', 'run id')
      .option('--format <format>', 'md, json, or sarif', 'md')
      .option('--out <path>', 'write to a file instead of stdout'),
  ).action(async (options: ReportOptions) => {
    process.exitCode = await reportCommand(options);
  });

  const configCommand = program.command('config').description('Configuration utilities');
  addCommonOptions(
    configCommand.command('validate').description('Validate .review/config.yml'),
  ).action(async (options: CommonOptions) => {
    process.exitCode = await validateConfigCommand(options);
  });

  const ledgerCommand = program.command('ledger').description('Ledger utilities');
  addCommonOptions(
    ledgerCommand.command('verify').description('Verify the append-only ledger hash chain'),
  ).action(async (options: CommonOptions) => {
    process.exitCode = await ledgerVerifyCommand({ repo: options.repo });
  });

  const hooksCommand = program.command('hooks').description('Git hook utilities');
  addCommonOptions(
    hooksCommand
      .command('install')
      .description('Install pre-commit/pre-push hooks from the configured checks')
      .option('--force', 'back up and replace existing unmanaged hooks'),
  ).action(async (options: CommonOptions & { force?: boolean }) => {
    process.exitCode = await hooksInstallCommand(options);
  });
  addCommonOptions(
    hooksCommand.command('uninstall').description('Remove managed hooks and restore backups'),
  ).action(async (options: CommonOptions) => {
    process.exitCode = await hooksUninstallCommand(options);
  });

  addCommonOptions(
    program
      .command('approve')
      .description('Record an approval for a run (external reviewer for high risk)')
      .requiredOption('--run <id>', 'run id')
      .option('--external', 'approval is from an external reviewer')
      .option('--as <login>', 'approver identity')
      .option('--solo-override', 'use allow_solo_override for high risk')
      .option('--note <text>', 'approval note'),
  ).action(async (options: ApproveOptions) => {
    process.exitCode = await approveCommand(options);
  });

  addCommonOptions(
    program
      .command('reset-rounds')
      .description('Reset the review-round counter for a PR after a replan')
      .requiredOption('--pr <number>', 'PR number')
      .requiredOption('--reason <text>', 'reason for resetting the rounds'),
  ).action(async (options: CommonOptions & { pr: string; reason: string }) => {
    process.exitCode = await resetRoundsCommand(options);
  });

  addCommonOptions(
    program
      .command('revert')
      .description('Print a safe git revert command for a merged PR (does not execute)')
      .option('--merge <sha>', 'merge commit SHA')
      .option('--pr <number>', 'PR number (uses gh or git log)'),
  ).action(async (options: CommonOptions & { merge?: string; pr?: string }) => {
    process.exitCode = await revertCommand(options);
  });

  addCommonOptions(
    program
      .command('eval')
      .description('Run golden-set eval and compare with the baseline')
      .option('--cases <dir>', 'cases directory (default .review/eval/cases)')
      .option('--mode <mode>', 'override mode for cases without a mode')
      .option('--update-baseline', 'store current metrics as the new baseline')
      .option('--fail-on-regression', 'exit 1 when the baseline comparison regresses')
      .option('--json', 'print the eval summary as JSON'),
  ).action(async (options: EvalCliOptions) => {
    process.exitCode = await evalCommand(options);
  });

  addCommonOptions(
    program
      .command('outcome')
      .description('Record a finding resolution')
      .requiredOption('--run <id>', 'run id')
      .requiredOption('--finding <id>', 'finding id')
      .requiredOption('--status <status>', 'fixed|dismissed|accepted_risk|ignored')
      .option('--reason <text>', 'resolution reason')
      .option('--kind <kind>', 'dismissed reason: error|intentional|minor'),
  ).action(async (options: CommonOptions & { run: string; finding: string; status: string; reason?: string; kind?: string }) => {
    process.exitCode = await outcomeCommand(options);
  });

  addCommonOptions(
    program
      .command('outcomes')
      .description('Aggregate finding outcomes from the ledger')
      .option('--since <duration>', 'e.g. 30d', '30d'),
  ).action(async (options: CommonOptions & { since?: string }) => {
    process.exitCode = await outcomesCommand(options);
  });

  addCommonOptions(
    program
      .command('metrics')
      .description('Show cost/quality metrics from the ledger')
      .option('--since <duration>', 'e.g. 30d', '30d')
      .option('--json', 'print JSON'),
  ).action(async (options: CommonOptions & { since?: string; json?: boolean }) => {
    process.exitCode = await metricsCommand(options);
  });

  addCommonOptions(
    program
      .command('scan')
      .description('Scan recent commits as a non-blocking backlog report')
      .option('--since <duration>', 'scan window, e.g. 30d', '30d')
      .option('--mode <mode>', 'quick|standard|deep', 'standard')
      .option('--json', 'print JSON'),
  ).action(async (options: CommonOptions & { since?: string; mode?: string; json?: boolean }) => {
    process.exitCode = await scanCommand(options);
  });

  addCommonOptions(
    program
      .command('full')
      .description('Review an entire project in resumable module batches')
      .option('--mode <mode>', 'quick|standard|deep', 'quick')
      .option('--dry-run', 'estimate cost without calling models')
      .option('--yes', 'confirm a non-interactive full scan')
      .option('--resume', 'resume the latest running full scan')
      .option('--scan-id <id>', 'resume a specific full scan')
      .option('--budget <tokens>', 'total token budget for this full scan')
      .option('--max-usd <usd>', 'abort if the estimate exceeds this USD amount')
      .option('--max-files <n>', 'limit files included in the scan')
      .option('--max-files-per-batch <n>', 'limit files per module batch')
      .option('--json', 'print JSON'),
  ).action(async (options: FullCliOptions) => {
    process.exitCode = await fullCommand(options);
  });

  addCommonOptions(
    program.command('budget').description('Show monthly AI spend from the ledger'),
  ).action(async (options: CommonOptions) => {
    process.exitCode = await budgetCommand(options);
  });

  addCommonOptions(
    program
      .command('gc')
      .description('Remove old run artifacts (ledger is never removed)')
      .option('--days <days>', 'retain artifacts newer than this many days', '90'),
  ).action(async (options: CommonOptions & { days: string }) => {
    process.exitCode = await gcCommand(options);
  });

  return program;
}

export async function main(argv: string[] = process.argv): Promise<number> {
  process.exitCode = 0;
  const program = buildProgram();
  try {
    await program.parseAsync(argv);
    return process.exitCode ?? 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode !== 0) console.error(error.message);
      return error.exitCode;
    }
    if (error instanceof ReviewError) {
      console.error(`Error: ${error.message}`);
      return error.exitCode;
    }
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isMain()) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 2;
    });
}
