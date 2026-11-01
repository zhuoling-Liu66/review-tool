import { readLedger } from './ledger.js';

export interface MonthlySpend {
  period: string;
  spentUsd: number;
  priced: boolean;
  events: number;
}

export async function getMonthlySpend(
  repoRoot: string,
  now: Date = new Date(),
): Promise<MonthlySpend> {
  const period = now.toISOString().slice(0, 7);
  const events = await readLedger(repoRoot);
  let spentUsd = 0;
  let priced = true;
  let count = 0;

  for (const event of events) {
    if (event.type !== 'agent.invoked') continue;
    if (!event.ts.startsWith(period)) continue;
    const cost = Number(event.payload.cost_usd ?? 0);
    if (Number.isFinite(cost)) spentUsd += cost;
    if (event.payload.priced === false) priced = false;
    count += 1;
  }

  return {
    period,
    spentUsd: Number(spentUsd.toFixed(6)),
    priced,
    events: count,
  };
}
