import { describe, expect, it } from "bun:test";

import { loadConfig } from "../src/config";
import { resolveModelConfig } from "../src/models";

describe("resolveModelConfig", () => {
  it("resolves DeepSeek defaults from the canonical key", () => {
    const r = resolveModelConfig(loadConfig({ LLM_DEEPSEEK_API_KEY: "dk" }));

    expect(r.provider).toBe("deepseek");
    expect(r.model).toBe("deepseek-v4-flash");
    expect(r.baseURL).toBe("https://api.deepseek.com");
    expect(r.apiKey).toBe("dk");
    expect(r.maxTokens).toBe(4096);
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
    expect(r.maxTokens).toBeUndefined();
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
    expect(r.maxTokens).toBe(32_768);
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

  it("throws for an unknown model, listing the allowed ones", () => {
    expect(() =>
      resolveModelConfig(
        loadConfig({ LLM_DEEPSEEK_API_KEY: "dk", LLM_MODEL: "deepseek-v4-pro" }),
      ),
    ).toThrow(/deepseek-v4-flash/);
  });

  it("throws for a missing key, naming the variable", () => {
    expect(() => resolveModelConfig(loadConfig({}))).toThrow(/LLM_DEEPSEEK_API_KEY/);
    expect(() =>
      resolveModelConfig(loadConfig({ LLM_PROVIDER: "moonshot-cn" })),
    ).toThrow(/LLM_MOONSHOT_CN_API_KEY/);
  });
});
