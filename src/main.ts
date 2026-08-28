import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { createUniversalAgent } from "./agents";
import { JsonlSaver, resolveStateDir } from "./checkpoint";
import { loadConfig } from "./config";
import { OUTPUT_BUDGET, resolveModelConfig } from "./models";
import { readProjectInstructions } from "./context";
import { createLogger } from "./logger";
import { resolveMemoryDirs } from "./memory";
import { buildSystemPrompt, type PromptEnvironment } from "./agents";
import { parseArgs, runOnce, runRepl, type Start } from "./console";
import { resolveSession } from "./session";
import { defaultSkillRoots, loadSkills, SkillRegistry } from "./skills";
import { killRunningCommands } from "./tools";
import { loadPermissions } from "./tools/permissionConfig";

/**
 * Takes every still-running command with us on the way out.
 *
 * `Bash` spawns detached (`src/tools/mutating.ts`), which is what lets the
 * deadline kill a whole pipeline — and what lets a survivor outlive this
 * process when nothing sweeps. Registered here rather than in the tool because
 * a module that installs signal handlers on import is a side effect nobody
 * greps for; the process's exit belongs to its entry point.
 *
 * `exit` covers the normal end and every `process.exit`. The two signals do not
 * run `exit` handlers on their own, so they sweep and then leave with the
 * conventional 128+signal.
 */
function sweepOnExit(): void {
  process.on("exit", killRunningCommands);
  for (const [signal, code] of [
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const) {
    process.on(signal, () => {
      killRunningCommands();
      process.exit(code);
    });
  }
}

async function main(): Promise<void> {
  sweepOnExit();
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

  // Read once, here, for the same reason as the instructions above: the agent
  // builder does not touch the filesystem. A malformed file throws here and
  // stops the program rather than silently dropping its protection.
  const rules = loadPermissions({
    userFile: join(homedir(), ".mimicc", "permissions.json"),
    repoFile: join(process.cwd(), ".mimicc-permissions.json"),
  });

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
    // The *want*. What actually goes on the wire is this clamped against what
    // the history leaves — `outputCeiling` in `src/context/compaction.ts`.
    outputBudget: model.maxTokens ?? OUTPUT_BUDGET,
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
    // Already parsed and merged by `loadPermissions` above — rules drive the
    // permission gate's allow/ask/deny on top of the hard floor.
    rules,
    // `--auto` flips the gate's baseline ask to allow (deny still holds).
    auto: start.auto,
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
    // The work budget lives on the token/time axis (turn-budget ticket 01);
    // env overrides ride in through config.ts, defaults applied in the loop.
    turnBudget: {
      tokenMultiplier: config.MIMICC_TURN_TOKEN_BUDGET_MULTIPLIER,
      timeBudgetMs: config.MIMICC_TURN_TIME_BUDGET_MS,
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

  // One turn and out. Branches here rather than inside `runRepl` because the
  // two share the graph and nothing else: the repl owns a terminal, this owns a
  // process exit code.
  if (start.kind === "print") {
    const result = await runOnce({ graph, task: start.task });
    if (result.text !== "") process.stdout.write(`${result.text}\n`);
    if (result.refused > 0) {
      process.stderr.write(
        `${String(result.refused)} call(s) refused: nobody is attached to approve them. ` +
          `Pass --auto to run without asking.\n`,
      );
    }
    if (!result.ok) {
      process.stderr.write(`${result.error ?? "the turn did not finish"}\n`);
      process.exit(1);
    }
    return;
  }

  await runRepl({ graph, skills, stateDir, start });
}

/** What `--print` resolves to. Not a {@link Start}: it never opens a repl. */
interface PrintStart {
  kind: "print";
  task: string;
  auto: boolean;
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
async function resolveStart(stateDir: string): Promise<Start | PrintStart> {
  const invocation = parseArgs(process.argv.slice(2));

  if (invocation.kind === "error") {
    process.stderr.write(`${invocation.message}\n`);
    process.exit(1);
  }
  if (invocation.kind !== "resume") return invocation;

  const found = await resolveSession(stateDir, invocation.prefix);
  if (found.kind === "one") {
    return { kind: "session", session: found.session, auto: invocation.auto };
  }
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
