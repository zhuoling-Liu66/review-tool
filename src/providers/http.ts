import { ProviderError } from '../errors.js';

export interface HttpResponse {
  status: number;
  bodyText: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function postJsonWithRetry(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs = 120_000,
  maxRetries = 3,
): Promise<HttpResponse> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const bodyText = await response.text();
      if (response.status === 429 || response.status >= 500) {
        if (attempt < maxRetries) {
          await sleep(1_000 * 2 ** attempt + Math.floor(Math.random() * 400));
          continue;
        }
      }
      return { status: response.status, bodyText };
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxRetries) {
        await sleep(1_000 * 2 ** attempt + Math.floor(Math.random() * 400));
        continue;
      }
    }
  }
  throw new ProviderError(`Provider request failed: ${lastError?.message ?? 'unknown error'}`);
}
