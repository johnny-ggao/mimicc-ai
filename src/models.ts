import type { Config } from "./config";

/**
 * The provider/model registry, and the resolution that turns a parsed
 * environment into the one model the program runs on.
 *
 * Two facts used to live as globals — `WINDOW_LIMIT` (a constant) and
 * `maxTokens` (a literal in main.ts) — both silently assumed the program's one
 * model, DeepSeek. Adding a second provider made both per-model, and this file
 * is where they now live. A window limit is a *measured* fact, not a default:
 * DeepSeek's 1,048,576 was measured from the provider's own refusal (see
 * context/compaction.ts), and Moonshot's numbers come from its documentation
 * (`docs/research/moonshot-provider-facts.md`). Unknown models are refused
 * rather than run with a guessed window.
 */

export type ProviderId = "deepseek" | "moonshot-cn";

export interface ModelSpec {
  /** The context-window ceiling, in tokens. Measured or documented, never guessed. */
  windowLimit: number;
  /**
   * The output-token ceiling handed to ChatOpenAI as `maxTokens`. Absent means
   * "leave it to the provider's own default" — the right answer for a model
   * whose parameter is not the `max_tokens` that ChatOpenAI emits (see the
   * `kimi-k3` entry).
   */
  maxTokens?: number;
}

export interface ProviderSpec {
  id: ProviderId;
  /** baseURL sent to ChatOpenAI, including any required `/v1` suffix. */
  baseURL: string;
  /** The env var whose value is this provider's API key. */
  keyEnvVar: "LLM_DEEPSEEK_API_KEY" | "LLM_MOONSHOT_CN_API_KEY";
  /** Deprecated alias for `keyEnvVar`, read only when `keyEnvVar` is unset. */
  legacyKeyEnvVar?: "LLM_API_KEY";
  defaultModel: string;
  models: Record<string, ModelSpec>;
}

export const PROVIDERS: Record<ProviderId, ProviderSpec> = {
  deepseek: {
    id: "deepseek",
    baseURL: "https://api.deepseek.com",
    keyEnvVar: "LLM_DEEPSEEK_API_KEY",
    // `LLM_API_KEY` was the program's only key before providers existed; it
    // meant DeepSeek. Kept as a narrow, logged alias rather than breaking every
    // existing .env and CI on the day a second provider landed.
    legacyKeyEnvVar: "LLM_API_KEY",
    defaultModel: "deepseek-v4-flash",
    models: {
      "deepseek-v4-flash": { windowLimit: 1_048_576, maxTokens: 4096 },
    },
  },
  "moonshot-cn": {
    id: "moonshot-cn",
    // `/v1` is part of Moonshot's documented base URL, unlike DeepSeek's.
    baseURL: "https://api.moonshot.cn/v1",
    keyEnvVar: "LLM_MOONSHOT_CN_API_KEY",
    defaultModel: "kimi-k3",
    models: {
      // K3 reports `max_completion_tokens`, not `max_tokens`, and ChatOpenAI
      // only emits `max_completion_tokens` for OpenAI o* / gpt-5 models (its
      // `isReasoningModel`). Leaving maxTokens absent means no output cap is
      // sent and Moonshot applies its own default (131072) — which is exactly
      // the "align to the provider's default" target, reached by not fighting
      // the wrong parameter name.
      "kimi-k3": { windowLimit: 1_048_576 },
      "kimi-k2.7-code": { windowLimit: 262_144, maxTokens: 32_768 },
      "kimi-k2.6": { windowLimit: 262_144, maxTokens: 32_768 },
    },
  },
};

/** One model, fully resolved: everything `createUniversalAgent` needs. */
export interface ResolvedModelConfig {
  provider: ProviderId;
  model: string;
  baseURL: string;
  apiKey: string;
  maxTokens: number | undefined;
  windowLimit: number;
  /** True when the key came from the deprecated `LLM_API_KEY` alias. */
  usedLegacyKey: boolean;
}

/**
 * Turns the parsed environment into one concrete model, or throws.
 *
 * All three failure modes — unknown provider, unknown model, missing key — throw
 * here rather than in zod, because two of them ("which providers exist", "which
 * models a provider has") are the registry's knowledge, not the schema's.
 */
export function resolveModelConfig(env: Config): ResolvedModelConfig {
  const provider = (PROVIDERS as Record<string, ProviderSpec | undefined>)[
    env.LLM_PROVIDER
  ];
  if (provider === undefined) {
    throw new Error(
      `unknown LLM_PROVIDER "${env.LLM_PROVIDER}"; allowed: ${Object.keys(PROVIDERS).join(", ")}`,
    );
  }

  const model = env.LLM_MODEL ?? provider.defaultModel;
  const spec = provider.models[model];
  if (spec === undefined) {
    throw new Error(
      `unknown model "${model}" for provider "${provider.id}"; allowed: ${Object.keys(provider.models).join(", ")}`,
    );
  }

  const canonicalKey = env[provider.keyEnvVar];
  const legacyKey =
    provider.legacyKeyEnvVar !== undefined ? env[provider.legacyKeyEnvVar] : undefined;
  const apiKey = canonicalKey ?? legacyKey;
  if (apiKey === undefined) {
    const names =
      provider.legacyKeyEnvVar !== undefined
        ? `${provider.keyEnvVar} (or ${provider.legacyKeyEnvVar})`
        : provider.keyEnvVar;
    throw new Error(`missing API key for provider "${provider.id}": set ${names}`);
  }

  return {
    provider: provider.id,
    model,
    baseURL: env.LLM_BASE_URL ?? provider.baseURL,
    apiKey,
    maxTokens: spec.maxTokens,
    windowLimit: spec.windowLimit,
    usedLegacyKey: canonicalKey === undefined && legacyKey !== undefined,
  };
}
