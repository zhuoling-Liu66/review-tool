export const SEVERITIES = ['blocker', 'important', 'minor', 'nit'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CATEGORIES = [
  'correctness',
  'security',
  'data',
  'concurrency',
  'performance',
  'tests',
  'api_compat',
  'maintainability',
  'docs',
  'other',
] as const;
export type Category = (typeof CATEGORIES)[number];

export type Tier = 'low' | 'medium' | 'high';
export type Mode = 'quick' | 'standard' | 'deep';

export interface LineRange {
  start: number;
  end: number;
}

export interface ChangedFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface DiffInfo {
  repoRoot: string;
  baseRef: string;
  headRef: string;
  baseSha: string;
  headSha: string;
  mergeBase: string;
  patch: string;
  files: ChangedFile[];
  changedRanges: Record<string, LineRange[]>;
  totalAdditions: number;
  totalDeletions: number;
}

export type CheckStatus = 'pass' | 'fail' | 'error' | 'skipped';

export interface CheckResult {
  name: string;
  command: string;
  status: CheckStatus;
  blocking: boolean;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  summary: string;
  logPath?: string;
}

export interface PolicyDecision {
  tier: Tier;
  mode: Mode;
  reasons: string[];
  sensitiveHits: string[];
  requiresHuman: boolean;
  budgetTokens: number;
}

export interface FindingGrounding {
  fileExists: boolean;
  lineInFile: boolean;
  lineInChangedRange: boolean;
  snippetSha256: string | null;
}

export interface FindingVotes {
  confirm: number;
  reject: number;
  uncertain: number;
  unavailable: number;
}

export type FindingStatus = 'reported' | 'suppressed' | 'rejected' | 'needs_human';

export type VerificationStatus =
  | 'none'
  | 'confirmed'
  | 'rejected'
  | 'uncertain'
  | 'unavailable';

export interface Finding {
  id: string;
  runId: string;
  fingerprint: string;
  file: string;
  line: number;
  endLine: number;
  severity: Severity;
  category: Category;
  claim: string;
  evidence: string;
  suggestion: string | null;
  confidence: number | null;
  status: FindingStatus;
  verification: VerificationStatus;
  verificationReason: string | null;
  verifiedBy: string | null;
  votes: FindingVotes;
  grounding: FindingGrounding;
  sourceModel: string;
  promptVersion: string;
  createdAt: string;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  priced: boolean;
}

export interface AiRunInfo {
  status: 'completed' | 'skipped' | 'failed';
  reason: string | null;
  model: string | null;
  provider: string | null;
  usage: ModelUsage | null;
  promptHash: string | null;
  contextHash: string | null;
  cacheHits: number;
}

export type RunStatus = 'completed' | 'failed' | 'incomplete' | 'awaiting_approval';

export interface ContextFileSummary {
  path: string;
  sha256: string | null;
  bytes: number;
  included: boolean;
  reason?: string;
}

export interface RunManifest {
  runId: string;
  repoRoot: string;
  trigger: 'cli' | 'eval' | 'scan';
  shadow: boolean;
  git: {
    baseRef: string;
    headRef: string;
    baseSha: string;
    headSha: string;
    mergeBase: string;
    patchSha256: string;
  };
  configPath: string;
  configHash: string;
  tier: Tier;
  mode: Mode;
  multiAgent: boolean;
  policy: PolicyDecision;
  checks: CheckResult[];
  ai: AiRunInfo;
  findings: Finding[];
  budget: {
    limitTokens: number;
    usedTokens: number;
    remainingTokens: number;
    usedUsd: number;
    priced: boolean;
    warning: boolean;
    monthlyPeriod: string;
    monthlyLimitUsd: number;
    monthlySpentUsd: number;
    monthlyWarning: boolean;
    monthlyBlocked: boolean;
  };
  context: {
    hash: string;
    promptHash: string;
    promptVersion: string;
    estimatedTokens: number;
    files: ContextFileSummary[];
    trimmed: boolean;
  } | null;
  security: {
    injectionSuspicions: string[];
  };
  approval: {
    required: boolean;
    satisfied: boolean;
    approver: string | null;
    approverType: string | null;
    cooldownSatisfied: boolean;
  };
  rounds: {
    prNumber: number | null;
    number: number;
    max: number;
    limited: boolean;
  };
  status: RunStatus;
  exitCode: number;
  startedAt: string;
  endedAt: string;
  artifactDir: string;
  reportPath: string;
}

export interface RunResult {
  runId: string;
  status: RunStatus;
  exitCode: number;
  tier: Tier;
  mode: Mode;
  requiresHuman: boolean;
  findingCount: number;
  blockerCount: number;
  needsHumanCount: number;
  checksFailed: number;
  reportPath: string;
  manifestPath: string;
  artifactDir: string;
  terminalSummary: string;
}
