import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { ConfigError } from './errors.js';
import { sha256Prefixed, stableStringify } from './util/hash.js';

export const DEFAULT_LOW_PATHS = ['docs/**', '**/*.md', 'tests/**', '**/*.test.*', '**/*.spec.*'];
export const DEFAULT_HIGH_PATHS = [
  '.github/workflows/**',
  'auth/**',
  'billing/**',
  'payments/**',
  'scripts/release/**',
  'migrations/**',
  'infra/**',
];
export const DEFAULT_DEPENDENCY_PATHS = [
  'package.json',
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'requirements*.txt',
  'go.mod',
  'go.sum',
  'Cargo.lock',
];
export const DEFAULT_CHECK_SKIP_PATHS = ['dist/**', 'generated/**', '**/*.lock', '**/*.snap'];
export const DEFAULT_REVIEW_SKIP_PATHS = [
  'dist/**',
  'generated/**',
  'vendor/**',
  '**/*.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'npm-shrinkwrap.json',
  'Cargo.lock',
  'go.sum',
  'poetry.lock',
  'Gemfile.lock',
  'composer.lock',
];

const providerSchema = z.object({
  type: z.enum(['openai', 'anthropic', 'openai-compatible', 'mock']).default('openai-compatible'),
  base_url: z.string().url().optional(),
  api_key_env: z.string().min(1).optional(),
  mock_response: z.string().optional(),
  mock_response_file: z.string().optional(),
  mock_verifier_response: z.string().optional(),
  mock_repair_response: z.string().optional(),
});

const modelSchema = z.object({
  provider: z.string().min(1),
  name: z.string().min(1),
  max_output_tokens: z.number().int().positive().max(64000).default(2048),
});

const pricingSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
});

const checkSchema = z.object({
  cmd: z.string().min(1),
  blocking: z.boolean().default(true),
  timeout_sec: z.number().int().positive().default(300),
});

const checksSchema = z
  .object({
    skip_paths: z.array(z.string()).default(DEFAULT_CHECK_SKIP_PATHS),
  })
  .catchall(checkSchema)
  .prefault({});

const budgetSchema = z
  .object({
    per_run_tokens: z
      .record(z.string(), z.number().int().positive())
      .default({ quick: 50_000, standard: 200_000, deep: 500_000 }),
    hard_max_tokens: z.number().int().positive().default(600_000),
    monthly_usd: z.number().nonnegative().default(50),
    warn_at: z.number().min(0).max(1).default(0.8),
    monthly_hard_stop: z.boolean().default(true),
  })
  .prefault({});

const tiersSchema = z
  .object({
    low: z.object({ paths: z.array(z.string()).default(DEFAULT_LOW_PATHS) }).prefault({}),
    high: z.object({ paths: z.array(z.string()).default(DEFAULT_HIGH_PATHS) }).prefault({}),
    dependencies: z
      .object({
        paths: z.array(z.string()).default(DEFAULT_DEPENDENCY_PATHS),
        min_tier: z.enum(['medium', 'high']).default('medium'),
      })
      .prefault({}),
    diff_size: z
      .object({
        warn: z.number().int().positive().default(400),
        medium_at: z.number().int().positive().default(800),
        high_at: z.number().int().positive().default(1200),
        exclude: z.array(z.string()).default(DEFAULT_CHECK_SKIP_PATHS),
      })
      .prefault({}),
  })
  .prefault({});

const reviewSchema = z
  .object({
    skip_paths: z.array(z.string()).default(DEFAULT_REVIEW_SKIP_PATHS),
    light_paths: z.array(z.string()).default(['docs/**', '**/*.md']),
    context_limits: z
      .object({
        quick: z.number().int().positive().default(24_000),
        standard: z.number().int().positive().default(26_000),
        deep: z.number().int().positive().default(50_000),
      })
      .prefault({}),
    finders: z
      .object({
        quick: z.array(z.string()).default(['correctness']),
        standard: z.array(z.string()).default(['correctness', 'security', 'tests']),
        deep: z.array(z.string()).default(['correctness', 'security', 'tests', 'api_contract']),
      })
      .prefault({}),
    min_severity_to_report: z.enum(['blocker', 'important', 'minor', 'nit']).default('minor'),
    multi_agent: z.enum(['auto', 'on', 'off']).default('auto'),
  })
  .prefault({});

