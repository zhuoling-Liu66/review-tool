import type { ModelConfig, ProviderConfig } from '../config.js';
import { ProviderError } from '../errors.js';
import type { ModelClient, ModelRequest, ModelResponse } from './types.js';
import { postJsonWithRetry } from './http.js';

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ text?: string }>;
      reasoning_content?: string;
    };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
}

export class OpenAICompatibleClient implements ModelClient {
  readonly providerName: string;
  readonly modelName: string;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  readonly providerType: string;

  constructor(
    providerName: string,
    provider: ProviderConfig,
    model: ModelConfig,
    apiKey: string | undefined,
  ) {
    this.providerName = providerName;
    this.modelName = model.name;
    this.apiKey = apiKey;
    this.baseUrl = (provider.base_url ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.providerType = provider.type;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (!this.apiKey && this.baseUrl.includes('api.openai.com')) {
      throw new ProviderError(`Missing API key for provider "${this.providerName}".`);
    }
    const endpoint = `${this.baseUrl}/chat/completions`;
    const baseBody = {
      model: this.modelName,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
      temperature: 0,
      max_tokens: request.maxOutputTokens,
    };
    const headers: Record<string, string> = {};
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    let response = await postJsonWithRetry(
      endpoint,
      headers,
      { ...baseBody, response_format: { type: 'json_object' } },
    );
    if (
      response.status === 400 &&
      /response_format|json_object|unsupported/i.test(response.bodyText)
    ) {
      response = await postJsonWithRetry(endpoint, headers, baseBody);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new ProviderError(
        `Provider ${this.providerName} returned HTTP ${response.status}: ${response.bodyText.slice(0, 1_000)}`,
        response.status,
      );
    }

    const parseResponse = (bodyText: string): ChatCompletionResponse => {
      try {
        return JSON.parse(bodyText) as ChatCompletionResponse;
      } catch {
        throw new ProviderError(`Provider ${this.providerName} returned non-JSON HTTP body.`);
      }
    };

    let parsed = parseResponse(response.bodyText);
    let content = parsed.choices?.[0]?.message?.content;
    let text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((part) => part.text ?? '').join('')
          : '';

    // DeepSeek (and some compatible providers) can return an empty/space-only
    // body when JSON mode cannot satisfy the schema. Retry once without
    // response_format before giving up.
    if (!text.trim()) {
      const fallback = await postJsonWithRetry(endpoint, headers, baseBody);
      if (fallback.status < 200 || fallback.status >= 300) {
        throw new ProviderError(
          `Provider ${this.providerName} returned HTTP ${fallback.status} on non-JSON fallback: ${fallback.bodyText.slice(0, 1_000)}`,
          fallback.status,
        );
      }
      response = fallback;
      parsed = parseResponse(fallback.bodyText);
      content = parsed.choices?.[0]?.message?.content;
      text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.map((part) => part.text ?? '').join('')
            : '';
    }
    if (!text.trim()) {
      const finishReason = parsed.choices?.[0]?.finish_reason;
      throw new ProviderError(
        `Provider ${this.providerName} returned an empty completion (finish_reason: ${finishReason ?? 'unknown'}).`,
      );
    }

    return {
      text,
      inputTokens: parsed.usage?.prompt_tokens,
      outputTokens: parsed.usage?.completion_tokens,
      model: parsed.model,
    };
  }
}
