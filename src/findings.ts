import { z } from 'zod';
import { AiOutputError } from './errors.js';
import { readFileAtCommit } from './git.js';
import type { Category, DiffInfo, Finding, Severity } from './types.js';
import { CATEGORIES, SEVERITIES } from './types.js';
import { sha256Prefixed, stableStringify } from './util/hash.js';

export const rawFindingSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
  end_line: z.number().int().positive().optional(),
  severity: z.enum(SEVERITIES),
  category: z.enum(CATEGORIES),
  claim: z.string().min(1).max(2_000),
  evidence: z.string().min(1).max(8_000),
  suggestion: z.string().max(4_000).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export const aiResponseSchema = z.object({
  findings: z.array(rawFindingSchema).max(20),
});

export const verificationSchema = z.object({
  verdict: z.enum(['confirm', 'reject', 'uncertain']),
  reason: z.string().min(1).max(2_000),
  confidence: z.number().min(0).max(1).optional(),
});

export type RawFinding = z.infer<typeof rawFindingSchema>;
export type VerificationResult = z.infer<typeof verificationSchema>;

export interface GroundingResult {
  findings: Finding[];
  ungrounded: number;
  duplicates: number;
  invalid: number;
}

const SEVERITY_RANK: Record<Severity, number> = {
  nit: 0,
  minor: 1,
  important: 2,
  blocker: 3,
};

export function isAtLeastSeverity(severity: Severity, minimum: Severity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[minimum];
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new AiOutputError('Agent response did not contain a JSON object.');
  }
  try {
    return JSON.parse(unfenced.slice(start, end + 1));
  } catch (error) {
    throw new AiOutputError(`Agent response was not valid JSON: ${(error as Error).message}`);
  }
}

export function parseAiFindings(text: string): RawFinding[] {
  const parsed = extractJsonObject(text);
  const normalized = normalizeAiPayload(parsed);
  const result = aiResponseSchema.safeParse(normalized);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new AiOutputError(`Agent response did not match the findings schema: ${issues}`);
  }
  return result.data.findings;
}

const CATEGORY_ALIASES: Record<string, Category> = {
  bug: 'correctness',
  logic: 'correctness',
  correctness: 'correctness',
  security: 'security',
  auth: 'security',
  authentication: 'security',
  vulnerability: 'security',
  test: 'tests',
  tests: 'tests',
  testing: 'tests',
  performance: 'performance',
  perf: 'performance',
  concurrency: 'concurrency',
  race: 'concurrency',
  data: 'data',
  database: 'data',
  compatibility: 'api_compat',
  'api-compat': 'api_compat',
  api_compat: 'api_compat',
  maintainability: 'maintainability',
  quality: 'maintainability',
  refactor: 'maintainability',
  docs: 'docs',
  documentation: 'docs',
  other: 'other',
};

const SEVERITY_ALIASES: Record<string, Severity> = {
  critical: 'blocker',
  high: 'important',
  medium: 'minor',
  low: 'minor',
  info: 'nit',
  blocker: 'blocker',
  important: 'important',
  minor: 'minor',
  nit: 'nit',
};

function normalizeAiPayload(value: unknown): unknown {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { findings?: unknown }).findings)) {
    return value;
  }
  const findings = (value as { findings: unknown[] }).findings.map((item) => {
    if (!item || typeof item !== 'object') return item;
    const finding = { ...(item as Record<string, unknown>) };
    if (typeof finding.category === 'string') {
      finding.category =
        CATEGORY_ALIASES[finding.category.toLowerCase().replace(/\s+/g, '-')] ??
        finding.category;
    }
    if (typeof finding.severity === 'string') {
      finding.severity =
        SEVERITY_ALIASES[finding.severity.toLowerCase()] ?? finding.severity;
    }
    for (const key of ['line', 'end_line']) {
      if (typeof finding[key] === 'string' && /^\d+$/.test(finding[key] as string)) {
        finding[key] = Number(finding[key]);
      }
    }
    if (typeof finding.confidence === 'string' && /^\d+(\.\d+)?$/.test(finding.confidence)) {
      finding.confidence = Number(finding.confidence);
    }
    return finding;
  });
  return { ...(value as Record<string, unknown>), findings };
}

