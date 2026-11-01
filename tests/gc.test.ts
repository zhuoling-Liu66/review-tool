import { mkdir, mkdtemp, rm, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gcArtifacts } from '../src/gc';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('gc', () => {
  it('removes only old artifact directories', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'review-gc-test-'));
    dirs.push(dir);
    const oldDir = path.join(dir, '.review', 'artifacts', 'r_old');
    const newDir = path.join(dir, '.review', 'artifacts', 'r_new');
    await mkdir(oldDir, { recursive: true });
    await mkdir(newDir, { recursive: true });
    const oldTime = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    await utimes(oldDir, oldTime, oldTime);

    const result = await gcArtifacts(dir, 30);
    expect(result.removed).toEqual(['r_old']);
    expect(result.kept).toBe(1);

    const { stat } = await import('node:fs/promises');
    await expect(stat(oldDir)).rejects.toThrow();
    await expect(stat(newDir)).resolves.toBeDefined();
  });
});
