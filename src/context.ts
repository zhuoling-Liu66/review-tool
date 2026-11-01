import { readFileAtCommit } from './git.js';
import type { ReviewConfig } from './config.js';
import { QUICK_PROMPT_VERSION, QUICK_SYSTEM_PROMPT } from './prompts.js';import type { DiffInfo } from './types.js';
import { sha256Prefixed } from './util/hash.js';
import { sanitizeUnsafeCharacters } from './util/injection.js';
import { redactSecrets } from './util/redact.js';
import { estimateTokens, truncateText } from './util/tokens.js';import picomatch from 'picomatch';

function sanitizeForModel(text: string): string {
  return sanitizeUnsafeCharacters(redactSecrets(text)).text;
}

export interface ContextFileInfo {
  path: string;
  sha256: string | null;
  bytes: number;
  included: boolean;
  reason?: string;
}

export interface ContextBundle {
  system: string;
  user: string;
  contextHash: string;
  promptHash: string;
  promptVersion: string;
  estimatedTokens: number;
  files: ContextFileInfo[];
  headContents: Record<string, string>;
  trimmed: boolean;
}

function normalize(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function isLikelyBinary(text: string): boolean {
  return text.includes('\u0000');
}

export interface ContextSpec {
  system: string;
  promptVersion: string;
  limitTokens: number;
}

export async function buildContext(
  diff: DiffInfo,
  config: ReviewConfig,
  intent: string | undefined,
  spec: ContextSpec,
): Promise<ContextBundle> {
  const limitChars = Math.max(
    8_000,
    spec.limitTokens * 4 - spec.system.length - 1_000,
  );
  const diffBudget = Math.floor(limitChars * 0.58);
  const filesBudget = Math.floor(limitChars * 0.30);
  const docsBudget = Math.floor(limitChars * 0.08);
  const intentBudget = Math.floor(limitChars * 0.04);

  const reviewableFiles = diff.files.filter(
    (file) =>
      file.status !== 'D' &&
      !file.binary &&
      !matchesAny(file.path, config.review.skip_paths),
  );

  const headContents: Record<string, string> = {};
  const fileInfos: ContextFileInfo[] = [];
  const fileSections: string[] = [];
  let filesUsed = 0;
  const reviewablePaths = new Set(reviewableFiles.map((file) => file.path));
  const reviewPatch = filterPatch(diff.patch, reviewablePaths);

  for (const file of reviewableFiles.slice(0, 15)) {
    const content = await readFileAtCommit(diff.repoRoot, diff.headSha, file.path);
    if (content === null || isLikelyBinary(content)) {
      fileInfos.push({ path: file.path, sha256: null, bytes: 0, included: false, reason: 'unreadable_or_binary' });
      continue;
    }
    headContents[file.path] = content;
    const remaining = filesBudget - filesUsed;
    if (remaining <= 800) {
      fileInfos.push({ path: file.path, sha256: sha256Prefixed(content), bytes: content.length, included: false, reason: 'budget' });
      continue;
    }
    const excerpt = truncateText(sanitizeForModel(content), Math.min(12_000, remaining));
    filesUsed += excerpt.length;
    fileSections.push(`### ${file.path}\n\`\`\`\n${excerpt}\n\`\`\``);
    fileInfos.push({ path: file.path, sha256: sha256Prefixed(content), bytes: content.length, included: true });
  }

  const docs: Array<{ name: string; content: string }> = [];
  for (const docName of ['CLAUDE.md', 'REVIEW.md']) {
    const content = await readFileAtCommit(diff.repoRoot, diff.headSha, docName);
    if (content) docs.push({ name: docName, content: truncateText(sanitizeForModel(content), Math.floor(docsBudget / 2)) });
  }

  const docsSection = docs.length
    ? docs.map((doc) => `### ${doc.name}\n${doc.content}`).join('\n\n')
    : '(No CLAUDE.md or REVIEW.md found at HEAD.)';

  const diffText = truncateText(sanitizeForModel(reviewPatch), diffBudget);
  const intentText = intent
    ? truncateText(sanitizeForModel(intent), Math.max(200, intentBudget))
    : '(No intent text provided.)';

  const user = [
    '## Project conventions',
    docsSection,
    '',
    '## Change intent',
    intentText,
    '',
    '## Changed files',
    diff.files.length
      ? diff.files.map((file) => `- ${file.status} ${file.path} (+${file.additions}/-${file.deletions})`).join('\n')
      : '(none)',
    '',
    '## Diff (unified=3)',
    '```diff',
    diffText,
    '```',
    '',
    '## Full contents of changed files at HEAD (may be truncated)',
    fileSections.length ? fileSections.join('\n\n') : '(No readable changed files.)',
  ].join('\n');

  const safety = isOverBudget(spec.system, user, spec.limitTokens);
  const finalUser = safety
    ? await buildFallbackUser(
        diff,
        reviewPatch,
        config,
        intentText,
        docsSection,
        fileSections,
        limitChars,
        spec,
      )
    : user;

  const combined = `${spec.system}\n---\n${finalUser}`;
  return {
    system: spec.system,
    user: finalUser,
    contextHash: sha256Prefixed(combined),
    promptHash: sha256Prefixed(`${spec.promptVersion}\n${spec.system}`),
    promptVersion: spec.promptVersion,
    estimatedTokens: estimateTokens(combined),
    files: fileInfos,
    headContents,
    trimmed: safety,
  };
}

export async function buildQuickContext(
  diff: DiffInfo,
  config: ReviewConfig,
  intent?: string,
): Promise<ContextBundle> {
  return buildContext(diff, config, intent, {
    system: QUICK_SYSTEM_PROMPT,
    promptVersion: QUICK_PROMPT_VERSION,
    limitTokens: config.review.context_limits.quick,
  });
}

async function buildFallbackUser(
  diff: DiffInfo,
  reviewPatch: string,
  config: ReviewConfig,
  intentText: string,
  docsSection: string,
  fileSections: string[],
  limitChars: number,
  spec: ContextSpec,
): Promise<string> {
  const diffBudget = Math.floor(limitChars * 0.70);
  const user = [
    '## Project conventions',
    docsSection,
    '',
    '## Change intent',
    intentText,
    '',
    '## Changed files',
    diff.files.map((file) => `- ${file.status} ${file.path}`).join('\n') || '(none)',
    '',
    '## Diff (unified=3)',
    '```diff',
    truncateText(sanitizeForModel(reviewPatch), diffBudget),
    '```',
    '',
    '## File contents omitted to stay within the review context limit.',
    fileSections.length ? `[${fileSections.length} file excerpt(s) omitted]` : '',
  ].join('\n');

  if (!isOverBudget(spec.system, user, spec.limitTokens)) {
    return user;
  }
  return [
    '## Changed files',
    diff.files.map((file) => `- ${file.status} ${file.path}`).join('\n') || '(none)',
    '',
    '## Diff (truncated)',
    truncateText(sanitizeForModel(reviewPatch), Math.floor(limitChars * 0.65)),
  ].join('\n');
}

function isOverBudget(system: string, user: string, limitTokens: number): boolean {
  return estimateTokens(`${system}\n---\n${user}`) > limitTokens;
}

function matchesAny(filePath: string, patterns: string[]): boolean {
  const normalized = normalize(filePath);
  return patterns.some((pattern) => picomatch(pattern, { dot: true })(normalized));
}

function filterPatch(patch: string, allowedPaths: Set<string>): string {
  if (allowedPaths.size === 0) return '';
  const sections: string[] = [];
  let current: string[] = [];
  let currentPath: string | null = null;

  const flush = () => {
    if (current.length > 0 && currentPath !== null && allowedPaths.has(currentPath)) {
      sections.push(current.join('\n'));
    }
    current = [];
    currentPath = null;
  };

  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      flush();
      current.push(line);
      continue;
    }
    current.push(line);
    if (line.startsWith('+++ ')) {
      const rawPath = line.slice(4).trim();
      currentPath =
        rawPath === '/dev/null' ? null : normalize(rawPath.replace(/^b\//, ''));
    }
  }
  flush();
  return sections.join('\n');
}