export function parseVerification(text: string): VerificationResult {
  const parsed = extractJsonObject(text);
  const result = verificationSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new AiOutputError(`Verifier response did not match the schema: ${issues}`);
  }
  return result.data;
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^[ab]\//, '');
}

function normalizeClaim(claim: string): string {
  return claim
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 20)
    .join(' ');
}

function fingerprintFor(file: string, category: Category, line: number, claim: string): string {
  return sha256Prefixed(
    stableStringify({
      file,
      category,
      lineBucket: Math.floor((line - 1) / 10),
      claim: normalizeClaim(claim),
    }),
  );
}

export async function groundFindings(
  rawFindings: RawFinding[],
  diff: DiffInfo,
  headContents: Record<string, string>,
  runId: string,
  minSeverityToReport: Severity,
  sourceModel: string,
  promptVersion: string,
): Promise<GroundingResult> {
  const fileMap = new Map(diff.files.map((file) => [file.path, file]));
  const contentCache = new Map<string, string | null>(Object.entries(headContents));
  const byFingerprint = new Map<string, Finding>();
  let ungrounded = 0;
  let duplicates = 0;

  for (const raw of rawFindings) {
    const filePath = normalizePath(raw.file);
    const changedFile = fileMap.get(filePath);
    if (!changedFile || changedFile.status === 'D') {
      ungrounded += 1;
      continue;
    }

    let content = contentCache.get(filePath);
    if (content === undefined) {
      content = await readFileAtCommit(diff.repoRoot, diff.headSha, filePath);
      contentCache.set(filePath, content);
    }
    if (content === null || content.includes('\u0000')) {
      ungrounded += 1;
      continue;
    }

    const lines = content.split(/\r?\n/);
    if (raw.line > lines.length) {
      ungrounded += 1;
      continue;
    }
    const endLine = Math.min(
      lines.length,
      Math.max(raw.line, raw.end_line ?? raw.line),
    );
    const snippet = lines.slice(raw.line - 1, endLine).join('\n');
    const ranges = diff.changedRanges[filePath] ?? [];
    const lineInChangedRange = ranges.some((range) => raw.line >= range.start && raw.line <= range.end);
    const fingerprint = fingerprintFor(filePath, raw.category, raw.line, raw.claim);

    const finding: Finding = {
      id: '',
      runId,
      fingerprint,
      file: filePath,
      line: raw.line,
      endLine,
      severity: raw.severity,
      category: raw.category,
      claim: raw.claim.trim(),
      evidence: raw.evidence.trim(),
      suggestion: raw.suggestion?.trim() || null,
      confidence: raw.confidence ?? null,
      status: isAtLeastSeverity(raw.severity, minSeverityToReport) ? 'reported' : 'suppressed',
      verification: 'none',
      verificationReason: null,
      verifiedBy: null,
      votes: { confirm: 0, reject: 0, uncertain: 0, unavailable: 0 },
      grounding: {
        fileExists: true,
        lineInFile: true,
        lineInChangedRange,
        snippetSha256: sha256Prefixed(snippet),
      },
      sourceModel,
      promptVersion,
      createdAt: new Date().toISOString(),
    };

    const existing = byFingerprint.get(fingerprint);
    if (existing) {
      duplicates += 1;
      if (SEVERITY_RANK[finding.severity] > SEVERITY_RANK[existing.severity]) {
        existing.severity = finding.severity;
        existing.status = finding.status;
      }
      if (finding.evidence.length > existing.evidence.length) {
        existing.evidence = finding.evidence;
      }
      if (finding.suggestion && !existing.suggestion) {
        existing.suggestion = finding.suggestion;
      }
      if (finding.grounding.lineInChangedRange) {
        existing.grounding.lineInChangedRange = true;
      }
      continue;
    }
    byFingerprint.set(fingerprint, finding);
  }

  const findings = [...byFingerprint.values()]
    .sort(
      (a, b) =>
        SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
        a.file.localeCompare(b.file) ||
        a.line - b.line,
    )
    .map((finding, index) => ({ ...finding, id: `f_${String(index + 1).padStart(3, '0')}` }));

  return {
    findings,
    ungrounded,
    duplicates,
    invalid: 0,
  };
}
