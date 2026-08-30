import { describe, expect, it } from "bun:test";

import { loadConfig } from "../src/config";
import { OUTPUT_BUDGET, PROVIDERS, resolveModelConfig } from "../src/models";
import {
  CONTEXT_SAFETY_TOKENS,
  isOverflow,
  MIN_OUTPUT_TOKENS,
  outputCeiling,
  TRIGGER_FRACTION,
} from "../src/context/compaction";

describe("resolveModelConfig", () => {
  // `LLM_PROVIDER` is spelled out in every DeepSeek case below. It used to be
  // implied — the schema's default was `deepseek` until 2026-08-30 — and leaving
  // it implied after the default moved would have quietly re-pointed these
  // assertions at 智谱 while the test names still said DeepSeek.
  it("resolves DeepSeek defaults from the canonical key", () => {
    const r = resolveModelConfig(
      loadConfig({ LLM_PROVIDER: "deepseek", LLM_DEEPSEEK_API_KEY: "dk" }),
    );

    expect(r.provider).toBe("deepseek");
    expect(r.model).toBe("deepseek-v4-flash");
    expect(r.baseURL).toBe("https://api.deepseek.com");
    expect(r.apiKey).toBe("dk");
    expect(r.maxTokens).toBe(OUTPUT_BUDGET);
    expect(r.maxOutputTokens).toBe(393_216);
    expect(r.windowLimit).toBe(1_048_576);
    expect(r.usedLegacyKey).toBe(false);
  });

  it("falls back to the legacy LLM_API_KEY for DeepSeek and flags it", () => {
    const r = resolveModelConfig(
      loadConfig({ LLM_PROVIDER: "deepseek", LLM_API_KEY: "legacy" }),
    );

    expect(r.apiKey).toBe("legacy");
    expect(r.usedLegacyKey).toBe(true);
  });

  it("prefers the canonical key over the legacy alias", () => {
    const r = resolveModelConfig(
      loadConfig({
        LLM_PROVIDER: "deepseek",
        LLM_DEEPSEEK_API_KEY: "canonical",
        LLM_API_KEY: "legacy",
      }),
    );

    expect(r.apiKey).toBe("canonical");
    expect(r.usedLegacyKey).toBe(false);
  });

  it("resolves Moonshot with its default model", () => {
    const r = resolveModelConfig(
      loadConfig({ LLM_PROVIDER: "moonshot-cn", LLM_MOONSHOT_CN_API_KEY: "mk" }),
    );

    expect(r.provider).toBe("moonshot-cn");
    expect(r.model).toBe("kimi-k3");
    expect(r.baseURL).toBe("https://api.moonshot.cn/v1");
    expect(r.apiKey).toBe("mk");
    // kimi-k3 reports `max_completion_tokens`, not `max_tokens`, so no output cap
    // is sent — Moonshot's own default applies.
    // kimi-k3 knows its ceiling and deliberately does not send it — the two
    // fields exist to keep that distinguishable from "nobody looked it up".
    expect(r.maxTokens).toBeUndefined();
    expect(r.maxOutputTokens).toBe(131_072);
    expect(r.windowLimit).toBe(1_048_576);
  });

  it("resolves a named Moonshot model with its own facts", () => {
    const r = resolveModelConfig(
      loadConfig({
        LLM_PROVIDER: "moonshot-cn",
        LLM_MODEL: "kimi-k2.6",
        LLM_MOONSHOT_CN_API_KEY: "mk",
      }),
    );

    expect(r.model).toBe("kimi-k2.6");
    expect(r.maxTokens).toBe(OUTPUT_BUDGET);
    expect(r.maxOutputTokens).toBe(32_768);
    expect(r.windowLimit).toBe(262_144);
  });

  it("resolves 智谱 with its only registered model — and it is the default", () => {
    // No `LLM_PROVIDER` here on purpose: 智谱 is the schema default since
    // 2026-08-30, so the default gets a case of its own rather than only ever
    // being the thing every other case spells out to avoid.
    const r = resolveModelConfig(loadConfig({ LLM_ZHIPU_CN_API_KEY: "zk" }));

    expect(r.provider).toBe("zhipu-cn");
    expect(r.model).toBe("glm-5.3-flash");
    expect(r.baseURL).toBe("https://open.bigmodel.cn/api/coding/paas/v4");
    expect(r.apiKey).toBe("zk");
    expect(r.maxTokens).toBe(OUTPUT_BUDGET);
    expect(r.maxOutputTokens).toBe(131_072);
    // Measured, not documented: 1,021,379 tokens of input answered 200 and a
    // shot past 2^20 answered 400 (`repro/55`). The docs only ever say "1M".
    expect(r.windowLimit).toBe(1_048_576);
  });

  it("does not read the DeepSeek legacy alias for another provider", () => {
    // `LLM_API_KEY` means DeepSeek and only DeepSeek. A provider registered
    // without a `legacyKeyEnvVar` must not quietly borrow it.
    expect(() =>
      resolveModelConfig(
        loadConfig({ LLM_PROVIDER: "zhipu-cn", LLM_API_KEY: "legacy" }),
      ),
    ).toThrow(/LLM_ZHIPU_CN_API_KEY/);
  });

  it("honours the LLM_BASE_URL override", () => {
    const r = resolveModelConfig(
      loadConfig({
        LLM_PROVIDER: "deepseek",
        LLM_DEEPSEEK_API_KEY: "dk",
        LLM_BASE_URL: "https://proxy.example/v1",
      }),
    );

    expect(r.baseURL).toBe("https://proxy.example/v1");
  });

  it("throws for an unknown provider, listing the allowed ones", () => {
    expect(() => resolveModelConfig(loadConfig({ LLM_PROVIDER: "openai" }))).toThrow(
      /deepseek, moonshot-cn, zhipu-cn/,
    );
  });

  // The name is the point: this covers the *unknown model* path. It used to reach
  // for `deepseek-v4-pro` as the example, which was a real model the registry had
  // simply never listed — so the test froze the gap in place and read as though
  // the omission were intended. Use an id the provider does not have.
  it("throws for an unknown model, listing the allowed ones", () => {
    expect(() =>
      resolveModelConfig(
        loadConfig({
          LLM_PROVIDER: "deepseek",
          LLM_DEEPSEEK_API_KEY: "dk",
          LLM_MODEL: "deepseek-v9-nonexistent",
        }),
      ),
    ).toThrow(/deepseek-v4-flash/);
  });

  it("resolves deepseek-v4-pro, which GET /models lists alongside flash", () => {
    const r = resolveModelConfig(
      loadConfig({
        LLM_PROVIDER: "deepseek",
        LLM_DEEPSEEK_API_KEY: "dk",
        LLM_MODEL: "deepseek-v4-pro",
      }),
    );
    expect(r.model).toBe("deepseek-v4-pro");
    expect(r.windowLimit).toBe(1_048_576);
  });

  it("throws for a missing key, naming the variable", () => {
    expect(() => resolveModelConfig(loadConfig({ LLM_PROVIDER: "deepseek" }))).toThrow(
      /LLM_DEEPSEEK_API_KEY/,
    );
    // The empty environment lands on 智谱 now, and pinning that is the point:
    // this line is what a `.env`-less run actually does.
    expect(() => resolveModelConfig(loadConfig({}))).toThrow(/LLM_ZHIPU_CN_API_KEY/);
    expect(() =>
      resolveModelConfig(loadConfig({ LLM_PROVIDER: "moonshot-cn" })),
    ).toThrow(/LLM_MOONSHOT_CN_API_KEY/);
    expect(() => resolveModelConfig(loadConfig({ LLM_PROVIDER: "zhipu-cn" }))).toThrow(
      /LLM_ZHIPU_CN_API_KEY/,
    );
  });
});

