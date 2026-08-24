import { describe, expect, it } from "bun:test";

import { loadConfig } from "../src/config";
import { OUTPUT_BUDGET, PROVIDERS, resolveModelConfig } from "../src/models";
import { TRIGGER_FRACTION } from "../src/context/compaction";

describe("resolveModelConfig", () => {
  it("resolves DeepSeek defaults from the canonical key", () => {
    const r = resolveModelConfig(loadConfig({ LLM_DEEPSEEK_API_KEY: "dk" }));

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
    const r = resolveModelConfig(loadConfig({ LLM_API_KEY: "legacy" }));

    expect(r.apiKey).toBe("legacy");
    expect(r.usedLegacyKey).toBe(true);
  });

  it("prefers the canonical key over the legacy alias", () => {
    const r = resolveModelConfig(
      loadConfig({ LLM_DEEPSEEK_API_KEY: "canonical", LLM_API_KEY: "legacy" }),
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

  it("honours the LLM_BASE_URL override", () => {
    const r = resolveModelConfig(
      loadConfig({
        LLM_DEEPSEEK_API_KEY: "dk",
        LLM_BASE_URL: "https://proxy.example/v1",
      }),
    );

    expect(r.baseURL).toBe("https://proxy.example/v1");
  });

  it("throws for an unknown provider, listing the allowed ones", () => {
    expect(() => resolveModelConfig(loadConfig({ LLM_PROVIDER: "openai" }))).toThrow(
      /deepseek, moonshot-cn/,
    );
  });

  // The name is the point: this covers the *unknown model* path. It used to reach
  // for `deepseek-v4-pro` as the example, which was a real model the registry had
  // simply never listed — so the test froze the gap in place and read as though
  // the omission were intended. Use an id the provider does not have.
  it("throws for an unknown model, listing the allowed ones", () => {
    expect(() =>
      resolveModelConfig(
        loadConfig({ LLM_DEEPSEEK_API_KEY: "dk", LLM_MODEL: "deepseek-v9-nonexistent" }),
      ),
    ).toThrow(/deepseek-v4-flash/);
  });

  it("resolves deepseek-v4-pro, which GET /models lists alongside flash", () => {
    const r = resolveModelConfig(
      loadConfig({ LLM_DEEPSEEK_API_KEY: "dk", LLM_MODEL: "deepseek-v4-pro" }),
    );
    expect(r.model).toBe("deepseek-v4-pro");
    expect(r.windowLimit).toBe(1_048_576);
  });

  it("throws for a missing key, naming the variable", () => {
    expect(() => resolveModelConfig(loadConfig({}))).toThrow(/LLM_DEEPSEEK_API_KEY/);
    expect(() =>
      resolveModelConfig(loadConfig({ LLM_PROVIDER: "moonshot-cn" })),
    ).toThrow(/LLM_MOONSHOT_CN_API_KEY/);
  });
});

/**
 * The coupling `repro/33-does-output-share-the-window.ts` measured, pinned.
 *
 * DeepSeek counts the window as messages + completion, so what this program asks
 * for is subtracted from what the history may hold. `compaction.ts` starts
 * summarising at `TRIGGER_FRACTION` of the window and calls the rest margin
 * against its own token arithmetic. A completion budget has to fit inside that
 * margin *next to* an estimate error, not merely inside it.
 *
 * ⚠️ This test is the reason the two numbers cannot drift apart silently. It
 * fails if someone raises OUTPUT_BUDGET toward a provider ceiling, which is
 * exactly the mistake made and caught on 2026-08-24.
 */
describe("the output budget fits inside the compaction margin", () => {
  for (const provider of Object.values(PROVIDERS)) {
    for (const [name, spec] of Object.entries(provider.models)) {
      it(`${name}: budget leaves the summariser room to act first`, () => {
        const headroom = spec.windowLimit * (1 - TRIGGER_FRACTION);
        expect(OUTPUT_BUDGET).toBeLessThan(headroom);
        expect(OUTPUT_BUDGET).toBeLessThan(headroom * 0.1);
      });
    }
  }
});
