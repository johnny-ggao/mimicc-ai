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

export type ProviderId = "deepseek" | "moonshot-cn" | "zhipu-cn";

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
   * ask for is {@link OUTPUT_BUDGET}, which is far smaller and has to be — on
   * **some** providers the window counts messages and completion together. This
   * field's job is to cap that budget for a model too small to honour it, and to
   * stop anyone having to guess the number later.
   *
   * ⚠️ "Some" is load-bearing and was written as "the" until 2026-08-30: DeepSeek
   * counts the completion, 智谱 does not (`repro/33`, both measured). The budget
   * is small enough to be safe either way, which is why the difference costs
   * nothing — but a claim about *the window* that is really a claim about *one
   * provider* is how the other two defects in this file's history started.
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
 * ⚠️ **And it is DeepSeek's arithmetic, not the window's.** Measured 2026-08-30:
 * 智谱 accepted 971,327 input tokens alongside `max_tokens: 131_072` — a total of
 * 1,102,399 against a 1,048,576 window — with a 200. Two providers, two opposite
 * answers, so the paragraph above justifies this number **for the provider that
 * needs it**, and this one is a want on the other. Keeping it small is safe on
 * both; a fourth provider gets `repro/33` run at it before anyone assumes.
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
  keyEnvVar:
    "LLM_DEEPSEEK_API_KEY" | "LLM_MOONSHOT_CN_API_KEY" | "LLM_ZHIPU_CN_API_KEY";
  /** Deprecated alias for `keyEnvVar`, read only when `keyEnvVar` is unset. */
  legacyKeyEnvVar?: "LLM_API_KEY";
  defaultModel: string;
  models: Record<string, ModelSpec>;
  /**
   * Business codes this provider returns when the prompt is past the window.
   *
   * 🔴 **Without this the overflow protection is silently absent.**
   * `context/compaction.ts` does not recognise overflow itself — it asks
   * langchain, and langchain matches three hard-coded English phrases written
   * for OpenAI (`@langchain/openai/dist/utils/client.js:5-9`). DeepSeek happens
   * to hit `maximum context length`; 智谱 answers
   * `{"code":"1261","message":"Prompt exceeds max length"}` and hits none, so the
   * summarise-and-retry path never runs and the turn just fails. Measured
   * through this program's own stack: `repro/53-does-the-overflow-reach-us.ts`.
   *
   * **A code, not a phrase, and that is the point.** 智谱's own docs print the
   * message as `Prompt 超长` while the live API says `Prompt exceeds max length`
   * — the prose is already known to drift between doc and wire, and matching it
   * would hang the protection on an uncontracted sentence. The numeric code is
   * the part the 错误码 page actually contracts.
   *
   * Omitted for a provider that langchain already recognises. Empty is not a
   * bet that overflow cannot happen — it is a statement that the library's
   * phrases were checked against this provider and matched.
   */
  overflowCodes?: readonly string[];
}

export const PROVIDERS: Record<ProviderId, ProviderSpec> = {
  deepseek: {
    id: "deepseek",
    baseURL: "https://api.deepseek.com",
    keyEnvVar: "LLM_DEEPSEEK_API_KEY",
    // `LLM_API_KEY` was the program's only key before providers existed; it
    // meant DeepSeek. Kept as a narrow, logged alias rather than breaking every
    // existing .env and CI on the day a second provider landed.
    //
    // ⚠️ **It stopped being sufficient on its own on 2026-08-30**, when the
    // schema default moved to `zhipu-cn`: an environment carrying only this
    // variable no longer selects DeepSeek, it selects 智谱 and then fails for a
    // missing 智谱 key. The alias still works — `LLM_PROVIDER=deepseek` has to
    // be set alongside it. Deliberate: an alias that keeps silently steering the
    // provider choice is not deprecated, it is just undocumented.
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
  "zhipu-cn": {
    id: "zhipu-cn",
    // 🔴 **The Coding Plan endpoint, not the pay-as-you-go one.** 智谱 serves the
    // OpenAI protocol at two different paths and the account decides which one
    // answers: `/api/paas/v4` bills against balance, `/api/coding/paas/v4` against
    // a Coding Plan subscription. Measured 2026-08-30 with this project's key —
    // the pay-as-you-go path returns
    // `429 {"code":"1113","message":"余额不足或无可用资源包"}` for *every* request,
    // valid ones included, while the coding path answers 200. The registry names
    // the one this project actually runs on; a balance-billed account sets
    // `LLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4` and that is exactly what
    // the escape hatch is for.
    //
    // ⚠️ China platform only. `open.bigmodel.cn` and the international `z.ai` are
    // separate platforms with separate keys that 401 against each other — the
    // `-cn` suffix is the only warning anyone gets, same as `moonshot-cn`.
    baseURL: "https://open.bigmodel.cn/api/coding/paas/v4",
    keyEnvVar: "LLM_ZHIPU_CN_API_KEY",
    defaultModel: "glm-5.3-flash",
    // 1261 = "Prompt 超长" in the 错误码 page, "Prompt exceeds max length" on the
    // wire. See the field's doc above for why this exists and what breaks without it.
    overflowCodes: ["1261"],
    models: {
      // 🔴 **Neither number is measured.** Both come from 智谱's docs, and the
      // probe that would confirm them cannot run: the account behind
      // `LLM_ZHIPU_CN_API_KEY` answers every request — valid ones included —
      // with `429 {"code":"1113","message":"余额不足或无可用资源包"}`. That
      // check fires *before* parameter validation, so even `repro/32`'s free 400 is
      // out of reach here, unlike DeepSeek and Moonshot. Re-run
      // `bun repro/32-what-the-provider-allows.ts` once the account has balance.
      //
      // - output 131_072: 对话补全 API reference states `max_tokens` range
      //   [1, 131072]; the model card's "128K output" is the same number written
      //   the other way (128 × 1024). Documented, and the two doc pages agree.
      // - window 1_048_576: measured, and it cost a million tokens to learn.
      //   The docs only ever write "1M", never the integer, and the two readings
      //   are 48,576 apart. This entry first took the **low** reading on purpose
      //   — on this provider an over-read is not a caught overflow but a failed
      //   request — and `repro/55-is-the-registered-window-the-real-one.ts`
      //   showed that was wrong: **1,021,379 tokens of input answered 200**, and
      //   a shot above 1,048,576 answers 400. So the window is 2^20, the same
      //   convention the docs use when they write "128K" for a limit their API
      //   reference states as 131,072.
      //
      //   ⚠️ **The cheap outcome and the informative one are opposite here.**
      //   A refusal is free and a success is billed at a full window, so a
      //   provider that under-reports quietly is expensive to catch — which is
      //   the argument for measuring once and writing the number down, not for
      //   guessing conservatively and moving on.
      "glm-5.3-flash": { windowLimit: 1_048_576, maxOutputTokens: 131_072 },
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
  /**
   * This provider's own overflow signals, always an array — empty means
   * langchain's phrases were checked and matched. See {@link ProviderSpec.overflowCodes}.
   */
  overflowCodes: readonly string[];
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
    overflowCodes: provider.overflowCodes ?? [],
    usedLegacyKey: canonicalKey === undefined && legacyKey !== undefined,
  };
}
