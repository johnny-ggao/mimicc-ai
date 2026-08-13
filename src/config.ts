import { z } from "zod";

/**
 * Environment schema. Add new variables here — everything downstream reads the
 * parsed, typed object rather than `process.env` directly.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  LLM_BASE_URL: z.url().default("https://api.deepseek.com"),
  LLM_API_KEY: z.string().min(1),
  // DeepSeek's API reference lists exactly two models, `deepseek-v4-flash` and
  // `deepseek-v4-pro`. `deepseek-chat` still answers but is no longer among them
  // — an alias pointing somewhere undocumented, which is a poor thing to hold a
  // token baseline against.
  LLM_MODEL: z.string().min(1).default("deepseek-v4-flash"),
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
