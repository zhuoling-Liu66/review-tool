import picomatch from 'picomatch';
import { ConfigError } from './errors.js';
import type { ReviewConfig } from './config.js';
import type { DiffInfo, Mode, PolicyDecision, Tier } from './types.js';

const TEST_PATH_PATTERNS = ['tests/**', '**/*.test.*', '**/*.spec.*', '**/__tests__/**'];
const DOC_TEST_PATH_PATTERNS = ['docs/**', '**/*.md', ...TEST_PATH_PATTERNS];

function normalize(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function matchesAny(filePath: string, patterns: string[]): boolean {
  const normalized = normalize(filePath);
  return patterns.some((pattern) => picomatch(pattern, { dot: true })(normalized));
}

function isTestPath(filePath: string): boolean {
  return matchesAny(filePath, TEST_PATH_PATTERNS);
}

export interface PolicyOptions {
  mode?: Mode;
  budgetTokens?: number;
  overrideHighReason?: string;
}

export function evaluatePolicy(
  diff: DiffInfo,
  config: ReviewConfig,
  options: PolicyOptions = {},
): PolicyDecision {
  const mode = options.mode ?? 'quick';
  if (mode !== 'quick' && mode !== 'standard' && mode !== 'deep') {
    throw new ConfigError(`Mode "${mode}" is not supported. Use quick, standard, or deep.`);
  }

  const reasons: string[] = [];
  const sensitiveHits: string[] = [];
  const files = diff.files;

  if (files.length === 0) {
    reasons.push('no_changes');
    return {
      tier: 'low',
      mode,
      reasons,
      sensitiveHits,
      requiresHuman: false,
      budgetTokens: resolveBudget(config, mode, options.budgetTokens, reasons),
    };
  }

  for (const file of files) {
    if (matchesAny(file.path, config.tiers.high.paths)) {
      sensitiveHits.push(file.path);
    }
  }

  const dependencyHits = files.filter((file) =>
    matchesAny(file.path, config.tiers.dependencies.paths),
  );
  const deletedTests = files.filter((file) => file.status === 'D' && isTestPath(file.path));
  const lowOnly = files.every((file) => matchesAny(file.path, config.tiers.low.paths));

  let tier: Tier = 'medium';
  if (sensitiveHits.length > 0) {
    tier = 'high';
    reasons.push(`high_path:${sensitiveHits.slice(0, 3).join(',')}`);
  } else if (dependencyHits.length > 0) {
    tier = config.tiers.dependencies.min_tier;
    reasons.push(`dependency_change:${dependencyHits.slice(0, 3).map((file) => file.path).join(',')}`);
  } else if (deletedTests.length > 0) {
    tier = 'medium';
    reasons.push(`test_deleted:${deletedTests.slice(0, 3).map((file) => file.path).join(',')}`);
  } else if (lowOnly) {
    tier = 'low';
    reasons.push('low_risk_paths');
  } else {
    reasons.push('default_medium');
  }

  const changedLines = files.reduce((sum, file) => {
    if (matchesAny(file.path, config.tiers.diff_size.exclude)) return sum;
    return sum + file.additions + file.deletions;
  }, 0);

  if (changedLines > config.tiers.diff_size.warn) {
    reasons.push(`large_diff:${changedLines}`);
    const docsOrTestsOnly = files.every((file) =>
      matchesAny(file.path, DOC_TEST_PATH_PATTERNS),
    );
    if (!docsOrTestsOnly && tier === 'low' && changedLines > config.tiers.diff_size.medium_at) {
      tier = 'medium';
      reasons.push('large_diff_medium');
    }
    if (tier !== 'high' && changedLines > config.tiers.diff_size.high_at) {
      reasons.push('large_diff_high_hint');
    }
  }

  const [finalTier, requiresHuman] =
    tier === 'high' && options.overrideHighReason
      ? (['medium', false] as const)
      : ([tier, tier === 'high'] as const);
  if (tier === 'high' && options.overrideHighReason) {
    reasons.push(`override_high:${options.overrideHighReason}`);
  }

  return {
    tier: finalTier,
    mode,
    reasons,
    sensitiveHits,
    requiresHuman,
    budgetTokens: resolveBudget(config, mode, options.budgetTokens, reasons),
  };
}

function resolveBudget(
  config: ReviewConfig,
  mode: Mode,
  override: number | undefined,
  reasons: string[],
): number {
  const configured = config.budget.per_run_tokens[mode] ?? 50_000;
  const requested = override ?? configured;
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new ConfigError('Token budget must be a positive number.');
  }
  const hardMax = config.budget.hard_max_tokens;
  if (requested > hardMax) {
    reasons.push(`budget_clamped:${hardMax}`);
    return hardMax;
  }
  return Math.floor(requested);
}