const cacheSchema = z
  .object({
    enabled: z.boolean().default(true),
  })
  .prefault({});

const approvalSchema = z
  .object({
    low: z
      .object({
        by: z.literal('self').default('self'),
        cooldown_min: z.number().nonnegative().default(30),
      })
      .prefault({}),
    medium: z
      .object({
        by: z.literal('self_evidence').default('self_evidence'),
        cooldown_min: z.number().nonnegative().default(0),
      })
      .prefault({}),
    high: z
      .object({
        by: z.literal('external').default('external'),
        cooldown_min: z.number().nonnegative().default(0),
      })
      .prefault({}),
    checklist_version: z.number().int().positive().default(3),
    invalidate_on_new_diff: z.boolean().default(true),
    allow_solo_override: z.boolean().default(false),
    require_low_medium: z.boolean().default(false),
  })
  .prefault({});

const roundsSchema = z
  .object({
    max: z.number().int().positive().default(3),
    diff_only_after: z.number().int().nonnegative().default(1),
    require_category_fix: z.boolean().default(true),
  })
  .prefault({});

const scannerSchema = z
  .object({
    enabled: z.boolean().default(false),
    required: z.boolean().default(false),
    blocking: z.boolean().default(true),
    timeout_sec: z.number().int().positive().default(300),
    cmd: z.string().min(1).optional(),
  })
  .prefault({});

const securitySchema = z
  .object({
    gitleaks: scannerSchema,
    semgrep: scannerSchema,
    osv: scannerSchema,
  })
  .prefault({});

const configSchema = z.object({
  version: z.literal(1),
  repo: z.string().optional(),
  providers: z.record(z.string(), providerSchema).default({}),
  pricing: z.record(z.string(), pricingSchema).default({}),
  models: z.record(z.string(), modelSchema).default({}),
  budget: budgetSchema,
  tiers: tiersSchema,
  checks: checksSchema,
  review: reviewSchema,
  cache: cacheSchema,
  approval: approvalSchema,
  rounds: roundsSchema,
  security: securitySchema,
  report: z.unknown().optional(),
});

export type ReviewConfig = z.infer<typeof configSchema>;
export type ProviderConfig = z.infer<typeof providerSchema>;
export type ModelConfig = z.infer<typeof modelSchema>;
export type PricingConfig = z.infer<typeof pricingSchema>;
export type CheckConfig = z.infer<typeof checkSchema>;

export interface LoadedConfig {
  config: ReviewConfig;
  configPath: string;
  configHash: string;
}

export async function loadConfig(repoRoot: string, configPath?: string): Promise<LoadedConfig> {
  const filePath = configPath
    ? path.resolve(repoRoot, configPath)
    : path.join(repoRoot, '.review', 'config.yml');

  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch {
    throw new ConfigError(
      `Config not found: ${filePath}. Create .review/config.yml (see review.config.example.yml).`,
    );
  }

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new ConfigError(`Invalid YAML in ${filePath}: ${(error as Error).message}`);
  }

  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`Invalid config ${filePath}:\n${issues}`);
  }

  const config = parsed.data;
  for (const [role, model] of Object.entries(config.models)) {
    if (!config.providers[model.provider]) {
      throw new ConfigError(
        `models.${role}.provider references unknown provider "${model.provider}".`,
      );
    }
  }

  return {
    config,
    configPath: filePath,
    configHash: sha256Prefixed(stableStringify(config)),
  };
}

export function parseTokenBudget(input: string): number {
  const normalized = input.trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)(k|m)?$/.exec(normalized);
  if (!match) {
    throw new ConfigError(`Invalid budget "${input}". Use a number like 50000 or 200k.`);
  }
  const value = Number(match[1]);
  const unit = match[2];
  const multiplier = unit === 'm' ? 1_000_000 : unit === 'k' ? 1_000 : 1;
  const tokens = Math.floor(value * multiplier);
  if (!Number.isFinite(tokens) || tokens <= 0) {
    throw new ConfigError(`Invalid budget "${input}".`);
  }
  return tokens;
}
