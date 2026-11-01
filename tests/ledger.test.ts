import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LedgerWriter, readLedger, verifyLedger } from '../src/ledger';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'review-ledger-test-'));
  dirs.push(dir);
  return dir;
}

describe('ledger', () => {
  it('appends an event chain and verifies it', async () => {
    const dir = await makeDir();
    const ledger = await LedgerWriter.open(dir, 'r_test');
    await ledger.append('run.started', { value: 1 });
    await ledger.append('run.completed', { value: 2 });

    const events = await readLedger(dir);
    expect(events).toHaveLength(2);
    expect(events[0]?.seq).toBe(1);
    expect(events[0]?.prev_hash).toBeNull();
    expect(events[1]?.prev_hash).toBe(events[0]?.hash);

    const result = await verifyLedger(dir);
    expect(result).toEqual({ ok: true, count: 2, error: null });
  });

  it('detects tampering', async () => {
    const dir = await makeDir();
    const ledger = await LedgerWriter.open(dir, 'r_test');
    await ledger.append('run.started', { value: 1 });
    const ledgerPath = path.join(dir, '.review', 'ledger.jsonl');
    const text = await readFile(ledgerPath, 'utf8');
    const event = JSON.parse(text.trim());
    event.payload.value = 999;
    await writeFile(ledgerPath, `${JSON.stringify(event)}\n`, 'utf8');

    const result = await verifyLedger(dir);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/hash mismatch/);
  });
});
