import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { runReview } from '../src/pipeline';
import { approveRun } from '../src/approval';
import { readLedger, verifyLedger } from '../src/ledger';
import { resetRounds } from '../src/rounds';
import { createTestRepo, type TestRepo } from './helpers/repo';

const repos: TestRepo[] = [];

afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => repo.cleanup()));
});

describe('Quick pipeline', () => {
  it('reviews a change, writes artifacts and a valid ledger', async () => {
    const repo = await createTestRepo();
    repos.push(repo);

    const result = await runReview({ repoPath: repo.dir, baseRef: 'main' });
    expect(result.exitCode).toBe(0);
    expect(result.status).toBe('completed');
    expect(result.tier).toBe('medium');
    expect(result.mode).toBe('quick');
    expect(result.findingCount).toBe(1);
    expect(result.blockerCount).toBe(0);
    expect(result.terminalSummary).toContain('Findings: 1 reported');

    const ledger = await verifyLedger(repo.dir);
    expect(ledger.ok).toBe(true);
    expect(ledger.count).toBeGreaterThan(3);

    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    expect(manifest.findings).toHaveLength(1);
    expect(manifest.ai.status).toBe('completed');
    expect(manifest.budget.usedTokens).toBeGreaterThan(0);
    const report = await readFile(result.reportPath, 'utf8');
    expect(report).toContain('Token expiry');
    expect(report).toContain('Verification: **none**');
  });

  it('fails on a deterministic check before calling the model', async () => {
    const repo = await createTestRepo({ checkFails: true });
    repos.push(repo);
    const result = await runReview({ repoPath: repo.dir, baseRef: 'main' });
    expect(result.exitCode).toBe(1);
    expect(result.status).toBe('failed');
    expect(result.findingCount).toBe(0);
    expect(result.checksFailed).toBe(1);

    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    expect(manifest.ai.status).toBe('skipped');
    expect(manifest.ai.reason).toBe('checks_failed');
  });

  it('requires human approval for high-risk paths', async () => {
    const repo = await createTestRepo({ highRisk: true });
    repos.push(repo);
    const result = await runReview({ repoPath: repo.dir, baseRef: 'main' });
    expect(result.exitCode).toBe(3);
    expect(result.status).toBe('awaiting_approval');
    expect(result.tier).toBe('high');
    expect(result.requiresHuman).toBe(true);
  });

  it('returns incomplete when AI is explicitly disabled', async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    const result = await runReview({ repoPath: repo.dir, baseRef: 'main', noAi: true });
    expect(result.exitCode).toBe(4);
    expect(result.status).toBe('incomplete');
  });

  it('returns incomplete when no Quick model is configured', async () => {
    const repo = await createTestRepo({ noModels: true });
    repos.push(repo);
    const result = await runReview({ repoPath: repo.dir, baseRef: 'main' });
    expect(result.exitCode).toBe(4);
    expect(result.status).toBe('incomplete');
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    expect(manifest.ai.reason).toBe('no_quick_model');
  });

  it('hard-stops when the token budget is too small', async () => {
    const repo = await createTestRepo({ budgetQuick: 10 });
    repos.push(repo);
    const result = await runReview({ repoPath: repo.dir, baseRef: 'main' });
    expect(result.exitCode).toBe(4);
    expect(result.status).toBe('incomplete');
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    expect(manifest.ai.status).toBe('failed');
    expect(manifest.ai.reason).toContain('budget');
  });

  it('fails the run when a blocker is confirmed by the verifier', async () => {
    const repo = await createTestRepo({
      findings: [
        {
          file: 'src/app.ts',
          line: 2,
          severity: 'blocker',
          category: 'security',
          claim: 'Token validation accepts all non-expired-looking strings.',
          evidence: 'The new code does not validate the exp claim.',
        },
      ],
      verifierResponse: JSON.stringify({
        verdict: 'confirm',
        reason: 'The code does not inspect exp.',
        confidence: 0.9,
      }),
    });
    repos.push(repo);
    const result = await runReview({ repoPath: repo.dir, baseRef: 'main' });
    expect(result.exitCode).toBe(1);
    expect(result.status).toBe('failed');
    expect(result.blockerCount).toBe(1);
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    expect(manifest.findings[0].verification).toBe('confirmed');
    expect(manifest.findings[0].status).toBe('reported');
  });

  it('does not block when the verifier rejects a blocker', async () => {
    const repo = await createTestRepo({
      findings: [
        {
          file: 'src/app.ts',
          line: 2,
          severity: 'blocker',
          category: 'security',
          claim: 'Token validation accepts all non-expired-looking strings.',
          evidence: 'The new code does not validate the exp claim.',
        },
      ],
      verifierResponse: JSON.stringify({
        verdict: 'reject',
        reason: 'The caller validates the expiration before this function.',
        confidence: 0.9,
      }),
    });
    repos.push(repo);
    const result = await runReview({ repoPath: repo.dir, baseRef: 'main' });
    expect(result.exitCode).toBe(0);
    expect(result.status).toBe('completed');
    expect(result.blockerCount).toBe(0);
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    expect(manifest.findings[0].status).toBe('rejected');
    expect(manifest.findings[0].verification).toBe('rejected');
    const report = await readFile(result.reportPath, 'utf8');
    expect(report).toContain('Rejected findings');
  });

  it('requires human review when the verifier is uncertain', async () => {
    const repo = await createTestRepo({
      findings: [
        {
          file: 'src/app.ts',
          line: 2,
          severity: 'blocker',
          category: 'security',
          claim: 'Token validation accepts all non-expired-looking strings.',
          evidence: 'The new code does not validate the exp claim.',
        },
      ],
      verifierResponse: JSON.stringify({
        verdict: 'uncertain',
        reason: 'The caller is not in the provided context.',
        confidence: 0.4,
      }),
    });
    repos.push(repo);
    const result = await runReview({ repoPath: repo.dir, baseRef: 'main' });
    expect(result.exitCode).toBe(3);
    expect(result.status).toBe('awaiting_approval');
    expect(result.needsHumanCount).toBe(1);
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    expect(manifest.findings[0].status).toBe('needs_human');
    const report = await readFile(result.reportPath, 'utf8');
    expect(report).toContain('Needs human');
  });

  it('repairs a non-JSON Finder response once', async () => {
    const repo = await createTestRepo({
      mockResponse: 'I could not produce findings as JSON.',
      repairResponse: JSON.stringify({
        findings: [
          {
            file: 'src/app.ts',
            line: 2,
            severity: 'important',
            category: 'correctness',
            claim: 'The expiry check is incomplete.',
            evidence: 'The code only compares the token to a literal.',
          },
        ],
      }),
    });
    repos.push(repo);
    const result = await runReview({ repoPath: repo.dir, baseRef: 'main' });
    expect(result.exitCode).toBe(0);
    expect(result.findingCount).toBe(1);
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    expect(manifest.ai.status).toBe('completed');
    const events = await readLedger(repo.dir);
    expect(events.some((event) => event.type === 'agent.repaired')).toBe(true);
    expect(events.some((event) => event.type === 'agent.invalid_output')).toBe(true);
  });

  it('requires human approval when the only change is not reviewable by the AI', async () => {
    const repo = await createTestRepo({ withLockBranch: true });
    repos.push(repo);
    const result = await runReview({ repoPath: repo.dir, baseRef: 'main', headRef: 'lock' });
    expect(result.exitCode).toBe(3);
    expect(result.status).toBe('awaiting_approval');
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    expect(manifest.ai.reason).toBe('no_reviewable_files');
    expect(manifest.tier).toBe('medium');
  });

  it('runs Standard with three Finders and three verifier votes', async () => {
    const repo = await createTestRepo({
      verifierResponse: JSON.stringify({
        verdict: 'confirm',
        reason: 'Confirmed by the independent verifier.',
        confidence: 0.9,
      }),
    });
    repos.push(repo);
    const result = await runReview({
      repoPath: repo.dir,
      baseRef: 'main',
      mode: 'standard',
    });
    expect(result.exitCode).toBe(0);
    expect(result.mode).toBe('standard');
    expect(result.findingCount).toBe(1);

    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    expect(manifest.findings[0].verification).toBe('confirmed');
    expect(manifest.findings[0].votes).toEqual({
      confirm: 3,
      reject: 0,
      uncertain: 0,
      unavailable: 0,
    });

    const events = await readLedger(repo.dir);
    const invoked = events.filter((event) => event.type === 'agent.invoked');
    expect(invoked.filter((event) => String(event.payload.role).startsWith('finder_'))).toHaveLength(3);
    expect(invoked.filter((event) => String(event.payload.role).startsWith('verifier_'))).toHaveLength(3);
  });

  it('can fall back to a single Finder and one vote with multi_agent off', async () => {
    const repo = await createTestRepo({
      multiAgent: 'off',
      verifierResponse: JSON.stringify({
        verdict: 'confirm',
        reason: 'Single-vote Standard verification.',
        confidence: 0.8,
      }),
    });
    repos.push(repo);
    const result = await runReview({
      repoPath: repo.dir,
      baseRef: 'main',
      mode: 'standard',
    });
    expect(result.exitCode).toBe(0);
    expect(result.mode).toBe('standard');
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    expect(manifest.multiAgent).toBe(false);
    expect(manifest.findings[0].votes).toEqual({
      confirm: 1,
      reject: 0,
      uncertain: 0,
      unavailable: 0,
    });
    const events = await readLedger(repo.dir);
    const invoked = events.filter((event) => event.type === 'agent.invoked');
    expect(invoked.filter((event) => String(event.payload.role).startsWith('finder_'))).toHaveLength(1);
    expect(invoked.filter((event) => String(event.payload.role).startsWith('verifier_'))).toHaveLength(1);
  });

  it('allows an explicit high-risk override with a recorded reason', async () => {
    const repo = await createTestRepo({ highRisk: true });
    repos.push(repo);
    const result = await runReview({
      repoPath: repo.dir,
      baseRef: 'main',
      overrideHighReason: 'Personal repo; auth change reviewed manually today.',
    });
    expect(result.exitCode).toBe(0);
    expect(result.tier).toBe('medium');
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    expect(manifest.policy.reasons).toContain(
      'override_high:Personal repo; auth change reviewed manually today.',
    );
  });

  it('enforces the monthly budget across runs', async () => {
    const repo = await createTestRepo({ monthlyUsd: 0.0001 });
    repos.push(repo);
    const first = await runReview({ repoPath: repo.dir, baseRef: 'main' });
    expect(first.exitCode).toBe(0);

    const second = await runReview({ repoPath: repo.dir, baseRef: 'main' });
    expect(second.exitCode).toBe(4);
    expect(second.status).toBe('incomplete');
    const manifest = JSON.parse(await readFile(second.manifestPath, 'utf8'));
    expect(manifest.ai.reason).toBe('monthly_budget_exceeded');
    expect(manifest.budget.monthlyBlocked).toBe(true);
  });

  it('reuses cached agent responses without charging the budget', async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    const first = await runReview({ repoPath: repo.dir, baseRef: 'main' });
    expect(first.exitCode).toBe(0);

    const second = await runReview({ repoPath: repo.dir, baseRef: 'main' });
    expect(second.exitCode).toBe(0);
    const manifest = JSON.parse(await readFile(second.manifestPath, 'utf8'));
    expect(manifest.ai.cacheHits).toBeGreaterThan(0);
    expect(manifest.ai.usage).toBeNull();
    const events = await readLedger(repo.dir);
    expect(events.some((event) => event.type === 'agent.cached')).toBe(true);
  });

  it('runs Deep with four Finder perspectives and three verifier votes', async () => {
    const repo = await createTestRepo({
      verifierResponse: JSON.stringify({
        verdict: 'confirm',
        reason: 'Deep verification.',
        confidence: 0.9,
      }),
    });
    repos.push(repo);
    const result = await runReview({
      repoPath: repo.dir,
      baseRef: 'main',
      mode: 'deep',
    });
    expect(result.exitCode).toBe(0);
    expect(result.mode).toBe('deep');
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    expect(manifest.multiAgent).toBe(true);
    const events = await readLedger(repo.dir);
    const invoked = events.filter((event) => event.type === 'agent.invoked');
    expect(invoked.filter((event) => String(event.payload.role).startsWith('finder_'))).toHaveLength(4);
    expect(invoked.filter((event) => String(event.payload.role).startsWith('verifier_'))).toHaveLength(3);
  });

  it('can approve a high-risk run and pass a subsequent run', async () => {
    const repo = await createTestRepo({ highRisk: true });
    repos.push(repo);
    const first = await runReview({ repoPath: repo.dir, baseRef: 'main' });
    expect(first.exitCode).toBe(3);
    expect(first.status).toBe('awaiting_approval');

    const approval = await approveRun(repo.dir, first.runId, {
      external: true,
      as: 'external-reviewer',
      note: 'Reviewed manually',
    });
    expect(approval.approverType).toBe('external');

    const second = await runReview({ repoPath: repo.dir, baseRef: 'main' });
    expect(second.exitCode).toBe(0);
    const manifest = JSON.parse(await readFile(second.manifestPath, 'utf8'));
    expect(manifest.approval.required).toBe(true);
    expect(manifest.approval.satisfied).toBe(true);
    expect(manifest.approval.approver).toBe('external-reviewer');
  });

  it('stops after the round limit and can be reset', async () => {
    const repo = await createTestRepo({ roundsMax: 1 });
    repos.push(repo);
    const first = await runReview({
      repoPath: repo.dir,
      baseRef: 'main',
      prNumber: 1,
    });
    expect(first.exitCode).toBe(0);

    const second = await runReview({
      repoPath: repo.dir,
      baseRef: 'main',
      prNumber: 1,
    });
    expect(second.exitCode).toBe(3);
    expect(second.status).toBe('awaiting_approval');
    const manifest = JSON.parse(await readFile(second.manifestPath, 'utf8'));
    expect(manifest.rounds.limited).toBe(true);
    expect(manifest.ai.reason).toBe('round_limit_reached');

    await resetRounds(repo.dir, 1, 'replanned after round limit');
    const third = await runReview({
      repoPath: repo.dir,
      baseRef: 'main',
      prNumber: 1,
    });
    expect(third.exitCode).toBe(0);
  });

  it('checks-only exits 0 and never runs AI', async () => {
    const repo = await createTestRepo();
    repos.push(repo);
    const result = await runReview({ repoPath: repo.dir, baseRef: 'main', checksOnly: true });
    expect(result.exitCode).toBe(0);
    expect(result.status).toBe('completed');
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    expect(manifest.ai.reason).toBe('checks_only');
  });
});
