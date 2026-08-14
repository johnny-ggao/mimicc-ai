/**
 * The fixed task every context-engineering ticket is weighed on.
 *
 * Run: `bun bench/measure.ts`
 *
 * Three read-only turns against the real provider, through the real graph, with
 * the real system prompt — and deliberately through `.stream()` with the console's
 * own streamMode, because "does usage survive streaming" is one of the questions
 * the scale had to answer.
 *
 * No Bash: it is the one tool behind the confirmation gate, and an interrupt
 * would hang a script with no one at the keyboard.
 *
 * ## Why the questions point at a fixture and not at src/
 *
 * They used to read src/logger.ts, src/agent.ts and src/config.ts. Every ticket
 * on this map edits src/ — so the tool results the model was handed changed
 * underneath the measurement, and "the same task" stopped being the same task.
 * The files under fixture/ are frozen instead. What is being measured is the
 * token cost of the agent's own machinery — system prompt, history growth, tool
 * result size — so the files only need to be stable and realistically sized, not
 * to be the real ones.
 *
 * Each question names a different fixture file, and no file carries another's
 * answer. Both halves of that are load-bearing, and both were learned by getting
 * them wrong:
 *
 * - The second question's constant first lived in the file the first question
 *   reads. The model already had the answer, skipped the tool call, and the turn
 *   cost one model call instead of two.
 * - The second question then named the symbol without its path, to force a
 *   search. Searching costs a variable number of calls — Grep then answer, or
 *   Grep then Read then answer — and two passes of the same task came out 17%
 *   apart. Naming the file makes every turn two calls.
 *
 * The lesson generalises past this script: a benchmark whose cost depends on the
 * model deciding how to look something up is measuring the model, not the change
 * under test.
 *
 * Keep the turns byte-identical between runs. The numbers are only comparable
 * across a change if the input did not move. The same goes for the fixture: one
 * edited character there invalidates every baseline.
 *
 * ## Why it runs the whole thing twice and throws the first away
 *
 * DeepSeek's prefix cache outlives the process. So the first pass over a prompt
 * nobody has sent lately reads 0 from cache, and the next pass reads most of it —
 * which means a naive "measure, change something, measure again" charges the
 * second measurement's warmth to the change. The first baseline taken here fell
 * into exactly that: `deepseek-chat` was measured cold (first request cached=0)
 * and `deepseek-v4-flash` warm (cached=2304), and the 9-point difference in hit
 * rate was not all model.
 *
 * Both passes are therefore run every time and only the second is reported, so
 * every number ever recorded is a warm number. Warm is also the honest state to
 * optimise for: a real session pays the cold price once and the warm price
 * forever after. Pass one's total is printed too — if the two passes disagree by
 * much, the cache was in an odd state and the reading should not be trusted.
 */
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { createUniversalAgent, RECURSION_LIMIT } from "../src/agent";
import { loadConfig } from "../src/config";
import { buildSystemPrompt } from "../src/prompt";
import type { ModelUsage } from "../src/usage";

const FIXTURE = "bench/fixture";

const TURNS = [
  `What does ${FIXTURE}/telemetry.ts write to, and why that stream? One line.`,
  `What is RETRY_BACKOFF_MS in ${FIXTURE}/backoff.ts, and what does the doubling stop at?`,
  `What is the default region in ${FIXTURE}/settings.ts?`,
];

const config = loadConfig();
const seen: (ModelUsage & { pass: number; turn: number })[] = [];
let pass = 0;
let turn = 0;


const systemPrompt = buildSystemPrompt({
  cwd: process.cwd(),
  platform: process.platform,
  // Pinned, not today's date. buildSystemPrompt writes the date into the prompt,
  // so letting it drift would silently change the measured bytes at midnight.
  today: "2026-08-13",
  isGitRepo: true,
});

const graph = createUniversalAgent({
  baseURL: config.LLM_BASE_URL,
  apiKey: config.LLM_API_KEY,
  model: config.LLM_MODEL,
  maxTokens: 4096,
  systemPrompt,
  onUsage: (usage) => seen.push({ pass, turn, ...usage }),
});

for (const current of [1, 2]) {
  pass = current;
  // A fresh thread per pass, so pass two starts from an empty history and its
  // message counts line up with pass one's. Sharing a thread would measure a
  // six-turn conversation instead of the same three-turn one twice.
  const thread = crypto.randomUUID();

  for (const [index, text] of TURNS.entries()) {
    turn = index + 1;
    // No seeded system message: it goes to createUniversalAgent above and is
    // prepended per request from outside the thread. `index` is unused now, but
    // the turns still have to run in order — the history is what is being grown.
    void index;
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

    // Drain it. The console renders here; this script only wants the side effects.
    for await (const _ of stream) void _;
    process.stdout.write(`pass ${String(pass)} turn ${String(turn)} done\n`);
  }
}

const warmup = seen.filter((row) => row.pass === 1);
const reported = seen.filter((row) => row.pass === 2);

process.stdout.write(
  `\nmodel ${config.LLM_MODEL}  ` +
    `(warm-up pass discarded: input ${String(warmup.reduce((sum, row) => sum + row.inputTokens, 0))}, ` +
    `cached ${String(warmup.reduce((sum, row) => sum + row.cacheRead, 0))})\n`,
);

process.stdout.write("\nturn  msgs   input   cached   out  reasoning   ms\n");
for (const row of reported) {
  process.stdout.write(
    [
      String(row.turn).padStart(4),
      String(row.messages).padStart(6),
      String(row.inputTokens).padStart(8),
      String(row.cacheRead).padStart(8),
      String(row.outputTokens).padStart(6),
      String(row.reasoningTokens ?? "-").padStart(10),
      String(row.elapsedMs).padStart(6),
    ].join("") + "\n",
  );
}

const input = reported.reduce((sum, row) => sum + row.inputTokens, 0);
const cached = reported.reduce((sum, row) => sum + row.cacheRead, 0);
process.stdout.write(
  `\nrequests ${String(reported.length)}  input ${String(input)}  cached ${String(cached)} ` +
    `(${String(Math.round((cached / Math.max(input, 1)) * 100))}%)  ` +
    `output ${String(reported.reduce((sum, row) => sum + row.outputTokens, 0))}\n`,
);
