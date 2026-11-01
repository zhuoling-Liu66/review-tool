import type { ModelConfig, ProviderConfig } from '../config.js';
import { ProviderError } from '../errors.js';
import type { ModelClient, ModelRequest, ModelResponse } from './types.js';
import { postJsonWithRetry } from './http.js';

interface AnthropicResponse {
  content?: Array<{ type?: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  model?: string;
}

export class AnthropicClient implements ModelClient {
  readonly providerName: string;
  readonly modelName: string;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;

  constructor(
    providerName: string,
    provider: ProviderConfig,
    model: ModelConfig,
    apiKey: string | undefined,
  ) {
    this.providerName = providerName;
    this.modelName = model.name;
    this.apiKey = apiKey;
    this.baseUrl = (provider.base_url ?? 'https://api.anthropic.com').replace(/\/+$/, '');
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (!this.apiKey) {
      throw new ProviderError(`Missing API key for provider "${this.providerName}".`);
    }
    const endpoint = `${this.baseUrl}/v1/messages`;
    const response = await postJsonWithRetry(
      endpoint,
      {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      {
        model: this.modelName,
        max_tokens: request.maxOutputTokens,
        temperature: 0,
        system: request.system,
        messages: [{ role: 'user', content: request.user }],
      },
    );
    if (response.status < 200 || response.status >= 300) {
      throw new ProviderError(
        `Provider ${this.providerName} returned HTTP ${response.status}: ${response.bodyText.slice(0, 1_000)}`,
        response.status,
      );
    }

    let parsed: AnthropicResponse;
    try {
      parsed = JSON.parse(response.bodyText) as AnthropicResponse;
    } catch {
      throw new ProviderError(`Provider ${this.providerName} returned non-JSON HTTP body.`);
    }
    const text = (parsed.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');
    if (!text.trim()) {
      throw new ProviderError(`Provider ${this.providerName} returned an empty completion.`);
    }
    return {
      text,
      inputTokens: parsed.usage?.input_tokens,
      outputTokens: parsed.usage?.output_tokens,
      model: parsed.model,
    };
  }
}
