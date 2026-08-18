import { z } from "zod";

/**
 * Environment schema. Add new variables here — everything downstream reads the
 * parsed, typed object rather than `process.env` directly.
 *
 * The model itself is no longer described here. `LLM_PROVIDER` + `LLM_MODEL`
 * pick an entry out of the provider registry in `src/models.ts`, which owns the
 * per-model facts (window limit, max tokens, base URL, key variable). This file
 * only parses the raw environment; turning it into one concrete model is
 * `resolveModelConfig`'s job.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  // Which provider the program runs on. Validated against the registry in
  // `resolveModelConfig`, not here — the registry is the single source of truth
  // for the provider list, and a `z.enum` here would be a second copy to drift.
  LLM_PROVIDER: z.string().min(1).default("deepseek"),
  // Optional: defaults to the selected provider's default model. Must name a
  // model registered for that provider — an unknown name fails at startup,
  // because the window limit a model's overflow protection depends on is a
  // measured fact, not something to guess for an alias (see src/models.ts).
  LLM_MODEL: z.string().min(1).optional(),
  // Optional override over the provider's registered base URL. Kept as an escape
  // hatch for proxies and self-hosted OpenAI-compatible endpoints. Overriding it
  // keeps the selected model's window/max-token facts, which may not match the
  // foreign endpoint — that mismatch is the caller's responsibility.
  LLM_BASE_URL: z.url().optional(),

  // Per-provider API keys. The registry maps each provider to its key variable.
  // `LLM_API_KEY` is the deprecated name for the DeepSeek key, read only when
  // `LLM_DEEPSEEK_API_KEY` is unset (see resolveModelConfig).
  LLM_API_KEY: z.string().min(1).optional(),
  LLM_DEEPSEEK_API_KEY: z.string().min(1).optional(),
  LLM_MOONSHOT_CN_API_KEY: z.string().min(1).optional(),
});

export type Config = z.infer<typeof envSchema>;

/**
 * Parses and validates the environment. Throws with a readable summary of every
 * invalid variable at once rather than failing one at a time at first use.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): Config {
  const result = envSchema.safeParse(env);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  return result.data;
}
