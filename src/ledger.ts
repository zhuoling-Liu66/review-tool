import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ReviewError } from './errors.js';
import { sha256Prefixed, stableStringify } from './util/hash.js';

export interface LedgerEvent {
  seq: number;
  ts: string;
  type: string;
  run_id: string;
  payload: Record<string, unknown>;
  prev_hash: string | null;
  hash: string;
}

export interface LedgerVerifyResult {
  ok: boolean;
  count: number;
  error: string | null;
}

export function getLedgerPath(repoRoot: string): string {
  return path.join(repoRoot, '.review', 'ledger.jsonl');
}

export class LedgerWriter {
  private readonly filePath: string;
  private readonly runId: string;
  private seq: number;
  private prevHash: string | null;

  private constructor(filePath: string, runId: string, seq: number, prevHash: string | null) {
    this.filePath = filePath;
    this.runId = runId;
    this.seq = seq;
    this.prevHash = prevHash;
  }

  static async open(repoRoot: string, runId: string): Promise<LedgerWriter> {
    const filePath = getLedgerPath(repoRoot);
    await mkdir(path.dirname(filePath), { recursive: true });
    const last = await readLastEvent(filePath);
    return new LedgerWriter(filePath, runId, last?.seq ?? 0, last?.hash ?? null);
  }

  async append(type: string, payload: Record<string, unknown>): Promise<LedgerEvent> {
    const unsigned = {
      seq: this.seq + 1,
      ts: new Date().toISOString(),
      type,
      run_id: this.runId,
      payload,
      prev_hash: this.prevHash,
    };
    const event: LedgerEvent = {
      ...unsigned,
      hash: sha256Prefixed(stableStringify(unsigned)),
    };
    await appendFile(this.filePath, `${JSON.stringify(event)}\n`, 'utf8');
    this.seq = event.seq;
    this.prevHash = event.hash;
    return event;
  }
}

async function readLastEvent(filePath: string): Promise<LedgerEvent | null> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const last = lines[lines.length - 1];
  if (!last) return null;
  try {
    return JSON.parse(last) as LedgerEvent;
  } catch {
    throw new ReviewError(
      `Ledger is corrupt: cannot parse last line of ${filePath}. Run "review ledger verify".`,
      2,
    );
  }
}

export async function readLedger(repoRoot: string): Promise<LedgerEvent[]> {
  const filePath = getLedgerPath(repoRoot);
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch {
    return [];
  }
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as LedgerEvent);
}

export async function verifyLedger(repoRoot: string): Promise<LedgerVerifyResult> {
  const filePath = getLedgerPath(repoRoot);
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch {
    return { ok: true, count: 0, error: null };
  }

  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  let previousHash: string | null = null;
  let expectedSeq = 1;

  for (let index = 0; index < lines.length; index += 1) {
    let event: LedgerEvent;
    try {
      event = JSON.parse(lines[index]!) as LedgerEvent;
    } catch {
      return { ok: false, count: index, error: `Line ${index + 1}: invalid JSON` };
    }
    if (event.seq !== expectedSeq) {
      return {
        ok: false,
        count: index,
        error: `Line ${index + 1}: expected seq ${expectedSeq}, got ${event.seq}`,
      };
    }
    if (event.prev_hash !== previousHash) {
      return {
        ok: false,
        count: index,
        error: `Line ${index + 1}: prev_hash mismatch`,
      };
    }
    const unsigned = {
      seq: event.seq,
      ts: event.ts,
      type: event.type,
      run_id: event.run_id,
      payload: event.payload,
      prev_hash: event.prev_hash,
    };
    const expectedHash = sha256Prefixed(stableStringify(unsigned));
    if (event.hash !== expectedHash) {
      return { ok: false, count: index, error: `Line ${index + 1}: hash mismatch` };
    }
    previousHash = event.hash;
    expectedSeq += 1;
  }

  return { ok: true, count: lines.length, error: null };
}
