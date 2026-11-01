import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

export interface GcResult {
  removed: string[];
  kept: number;
  artifactsDir: string;
}

export async function gcArtifacts(
  repoRoot: string,
  days: number,
  now: Date = new Date(),
): Promise<GcResult> {
  const artifactsDir = path.join(repoRoot, '.review', 'artifacts');
  let entries: string[];
  try {
    entries = await readdir(artifactsDir);
  } catch {
    return { removed: [], kept: 0, artifactsDir };
  }
  const cutoff = now.getTime() - Math.max(0, days) * 24 * 60 * 60 * 1000;
  const removed: string[] = [];
  let kept = 0;

  for (const entry of entries) {
    const fullPath = path.join(artifactsDir, entry);
    try {
      const info = await stat(fullPath);
      if (!info.isDirectory()) continue;
      if (info.mtimeMs < cutoff) {
        await rm(fullPath, { recursive: true, force: true });
        removed.push(entry);
      } else {
        kept += 1;
      }
    } catch {
      // A concurrent run may remove an artifact while gc is scanning; skip it.
    }
  }

  return { removed, kept, artifactsDir };
}
