import { execa } from 'execa';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import picomatch from 'picomatch';
import { createInterface } from 'node:readline/promises';
import { BudgetTracker } from './budget.js';
import { loadConfig } from './config.js';
import { BudgetExceededError, ReviewError } from './errors.js';
import { groundFindings, parseAiFindings } from './findings.js';
import { getRepoRoot, readFileAtCommit, resolveCommit } from './git.js';
import { LedgerWriter } from './ledger.js';
import { FULL_FINDER_PROMPT_VERSION, FULL_FINDER_SYSTEM_PROMPT } from './prompts.js';
import { calculateCost, createModelClient, getPricing, resolveModel } from './providers/index.js';
import type { DiffInfo, Finding, Mode } from './types.js';
import { sha256Prefixed } from './util/hash.js';
import { estimateTokens, truncateText } from './util/tokens.js';

interface FullFile {
  path: string;
  sha256: string;
  bytes: number;
}

interface SkippedFile {
  path: string;
  reason: string;
}

type BatchStatus = 'pending' | 'done' | 'failed';

interface FullBatchState {
  id: string;
  module: string;
  files: FullFile[];
  status: BatchStatus;
  findings: Finding[];
  tokens: number;
  costUsd: number;
  error?: string;
}

export interface FullScanState {
  schema: 'review.full.v1';
  scanId: string;
  repoRoot: string;
  headSha: string;
  mode: Mode;
  configHash: string;
  createdAt: string;
  updatedAt: string;
  status: 'running' | 'completed' | 'incomplete';
  files: FullFile[];
  skipped: SkippedFile[];
  batches: FullBatchState[];
  totals: {
    tokens: number;
    costUsd: number;
    findings: number;
  };
}

export interface FullEstimate {
  batches: number;
  pendingBatches: number;
  files: number;
  skipped: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  priced: boolean;
  budgetTokens: number;
  maxUsd: number | null;
}

export interface FullScanOptions {
  repoPath: string;
  configPath?: string;
  mode?: Mode;
  dryRun?: boolean;
  yes?: boolean;
  resume?: boolean;
  scanId?: string;
  budgetTokens?: number;
  maxUsd?: number;
  maxFiles?: number;
  maxFilesPerBatch?: number;
  log?: (message: string) => void;
}

export interface FullScanResult {
  scanId: string;
  status: 'completed' | 'incomplete' | 'planned';
  headSha: string;
  mode: Mode;
  estimated: FullEstimate;
  actual: { tokens: number; costUsd: number; findings: number; batchesFailed: number };
  statePath: string;
  reportPath: string;
  findingsPath: string;
  findings: Finding[];
  exitCode: number;
}

const FULL_SKIP_PATTERNS = [
  'docs/**',
  '**/*.md',
  '**/*.lock',
  '**/*.map',
  '.review/**',
  '**/*.svg',
  '**/*.png',
  '**/*.jpg',
  '**/*.jpeg',
  '**/*.gif',
  '**/*.ico',
  '**/*.webp',
];
const MAX_FILE_BYTES = 200_000;
const MAX_BATCH_CHARS = 55_000;

function matchesAny(filePath: string, patterns: string[]): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return patterns.some((pattern) => picomatch(pattern, { dot: true })(normalized));
}

function makeScanId(): string {
  return `full_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${Math.random().toString(16).slice(2, 8)}`;
}

function stateDir(repoRoot: string, scanId: string): string {
  return path.join(repoRoot, '.review', 'full', scanId);
}

function statePathFor(repoRoot: string, scanId: string): string {
  return path.join(stateDir(repoRoot, scanId), 'state.json');
}

function reportPathFor(repoRoot: string, scanId: string): string {
  return path.join(stateDir(repoRoot, scanId), 'report.md');
}

function findingsPathFor(repoRoot: string, scanId: string): string {
  return path.join(stateDir(repoRoot, scanId), 'findings.json');
}

