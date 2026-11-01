import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256Prefixed, stableStringify } from './util/hash.js';

export interface CachedAgentResponse {
  schema: 'review.cache.v1';
  text: string;
  model: string;
  provider: string;
  createdAt: string;
}

export interface CacheKeyInput {
  provider: string;
  model: string;
  maxOutputTokens: number;
  role: string;
  system: string;
  user: string;
}

export function buildCacheKey(input: CacheKeyInput): string {
  return sha256Prefixed(stableStringify(input)).replace('sha256:', '');
}

function cacheDir(repoRoot: string): string {
  return path.join(repoRoot, '.review', 'cache', 'ai');
}

export async function readCachedResponse(
  repoRoot: string,
  key: string,
): Promise<CachedAgentResponse | null> {
  try {
    const text = await readFile(path.join(cacheDir(repoRoot), `${key}.json`), 'utf8');
    const parsed = JSON.parse(text) as CachedAgentResponse;
    if (parsed.schema !== 'review.cache.v1' || typeof parsed.text !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeCachedResponse(
  repoRoot: string,
  key: string,
  response: CachedAgentResponse,
): Promise<void> {
  try {
    const dir = cacheDir(repoRoot);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${key}.json`), `${JSON.stringify(response, null, 2)}\n`, 'utf8');
  } catch {
    // Cache failures must never fail a review.
  }
}
