import { describe, expect, it } from "bun:test";

import { loadConfig } from "../src/config";

// No key is required at parse time any more — keys are per-provider and resolved
// by `resolveModelConfig`, not by this schema. So cases need no ambient key.
describe("loadConfig", () => {
  it("applies defaults when optional variables are absent", () => {
    const config = loadConfig({});

    expect(config.NODE_ENV).toBe("development");
    expect(config.LOG_LEVEL).toBe("info");
    expect(config.LLM_PROVIDER).toBe("zhipu-cn");
    expect(config.LLM_MODEL).toBeUndefined();
    expect(config.LLM_BASE_URL).toBeUndefined();
  });

  it("reads values from the provided environment", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      LOG_LEVEL: "warn",
      LLM_PROVIDER: "moonshot-cn",
      LLM_MODEL: "kimi-k2.6",
      LLM_BASE_URL: "https://example.com/v1",
      LLM_MOONSHOT_CN_API_KEY: "mk",
    });

    expect(config.NODE_ENV).toBe("production");
    expect(config.LOG_LEVEL).toBe("warn");
    expect(config.LLM_PROVIDER).toBe("moonshot-cn");
    expect(config.LLM_MODEL).toBe("kimi-k2.6");
    expect(config.LLM_BASE_URL).toBe("https://example.com/v1");
    expect(config.LLM_MOONSHOT_CN_API_KEY).toBe("mk");
  });

  it("throws a readable error for an invalid value", () => {
    expect(() => loadConfig({ LOG_LEVEL: "verbose" })).toThrow(
      /Invalid environment configuration/,
    );
  });

  it("rejects a base URL that is not a URL", () => {
    expect(() => loadConfig({ LLM_BASE_URL: "not-a-url" })).toThrow(/LLM_BASE_URL/);
  });
});