async function saveState(repoRoot: string, state: FullScanState): Promise<void> {
  const dir = stateDir(repoRoot, state.scanId);
  await mkdir(dir, { recursive: true });
  state.updatedAt = new Date().toISOString();
  state.totals = {
    tokens: state.batches.reduce((sum, batch) => sum + batch.tokens, 0),
    costUsd: Number(state.batches.reduce((sum, batch) => sum + batch.costUsd, 0).toFixed(6)),
    findings: state.batches.reduce((sum, batch) => sum + batch.findings.length, 0),
  };
  const target = statePathFor(repoRoot, state.scanId);
  const temp = `${target}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(temp, target);
}

async function loadState(repoRoot: string, scanId: string): Promise<FullScanState> {
  try {
    return JSON.parse(
      await readFile(statePathFor(repoRoot, scanId), 'utf8'),
    ) as FullScanState;
  } catch {
    throw new ReviewError(`Full scan state not found: ${scanId}`, 2);
  }
}

async function latestRunningState(repoRoot: string): Promise<FullScanState | null> {
  const dir = path.join(repoRoot, '.review', 'full');
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  let best: FullScanState | null = null;
  for (const entry of entries) {
    try {
      const state = await loadState(repoRoot, entry);
      if (state.status === 'completed') continue;
      if (!best || state.updatedAt > best.updatedAt) best = state;
    } catch {
      // Ignore malformed/incomplete state directories.
    }
  }
  return best;
}

async function listTrackedFiles(repoRoot: string): Promise<string[]> {
  const result = await execa('git', ['-C', repoRoot, 'ls-files', '-z'], {
    reject: false,
    all: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.exitCode !== 0) {
    throw new ReviewError(`git ls-files failed: ${result.stderr}`, 2);
  }
  return result.stdout.split('\0').filter(Boolean).sort();
}

async function readHeadFiles(
  repoRoot: string,
  headSha: string,
  config: Awaited<ReturnType<typeof loadConfig>>['config'],
  maxFiles?: number,
): Promise<{ files: FullFile[]; contents: Map<string, string>; skipped: SkippedFile[] }> {
  const paths = await listTrackedFiles(repoRoot);
  const files: FullFile[] = [];
  const contents = new Map<string, string>();
  const skipped: SkippedFile[] = [];
  const skipPatterns = [...config.review.skip_paths, ...FULL_SKIP_PATTERNS];

  for (const filePath of paths) {
    if (maxFiles !== undefined && files.length >= maxFiles) {
      skipped.push({ path: filePath, reason: 'max_files_limit' });
      continue;
    }
    if (matchesAny(filePath, skipPatterns)) {
      skipped.push({ path: filePath, reason: 'skip_path' });
      continue;
    }
    const content = await readFileAtCommit(repoRoot, headSha, filePath);
    if (content === null || content.includes('\u0000')) {
      skipped.push({ path: filePath, reason: 'binary_or_unreadable' });
      continue;
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
      skipped.push({ path: filePath, reason: 'file_too_large' });
      continue;
    }
    const entry = {
      path: filePath,
      sha256: sha256Prefixed(content),
      bytes: Buffer.byteLength(content, 'utf8'),
    };
    files.push(entry);
    contents.set(filePath, content);
  }
  return { files, contents, skipped };
}

function groupBatches(
  files: FullFile[],
  maxFilesPerBatch = 8,
): Array<{ id: string; module: string; files: FullFile[] }> {
  const groups = new Map<string, FullFile[]>();
  for (const file of files) {
    const module = file.path.includes('/') ? file.path.split('/')[0]! : '(root)';
    const list = groups.get(module) ?? [];
    if (!groups.has(module)) groups.set(module, list);
    list.push(file);
  }
  const batches: Array<{ id: string; module: string; files: FullFile[] }> = [];
  let index = 1;
  for (const [module, moduleFiles] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    let current: FullFile[] = [];
    let chars = 0;
    const flush = () => {
      if (current.length === 0) return;
      batches.push({ id: `b_${String(index).padStart(3, '0')}`, module, files: current });
      index += 1;
      current = [];
      chars = 0;
    };
    for (const file of moduleFiles) {
      if (
        current.length >= maxFilesPerBatch ||
        (current.length > 0 && chars + file.bytes > MAX_BATCH_CHARS)
      ) {
        flush();
      }
      current.push(file);
      chars += file.bytes;
    }
    flush();
  }
  return batches;
}

async function readDocs(repoRoot: string, headSha: string): Promise<string> {
  const sections: string[] = [];
  for (const name of ['CLAUDE.md', 'REVIEW.md']) {
    const content = await readFileAtCommit(repoRoot, headSha, name);
    if (content) sections.push(`### ${name}\n${truncateText(content, 6_000)}`);
  }
  return sections.length ? sections.join('\n\n') : '(No CLAUDE.md or REVIEW.md found.)';
}

