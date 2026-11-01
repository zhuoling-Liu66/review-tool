import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ReviewError } from './errors.js';
import { runReview } from './pipeline.js';
import type { Finding, Mode } from './types.js';
import { CATEGORIES } from './types.js';

const expectedFindingSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
  category: z.enum(CATEGORIES),
  must_match: z.string().optional(),
});

const evalCaseSchema = z.object({
  case_id: z.string().min(1),
  base: z.string().min(1),
  head: z.string().min(1),
  mode: z.enum(['quick', 'standard', 'deep']).optional(),
  expected_findings: z.array(expectedFindingSchema),
  clean: z.boolean().optional(),
  notes: z.string().optional(),
});

export type EvalCase = z.infer<typeof evalCaseSchema>;

export interface EvalCaseResult {
  caseId: string;
  mode: Mode;
  expected: number;
  matched: number;
  reported: number;
  falsePositives: number;
  costUsd: number;
  tokens: number;
  status: string;
  findings: Array<{ file: string; line: number; category: string; claim: string; status: string }>;
}

export interface EvalSummary {
  evalId: string;
  cases: number;
  expected: number;
  matched: number;
  recall: number;
  cleanFalsePositives: number;
  unmatchedReported: number;
  costUsd: number;
  tokens: number;
  results: EvalCaseResult[];
  baseline: null | {
    recall: number;
    cleanFalsePositives: number;
    costUsd: number;
    regressions: string[];
  };
}

export interface EvalOptions {
  repoPath: string;
  casesDir?: string;
  mode?: Mode;
  updateBaseline?: boolean;
  writeResults?: boolean;
}

