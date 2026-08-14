/**
 * Does the model actually read "no tag" as "no file"? — probe for issue 04, mode ①.
 *
 * Run: `bun bench/instructions-probe.ts`
 *
 * Mode ① (repository has no AGENTS.md → inject nothing) is the only one of the
 * four failure modes carried by an argument rather than by evidence. The argument
 * was: the system prompt states the contract, so the *absence* of a
 * `<project-instructions>` tag is itself a readable signal and costs no tokens to
 * send. That is a claim about the model, and claims about the model get measured.
 *
 * Two things would falsify it:
 *
 * - The model goes looking anyway (Glob/Read for AGENTS.md), which means the
 *   injection saved nothing and the deleted half of step 3 is still being obeyed
 *   from habit. Visible here as a turn costing more than one model request.
 * - The model claims instructions exist when none were injected, or fails to use
 *   them when they were.
 *
 * Sampled, because one answer from a model with a chain of thought is an
 * anecdote. Nothing here is a baseline — it is a one-off probe, like
 * order-probe.ts and wire-check.ts.
 */
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { createUniversalAgent, RECURSION_LIMIT } from "../src/agents";
import { loadConfig } from "../src/config";
import { readProjectInstructions } from "../src/context";
import { createLogger } from "../src/logger";
import { buildSystemPrompt } from "../src/agents";

const BENCH = "bench";
const SAMPLES = 3;

// Asks the model to commit to an answer *and* to say what it based it on, so a
// lucky guess reads differently from the contract being understood.
const ASK =
  "Does this repository give you project instructions (AGENTS.md or CLAUDE.md)? " +
  "Answer yes or no on the first line, then one line saying how you know.";

// Only answerable from the injected file. Catches the opposite failure: the tag
// arrives and the model ignores it.
const USE = "What is the only command CI runs here, and where does that rule come from?";

const config = loadConfig();

const systemPrompt = buildSystemPrompt({
  cwd: process.cwd(),
  platform: process.platform,
  today: "2026-08-13",
  isGitRepo: true,
});

const instructions = readProjectInstructions(
  `${BENCH}/fixture-agents-md`,
  createLogger("warn"),
);
if (instructions === undefined) throw new Error("fixture AGENTS.md not found");

async function ask(label: string, inject: boolean, question: string) {
  let requests = 0;
  const graph = createUniversalAgent({
    baseURL: config.LLM_BASE_URL,
    apiKey: config.LLM_API_KEY,
    model: config.LLM_MODEL,
    maxTokens: 1024,
    systemPrompt,
    ...(inject ? { projectInstructions: instructions } : {}),
    onUsage: () => (requests += 1),
  });

  const messages: BaseMessage[] = [new HumanMessage(question)];
  const stream = (await graph.stream(
    { messages },
    {
      streamMode: ["messages", "values"],
      recursionLimit: RECURSION_LIMIT,
      signal: AbortSignal.timeout(120_000),
      configurable: { thread_id: crypto.randomUUID() },
    },
  )) as AsyncIterable<[string, unknown]>;

  let last: { messages?: BaseMessage[] } | undefined;
  const tools: string[] = [];
  for await (const [mode, payload] of stream) {
    if (mode === "values") last = payload as { messages?: BaseMessage[] };
  }

  for (const message of last?.messages ?? []) {
    if (message.getType() === "tool") tools.push(message.name ?? "?");
  }

  const answer = last?.messages?.at(-1)?.content ?? "(no content)";
  const text = (typeof answer === "string" ? answer : JSON.stringify(answer))
    .replace(/\s+/g, " ")
    .trim();

  process.stdout.write(
    `\n[${label}] requests=${String(requests)} tools=${tools.length > 0 ? tools.join(",") : "none"}\n  ${text.slice(0, 300)}\n`,
  );
  return { requests, tools };
}

process.stdout.write(`model ${config.LLM_MODEL}\n`);

// `bun instructions-probe.ts use` reruns only the last probe.
const only = process.argv[2];
const results: { label: string; requests: number; tools: string[] }[] = [];
for (let sample = 1; only === undefined && sample <= SAMPLES; sample += 1) {
  results.push({ label: `off-${String(sample)}`, ...(await ask(`off ${String(sample)}`, false, ASK)) });
}
for (let sample = 1; only === undefined && sample <= SAMPLES; sample += 1) {
  results.push({ label: `on-${String(sample)}`, ...(await ask(`on ${String(sample)}`, true, ASK)) });
}
results.push({ label: "on-use", ...(await ask("on use", true, USE)) });

process.stdout.write("\n--- summary ---\n");
for (const row of results) {
  process.stdout.write(
    `${row.label.padEnd(8)} requests ${String(row.requests)}  tools ${row.tools.length > 0 ? row.tools.join(",") : "none"}\n`,
  );
}
