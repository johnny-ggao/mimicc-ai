import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { createUniversalAgent } from "./agents";
import { JsonlSaver, resolveStateDir } from "./checkpoint";
import { loadConfig } from "./config";
import { resolveModelConfig } from "./models";
import { readProjectInstructions } from "./context";
import { createLogger } from "./logger";
import { resolveMemoryDirs } from "./memory";
import { buildSystemPrompt, type PromptEnvironment } from "./agents";
import { parseArgs, runRepl, type Start } from "./console";
import { resolveSession } from "./session";
import { defaultSkillRoots, loadSkills, SkillRegistry } from "./skills";

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.LOG_LEVEL);

  // Resolved here, once, rather than passed through as three env strings: the
  // per-model facts (window limit, max tokens, base URL) live in the registry,
  // and "which one model runs" is an environment question the agent builder
  // should not re-answer.
  const model = resolveModelConfig(config);
  if (model.usedLegacyKey) {
    log.warn("deprecated_llm_api_key", {
      note: "LLM_API_KEY is the legacy name for the DeepSeek key; set LLM_DEEPSEEK_API_KEY",
    });
  }

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

  // Read before the model client is built, so a typo in the arguments costs a
  // usage line rather than a connection.
  const start = await resolveStart(stateDir);

  // Same reasoning as the state directory, different answer. Memory does not
  // follow the dev/production split — see the note in memory/location.ts for why
  // a NODE_ENV-dependent path would fork one project's memory in half.
  const memory = resolveMemoryDirs({
    override: process.env.MIMICC_MEMORY_DIR,
    cwd: process.cwd(),
  });

  // Same reasoning as the instructions above: read once, here, so the agent
  // builder never touches the filesystem. Skills come from outside the working
  // directory (~/.mimicc/skills and ~/.claude/skills), which is also why they
  // are read by name here and not reachable through the Read tool.
  const skills = new SkillRegistry(loadSkills(defaultSkillRoots(), log));

  const graph = createUniversalAgent({
    baseURL: model.baseURL,
    apiKey: model.apiKey,
    model: model.model,
    ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
    // The window limit is a per-model fact from the registry, not the global
    // `WINDOW_LIMIT` constant that only described DeepSeek.
    window: { limit: model.windowLimit },
    systemPrompt,
    ...(instructions !== undefined ? { projectInstructions: instructions } : {}),
    checkpointer: new JsonlSaver(stateDir),
    memory,
    skills,
    // The same path, so a tool call's journal lands beside its session's file.
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
    // A turn that was force-stopped is neither a failure nor a clean success;
    // it is the third state the loop guard reports, and it must be observable
    // as structured data rather than inferred from the transcript.
    onCap: (reason) => {
      log.info("turn_capped", { reason });
    },
  });

  log.info("repl_start", {
    provider: model.provider,
    model: model.model,
    baseURL: model.baseURL,
    windowLimit: model.windowLimit,
    // Worth watching: this is the cacheable prefix sent on every single turn.
    systemPromptChars: systemPrompt.length,
    projectInstructionsChars: instructions?.length ?? 0,
    skills: skills.all().length,
    // Printed because "where did my history go" is otherwise a guess, and
    // because the answer differs between development and a released build.
    stateDir,
  });

  await runRepl({ graph, skills, stateDir, start });
}

/**
 * What the command line asked for, resolved against what is on disk.
 *
 * Split in two on purpose: the parsing is pure and lives in `console/args.ts`,
 * where a test can reach it, and the half that touches the filesystem is here,
 * for the same reason every other path in this file is here.
 *
 * ⚠️ An ambiguous prefix cannot turn into a picker the way it does inside the
 * repl. `--resume <id>` is the *non-interactive* path — it exists so this
 * feature can be tested and scripted at all — and answering it with a prompt
 * would take that away.
 */
async function resolveStart(stateDir: string): Promise<Start> {
  const invocation = parseArgs(process.argv.slice(2));

  if (invocation.kind === "error") {
    process.stderr.write(`${invocation.message}\n`);
    process.exit(1);
  }
  if (invocation.kind !== "resume") return invocation;

  const found = await resolveSession(stateDir, invocation.prefix);
  if (found.kind === "one") return { kind: "session", session: found.session };
  if (found.kind === "none") {
    process.stderr.write(`no session starts with ${invocation.prefix}\n`);
    process.exit(1);
  }

  const listed = found.candidates.map((one) => `  ${one.id}  ${one.title}`).join("\n");
  process.stderr.write(
    `${invocation.prefix} matches ${String(found.candidates.length)} sessions:\n${listed}\n`,
  );
  process.exit(1);
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
