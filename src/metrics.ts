import { readLedger } from './ledger.js';
import { collectOutcomes, type OutcomeSummary } from './outcomes.js';

export interface MetricsSummary {
  sinceDays: number;
  runs: number;
  findings: number;
  blockers: number;
  needsHuman: number;
  checksFailed: number;
  tokens: number;
  costUsd: number;
  overrides: number;
  rounds: number;
  byMode: Record<string, number>;
  byTier: Record<string, number>;
  outcomes: OutcomeSummary;
}

export async function collectMetrics(repoRoot: string, sinceDays = 30): Promise<MetricsSummary> {
  const events = await readLedger(repoRoot);
  const cutoff = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
  const recent = events.filter((event) => new Date(event.ts).getTime() >= cutoff);
  const summary: MetricsSummary = {
    sinceDays,
    runs: 0,
    findings: 0,
    blockers: 0,
    needsHuman: 0,
    checksFailed: 0,
    tokens: 0,
    costUsd: 0,
    overrides: 0,
    rounds: 0,
    byMode: {},
    byTier: {},
    outcomes: await collectOutcomes(repoRoot, sinceDays),
  };

  for (const event of recent) {
    if (event.type === 'run.completed') {
      summary.runs += 1;
      summary.findings += Number(event.payload.findings ?? 0);
      summary.blockers += Number(event.payload.blockers ?? 0);
      summary.needsHuman += Number(event.payload.needs_human ?? 0);
      summary.checksFailed += Number(event.payload.checks_failed ?? 0);
      summary.tokens += Number(event.payload.tokens ?? 0);
      summary.costUsd += Number(event.payload.cost_usd ?? 0);
      const mode = String(event.payload.mode ?? 'unknown');
      const tier = String(event.payload.tier ?? 'unknown');
      summary.byMode[mode] = (summary.byMode[mode] ?? 0) + 1;
      summary.byTier[tier] = (summary.byTier[tier] ?? 0) + 1;
    }
    if (
      event.type === 'policy.decided' &&
      Array.isArray(event.payload.reasons) &&
      event.payload.reasons.some((reason) => String(reason).startsWith('override_high:'))
    ) {
      summary.overrides += 1;
    }
    if (event.type === 'review.round') summary.rounds += 1;
  }
  summary.costUsd = Number(summary.costUsd.toFixed(6));
  return summary;
}

export function renderMetricsMarkdown(summary: MetricsSummary): string {
  return [
    `# Review metrics (last ${summary.sinceDays} days)`,
    '',
    '| Metric | Value |',
    '|---|---|',
    `| Runs | ${summary.runs} |`,
    `| Published findings | ${summary.findings} |`,
    `| Blockers | ${summary.blockers} |`,
    `| Needs human | ${summary.needsHuman} |`,
    `| Checks failed | ${summary.checksFailed} |`,
    `| Tokens | ${summary.tokens.toLocaleString()} |`,
    `| Cost | $${summary.costUsd.toFixed(4)} |`,
    `| Overrides | ${summary.overrides} |`,
    `| Rounds | ${summary.rounds} |`,
    `| Fixed / dismissed / accepted / ignored | ${summary.outcomes.byStatus.fixed} / ${summary.outcomes.byStatus.dismissed} / ${summary.outcomes.byStatus.accepted_risk} / ${summary.outcomes.byStatus.ignored} |`,
    `| Open findings | ${summary.outcomes.open} |`,
    `| Dismissed reasons (error/intentional/minor) | ${summary.outcomes.dismissedReasons.error} / ${summary.outcomes.dismissedReasons.intentional} / ${summary.outcomes.dismissedReasons.minor} |`,
    '',
    `By mode: ${Object.entries(summary.byMode).map(([key, value]) => `${key}=${value}`).join(', ') || '(none)'}`,
    `By tier: ${Object.entries(summary.byTier).map(([key, value]) => `${key}=${value}`).join(', ') || '(none)'}`,
  ].join('\n');
}
