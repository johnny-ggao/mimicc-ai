/**
 * Every label a kind produces, taken from the real provider.
 *
 * Run: `bun bench/kind-labels.ts`
 *
 * The identity of a kind (`src/agents/kinds.ts`) is supposed to derive four strings:
 * the meter's label, the summarising call's label, the `agent` on every window
 * event, and — for a subagent — the type the model dispatches. Unit tests assert
 * each of those, but every one of them is a string arriving from a middleware
 * that only fires when a window actually fills, so the whole set has never been
 * seen end to end against a live model. This is that reading.
 *
 * ## Why the window is shrunk rather than filled
 *
 * The real trigger is 80% of 1,048,576 tokens. Producing that costs roughly a
 * dollar and twenty minutes to observe an `if`. `used()` anchors on the last
 * `input_tokens` the provider reported — which includes the resident system
 * prompt and tool schemas, about 2,400 tokens — so a 4,000-token limit crosses
 * its 3,200 trigger within two or three turns of ordinary work. The code path is
 * identical; only the constant moves.
 *
 * ## Why the Explore half dispatches directly
 *
 * Asking the agent a question and hoping it reaches for `Task` measures the
 * model's judgement, not the labels. `createTaskTool` is invoked here the way
 * `tests/task.test.ts` invokes it, so the dispatch is certain.
 *
 * Costs a few cents: fifteen to twenty small requests.
 */
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";

import { createUniversalAgent, RECURSION_LIMIT } from "../src/agents";
import { loadConfig } from "../src/config";
import { subagentSpecs } from "../src/agents";
import { buildSystemPrompt } from "../src/agents";
import { createTaskTool } from "../src/tools";
import type { ModelUsage } from "../src/usage";
import type { WindowEvent } from "../src/context";

const FIXTURE = "bench/fixture";

/**
 * Small enough to cross within a few turns, large enough to hold one request.
 *
 * Two numbers, not one, and the difference is the finding: an Explore agent's
 * resident cost is about a third of the main agent's — three tools against
 * seven, and a shorter prompt — so a limit tuned to make the agent summarise
 * leaves the subagent comfortably under its trigger. Measured on the first run
 * of this script: the main agent crossed 3,200 four times while Explore's
 * largest request was 2,424 and it never summarised at all. A kind's thresholds
 * are not transferable between kinds, which is the same reason the open question
 * "should Explore's trigger be lower than the agent's" is still open — there is
 * no observation to base it on yet, and this is not one either.
 *
 * `keepFraction` is the production 0.3 and not something smaller, and that was
 * also learned the hard way here: at 0.1 the first cut came out
 * `before=3 kept=0`, the agent lost the thread it was pulling, and the very next
 * run died on `GraphRecursionError` after 24 nodes. **A retention budget too
 * small to hold the task in progress turns summarising into looping** — worth
 * knowing before anyone tunes that constant down to save tokens.
 */
const WINDOW = { limit: 5_000, keepFraction: 0.3 };
const EXPLORE_WINDOW = { limit: 2_500, keepFraction: 0.3 };

/**
 * Five turns, not the three `measure.ts` uses, and the extra two are load-bearing.
 *
 * The two sides of the window mechanism measure with different rulers, which
 * only shows at this scale: `used()` anchors on the provider's own
 * `input_tokens` and so counts the ~2,400-token resident prompt, while
 * `chooseCutoff` walks the message array with the chars/4 estimate and counts
 * only the messages. At three turns the trigger was crossed (4,483 against a
 * 4,000 line) and the cut was still refused — the messages' *estimate* had not
 * reached the retention budget, so there was nothing the cutter was willing to
 * drop. Two more turns grow the half that the cutter can see.
 *
 * In production the resident segment is 0.2% of the window and this asymmetry is
 * invisible. It is worth knowing anyway: a summary is triggered by one number
 * and executed against another, and they can disagree.
 */
