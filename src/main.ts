import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { createUniversalAgent } from "./agents";
import { JsonlSaver, resolveStateDir } from "./checkpoint";
import { loadConfig } from "./config";
import { readProjectInstructions } from "./context";
import { createLogger } from "./logger";
import { resolveMemoryDirs } from "./memory";
import { buildSystemPrompt, type PromptEnvironment } from "./agents";
import { runRepl } from "./console";

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.LOG_LEVEL);

  const systemPrompt = buildSystemPrompt(describeEnvironment());
  // Read once, here, for the same reason `describeEnvironment` is called here:
  // the agent builder should not touch the filesystem. Once, at startup, is
  // also deliberate and temporary — a mid-session edit to AGENTS.md does not
  // take effect until restart, and making it live is a change to this line.
  const instructions = readProjectInstructions(process.cwd(), log);

  // Resolved here for the same reason the prompt environment and the project
  // instructions are: the agent builder does not touch the filesystem, and
  // "where does history live" is an environment question, not a graph question.
  const stateDir = resolveStateDir({
    nodeEnv: config.NODE_ENV,
    override: process.env.MIMICC_STATE_DIR,
    cwd: process.cwd(),
  });

  // Same reasoning as the state directory, different answer. Memory does not
  // follow the dev/production split — see the note in memory/location.ts for why
  // a NODE_ENV-dependent path would fork one project's memory in half.
  const memory = resolveMemoryDirs({
    override: process.env.MIMICC_MEMORY_DIR,
    cwd: process.cwd(),
  });

  const graph = createUniversalAgent({
    baseURL: config.LLM_BASE_URL,
    apiKey: config.LLM_API_KEY,
    model: config.LLM_MODEL,
    maxTokens: 4096,
    systemPrompt,
    ...(instructions !== undefined ? { projectInstructions: instructions } : {}),
    checkpointer: new JsonlSaver(stateDir),
    memory,
    // The same path, so a tool call's journal lands beside its thread's file.
    stateDir,
    // One line per request to the provider. This is the scale every
    // context-engineering change is weighed on, so it is wired up before the
    // first such change rather than after.
    onUsage: (usage) => {
      log.info("model_usage", { ...usage });
    },
    // A summary changes what the model can see for the rest of the thread. The
    // full history is still on disk, but the change itself should never be
    // something you have to infer from the token counts.
    onWindow: (event) => {
      log.info("context_window", { ...event });
    },
  });

  log.info("repl_start", {
    model: config.LLM_MODEL,
    baseURL: config.LLM_BASE_URL,
    // Worth watching: this is the cacheable prefix sent on every single turn.
    systemPromptChars: systemPrompt.length,
    projectInstructionsChars: instructions?.length ?? 0,
    // Printed because "where did my history go" is otherwise a guess, and
    // because the answer differs between development and a released build.
    stateDir,
  });

  await runRepl({ graph });
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
