import type { ModelConfig, ProviderConfig, PricingConfig, ReviewConfig } from '../config.js';
import { ConfigError } from '../errors.js';
import { AnthropicClient } from './anthropic.js';
import { MockClient } from './mock.js';
import { OpenAICompatibleClient } from './openai.js';
import type { ModelClient } from './types.js';

export interface ResolvedModel {
  role: string;
  providerName: string;
  provider: ProviderConfig;
  model: ModelConfig;
}

export function resolveModel(config: ReviewConfig, role: string): ResolvedModel | null {
  const model = config.models[role];
  if (!model) return null;
  const provider = config.providers[model.provider];
  if (!provider) {
    throw new ConfigError(
      `models.${role}.provider references unknown provider "${model.provider}".`,
    );
  }
  return { role, providerName: model.provider, provider, model };
}

export function createModelClient(
  config: ReviewConfig,
  role: string,
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): ModelClient | null {
  const resolved = resolveModel(config, role);
  if (!resolved) return null;
  const { providerName, provider, model } = resolved;

  if (provider.type === 'mock') {
    return new MockClient(providerName, provider, model, repoRoot);
  }

  const defaultKeyEnv = provider.type === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
  const apiKey = env[provider.api_key_env ?? defaultKeyEnv];

  if (provider.type === 'anthropic') {
    return new AnthropicClient(providerName, provider, model, apiKey);
  }

  return new OpenAICompatibleClient(providerName, provider, model, apiKey);
}

export function getPricing(config: ReviewConfig, modelName: string): PricingConfig | null {
  return config.pricing[modelName] ?? null;
}

export function calculateCost(
  pricing: PricingConfig | null,
  inputTokens: number,
  outputTokens: number,
): { costUsd: number; priced: boolean } {
  if (!pricing) return { costUsd: 0, priced: false };
  const costUsd =
    (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
  return { costUsd: Number(costUsd.toFixed(6)), priced: true };
}
