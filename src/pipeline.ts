import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import picomatch from 'picomatch';
import { findApproval } from './approval.js';
import { BudgetTracker } from './budget.js';
import { buildCacheKey, readCachedResponse, writeCachedResponse } from './cache.js';
import { hasBlockingFailure, runChecks } from './checks.js';
import { loadConfig, type ModelConfig, type ReviewConfig } from './config.js';
import { buildContext, buildQuickContext, type ContextBundle } from './context.js';
import { AiOutputError, BudgetExceededError } from './errors.js';
import { groundFindings, parseAiFindings, parseVerification } from './findings.js';
import type { RawFinding } from './findings.js';
import { getDiff, getRepoRoot, readFileAtCommit } from './git.js';
import { LedgerWriter } from './ledger.js';
import { getMonthlySpend } from './monthly-budget.js';
import { evaluatePolicy } from './policy.js';
import { getRoundState, recordRound } from './rounds.js';
import { runSecurityScans } from './security.js';
import {
  buildFinderSystemPrompt,
  FINDER_PROMPT_VERSION,
  QUICK_PROMPT_VERSION,
  QUICK_REPAIR_PROMPT,
  QUICK_REPAIR_PROMPT_VERSION,
  QUICK_VERIFIER_PROMPT_VERSION,
  QUICK_VERIFIER_SYSTEM_PROMPT,
} from './prompts.js';
import { createModelClient, getPricing, calculateCost, resolveModel } from './providers/index.js';
import type { ModelClient } from './providers/types.js';
import { renderMarkdownReport, renderTerminalSummary } from './report.js';
import type {
  AiRunInfo,
  ContextFileSummary,
  DiffInfo,
  Finding,
  Mode,
  ModelUsage,
  PolicyDecision,
  RunManifest,
  RunResult,
  RunStatus,
  VerificationStatus,
} from './types.js';
import { sha256Prefixed } from './util/hash.js';
import { detectInjectionSuspicion } from './util/injection.js';
import { redactSecrets } from './util/redact.js';
import { estimateTokens, truncateText } from './util/tokens.js';

export interface RunOptions {
  repoPath: string;
  baseRef: string;
  headRef?: string;
  configPath?: string;
  mode?: Mode;
  budgetTokens?: number;
  intent?: string;
  noAi?: boolean;
  checksOnly?: boolean;
  overrideHighReason?: string;
  requireApproval?: boolean;
  prNumber?: number;
  evalMode?: boolean;
  shadow?: boolean;
  trigger?: 'cli' | 'eval' | 'scan';
}

interface UsageAccumulator {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  priced: boolean;
  calls: number;
  cacheHits: number;
}

interface AgentCallResult {
  text: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  priced: boolean;
  cached: boolean;
}

interface AgentCallParams {
  repoRoot: string;
  role: string;
  client: ModelClient;
  model: ModelConfig;
  providerName: string;
  system: string;
  user: string;
  maxOutputTokens: number;
  budget: BudgetTracker;
  ledger: LedgerWriter;
  config: ReviewConfig;
  usage: UsageAccumulator;
  promptHash: string | null;
  contextHash: string | null;
}

async function callAgent(params: AgentCallParams): Promise<AgentCallResult> {
  const inputEstimate = estimateTokens(params.system) + estimateTokens(params.user);
  const cacheKey = buildCacheKey({
    provider: params.providerName,
    model: params.model.name,
    maxOutputTokens: params.maxOutputTokens,
    role: params.role,
    system: params.system,
    user: params.user,
  });

  if (params.config.cache.enabled) {
    const cached = await readCachedResponse(params.repoRoot, cacheKey);
    if (cached) {
      params.usage.cacheHits += 1;
      await params.ledger.append('agent.cached', {
        role: params.role,
        provider: params.providerName,
        model: cached.model,
        prompt_hash: params.promptHash,
        context_hash: params.contextHash,
        cache_key: cacheKey,
      });
      return {
        text: cached.text,
        model: cached.model,
        provider: cached.provider,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        priced: true,
        cached: true,
      };
    }
  }

  const reservation = params.budget.reserve(inputEstimate + params.maxOutputTokens);
  const startedAt = Date.now();
  try {
    const response = await params.client.complete({
      system: params.system,
      user: params.user,
      maxOutputTokens: params.maxOutputTokens,
      role: params.role,
    });
    const inputTokens = response.inputTokens ?? inputEstimate;
    const outputTokens = response.outputTokens ?? estimateTokens(response.text);
    const pricing = getPricing(params.config, params.model.name);
    const cost = calculateCost(pricing, inputTokens, outputTokens);
    params.budget.settle(
      reservation,
      inputTokens,
      outputTokens,
      cost.costUsd,
      cost.priced,
    );
    params.usage.inputTokens += inputTokens;
    params.usage.outputTokens += outputTokens;
    params.usage.costUsd += cost.costUsd;
    params.usage.calls += 1;
    if (!cost.priced) params.usage.priced = false;
    const modelName = response.model ?? params.model.name;
    if (params.config.cache.enabled) {
      await writeCachedResponse(params.repoRoot, cacheKey, {
        schema: 'review.cache.v1',
        text: response.text,
        model: modelName,
        provider: params.providerName,
        createdAt: new Date().toISOString(),
      });
    }
    await params.ledger.append('agent.invoked', {
      role: params.role,
      provider: params.providerName,
      model: modelName,
      prompt_hash: params.promptHash,
      context_hash: params.contextHash,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: cost.costUsd,
      priced: cost.priced,
      duration_ms: Date.now() - startedAt,
      status: 'completed',
      cached: false,
    });
    return {
      text: response.text,
      model: modelName,
      provider: params.providerName,
      inputTokens,
      outputTokens,
      costUsd: cost.costUsd,
      priced: cost.priced,
      cached: false,
    };
  } catch (error) {
    params.budget.settle(reservation, 0, 0, 0, true);
    await params.ledger.append('agent.failed', {
      role: params.role,
      provider: params.providerName,
      model: params.model.name,
      error: error instanceof Error ? error.message : String(error),
      duration_ms: Date.now() - startedAt,
    });
    throw error;
  }
}