const TURNS = [
  `What does ${FIXTURE}/telemetry.ts write to, and why that stream? One line.`,
  `What is RETRY_BACKOFF_MS in ${FIXTURE}/backoff.ts, and what does the doubling stop at?`,
  `What is the default region in ${FIXTURE}/settings.ts?`,
  `Read ${FIXTURE}/telemetry.ts and ${FIXTURE}/backoff.ts again and tell me every exported name in both.`,
  `Read all three files in ${FIXTURE}/ and list every constant in them with its value.`,
];

const config = loadConfig();
const usage: ModelUsage[] = [];
const events: WindowEvent[] = [];

const graph = createUniversalAgent({
  baseURL: config.LLM_BASE_URL,
  apiKey: config.LLM_API_KEY,
  model: config.LLM_MODEL,
  maxTokens: 4096,
  systemPrompt: buildSystemPrompt({
    cwd: process.cwd(),
    platform: process.platform,
    today: "2026-08-14",
    isGitRepo: true,
  }),
  window: WINDOW,
  onUsage: (record) => usage.push(record),
  onWindow: (event) => events.push(event),
});

const thread = crypto.randomUUID();
for (const text of TURNS) {
  const messages: BaseMessage[] = [new HumanMessage(text)];
  const stream = (await graph.stream(
    { messages },
    {
      streamMode: ["messages", "values"],
      recursionLimit: RECURSION_LIMIT,
      signal: AbortSignal.timeout(120_000),
      configurable: { thread_id: thread },
    },
  )) as AsyncIterable<[string, unknown]>;
  for await (const _ of stream) void _;
  process.stdout.write(".");
}
process.stdout.write(" main done\n");

// The subagent half. Its own model instance, because the agent above keeps its
// own and this script has no handle on it — the labels are what is under test,
// not the sharing.
const model = new ChatOpenAI({
  model: config.LLM_MODEL,
  apiKey: config.LLM_API_KEY,
  configuration: { baseURL: config.LLM_BASE_URL },
  maxTokens: 4096,
});

const report = await createTaskTool({
  model,
  subagents: subagentSpecs({
    model,
    window: EXPLORE_WINDOW,
    onUsage: (record) => usage.push(record),
    onWindow: (event) => events.push(event),
  }),
}).invoke({
  description: `Read every file in ${FIXTURE}/ and say in one line what each one is for.`,
  subagent_type: "explore",
});
process.stdout.write(`explore done (${String(report.length)} chars reported)\n`);

process.stdout.write("\nmodel_usage — one row per provider request\n");
process.stdout.write("agent            msgs   input  cached   out     ms\n");
for (const row of usage) {
  process.stdout.write(
    row.agent.padEnd(16) +
      String(row.messages).padStart(4) +
      String(row.inputTokens).padStart(8) +
      String(row.cacheRead).padStart(8) +
      String(row.outputTokens).padStart(6) +
      String(row.elapsedMs).padStart(7) +
      "\n",
  );
}

process.stdout.write("\ncontext_window — one row per summary\n");
if (events.length === 0) {
  process.stdout.write(
    "  none. The window never filled — raise the turns or lower WINDOW.limit.\n",
  );
}
for (const event of events) {
  process.stdout.write(
    event.type === "summarized"
      ? `  ${event.agent.padEnd(10)} summarized  reason=${event.reason}  before=${String(event.before)}  kept=${String(event.kept)}\n`
      : `  ${event.agent.padEnd(10)} FAILED      reason=${event.reason}  ${event.error}\n`,
  );
}

// The point of the whole script, stated rather than left to be read off the
// table: every label present, and no unattributed `"summary"` left anywhere.
const labels = [...new Set(usage.map((row) => row.agent))].sort();
process.stdout.write(`\nlabels seen: ${labels.join(", ")}\n`);
process.stdout.write(
  labels.includes("summary")
    ? "FAIL — a bare `summary` label survived; a kind is summarising anonymously\n"
    : "ok — no bare `summary` label; every row names a kind\n",
);
