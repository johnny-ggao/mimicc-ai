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
  //
  // ⚠️ **The default moved from `deepseek` to `zhipu-cn` on 2026-08-30**, which
  // changes what an *empty* environment does, not just what the docs say. Two
  // consequences worth knowing before moving it again:
  //   - `LLM_API_KEY`, the deprecated alias, is DeepSeek's key and only
  //     DeepSeek's. An environment carrying nothing but that used to run; now it
  //     fails with "missing API key for provider zhipu-cn" until `LLM_PROVIDER`
  //     names DeepSeek. That is the deprecation working, not a regression — but
  //     it is a failure at startup, so it should surprise nobody twice.
  //   - Every test that wants DeepSeek now has to say so. Three in
  //     `tests/models.test.ts` used to get it by default and would otherwise
  //     have started asserting 智谱's numbers under a DeepSeek name.
  LLM_PROVIDER: z.string().min(1).default("zhipu-cn"),
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
  LLM_ZHIPU_CN_API_KEY: z.string().min(1).optional(),

  // Which web-search backend the WebSearch tool runs on (web-tools ticket 01).
  // One name, one live backend — the seam is designed for swapping, not for a
  // fleet. `off` disables the tool; an unknown name throws at startup
  // (`resolveSearchBackend`), same refuse-don't-fallback as `--exclude-tools`.
  MIMICC_WEB_SEARCH_BACKEND: z.string().min(1).default("zhipu-web-search"),

  // Turn-budget overrides (turn-budget ticket 02). The work budget lives on the
  // token/time axis — there is no step budget. Defaults: token budget = the
  // effective window limit × 4, wall-clock backstop = 10 minutes per turn.
  MIMICC_TURN_TOKEN_BUDGET_MULTIPLIER: z.coerce.number().positive().default(4),
  MIMICC_TURN_TIME_BUDGET_MS: z.coerce.number().positive().default(600_000),
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