function buildFullUserPrompt(
  docs: string,
  batch: { module: string; files: FullFile[] },
  contents: Map<string, string>,
  limitChars: number,
): string {
  const sections = batch.files.map((file) => {
    const content = contents.get(file.path) ?? '';
    const lines = content.split(/\r?\n/);
    const numbered = lines.map((line, index) => `${index + 1}: ${line}`).join('\n');
    return `### ${file.path}\n\`\`\`\n${truncateText(numbered, 12_000)}\n\`\`\``;
  });
  const budget = Math.max(8_000, limitChars);
  return [
    `## Module: ${batch.module}`,
    '',
    '## Project conventions',
    docs,
    '',
    '## Files in this module',
    truncateText(sections.join('\n\n'), budget),
    '',
    'Review these files and return JSON findings only.',
  ].join('\n');
}

async function confirmEstimate(estimate: FullEstimate): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new ReviewError(
      'Full review needs confirmation or --yes in non-interactive mode.',
      2,
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const cost = estimate.priced ? `$${estimate.costUsd.toFixed(2)}` : 'unpriced';
  const answer = await rl.question(
    `Full review will run ${estimate.pendingBatches} batch(es), ~${estimate.inputTokens} input tokens, estimated ${cost}. Continue? [y/N] `,
  );
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

function aggregateFindings(state: FullScanState): Finding[] {
  const seen = new Set<string>();
  const findings: Finding[] = [];
  for (const batch of state.batches) {
    for (const finding of batch.findings) {
      if (seen.has(finding.fingerprint)) continue;
      seen.add(finding.fingerprint);
      findings.push({ ...finding, id: `ff_${String(findings.length + 1).padStart(3, '0')}` });
    }
  }
  return findings.sort(
    (a, b) =>
      b.severity.localeCompare(a.severity) ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );
}

function renderFullReport(state: FullScanState, findings: Finding[]): string {
  const reported = findings.filter((finding) => finding.status === 'reported');
  const skipped = state.skipped.length;
  const failed = state.batches.filter((batch) => batch.status === 'failed');
  const lines = [
    `# Full review ${state.scanId}`,
    '',
    '| Item | Value |',
    '|---|---|',
    `| Status | ${state.status} |`,
    `| Head | \`${state.headSha}\` |`,
    `| Mode | ${state.mode} |`,
    `| Files reviewed | ${state.files.length} |`,
    `| Files skipped | ${skipped} |`,
    `| Batches | ${state.batches.length} (${failed.length} failed) |`,
    `| Findings | ${reported.length} published / ${findings.length} total |`,
    `| Cost | $${state.totals.costUsd.toFixed(4)} |`,
    `| Tokens | ${state.totals.tokens.toLocaleString()} |`,
    '',
    'Findings are module-level advisory results from one Finder; there is no interactive approval in full mode.',
    '',
  ];
  if (findings.length === 0) {
    lines.push('No findings.');
  } else {
    lines.push('## Findings');
    lines.push('');
    lines.push('| ID | Severity | Category | Location | Claim |');
    lines.push('|---|---|---|---|---|');
    for (const finding of findings) {
      lines.push(
        `| ${finding.id} | ${finding.severity} | ${finding.category} | ${finding.file}:${finding.line} | ${finding.claim.replace(/\|/g, '\\|')} |`,
      );
    }
  }
  if (state.skipped.length > 0) {
    lines.push('', '## Skipped files', '');
    for (const skippedFile of state.skipped.slice(0, 100)) {
      lines.push(`- ${skippedFile.path}: ${skippedFile.reason}`);
    }
    if (state.skipped.length > 100) lines.push(`- … ${state.skipped.length - 100} more`);
  }
  lines.push('', '## Batches', '');
  for (const batch of state.batches) {
    lines.push(
      `- ${batch.id} · ${batch.module} · ${batch.status} · ${batch.files.length} files · ${batch.findings.length} findings${batch.error ? ` · ${batch.error}` : ''}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export async function runFullScan(options: FullScanOptions): Promise<FullScanResult> {
  const repoRoot = await getRepoRoot(options.repoPath);
  const loaded = await loadConfig(repoRoot, options.configPath);
  const config = loaded.config;
  const headSha = await resolveCommit(repoRoot, 'HEAD');
  const mode = options.mode ?? 'quick';
  const role = mode === 'deep' ? 'deep' : mode === 'standard' ? 'finder' : 'quick';
  const resolvedModel = resolveModel(config, role) ?? resolveModel(config, 'quick');
  if (!resolvedModel) throw new ReviewError('No model configured for full review.', 2);
  const client = createModelClient(config, resolvedModel.role, repoRoot);
  if (!client) throw new ReviewError('No model client configured for full review.', 2);
  const log = options.log ?? (() => {});

  let state: FullScanState;
  let contents: Map<string, string>;
  let docs: string;

  if (options.resume || options.scanId) {
    state = options.scanId
      ? await loadState(repoRoot, options.scanId)
      : (await latestRunningState(repoRoot)) ??
        (() => {
          throw new ReviewError('No running full scan to resume.', 2);
        })();
    if (state.headSha !== headSha && state.status !== 'completed') {
      throw new ReviewError(
        `Cannot resume scan ${state.scanId}: HEAD changed from ${state.headSha} to ${headSha}. Start a new scan.`,
        2,
      );
    }
    state.mode = mode;
    const read = await readHeadFiles(repoRoot, headSha, config, options.maxFiles);
    contents = read.contents;
    if (state.status === 'completed') {
      const findings = aggregateFindings(state);
      const reportPath = reportPathFor(repoRoot, state.scanId);
      await writeFile(reportPath, renderFullReport(state, findings), 'utf8');
      return {
        scanId: state.scanId,
        status: 'completed',
        headSha,
        mode,
        estimated: emptyEstimate(state, resolvedModel.model.name, config),
        actual: {
          tokens: state.totals.tokens,
          costUsd: state.totals.costUsd,
          findings: findings.length,
          batchesFailed: 0,
        },
        statePath: statePathFor(repoRoot, state.scanId),
        reportPath,
        findingsPath: findingsPathFor(repoRoot, state.scanId),
        findings,
        exitCode: 0,
      };
    }
    docs = await readDocs(repoRoot, headSha);
    for (const batch of state.batches) {
      if (batch.status !== 'done') continue;
      // Done batches keep their state; pending batches are rebuilt from HEAD.
      for (const file of batch.files) {
        if (!contents.has(file.path)) {
          batch.status = 'pending';
          batch.error = 'file changed or missing at HEAD';
        }
      }
    }
  } else {
    const read = await readHeadFiles(repoRoot, headSha, config, options.maxFiles);
    contents = read.contents;
    docs = await readDocs(repoRoot, headSha);
    const planned = groupBatches(read.files, options.maxFilesPerBatch ?? 8);
    const now = new Date().toISOString();
    state = {
      schema: 'review.full.v1',
      scanId: makeScanId(),
      repoRoot,
      headSha,
      mode,
      configHash: loaded.configHash,
      createdAt: now,
      updatedAt: now,
      status: 'running',
      files: read.files,
      skipped: read.skipped,
      batches: planned.map((batch) => ({
        id: batch.id,
        module: batch.module,
        files: batch.files,
        status: 'pending',
        findings: [],
        tokens: 0,
        costUsd: 0,
      })),
      totals: { tokens: 0, costUsd: 0, findings: 0 },
    };
  }

  const limitChars = Math.max(20_000, config.review.context_limits[mode] * 4 - 4_000);
  const pending = state.batches.filter((batch) => batch.status !== 'done');
  const promptInputs = new Map<string, { system: string; user: string; inputTokens: number }>();
  let estimatedInput = 0;
  let estimatedOutput = 0;
  let estimatedCost = 0;
  let priced = true;
  for (const batch of pending) {
    const user = buildFullUserPrompt(docs, batch, contents, limitChars);
    const inputTokens = estimateTokens(FULL_FINDER_SYSTEM_PROMPT) + estimateTokens(user);
    const outputTokens = Math.min(2_000, resolvedModel.model.max_output_tokens);
    estimatedInput += inputTokens;
    estimatedOutput += outputTokens;
    promptInputs.set(batch.id, { system: FULL_FINDER_SYSTEM_PROMPT, user, inputTokens });
    const price = getPricing(config, resolvedModel.model.name);
    if (!price) {
      priced = false;
      continue;
    }
    const cost = calculateCost(price, inputTokens, outputTokens);
    estimatedCost += cost.costUsd;
    if (!cost.priced) priced = false;
  }

  const budgetTokens =
    options.budgetTokens ??
    Math.max(10_000, Math.ceil((estimatedInput + estimatedOutput) * 2));
  const estimate: FullEstimate = {
    batches: state.batches.length,
    pendingBatches: pending.length,
    files: state.files.length,
    skipped: state.skipped.length,
    calls: pending.length,
    inputTokens: estimatedInput,
    outputTokens: estimatedOutput,
    costUsd: Number(estimatedCost.toFixed(6)),
    priced,
    budgetTokens,
    maxUsd: options.maxUsd ?? null,
  };

  log(
    `Full scan ${state.scanId}: ${state.files.length} file(s), ${state.skipped.length} skipped, ${pending.length}/${state.batches.length} batch(es) to run`,
  );
  log(
    `Estimate: ~${estimatedInput.toLocaleString()} input + ${estimatedOutput.toLocaleString()} output tokens; ${priced ? `$${estimate.costUsd.toFixed(4)}` : 'unpriced'}`,
  );

  if (options.maxUsd !== undefined && priced && estimate.costUsd > options.maxUsd) {
    throw new ReviewError(
      `Estimated cost $${estimate.costUsd.toFixed(2)} exceeds --max-usd ${options.maxUsd}.`,
      2,
    );
  }
  if (options.budgetTokens !== undefined && estimatedInput + estimatedOutput > options.budgetTokens) {
    throw new ReviewError(
      `Estimated tokens ${estimatedInput + estimatedOutput} exceed --budget ${options.budgetTokens}.`,
      2,
    );
  }
  if (options.dryRun) {
    return {
      scanId: state.scanId,
      status: 'planned',
      headSha,
      mode,
      estimated: estimate,
      actual: { tokens: 0, costUsd: 0, findings: 0, batchesFailed: 0 },
      statePath: statePathFor(repoRoot, state.scanId),
      reportPath: reportPathFor(repoRoot, state.scanId),
      findingsPath: findingsPathFor(repoRoot, state.scanId),
      findings: aggregateFindings(state),
      exitCode: 0,
    };
  }

  if (!options.yes && !(await confirmEstimate(estimate))) {
    throw new ReviewError('Full review cancelled.', 2);
  }

  await mkdir(stateDir(repoRoot, state.scanId), { recursive: true });
  await saveState(repoRoot, state);
  const ledger = await LedgerWriter.open(repoRoot, state.scanId);
  await ledger.append('full.scan.started', {
    head_sha: headSha,
    mode,
    batches: state.batches.length,
    files: state.files.length,
    estimate,
  });

  const budget = new BudgetTracker(budgetTokens);
  let budgetExceeded = false;
  let batchesFailed = 0;

  for (const batch of state.batches) {
    if (batch.status === 'done') continue;
    if (budgetExceeded) break;
    const prompt = promptInputs.get(batch.id);
    if (!prompt) {
      batch.status = 'failed';
      batch.error = 'prompt_not_built';
      batchesFailed += 1;
      await saveState(repoRoot, state);
      continue;
    }
    log(`[${batch.id}] ${batch.module}: reviewing ${batch.files.length} file(s)`);
    try {
      const reservation = budget.reserve(prompt.inputTokens + resolvedModel.model.max_output_tokens);
      const response = await client.complete({
        system: prompt.system,
        user: prompt.user,
        maxOutputTokens: resolvedModel.model.max_output_tokens,
        role: 'full_finder',
      });
      const inputTokens = response.inputTokens ?? prompt.inputTokens;
      const outputTokens = response.outputTokens ?? estimateTokens(response.text);
      const price = getPricing(config, resolvedModel.model.name);
      const cost = calculateCost(price, inputTokens, outputTokens);
      budget.settle(reservation, inputTokens, outputTokens, cost.costUsd, cost.priced);
      const raw = parseAiFindings(response.text);
      const batchContents: Record<string, string> = {};
      const batchFiles = batch.files.map((file) => {
        const content = contents.get(file.path) ?? '';
        batchContents[file.path] = content;
        const lines = content.split(/\r?\n/).length;
        return {
          path: file.path,
          status: 'M',
          additions: lines,
          deletions: 0,
          binary: false,
        };
      });
      const syntheticDiff: DiffInfo = {
        repoRoot,
        baseRef: 'full',
        headRef: 'HEAD',
        baseSha: headSha,
        headSha,
        mergeBase: headSha,
        patch: '',
        files: batchFiles,
        changedRanges: Object.fromEntries(
          batchFiles.map((file) => [file.path, [{ start: 1, end: file.additions }]]),
        ),
        totalAdditions: batchFiles.reduce((sum, file) => sum + file.additions, 0),
        totalDeletions: 0,
      };
      const grounded = await groundFindings(
        raw,
        syntheticDiff,
        batchContents,
        state.scanId,
        config.review.min_severity_to_report,
        response.model ?? resolvedModel.model.name,
        FULL_FINDER_PROMPT_VERSION,
      );
      batch.findings = grounded.findings;
      batch.tokens = inputTokens + outputTokens;
      batch.costUsd = cost.costUsd;
      batch.status = 'done';
      batch.error = undefined;
      await ledger.append('full.batch.completed', {
        batch_id: batch.id,
        module: batch.module,
        findings: batch.findings.length,
        tokens: batch.tokens,
        cost_usd: batch.costUsd,
      });
      log(`[${batch.id}] done: ${batch.findings.length} finding(s)`);
    } catch (error) {
      batch.status = 'failed';
      batch.error = error instanceof Error ? error.message : String(error);
      batchesFailed += 1;
      if (error instanceof BudgetExceededError) budgetExceeded = true;
      await ledger.append('full.batch.failed', {
        batch_id: batch.id,
        error: batch.error,
      });
      log(`[${batch.id}] failed: ${batch.error}`);
    }
    await saveState(repoRoot, state);
    // DeepSeek and other providers rate-limit bursts; keep full scans gentle.
    const batchDelayMs = Math.max(
      0,
      Number(process.env.REVIEW_FULL_BATCH_DELAY_MS ?? 500) || 0,
    );
    if (batchDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, batchDelayMs));
    }
  }

  const remaining = state.batches.filter((batch) => batch.status !== 'done').length;
  state.status = remaining === 0 ? 'completed' : 'incomplete';
  const findings = aggregateFindings(state);
  await saveState(repoRoot, state);
  await writeFile(
    findingsPathFor(repoRoot, state.scanId),
    `${JSON.stringify(findings, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    reportPathFor(repoRoot, state.scanId),
    renderFullReport(state, findings),
    'utf8',
  );
  await ledger.append('full.scan.completed', {
    status: state.status,
    batches_failed: batchesFailed,
    findings: findings.length,
    tokens: state.totals.tokens,
    cost_usd: state.totals.costUsd,
  });

  return {
    scanId: state.scanId,
    status: state.status,
    headSha,
    mode,
    estimated: estimate,
    actual: {
      tokens: state.totals.tokens,
      costUsd: state.totals.costUsd,
      findings: findings.length,
      batchesFailed,
    },
    statePath: statePathFor(repoRoot, state.scanId),
    reportPath: reportPathFor(repoRoot, state.scanId),
    findingsPath: findingsPathFor(repoRoot, state.scanId),
    findings,
    exitCode: remaining === 0 ? 0 : 4,
  };
}

function emptyEstimate(
  state: FullScanState,
  modelName: string,
  config: Awaited<ReturnType<typeof loadConfig>>['config'],
): FullEstimate {
  const price = getPricing(config, modelName);
  return {
    batches: state.batches.length,
    pendingBatches: 0,
    files: state.files.length,
    skipped: state.skipped.length,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: state.totals.costUsd,
    priced: Boolean(price),
    budgetTokens: 0,
    maxUsd: null,
  };
}
