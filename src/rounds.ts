import { LedgerWriter, readLedger } from './ledger.js';
import { ReviewError } from './errors.js';

export interface RoundState {
  count: number;
  lastHead: string | null;
}

export async function getRoundState(repoRoot: string, prNumber: number): Promise<RoundState> {
  const events = await readLedger(repoRoot);
  let lastReset = -1;
  events.forEach((event, index) => {
    if (
      event.type === 'rounds.reset' &&
      Number(event.payload.pr_number) === prNumber
    ) {
      lastReset = index;
    }
  });

  const rounds = events.filter(
    (event, index) =>
      index > lastReset &&
      event.type === 'review.round' &&
      Number(event.payload.pr_number) === prNumber,
  );
  const last = rounds[rounds.length - 1];
  return {
    count: rounds.length,
    lastHead: last?.payload.head_sha ? String(last.payload.head_sha) : null,
  };
}

export async function recordRound(
  ledger: LedgerWriter,
  prNumber: number,
  round: number,
  headSha: string,
): Promise<void> {
  await ledger.append('review.round', {
    pr_number: prNumber,
    round,
    head_sha: headSha,
  });
}

export async function resetRounds(
  repoRoot: string,
  prNumber: number,
  reason: string,
): Promise<void> {
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new ReviewError(`Invalid PR number: ${prNumber}`, 2);
  }
  if (!reason.trim()) throw new ReviewError('A reason is required to reset rounds.', 2);
  const ledger = await LedgerWriter.open(repoRoot, `admin_rounds_${Date.now()}`);
  await ledger.append('rounds.reset', {
    pr_number: prNumber,
    reason: reason.trim(),
  });
}
