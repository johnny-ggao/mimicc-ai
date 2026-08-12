import { describe, expect, it } from "bun:test";

import { loadConfig } from "../src/config";

// LLM_API_KEY is required, so every case has to supply it explicitly rather
// than leaning on the ambient process environment.
const KEY = { LLM_API_KEY: "test-key" };

describe("loadConfig", () => {
  it("applies defaults when optional variables are absent", () => {
    const config = loadConfig(KEY);

    expect(config.NODE_ENV).toBe("development");
    expect(config.LOG_LEVEL).toBe("info");
    expect(config.LLM_BASE_URL).toBe("https://api.deepseek.com");
    expect(config.LLM_MODEL).toBe("deepseek-chat");
  });

  it("reads values from the provided environment", () => {
    const config = loadConfig({
      ...KEY,
      NODE_ENV: "production",
      LOG_LEVEL: "warn",
      LLM_BASE_URL: "https://api.openai.com/v1",
      LLM_MODEL: "gpt-4o-mini",
    });

    expect(config.NODE_ENV).toBe("production");
    expect(config.LOG_LEVEL).toBe("warn");
    expect(config.LLM_BASE_URL).toBe("https://api.openai.com/v1");
    expect(config.LLM_MODEL).toBe("gpt-4o-mini");
  });

  it("throws a readable error for an invalid value", () => {
    expect(() => loadConfig({ ...KEY, LOG_LEVEL: "verbose" })).toThrow(
      /Invalid environment configuration/,
    );
  });

  it("rejects a missing API key", () => {
    expect(() => loadConfig({})).toThrow(/LLM_API_KEY/);
  });

  it("rejects a base URL that is not a URL", () => {
    expect(() => loadConfig({ ...KEY, LLM_BASE_URL: "not-a-url" })).toThrow(
      /LLM_BASE_URL/,
    );
  });
});