/**
 * The coupling `repro/33-does-output-share-the-window.ts` measured, pinned.
 *
 * DeepSeek counts the window as messages + completion, so what this program asks
 * for is subtracted from what the history may hold.
 *
 * ⚠️ **This replaces a weaker test.** Until 2026-08-24 it asserted that
 * `OUTPUT_BUDGET` alone was a small fraction of the compaction margin — which was
 * the only defence available while that constant went to the wire untouched. It
 * is not the defence any more: the budget is now a *want* that `outputCeiling`
 * lowers per request, so the property worth holding is about the clamp, not about
 * the constant. Deleting the old one without this would have dropped the guard
 * that caught the 2026-08-24 mistake.
 */
describe("the clamp keeps a request inside the window, whatever the budget is", () => {
  for (const provider of Object.values(PROVIDERS)) {
    for (const [name, spec] of Object.entries(provider.models)) {
      it(`${name}: a nearly-full context cannot push a request over the window`, () => {
        // The worst case the trigger allows through: summarising starts here, so
        // a request may legitimately be this large before anything shrinks it.
        const used = Math.floor(spec.windowLimit * TRIGGER_FRACTION);
        const ceiling = outputCeiling(OUTPUT_BUDGET, used, spec.windowLimit);
        expect(used + ceiling).toBeLessThanOrEqual(spec.windowLimit);
      });

      it(`${name}: an empty context gets the whole budget`, () => {
        expect(outputCeiling(OUTPUT_BUDGET, 0, spec.windowLimit)).toBe(OUTPUT_BUDGET);
      });
    }
  }

  it("never returns less than the floor, however full the context", () => {
    expect(outputCeiling(OUTPUT_BUDGET, 1_048_576, 1_048_576)).toBe(MIN_OUTPUT_TOKENS);
  });

  it("holds back the safety margin the estimate is allowed to be wrong in", () => {
    // Room for exactly the budget plus the margin: the budget still fits.
    const limit = 100_000;
    const used = limit - OUTPUT_BUDGET - CONTEXT_SAFETY_TOKENS;
    expect(outputCeiling(OUTPUT_BUDGET, used, limit)).toBe(OUTPUT_BUDGET);
    // One token more of history and the answer has to give one token back.
    expect(outputCeiling(OUTPUT_BUDGET, used + 1, limit)).toBe(OUTPUT_BUDGET - 1);
  });
});