function makeRunId(): string {
  const now = new Date();
  const stamp = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
    '_',
    String(now.getUTCHours()).padStart(2, '0'),
    String(now.getUTCMinutes()).padStart(2, '0'),
    String(now.getUTCSeconds()).padStart(2, '0'),
  ].join('');
  return `r_${stamp}_${randomBytes(3).toString('hex')}`;
}

function matchesAny(filePath: string, patterns: string[]): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return patterns.some((pattern) => picomatch(pattern, { dot: true })(normalized));
}

function emptyAi(): AiRunInfo {
  return {
    status: 'skipped',
    reason: null,
    model: null,
    provider: null,
    usage: null,
    promptHash: null,
    contextHash: null,
    cacheHits: 0,
  };
}

function usageSnapshot(usage: UsageAccumulator): ModelUsage | null {
  if (usage.calls === 0) return null;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: Number(usage.costUsd.toFixed(6)),
    priced: usage.priced,
  };
}

async function buildVerifierUser(
  diff: Awaited<ReturnType<typeof getDiff>>,
  finding: Finding,
  headContents: Record<string, string>,
): Promise<string> {
  const content = headContents[finding.file] ?? (await readFileAtCommit(diff.repoRoot, diff.headSha, finding.file));
  if (content === null) throw new Error(`Code unavailable for ${finding.file}`);
  const lines = content.split(/\r?\n/);
  const start = Math.max(1, finding.line - 12);
  const end = Math.min(lines.length, Math.max(finding.endLine, finding.line) + 12);
  const numbered = lines
    .slice(start - 1, end)
    .map((line, index) => `${start + index}: ${line}`)
    .join('\n');
  const findingData = {
    file: finding.file,
    line: finding.line,
    end_line: finding.endLine,
    severity: finding.severity,
    category: finding.category,
    claim: finding.claim,
    evidence: finding.evidence,
  };
  return [
    '## Finding to verify',
    '```json',
    JSON.stringify(findingData, null, 2),
    '```',
    '',
    `## Code at HEAD (${finding.file}, lines ${start}-${end})`,
    '```',
    redactSecrets(numbered),
    '```',
    '',
    'Try to refute the finding. Return JSON only:',
    '{"verdict":"confirm|reject|uncertain","reason":"...","confidence":0.0}',
  ].join('\n');
}

function toContextMeta(context: ContextBundle): NonNullable<RunManifest['context']> {
  const files: ContextFileSummary[] = context.files.map((file) => ({
    path: file.path,
    sha256: file.sha256,
    bytes: file.bytes,
    included: file.included,
    reason: file.reason,
  }));
  return {
    hash: context.contextHash,
    promptHash: context.promptHash,
    promptVersion: context.promptVersion,
    estimatedTokens: context.estimatedTokens,
    files,
    trimmed: context.trimmed,
  };
}

interface StandardAiParams {
  mode: Mode;
  diff: DiffInfo;
  config: ReviewConfig;
  intent?: string;
  runId: string;
  budget: BudgetTracker;
  ledger: LedgerWriter;
  usage: UsageAccumulator;
}

interface StandardAiResult {
  findings: Finding[];
  ai: AiRunInfo;
  context: RunManifest['context'];
}