function normalize(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function matchesExpected(finding: Finding, expected: z.infer<typeof expectedFindingSchema>): boolean {
  if (normalize(finding.file) !== normalize(expected.file)) return false;
  if (Math.abs(finding.line - expected.line) > 10) return false;
  if (finding.category !== expected.category) return false;
  if (expected.must_match) {
    const haystack = `${finding.claim} ${finding.evidence}`.toLowerCase();
    if (!haystack.includes(expected.must_match.toLowerCase())) return false;
  }
  return true;
}

function countFalsePositives(actual: Finding[], expected: EvalCase['expected_findings']): {
  matched: number;
  falsePositives: number;
} {
  const used = new Set<number>();
  let matched = 0;
  for (const expectation of expected) {
    const index = actual.findIndex(
      (finding, findingIndex) => !used.has(findingIndex) && matchesExpected(finding, expectation),
    );
    if (index >= 0) {
      used.add(index);
      matched += 1;
    }
  }
  return { matched, falsePositives: actual.length - used.size };
}

export async function runEval(options: EvalOptions): Promise<EvalSummary> {
  const casesDir = options.casesDir ?? path.join(options.repoPath, '.review', 'eval', 'cases');
  let entries: string[];
  try {
    entries = await readdir(casesDir);
  } catch {
    throw new ReviewError(`Eval cases directory not found: ${casesDir}`, 2);
  }
  const caseFiles = entries.filter((entry) => entry.endsWith('.json')).sort();
  if (caseFiles.length === 0) {
    throw new ReviewError(`No eval cases found in ${casesDir}`, 2);
  }

  const evalId = `eval_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
  const results: EvalCaseResult[] = [];
  let expectedTotal = 0;
  let matchedTotal = 0;
  let cleanFalsePositives = 0;
  let unmatchedReported = 0;
  let costUsd = 0;
  let tokens = 0;

  for (const file of caseFiles) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path.join(casesDir, file), 'utf8'));
    } catch (error) {
      throw new ReviewError(`Invalid eval case ${file}: ${(error as Error).message}`, 2);
    }
    const validation = evalCaseSchema.safeParse(parsed);
    if (!validation.success) {
      throw new ReviewError(
        `Invalid eval case ${file}: ${validation.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
        2,
      );
    }
    const testCase = validation.data;
    const review = await runReview({
      repoPath: options.repoPath,
      baseRef: testCase.base,
      headRef: testCase.head,
      mode: testCase.mode ?? options.mode,
      evalMode: true,
      trigger: 'eval',
    });
    const manifest = JSON.parse(await readFile(review.manifestPath, 'utf8'));
    const actual = (manifest.findings as Finding[]).filter(
      (finding) => finding.status === 'reported' || finding.status === 'needs_human',
    );
    const comparison = countFalsePositives(actual, testCase.expected_findings);
    expectedTotal += testCase.expected_findings.length;
    matchedTotal += comparison.matched;
    if (testCase.clean) cleanFalsePositives += actual.length;
    else unmatchedReported += comparison.falsePositives;
    costUsd += manifest.budget.usedUsd;
    tokens += manifest.budget.usedTokens;
    results.push({
      caseId: testCase.case_id,
      mode: testCase.mode ?? options.mode ?? 'quick',
      expected: testCase.expected_findings.length,
      matched: comparison.matched,
      reported: actual.length,
      falsePositives: comparison.falsePositives,
      costUsd: manifest.budget.usedUsd,
      tokens: manifest.budget.usedTokens,
      status: review.status,
      findings: actual.map((finding) => ({
        file: finding.file,
        line: finding.line,
        category: finding.category,
        claim: finding.claim,
        status: finding.status,
      })),
    });
  }

  const recall = expectedTotal === 0 ? 1 : matchedTotal / expectedTotal;
  let baseline: EvalSummary['baseline'] = null;
  const baselinePath = path.join(options.repoPath, '.review', 'eval', 'baseline.json');
  let previous: {
    recall: number;
    cleanFalsePositives: number;
    costUsd: number;
  } | null = null;
  if (!options.updateBaseline) {
    try {
      const parsed = JSON.parse(await readFile(baselinePath, 'utf8')) as {
        recall?: number;
        cleanFalsePositives?: number;
        costUsd?: number;
      };
      if (typeof parsed.recall === 'number') {
        previous = {
          recall: parsed.recall,
          cleanFalsePositives: Number(parsed.cleanFalsePositives ?? 0),
          costUsd: Number(parsed.costUsd ?? 0),
        };
      }
    } catch {
      previous = null;
    }
  }

  if (previous) {
    const regressions: string[] = [];
    if (recall < previous.recall - 0.05) {
      regressions.push(
        `recall dropped from ${(previous.recall * 100).toFixed(1)}% to ${(recall * 100).toFixed(1)}%`,
      );
    }
    if (cleanFalsePositives > previous.cleanFalsePositives * 1.1) {
      regressions.push(
        `clean-set false positives rose from ${previous.cleanFalsePositives} to ${cleanFalsePositives}`,
      );
    }
    if (previous.costUsd > 0 && costUsd > previous.costUsd * 1.25) {
      regressions.push(
        `cost rose from $${previous.costUsd.toFixed(2)} to $${costUsd.toFixed(2)}`,
      );
    }
    baseline = { ...previous, regressions };
  }

  const summary: EvalSummary = {
    evalId,
    cases: results.length,
    expected: expectedTotal,
    matched: matchedTotal,
    recall,
    cleanFalsePositives,
    unmatchedReported,
    costUsd: Number(costUsd.toFixed(6)),
    tokens,
    results,
    baseline,
  };

  if (options.writeResults !== false) {
    const resultDir = path.join(options.repoPath, '.review', 'eval', 'results');
    await mkdir(resultDir, { recursive: true });
    await writeFile(
      path.join(resultDir, `${evalId}.json`),
      `${JSON.stringify(summary, null, 2)}\n`,
      'utf8',
    );
    await writeFile(
      path.join(resultDir, `${evalId}.md`),
      renderEvalMarkdown(summary),
      'utf8',
    );
  }
  if (options.updateBaseline) {
    await mkdir(path.dirname(baselinePath), { recursive: true });
    await writeFile(
      baselinePath,
      `${JSON.stringify(
        {
          recall,
          cleanFalsePositives,
          costUsd: summary.costUsd,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }

  return summary;
}

export function renderEvalMarkdown(summary: EvalSummary): string {
  const lines = [
    `# Eval ${summary.evalId}`,
    '',
    `- Cases: ${summary.cases}`,
    `- Recall: ${(summary.recall * 100).toFixed(1)}% (${summary.matched}/${summary.expected})`,
    `- Clean-set false positives: ${summary.cleanFalsePositives}`,
    `- Unmatched reported: ${summary.unmatchedReported}`,
    `- Cost: $${summary.costUsd.toFixed(4)}`,
    `- Tokens: ${summary.tokens.toLocaleString()}`,
    '',
    '| Case | Mode | Recall | Reported | False positives | Cost | Status |',
    '|---|---|---|---|---|---|---|',
    ...summary.results.map(
      (result) =>
        `| ${result.caseId} | ${result.mode} | ${result.matched}/${result.expected} | ${result.reported} | ${result.falsePositives} | $${result.costUsd.toFixed(4)} | ${result.status} |`,
    ),
  ];
  if (summary.baseline) {
    lines.push('', '## Baseline comparison');
    lines.push('');
    lines.push(
      `Previous recall: ${(summary.baseline.recall * 100).toFixed(1)}%; previous clean FP: ${summary.baseline.cleanFalsePositives}`,
    );
    if (summary.baseline.regressions.length === 0) lines.push('', 'No regression detected.');
    else {
      lines.push('', 'Regressions:');
      for (const regression of summary.baseline.regressions) lines.push(`- ${regression}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
