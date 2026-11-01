import { describe, expect, it } from 'vitest';
import { AiOutputError } from '../src/errors';
import { groundFindings, parseAiFindings, type RawFinding } from '../src/findings';
import type { DiffInfo } from '../src/types';

function makeDiff(): DiffInfo {
  return {
    repoRoot: '/repo',
    baseRef: 'main',
    headRef: 'HEAD',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    mergeBase: 'a'.repeat(40),
    patch: '',
    files: [{ path: 'src/app.ts', status: 'M', additions: 2, deletions: 1, binary: false }],
    changedRanges: { 'src/app.ts': [{ start: 2, end: 2 }] },
    totalAdditions: 2,
    totalDeletions: 1,
  };
}

const content = ['export function checkToken(token: string) {', '  return token !== "expired";', '}'].join('\n');

describe('findings parsing and grounding', () => {
  it('parses fenced JSON and returns no findings', () => {
    expect(parseAiFindings('```json\n{"findings":[]}\n```')).toEqual([]);
  });

  it('rejects invalid JSON', () => {
    expect(() => parseAiFindings('not json')).toThrow(AiOutputError);
    expect(() => parseAiFindings('{"findings":[{"file":"x"}]}')).toThrow(AiOutputError);
  });

  it('grounds, dedupes and suppresses findings', async () => {
    const raw: RawFinding[] = [
      {
        file: 'src/app.ts',
        line: 2,
        severity: 'important',
        category: 'correctness',
        claim: 'Expiry is compared to a literal.',
        evidence: 'The code does not inspect exp.',
      },
      {
        file: 'src/app.ts',
        line: 2,
        severity: 'important',
        category: 'correctness',
        claim: 'Expiry is compared to a literal.',
        evidence: 'Duplicate evidence, longer text to merge.',
      },
      {
        file: 'src/app.ts',
        line: 2,
        severity: 'nit',
        category: 'maintainability',
        claim: 'Consider using a named constant.',
        evidence: 'Literal string is repeated.',
      },
      {
        file: 'missing.ts',
        line: 1,
        severity: 'important',
        category: 'other',
        claim: 'Missing file',
        evidence: 'No file.',
      },
      {
        file: 'src/app.ts',
        line: 99,
        severity: 'important',
        category: 'other',
        claim: 'Out of range',
        evidence: 'Line does not exist.',
      },
    ];

    const result = await groundFindings(
      raw,
      makeDiff(),
      { 'src/app.ts': content },
      'r_test',
      'minor',
      'mock-model',
      'quick.v1',
    );
    expect(result.findings).toHaveLength(2);
    expect(result.duplicates).toBe(1);
    expect(result.ungrounded).toBe(2);
    expect(result.findings[0]?.severity).toBe('important');
    expect(result.findings[0]?.grounding.lineInChangedRange).toBe(true);
    expect(result.findings[1]?.status).toBe('suppressed');
    expect(result.findings[0]?.verification).toBe('none');
  });
});
