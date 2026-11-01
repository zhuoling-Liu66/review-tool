import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ReviewError } from './errors.js';
import { LedgerWriter, readLedger } from './ledger.js';
import type { RunManifest } from './types.js';

export type OutcomeStatus = 'fixed' | 'dismissed' | 'accepted_risk' | 'ignored';
export type DismissReason = 'error' | 'intentional' | 'minor';

export interface OutcomeOptions {
  reason?: string;
  reasonKind?: DismissReason;
}

export interface OutcomeSummary {
  totalFindings: number;
  resolved: number;
  open: number;
  byStatus: Record<OutcomeStatus, number>;
  dismissedReasons: Record<DismissReason, number>;
}

export async function recordOutcome(
  repoRoot: string,
  runId: string,
  findingId: string,
  status: OutcomeStatus,
  options: OutcomeOptions = {},
): Promise<void> {
  if (!/^r_[A-Za-z0-9_]+$/.test(runId)) throw new ReviewError(`Invalid run id: ${runId}`, 2);
  let manifest: RunManifest;
  try {
    manifest = JSON.parse(
      await readFile(
        path.join(repoRoot, '.review', 'artifacts', runId, 'manifest.json'),
        'utf8',
      ),
    ) as RunManifest;
  } catch {
    throw new ReviewError(`Run manifest not found for ${runId}`, 2);
  }
  if (!manifest.findings.some((finding) => finding.id === findingId)) {
    throw new ReviewError(`Finding ${findingId} not found in run ${runId}`, 2);
  }
  if (status === 'dismissed' && !options.reasonKind) {
    throw new ReviewError(
      'Dismissed outcomes require --kind error|intentional|minor.',
      2,
    );
  }
  const ledger = await LedgerWriter.open(repoRoot, runId);
  await ledger.append('finding.resolved', {
    finding_id: findingId,
    status,
    reason: options.reason?.trim() || null,
    reason_kind: options.reasonKind ?? null,
    ts: new Date().toISOString(),
  });
}

export async function collectOutcomes(
  repoRoot: string,
  sinceDays = 30,
): Promise<OutcomeSummary> {
  const events = await readLedger(repoRoot);
  const cutoff = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
  const recent = events.filter((event) => new Date(event.ts).getTime() >= cutoff);
  const created = new Set<string>();
  const resolved = new Map<string, string>();
  const byStatus: Record<OutcomeStatus, number> = {
    fixed: 0,
    dismissed: 0,
    accepted_risk: 0,
    ignored: 0,
  };
  const dismissedReasons: Record<DismissReason, number> = {
    error: 0,
    intentional: 0,
    minor: 0,
  };

  for (const event of recent) {
    if (event.type === 'finding.created' && event.payload.id) {
      created.add(`${event.run_id}:${String(event.payload.id)}`);
    }
    if (event.type === 'finding.resolved') {
      const key = `${event.run_id}:${String(event.payload.finding_id)}`;
      const status = String(event.payload.status) as OutcomeStatus;
      if (status in byStatus) {
        resolved.set(key, status);
        byStatus[status] += 1;
        if (status === 'dismissed') {
          const reason = String(event.payload.reason_kind ?? '') as DismissReason;
          if (reason in dismissedReasons) dismissedReasons[reason] += 1;
        }
      }
    }
  }

  return {
    totalFindings: created.size,
    resolved: resolved.size,
    open: Math.max(0, created.size - resolved.size),
    byStatus,
    dismissedReasons,
  };
}