/**
 * The registry's overflow codes, and the thing that breaks without them.
 *
 * 🔴 **A provider langchain does not recognise loses its overflow protection
 * silently.** `compaction.ts` never inspects the failure itself — it asks whether
 * langchain built a `ContextOverflowError`, and langchain builds one by matching
 * three English phrases. 智谱 answers `{"code":"1261","message":"Prompt exceeds
 * max length"}` and matches none, so the summarise-and-retry path simply never
 * ran: the turn failed instead. Measured end to end in
 * `repro/53-does-the-overflow-reach-us.ts`; pinned here so it cannot regress
 * without a red test.
 */
describe("overflow codes travel from the registry to the judge", () => {
  // The shape the OpenAI SDK actually hands us, measured: a `BadRequestError`
  // with `status` and `code` on it, no `ContextOverflowError` anywhere.
  const zhipuOverflow = Object.assign(new Error("400 Prompt exceeds max length"), {
    status: 400,
    code: "1261",
  });

  it("does not recognise a 智谱 overflow without the registry's codes", () => {
    expect(isOverflow(zhipuOverflow)).toBe(false);
  });

  it("recognises it with them", () => {
    expect(isOverflow(zhipuOverflow, ["1261"])).toBe(true);
  });

  it("carries them onto the resolved model, so main.ts has something to pass", () => {
    const r = resolveModelConfig(
      loadConfig({ LLM_PROVIDER: "zhipu-cn", LLM_ZHIPU_CN_API_KEY: "zk" }),
    );
    expect(r.overflowCodes).toEqual(["1261"]);
  });

  it("is empty for a provider langchain already recognises", () => {
    // Not an oversight: DeepSeek's refusal says `maximum context length`, which
    // langchain matches. Empty means checked, not skipped.
    const r = resolveModelConfig(
      loadConfig({ LLM_PROVIDER: "deepseek", LLM_DEEPSEEK_API_KEY: "dk" }),
    );
    expect(r.overflowCodes).toEqual([]);
  });

  it("ignores a code-shaped field that is not a code", () => {
    const weird = Object.assign(new Error("nope"), { code: { nested: true } });
    expect(isOverflow(weird, ["1261"])).toBe(false);
  });
});
