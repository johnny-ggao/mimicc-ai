import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { createAgentGraph } from "./agent";
import { loadConfig } from "./config";
import { createLogger } from "./logger";
import { buildSystemPrompt, type PromptEnvironment } from "./prompt";
import { runRepl } from "./repl";

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.LOG_LEVEL);

  const graph = createAgentGraph({
    baseURL: config.LLM_BASE_URL,
    apiKey: config.LLM_API_KEY,
    model: config.LLM_MODEL,
    maxTokens: 4096,
  });

  const systemPrompt = buildSystemPrompt(describeEnvironment());

  log.info("repl_start", {
    model: config.LLM_MODEL,
    baseURL: config.LLM_BASE_URL,
    // Worth watching: this is the cacheable prefix sent on every single turn.
    systemPromptChars: systemPrompt.length,
  });

  await runRepl({ graph, systemPrompt });
}

function describeEnvironment(): PromptEnvironment {
  const cwd = process.cwd();
  return {
    cwd,
    platform: process.platform,
    today: new Date().toISOString().slice(0, 10),
    isGitRepo: hasGitDir(cwd),
  };
}

// Walks up, because the agent is usually started somewhere below the repo root.
function hasGitDir(from: string): boolean {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

// Only failures that escape the repl land here — per-turn errors are printed
// inline and the prompt comes back.
main().catch((error: unknown) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
