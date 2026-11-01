import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './config.js';
import { ReviewError } from './errors.js';
import { LedgerWriter, readLedger } from './ledger.js';
import type { RunManifest, Tier } from './types.js';

export type ApprovalType = 'self' | 'external' | 'solo_override';

export interface ApprovalRecord {
  runId: string;
  diffSha256: string;
  headSha: string;
  approver: string;
  approverType: ApprovalType;
  note: string | null;
  ts: string;
}

export interface ApproveRunOptions {
  external?: boolean;
  as?: string;
  soloOverride?: boolean;
  note?: string;
  now?: Date;
  configPath?: string;
}

function manifestPath(repoRoot: string, runId: string): string {
  return path.join(repoRoot, '.review', 'artifacts', runId, 'manifest.json');
}

export async function findApproval(
  repoRoot: string,
  diffSha256: string,
  headSha: string,
  allowedTypes: ApprovalType[],
): Promise<ApprovalRecord | null> {
  const events = await readLedger(repoRoot);
  const allowed = new Set<string>(allowedTypes);
  const matches = events.filter(
    (event) =>
      event.type === 'approval.granted' &&
      event.payload.diff_sha256 === diffSha256 &&
      event.payload.head_sha === headSha &&
      allowed.has(String(event.payload.approver_type)),
  );
  const last = matches[matches.length - 1];
  if (!last) return null;
  return {
    runId: last.run_id,
    diffSha256,
    headSha,
    approver: String(last.payload.approver ?? 'unknown'),
    approverType: String(last.payload.approver_type) as ApprovalType,
    note: last.payload.note ? String(last.payload.note) : null,
    ts: last.ts,
  };
}

export async function approveRun(
  repoRoot: string,
  runId: string,
  options: ApproveRunOptions = {},
): Promise<ApprovalRecord> {
  if (!/^r_[A-Za-z0-9_]+$/.test(runId)) {
    throw new ReviewError(`Invalid run id: ${runId}`, 2);
  }
  let manifest: RunManifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath(repoRoot, runId), 'utf8')) as RunManifest;
  } catch {
    throw new ReviewError(`Run manifest not found for ${runId}`, 2);
  }

  const loaded = await loadConfig(repoRoot, options.configPath);
  const tier = manifest.tier as Tier;
  const level = loaded.config.approval[tier];
  const now = options.now ?? new Date();
  const endedAt = new Date(manifest.endedAt).getTime();
  const cooldownUntil = endedAt + level.cooldown_min * 60_000;
  if (now.getTime() < cooldownUntil) {
    const remaining = Math.ceil((cooldownUntil - now.getTime()) / 60_000);
    throw new ReviewError(
      `Cooldown not satisfied for tier ${tier}: ${remaining} minute(s) remaining.`,
      2,
    );
  }

  let approverType: ApprovalType;
  if (tier === 'high') {
    if (options.external) {
      approverType = 'external';
      if (!options.as?.trim()) {
        throw new ReviewError('High-risk external approval requires --as <login>.', 2);
      }
    } else if (options.soloOverride && loaded.config.approval.allow_solo_override) {
      approverType = 'solo_override';
    } else {
      throw new ReviewError(
        'High-risk approval requires --external --as <login> (or an enabled solo override).',
        2,
      );
    }
  } else {
    approverType = options.external ? 'external' : 'self';
  }

  const approver = options.as?.trim() || (approverType === 'self' ? 'self' : 'unknown');
  const diffSha256 = manifest.git.patchSha256;
  const ledger = await LedgerWriter.open(repoRoot, runId);
  await ledger.append('approval.granted', {
    diff_sha256: diffSha256,
    head_sha: manifest.git.headSha,
    approver,
    approver_type: approverType,
    checklist_version: loaded.config.approval.checklist_version,
    cooldown_satisfied: true,
    note: options.note?.trim() || null,
    ts: now.toISOString(),
  });

  return {
    runId,
    diffSha256,
    headSha: manifest.git.headSha,
    approver,
    approverType,
    note: options.note?.trim() || null,
    ts: now.toISOString(),
  };
}
