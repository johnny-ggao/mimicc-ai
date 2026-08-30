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
   * The provider's **real** output ceiling for this model, in tokens. Required,
   * and the requirement is the point: a registry entry carrying an invented
   * number is worse than no entry, because the invented number looks measured.
   *
   * Measured or documented, never guessed — same rule as {@link windowLimit}.
   * Re-derive any entry with `bun repro/32-what-the-provider-allows.ts`, which
   * asks each registered model for an impossible `max_tokens` and reads the
   * ceiling out of the refusal.
   *
   * 🔴 **This is the capability, and it is not what goes on the wire.** What we
   * ask for is {@link OUTPUT_BUDGET}, which is far smaller and has to be — the
   * window counts messages and completion together. This field's job is to cap
   * that budget for a model too small to honour it, and to stop anyone having to
   * guess the number later.
   */
  maxOutputTokens: number;
  /**
   * `false` for a model whose ceiling must **not** be sent as `max_tokens`.
   *
   * Sending nothing is not the same as not knowing: `kimi-k3` reports
   * `max_completion_tokens`, a parameter `ChatOpenAI` only emits for OpenAI
   * o* / gpt-5 models, so any value we put in `max_tokens` is sent under a name
   * the provider ignores. Staying silent lets Moonshot apply its own ceiling,
   * which is the one we want anyway. The real number still lives in
   * {@link maxOutputTokens}; this flag only decides whether it reaches the wire.
   */
  sendsMaxTokens?: false;
}

/**
 * How many output tokens this program asks for on one answer, before the window
 * clamps it. **A want, not a ceiling** — `outputCeiling` in
 * `src/context/compaction.ts` lowers it per request as the history fills up.
 *
 * 16384 is pi's per-model default (`packages/coding-agent/src/core/provider-composer.ts:161`),
 * copied rather than reasoned out from scratch: it is a program of the same
 * shape — a terminal coding agent — answering the same question. It is roughly
 * the largest answer this program has a legitimate use for, a `Write` of a
 * sizeable new file, and far below any provider ceiling.
 *
 * ⚠️ **It could not have been this large before the clamp existed.** Until
 * 2026-08-24 this number went to the wire untouched, so it had to be small
 * enough to be safe against a nearly-full window on its own — measured then:
 *
 *   > This model's maximum context length is 1048576 tokens. However, you
 *   > requested 1249764 tokens (856548 in the messages, 393216 in the
 *   > completion). Please reduce the length of the messages or completion.
 *
 * DeepSeek counts the window as **messages + completion**, so every token asked
 * for here is a token the history cannot use. Asking for the provider's real
 * ceiling (393,216) leaves 655,360 for input — **below the 838,860 at which
 * `context/compaction.ts` starts summarising**, so the request would be refused
 * before the overflow protection ever ran. `repro/33-does-output-share-the-window.ts`
 * is that experiment, control group included.
 *
 * That danger is now handled where it belongs, per request, so the number is
 * free to describe what an answer needs instead of what a full window survives.
 * `tests/models.test.ts` pins the clamp against every registered window.
 */
export const OUTPUT_BUDGET = 16_384;

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
    // `GET /models` lists three ids: these two and `deepseek-v4-flash-vision-exp`.
    // The vision model is left out deliberately — this program sends no images,
    // so registering it would advertise a capability the tools cannot reach.
    //
    // Both entries carry the same two numbers because the provider gives them
    // the same two numbers, checked 2026-08-24 from both directions:
    //   - window: the pricing table's "Model Details" says 1M for every v4 model,
    //     and 1_048_576 is the figure `repro/08-overflow.ts` measured on flash by
    //     walking into the hard 400.
    //   - output: asking for `max_tokens: 999_999_999` is refused with *the valid
    //     range of max_tokens is [1, 393216]* — identically for flash, pro, and
    //     the vision model.
    //
    // 🔑 `windowLimit` is the provider's own figure for both, not an
    // extrapolation from flash: the refusal in `repro/33` names it for `pro`
    // outright — *This model's maximum context length is 1048576 tokens*.
    models: {
      "deepseek-v4-flash": { windowLimit: 1_048_576, maxOutputTokens: 393_216 },
      "deepseek-v4-pro": { windowLimit: 1_048_576, maxOutputTokens: 393_216 },
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
      // `isReasoningModel`). So whatever we put in `max_tokens` is sent under a
      // name K3 ignores, and staying silent lets Moonshot apply its own ceiling
      // — which is the one we want. `sendsMaxTokens: false` says exactly that,
      // and keeps it distinguishable from "nobody looked the number up".
      //
      // ⚠️ **These three numbers are the weakest in the registry.** 131072 is
      // the figure the previous comment recorded as Moonshot's default for K3;
      // 32768 arrived with the entries and has no recorded source. Neither has
      // been through the refusal probe, because the Moonshot key was removed
      // from `.env` on 2026-08-24 and nothing here can reach that API today.
      // Run `bun repro/32-what-the-provider-allows.ts` with a Moonshot key to
      // replace them with measured values.
      "kimi-k3": {
        windowLimit: 1_048_576,
        maxOutputTokens: 131_072,
        sendsMaxTokens: false,
      },
      "kimi-k2.7-code": { windowLimit: 262_144, maxOutputTokens: 32_768 },
      "kimi-k2.6": { windowLimit: 262_144, maxOutputTokens: 32_768 },
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
  /**
   * The provider's real output ceiling, always populated. Carried separately
   * from {@link maxTokens} because a model can have a ceiling this program must
   * not send (see {@link ModelSpec.sendsMaxTokens}).
   */
  maxOutputTokens: number;
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
    // Three states, and they are all different: ask for the program's budget,
    // ask for less because this model cannot honour that much, or ask for
    // nothing at all. Never ask for `maxOutputTokens` — that is the provider's
    // ceiling, and on a window that counts the completion it would starve the
    // history (see OUTPUT_BUDGET).
    maxTokens:
      spec.sendsMaxTokens === false
        ? undefined
        : Math.min(OUTPUT_BUDGET, spec.maxOutputTokens),
    maxOutputTokens: spec.maxOutputTokens,
    windowLimit: spec.windowLimit,
    usedLegacyKey: canonicalKey === undefined && legacyKey !== undefined,
  };
}