async function runStandardAi(params: StandardAiParams): Promise<StandardAiResult | null> {
  const { mode, diff, config, intent, runId, budget, ledger, usage } = params;
  const deep = mode === 'deep';
  const quick = resolveModel(config, 'quick');
  const finderResolved =
    resolveModel(config, deep ? 'deep' : 'finder') ?? quick;
  if (!finderResolved) return null;
  const finderClient =
    createModelClient(config, deep ? 'deep' : 'finder', diff.repoRoot) ??
    (quick ? createModelClient(config, 'quick', diff.repoRoot) : null);
  if (!finderClient) return null;

  const perspectives =
    config.review.multi_agent === 'off'
      ? [config.review.finders[deep ? 'deep' : 'standard'][0] ?? 'correctness']
      : config.review.finders[deep ? 'deep' : 'standard'].length > 0
        ? config.review.finders[deep ? 'deep' : 'standard']
        : deep
          ? ['correctness', 'security', 'tests', 'api_contract']
          : ['correctness', 'security', 'tests'];
  const voteCount = config.review.multi_agent === 'off' ? 1 : 3;
  const contextLimit = deep
    ? config.review.context_limits.deep
    : config.review.context_limits.standard;

  const settled = await Promise.allSettled(
    perspectives.map(async (perspective) => {
      const context = await buildContext(diff, config, intent, {
        system: buildFinderSystemPrompt(perspective),
        promptVersion: FINDER_PROMPT_VERSION,
        limitTokens: contextLimit,
      });
      await ledger.append('context.built', {
        finder: perspective,
        context_hash: context.contextHash,
        prompt_hash: context.promptHash,
        prompt_version: context.promptVersion,
        estimated_tokens: context.estimatedTokens,
        files: context.files,
        trimmed: context.trimmed,
      });
      const finder = await callAgent({
        repoRoot: diff.repoRoot,
        role: `finder_${perspective}`,
        client: finderClient,
        model: finderResolved.model,
        providerName: finderResolved.providerName,
        system: context.system,
        user: context.user,
        maxOutputTokens: finderResolved.model.max_output_tokens,
        budget,
        ledger,
        config,
        usage,
        promptHash: context.promptHash,
        contextHash: context.contextHash,
      });
      let raw: RawFinding[];
      try {
        raw = parseAiFindings(finder.text);
      } catch (error) {
        if (error instanceof AiOutputError) {
          await ledger.append('agent.invalid_output', {
            role: `finder_${perspective}`,
            error: error.message,
          });
        }
        throw error;
      }
      return { perspective, context, raw, model: finder.model, provider: finder.provider };
    }),
  );

  const successes: Array<{
    perspective: string;
    context: ContextBundle;
    raw: RawFinding[];
    model: string;
    provider: string;
  }> = [];
  const failures: string[] = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      successes.push(result.value);
    } else {
      const reason =
        result.reason instanceof Error ? result.reason.message : String(result.reason);
      failures.push(`${perspectives[index] ?? 'unknown'}: ${reason}`);
    }
  });
  for (const failure of failures) {
    await ledger.append('finder.failed', { error: failure });
  }

  if (successes.length === 0) {
    return {
      findings: [],
      ai: {
        status: 'failed',
        reason: 'all_finders_failed',
        model: null,
        provider: null,
        usage: null,
        promptHash: null,
        contextHash: null,
        cacheHits: 0,
      },
      context: null,
    };
  }

  const first = successes[0]!;
  const rawAll = successes.flatMap((success) => success.raw);
  const sourceModels = [...new Set(successes.map((success) => success.model))].join(',');
  const grounded = await groundFindings(
    rawAll,
    diff,
    first.context.headContents,
    runId,
    config.review.min_severity_to_report,
    sourceModels,
    FINDER_PROMPT_VERSION,
  );
  const findings = grounded.findings;
  for (const finding of findings) {
    await ledger.append('finding.created', {
      id: finding.id,
      fingerprint: finding.fingerprint,
      file: finding.file,
      line: finding.line,
      end_line: finding.endLine,
      severity: finding.severity,
      category: finding.category,
      status: finding.status,
      confidence: finding.confidence,
      line_in_changed_range: finding.grounding.lineInChangedRange,
      verification: finding.verification,
    });
  }
  await ledger.append('grounding.completed', {
    candidates: rawAll.length,
    findings: findings.length,
    ungrounded: grounded.ungrounded,
    duplicates: grounded.duplicates,
    suppressed: findings.filter((finding) => finding.status === 'suppressed').length,
  });

  const verifierResolved = resolveModel(config, 'verifier') ?? finderResolved;
  const verifierClient =
    verifierResolved.role === finderResolved.role
      ? finderClient
      : (createModelClient(config, 'verifier', diff.repoRoot) ?? finderClient);

  const candidates = findings.filter((finding) => finding.status === 'reported');
  for (const finding of candidates) {
    let verifierUser: string;
    try {
      verifierUser = await buildVerifierUser(diff, finding, first.context.headContents);
    } catch (error) {
      finding.votes = { confirm: 0, reject: 0, uncertain: 0, unavailable: 3 };
      finding.verification = 'unavailable';
      finding.verificationReason =
        error instanceof Error ? error.message : 'verification_context_failed';
      finding.status = 'needs_human';
      await ledger.append('verification.failed', {
        finding_id: finding.id,
        error: finding.verificationReason,
      });
      continue;
    }

    const voteResults = await Promise.all(
      Array.from({ length: voteCount }, async (_, index) => {
        try {
          const verified = await callAgent({
            repoRoot: diff.repoRoot,
            role: `verifier_${index + 1}`,
            client: verifierClient,
            model: verifierResolved.model,
            providerName: verifierResolved.providerName,
            system: QUICK_VERIFIER_SYSTEM_PROMPT,
            user: verifierUser,
            maxOutputTokens: verifierResolved.model.max_output_tokens,
            budget,
            ledger,
            config,
            usage,
            promptHash: sha256Prefixed(
              `${QUICK_VERIFIER_PROMPT_VERSION}\n${QUICK_VERIFIER_SYSTEM_PROMPT}`,
            ),
            contextHash: null,
          });
          return {
            ok: true as const,
            verdict: parseVerification(verified.text),
            provider: verified.provider,
            model: verified.model,
          };
        } catch (error) {
          return {
            ok: false as const,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );

    const confirm = voteResults.filter(
      (result) => result.ok && result.verdict.verdict === 'confirm',
    ).length;
    const reject = voteResults.filter(
      (result) => result.ok && result.verdict.verdict === 'reject',
    ).length;
    const uncertain = voteResults.filter(
      (result) => result.ok && result.verdict.verdict === 'uncertain',
    ).length;
    const unavailable = voteResults.filter((result) => !result.ok).length;
    finding.votes = { confirm, reject, uncertain, unavailable };

    if (voteCount === 1) {
      if (confirm === 1) {
        finding.verification = 'confirmed';
        finding.status = 'reported';
      } else if (reject === 1) {
        finding.verification = 'rejected';
        finding.status = 'rejected';
      } else {
        finding.verification = unavailable === 1 ? 'unavailable' : 'uncertain';
        finding.status = 'needs_human';
      }
    } else if (confirm >= 2) {
      finding.verification = 'confirmed';
      finding.status = 'reported';
    } else if (reject >= 2) {
      finding.verification = 'rejected';
      finding.status = 'rejected';
    } else {
      finding.verification = unavailable === 3 ? 'unavailable' : 'uncertain';
      finding.status = 'needs_human';
    }

    const reasons = voteResults
      .filter((result) => result.ok)
      .map((result) => (result.ok ? result.verdict.reason : ''))
      .filter(Boolean);
    const verifiedBy = [
      ...new Set(
        voteResults
          .filter((result) => result.ok)
          .map((result) => (result.ok ? `${result.provider}/${result.model}` : '')),
      ),
    ].filter(Boolean);
    finding.verificationReason =
      reasons.join(' | ') ||
      (unavailable === 3 ? 'All verifier calls failed' : 'No majority verdict');
    finding.verifiedBy = verifiedBy.join(',') || null;

    await ledger.append('finding.verified', {
      finding_id: finding.id,
      verdict: finding.verification,
      votes: finding.votes,
      reason: finding.verificationReason,
      providers: verifiedBy,
    });
  }
  if (candidates.length > 0) {
    await ledger.append('verification.completed', {
      candidates: candidates.length,
      confirmed: findings.filter((finding) => finding.verification === 'confirmed').length,
      rejected: findings.filter((finding) => finding.verification === 'rejected').length,
      uncertain: findings.filter((finding) => finding.verification === 'uncertain').length,
      unavailable: findings.filter((finding) => finding.verification === 'unavailable').length,
    });
  }

  return {
    findings,
    ai: {
      status: 'completed',
      reason: failures.length > 0 ? `partial_finders:${failures.length}` : null,
      model: sourceModels,
      provider: [...new Set(successes.map((success) => success.provider))].join(','),
      usage: null,
      promptHash: first.context.promptHash,
      contextHash: first.context.contextHash,
      cacheHits: 0,
    },
    context: toContextMeta(first.context),
  };
}

export async function runReview(options: RunOptions): Promise<RunResult> {
  const startedAt = new Date().toISOString();
  const repoRoot = await getRepoRoot(options.repoPath);
  const loaded = await loadConfig(repoRoot, options.configPath);
  const config = options.evalMode
    ? { ...loaded.config, cache: { ...loaded.config.cache, enabled: false } }
    : loaded.config;
  const { configPath, configHash } = loaded;
  const trigger = options.trigger ?? 'cli';
  const shadow = options.shadow === true;
  const headRef = options.headRef ?? 'HEAD';
  const mode = options.mode ?? 'quick';

  const diff = await getDiff(repoRoot, options.baseRef, headRef);
  const injectionSuspicions = detectInjectionSuspicion(diff.patch);
  const runId = makeRunId();
  const artifactDir = path.join(repoRoot, '.review', 'artifacts', runId);
  const manifestPath = path.join(artifactDir, 'manifest.json');
  const reportPath = path.join(artifactDir, 'report.md');
  const findingsPath = path.join(artifactDir, 'findings.json');
  await mkdir(artifactDir, { recursive: true });

  const ledger = await LedgerWriter.open(repoRoot, runId);
  await ledger.append('run.started', {
    repo: repoRoot,
    base_ref: diff.baseRef,
    head_ref: diff.headRef,
    base_sha: diff.baseSha,
    head_sha: diff.headSha,
    merge_base: diff.mergeBase,
    patch_sha256: sha256Prefixed(diff.patch),
    config_hash: configHash,
    config_path: configPath,
    mode,
    trigger,
    shadow,
    pr_number: options.prNumber ?? null,
    injection_suspicions: injectionSuspicions,
  });
  const roundState =
    options.prNumber !== undefined && !options.evalMode && !shadow
      ? await getRoundState(repoRoot, options.prNumber)
      : { count: 0, lastHead: null };
  const roundLimitReached =
    options.prNumber !== undefined &&
    !options.evalMode &&
    !shadow &&
    roundState.count >= config.rounds.max;
  if (roundLimitReached) {
    await ledger.append('rounds.limited', {
      pr_number: options.prNumber,
      rounds: roundState.count,
      max: config.rounds.max,
    });
  }
  if (injectionSuspicions.length > 0) {
    await ledger.append('injection_suspected', {
      signals: injectionSuspicions,
    });
  }

  const configuredChecks = await runChecks(repoRoot, config, diff.files, artifactDir);
  const securityChecks = await runSecurityScans(repoRoot, config, artifactDir);
  const checks = [...configuredChecks, ...securityChecks];
  for (const check of checks) {
    await ledger.append('check.completed', {
      name: check.name,
      status: check.status,
      blocking: check.blocking,
      exit_code: check.exitCode,
      duration_ms: check.durationMs,
      timed_out: check.timedOut,
      log: check.logPath ? path.relative(repoRoot, check.logPath) : null,
      summary: check.summary,
    });
  }

  const policy: PolicyDecision = evaluatePolicy(diff, config, {
    mode,
    budgetTokens: options.budgetTokens,
    overrideHighReason: options.overrideHighReason,
  });
  const monthly = await getMonthlySpend(repoRoot);
  const monthlyLimit = config.budget.monthly_usd;
  const monthlyWarning =
    !options.evalMode && !shadow && monthlyLimit > 0 && monthly.spentUsd >= monthlyLimit * 0.8;
  const monthlyBlocked =
    !options.evalMode &&
    !shadow &&
    monthlyLimit > 0 &&
    config.budget.monthly_hard_stop &&
    monthly.spentUsd >= monthlyLimit;
  if (monthlyWarning) {
    await ledger.append('budget.monthly_warning', {
      period: monthly.period,
      spent_usd: monthly.spentUsd,
      limit_usd: monthlyLimit,
    });
  }
  if (monthlyBlocked) {
    await ledger.append('budget.monthly_exceeded', {
      period: monthly.period,
      spent_usd: monthly.spentUsd,
      limit_usd: monthlyLimit,
    });
  }
  await ledger.append('policy.decided', {
    tier: policy.tier,
    mode: policy.mode,
    reasons: policy.reasons,
    sensitive_hits: policy.sensitiveHits,
    requires_human: policy.requiresHuman,
    budget_tokens: policy.budgetTokens,
  });

  const budget = new BudgetTracker(policy.budgetTokens, null, config.budget.warn_at);
  const usage: UsageAccumulator = {
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    priced: true,
    calls: 0,
    cacheHits: 0,
  };
  const ai = emptyAi();
  let findings: Finding[] = [];
  let contextMeta: RunManifest['context'] = null;
  let aiExpected = false;
  const checksFailed = hasBlockingFailure(checks);

  const reviewableFiles = diff.files.filter(
    (file) =>
      file.status !== 'D' &&
      !file.binary &&
      !matchesAny(file.path, config.review.skip_paths),
  );

  if (checksFailed) {
    ai.reason = 'checks_failed';
  } else if (options.checksOnly) {
    ai.reason = 'checks_only';
  } else if (diff.files.length === 0) {
    ai.reason = 'no_changes';
  } else if (roundLimitReached) {
    ai.reason = 'round_limit_reached';
  } else if (reviewableFiles.length === 0) {
    ai.reason = 'no_reviewable_files';
  } else {
    aiExpected = true;
    if (monthlyBlocked) {
      ai.reason = 'monthly_budget_exceeded';
    } else if (options.noAi) {
      ai.reason = 'ai_disabled';
    } else if (mode === 'standard' || mode === 'deep') {
      try {
        const standard = await runStandardAi({
          mode,
          diff,
          config,
          intent: options.intent,
          runId,
          budget,
          ledger,
          usage,
        });
        if (!standard) {
          ai.reason = 'no_finder_model';
        } else {
          findings = standard.findings;
          contextMeta = standard.context;
          Object.assign(ai, standard.ai);
        }
      } catch (error) {
        ai.status = 'failed';
        ai.reason = error instanceof Error ? error.message : 'standard_pipeline_failed';
        await ledger.append('agent.failed', {
          role: 'standard_pipeline',
          error: ai.reason,
        });
      }
    } else {
      const resolved = resolveModel(config, 'quick');
      if (!resolved) {
        ai.reason = 'no_quick_model';
      } else {
        const client = createModelClient(config, 'quick', repoRoot);
        if (!client) {
          ai.reason = 'no_quick_model';
        } else {
          try {
            const context = await buildQuickContext(diff, config, options.intent);
            const contextFiles: ContextFileSummary[] = context.files.map((file) => ({
              path: file.path,
              sha256: file.sha256,
              bytes: file.bytes,
              included: file.included,
              reason: file.reason,
            }));
            contextMeta = {
              hash: context.contextHash,
              promptHash: context.promptHash,
              promptVersion: context.promptVersion,
              estimatedTokens: context.estimatedTokens,
              files: contextFiles,
              trimmed: context.trimmed,
            };
            await ledger.append('context.built', {
              context_hash: context.contextHash,
              prompt_hash: context.promptHash,
              prompt_version: context.promptVersion,
              estimated_tokens: context.estimatedTokens,
              files: contextFiles,
              trimmed: context.trimmed,
            });

            const finder = await callAgent({
              repoRoot,
              role: 'quick',
              client,
              model: resolved.model,
              providerName: resolved.providerName,
              system: context.system,
              user: context.user,
              maxOutputTokens: resolved.model.max_output_tokens,
              budget,
              ledger,
              config,
              usage,
              promptHash: context.promptHash,
              contextHash: context.contextHash,
            });
            ai.model = finder.model;
            ai.provider = finder.provider;
            ai.promptHash = context.promptHash;
            ai.contextHash = context.contextHash;

            let raw: RawFinding[] | null = null;
            try {
              raw = parseAiFindings(finder.text);
            } catch (error) {
              if (!(error instanceof AiOutputError)) throw error;
              await ledger.append('agent.invalid_output', {
                role: 'quick',
                error: error.message,
              });
              const repairUser = [
                QUICK_REPAIR_PROMPT,
                '',
                'Previous response (truncated):',
                truncateText(finder.text, 12_000),
                '',
                `Schema error: ${error.message}`,
              ].join('\n');
              const repaired = await callAgent({
                repoRoot,
                role: 'quick_repair',
                client,
                model: resolved.model,
                providerName: resolved.providerName,
                system: context.system,
                user: repairUser,
                maxOutputTokens: resolved.model.max_output_tokens,
                budget,
                ledger,
                config,
                usage,
                promptHash: sha256Prefixed(`${QUICK_REPAIR_PROMPT_VERSION}\n${QUICK_REPAIR_PROMPT}`),
                contextHash: context.contextHash,
              });
              raw = parseAiFindings(repaired.text);
              await ledger.append('agent.repaired', {
                role: 'quick',
                repaired_by: 'quick_repair',
              });
            }
            if (!raw) throw new AiOutputError('Agent returned no findings payload.');

            ai.status = 'completed';
            ai.reason = null;

            const grounded = await groundFindings(
              raw,
              diff,
              context.headContents,
              runId,
              config.review.min_severity_to_report,
              finder.model,
              QUICK_PROMPT_VERSION,
            );
            findings = grounded.findings;
            for (const finding of findings) {
              await ledger.append('finding.created', {
                id: finding.id,
                fingerprint: finding.fingerprint,
                file: finding.file,
                line: finding.line,
                end_line: finding.endLine,
                severity: finding.severity,
                category: finding.category,
                status: finding.status,
                confidence: finding.confidence,
                line_in_changed_range: finding.grounding.lineInChangedRange,
                verification: finding.verification,
              });
            }
            await ledger.append('grounding.completed', {
              candidates: raw.length,
              findings: findings.length,
              ungrounded: grounded.ungrounded,
              duplicates: grounded.duplicates,
              suppressed: findings.filter((finding) => finding.status === 'suppressed').length,
            });

            const verifierCandidates = findings.filter(
              (finding) =>
                finding.status === 'reported' &&
                (finding.severity === 'blocker' || finding.category === 'security'),
            );
            if (verifierCandidates.length > 0) {
              const verifierResolved = resolveModel(config, 'verifier') ?? resolved;
              const verifierClient =
                verifierResolved === resolved
                  ? client
                  : (createModelClient(config, 'verifier', repoRoot) ?? client);

              for (const finding of verifierCandidates) {
                try {
                  const verifierUser = await buildVerifierUser(
                    diff,
                    finding,
                    context.headContents,
                  );
                  const verified = await callAgent({
                    repoRoot,
                    role: 'quick_verifier',
                    client: verifierClient,
                    model: verifierResolved.model,
                    providerName: verifierResolved.providerName,
                    system: QUICK_VERIFIER_SYSTEM_PROMPT,
                    user: verifierUser,
                    maxOutputTokens: verifierResolved.model.max_output_tokens,
                    budget,
                    ledger,
                    config,
                    usage,
                    promptHash: sha256Prefixed(
                      `${QUICK_VERIFIER_PROMPT_VERSION}\n${QUICK_VERIFIER_SYSTEM_PROMPT}`,
                    ),
                    contextHash: null,
                  });
                  const verdict = parseVerification(verified.text);
                  finding.votes = {
                    confirm: verdict.verdict === 'confirm' ? 1 : 0,
                    reject: verdict.verdict === 'reject' ? 1 : 0,
                    uncertain: verdict.verdict === 'uncertain' ? 1 : 0,
                    unavailable: 0,
                  };
                  finding.verification =
                    verdict.verdict === 'confirm'
                      ? 'confirmed'
                      : verdict.verdict === 'reject'
                        ? 'rejected'
                        : 'uncertain';
                  finding.verificationReason = verdict.reason;
                  finding.verifiedBy = `${verified.provider}/${verified.model}`;
                  finding.status =
                    verdict.verdict === 'reject'
                      ? 'rejected'
                      : verdict.verdict === 'uncertain'
                        ? 'needs_human'
                        : 'reported';
                  await ledger.append('finding.verified', {
                    finding_id: finding.id,
                    verdict: verdict.verdict,
                    reason: verdict.reason,
                    confidence: verdict.confidence ?? null,
                    provider: verified.provider,
                    model: verified.model,
                  });
                } catch (error) {
                  finding.verification = 'unavailable';
                  finding.votes = { confirm: 0, reject: 0, uncertain: 0, unavailable: 1 };
                  finding.verificationReason =
                    error instanceof Error ? error.message : 'verification_failed';
                  finding.status = 'needs_human';
                  await ledger.append('verification.failed', {
                    finding_id: finding.id,
                    error: finding.verificationReason,
                  });
                }
              }
              await ledger.append('verification.completed', {
                candidates: verifierCandidates.length,
                confirmed: findings.filter((finding) => finding.verification === 'confirmed').length,
                rejected: findings.filter((finding) => finding.verification === 'rejected').length,
                uncertain: findings.filter((finding) => finding.verification === 'uncertain').length,
                unavailable: findings.filter((finding) => finding.verification === 'unavailable').length,
              });
            }
          } catch (error) {
            ai.status = 'failed';
            ai.reason =
              error instanceof BudgetExceededError
                ? 'budget_exceeded'
                : error instanceof AiOutputError
                  ? `invalid_output: ${error.message}`
                  : error instanceof Error
                    ? error.message
                    : 'agent_failed';
            await ledger.append('agent.failed', {
              role: 'quick_pipeline',
              provider: resolved.providerName,
              model: resolved.model.name,
              error: ai.reason,
            });
          }
        }
      }
    }
  }

  if (aiExpected && ai.status !== 'completed') {
    ai.status = ai.status === 'failed' ? 'failed' : 'skipped';
    if (!ai.reason) ai.reason = 'ai_incomplete';
  }
  ai.usage = usageSnapshot(usage);
  ai.cacheHits = usage.cacheHits;

  if (
    options.prNumber !== undefined &&
    !options.evalMode &&
    !shadow &&
    aiExpected &&
    !roundLimitReached &&
    ai.status === 'completed'
  ) {
    await recordRound(
      ledger,
      options.prNumber,
      roundState.count + 1,
      diff.headSha,
    );
  }

  const reportedFindings = findings.filter((finding) => finding.status === 'reported');
  const needsHumanFindings = findings.filter((finding) => finding.status === 'needs_human');
  const rejectedFindings = findings.filter((finding) => finding.status === 'rejected');
  const blockerCount = reportedFindings.filter(
    (finding) => finding.severity === 'blocker',
  ).length;
  const needsHumanCount = needsHumanFindings.length;
  const noReviewableApproval =
    !options.checksOnly &&
    reviewableFiles.length === 0 &&
    diff.files.length > 0 &&
    policy.tier !== 'low';
  const approvalRequired =
    !options.checksOnly &&
    !options.evalMode &&
    !shadow &&
    (policy.requiresHuman ||
      noReviewableApproval ||
      (policy.tier !== 'high' &&
        (options.requireApproval === true || config.approval.require_low_medium)));
  const allowedApprovalTypes =
    policy.tier === 'high'
      ? (['external', 'solo_override'] as const)
      : (['self', 'external', 'solo_override'] as const);
  const approval = approvalRequired
    ? await findApproval(
        repoRoot,
        sha256Prefixed(diff.patch),
        diff.headSha,
        [...allowedApprovalTypes],
      )
    : null;
  const approvalSatisfied = !approvalRequired || approval !== null;
  const requiresHuman =
    !approvalSatisfied || needsHumanCount > 0 || roundLimitReached;

  let status: RunStatus = 'completed';
  let exitCode = 0;

  if (checksFailed) {
    status = 'failed';
    exitCode = 1;
  } else if (blockerCount > 0) {
    status = 'failed';
    exitCode = 1;
  } else if (options.checksOnly) {
    status = 'completed';
    exitCode = 0;
  } else if (aiExpected && ai.status !== 'completed') {
    status = 'incomplete';
    exitCode = 4;
  } else if (needsHumanCount > 0) {
    status = 'awaiting_approval';
    exitCode = 3;
  } else if (roundLimitReached) {
    status = 'awaiting_approval';
    exitCode = 3;
  } else if (approvalRequired && !approvalSatisfied) {
    status = 'awaiting_approval';
    exitCode = 3;
  } else if (policy.requiresHuman && !approvalSatisfied) {
    status = 'awaiting_approval';
    exitCode = 3;
  }
  if (shadow) {
    status = 'completed';
    exitCode = 0;
  }

  const endedAt = new Date().toISOString();
  const budgetSnapshot = budget.snapshot();
  const budgetWarning = budget.isWarningTriggered();
  const multiAgent = (mode === 'standard' || mode === 'deep') && config.review.multi_agent !== 'off';
  if (budgetWarning) {
    await ledger.append('budget.warning', {
      used_tokens: budgetSnapshot.usedTokens,
      limit_tokens: budgetSnapshot.limitTokens,
      warn_at: config.budget.warn_at,
    });
  }
  const manifest: RunManifest = {
    runId,
    repoRoot,
    trigger,
    shadow,
    git: {
      baseRef: diff.baseRef,
      headRef: diff.headRef,
      baseSha: diff.baseSha,
      headSha: diff.headSha,
      mergeBase: diff.mergeBase,
      patchSha256: sha256Prefixed(diff.patch),
    },
    configPath,
    configHash,
    tier: policy.tier,
    mode: policy.mode,
    multiAgent,
    policy,
    checks,
    ai,
    findings,
    budget: {
      limitTokens: budgetSnapshot.limitTokens,
      usedTokens: budgetSnapshot.usedTokens,
      remainingTokens: budgetSnapshot.remainingTokens,
      usedUsd: budgetSnapshot.usedUsd,
      priced: budgetSnapshot.priced,
      warning: budgetWarning,
      monthlyPeriod: monthly.period,
      monthlyLimitUsd: monthlyLimit,
      monthlySpentUsd: monthly.spentUsd,
      monthlyWarning,
      monthlyBlocked,
    },
    context: contextMeta,
    security: { injectionSuspicions },
    approval: {
      required: approvalRequired,
      satisfied: approvalSatisfied,
      approver: approval?.approver ?? null,
      approverType: approval?.approverType ?? null,
      cooldownSatisfied: approval ? true : !approvalRequired,
    },
    rounds: {
      prNumber: options.prNumber ?? null,
      number:
        options.prNumber === undefined
          ? 0
          : roundLimitReached
            ? roundState.count
            : roundState.count +
              (aiExpected && ai.status === 'completed' ? 1 : 0),
      max: config.rounds.max,
      limited: roundLimitReached,
    },
    status,
    exitCode,
    startedAt,
    endedAt,
    artifactDir,
    reportPath,
  };

  const report = renderMarkdownReport(manifest);
  await writeFile(reportPath, report, 'utf8');
  await writeFile(findingsPath, `${JSON.stringify(findings, null, 2)}\n`, 'utf8');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  await ledger.append('run.completed', {
    status,
    exit_code: exitCode,
    tier: policy.tier,
    mode: policy.mode,
    tier_reasons: policy.reasons,
    requires_human: requiresHuman,
    approval_required: approvalRequired,
    approval_satisfied: approvalSatisfied,
    approver: approval?.approver ?? null,
    approver_type: approval?.approverType ?? null,
    findings: reportedFindings.length,
    blockers: blockerCount,
    needs_human: needsHumanCount,
    rejected: rejectedFindings.length,
    suppressed: findings.filter((finding) => finding.status === 'suppressed').length,
    checks_failed: checks.filter(
      (check) => check.status === 'fail' || check.status === 'error',
    ).length,
    ai_status: ai.status,
    ai_reason: ai.reason,
    cost_usd: budgetSnapshot.usedUsd,
    priced: budgetSnapshot.priced,
    tokens: budgetSnapshot.usedTokens,
    report: path.relative(repoRoot, reportPath),
    manifest: path.relative(repoRoot, manifestPath),
  });

  const result: RunResult = {
    runId,
    status,
    exitCode,
    tier: policy.tier,
    mode: policy.mode,
    requiresHuman,
    findingCount: reportedFindings.length,
    blockerCount,
    needsHumanCount,
    checksFailed: checks.filter(
      (check) => check.status === 'fail' || check.status === 'error',
    ).length,
    reportPath,
    manifestPath,
    artifactDir,
    terminalSummary: renderTerminalSummary(manifest),
  };

  return result;
}
