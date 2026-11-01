import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ModelConfig, ProviderConfig } from '../config.js';
import { ProviderError } from '../errors.js';
import type { ModelClient, ModelRequest, ModelResponse } from './types.js';
import { estimateTokens } from '../util/tokens.js';

export class MockClient implements ModelClient {
  readonly providerName: string;
  readonly modelName: string;
  private readonly provider: ProviderConfig;
  private readonly repoRoot: string;

  constructor(providerName: string, provider: ProviderConfig, model: ModelConfig, repoRoot: string) {
    this.providerName = providerName;
    this.modelName = model.name;
    this.provider = provider;
    this.repoRoot = repoRoot;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    let text = '';
    if (request.role?.includes('verifier') && this.provider.mock_verifier_response) {
      text = this.provider.mock_verifier_response;
    } else if (request.role?.includes('repair') && this.provider.mock_repair_response) {
      text = this.provider.mock_repair_response;
    } else {
      text = this.provider.mock_response ?? process.env.REVIEW_MOCK_RESPONSE ?? '';
    }
    if (!text && this.provider.mock_response_file) {
      const filePath = path.resolve(this.repoRoot, this.provider.mock_response_file);
      try {
        text = await readFile(filePath, 'utf8');
      } catch (error) {
        throw new ProviderError(`Cannot read mock_response_file: ${(error as Error).message}`);
      }
    }
    if (!text.trim()) text = '{"findings":[]}';
    return {
      text,
      inputTokens: estimateTokens(request.system) + estimateTokens(request.user),
      outputTokens: estimateTokens(text),
      model: `mock:${this.modelName}`,
    };
  }
}
