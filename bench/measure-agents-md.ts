/**
 * What AGENTS.md injection costs — the scale for issue 04.
 *
 * Run: `bun bench/measure-agents-md.ts`
 *
 * ## Why this is a separate file
 *
 * The map's rule: editing measure.ts's questions or a single byte under
 * `fixture/` invalidates every baseline ever recorded, so a new scenario gets a
 * new file. This one obeys that literally — it asks the *same three questions*
 * against the *same frozen fixture*, and never writes there. The AGENTS.md being
 * injected lives in its own directory, which is what `readProjectInstructions`
 * is pointed at.
 *
 * ## Why the comparison is off-vs-on and not old-vs-new baseline
 *
 * Two numbers taken from different scripts are two different tasks. Here both
 * configurations run the identical task in the same process minutes apart, so
 * the difference between them is the injection and nothing else.
 *
 * Each configuration runs the whole thing twice and reports only the second
 * pass, for the reason measure.ts documents: DeepSeek's prefix cache outlives
 * the process, so a cold first pass would charge its own coldness to whatever
 * changed.
 *
 * ## What was predicted before running it (issue 04)
 *
 * - `input` rises by roughly the token count of the injected text — the fixture
 *   AGENTS.md is ~1.6KB, so ~300-600 tokens per request.
 * - The **cache hit rate does not fall, and should rise**: the injected message
 *   is byte-identical on every turn and sits at a fixed position, so it joins the
 *   stable prefix rather than displacing it.
 * - A hit rate that *drops* is the failure this measurement exists to catch: it
 *   would mean the message is moving or changing between turns, i.e. the fixed
 *   id is not making `beforeAgent` idempotent after all.
 */
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { createUniversalAgent, RECURSION_LIMIT } from "../src/agents";
import { loadConfig } from "../src/config";
import { readProjectInstructions } from "../src/context";
import { createLogger } from "../src/logger";
import { buildSystemPrompt } from "../src/agents";
import type { ModelUsage } from "../src/usage";

const BENCH = "bench";
const FIXTURE = `${BENCH}/fixture`;

// Identical to measure.ts. Same task, same frozen files, so the only variable
// left is the injection.
const TURNS = [
  `What does ${FIXTURE}/telemetry.ts write to, and why that stream? One line.`,
  `What is RETRY_BACKOFF_MS in ${FIXTURE}/backoff.ts, and what does the doubling stop at?`,
  `What is the default region in ${FIXTURE}/settings.ts?`,
];

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

async function measure(label: string, inject: boolean) {
  const seen: (ModelUsage & { pass: number; turn: number })[] = [];
  let pass = 0;
  let turn = 0;

  const graph = createUniversalAgent({
    baseURL: config.LLM_BASE_URL,
    apiKey: config.LLM_API_KEY,
    model: config.LLM_MODEL,
    maxTokens: 4096,
    systemPrompt,
    ...(inject ? { projectInstructions: instructions } : {}),
    onUsage: (usage) => seen.push({ pass, turn, ...usage }),
  });

  for (const current of [1, 2]) {
    pass = current;
    const thread = crypto.randomUUID();

    for (const [index, text] of TURNS.entries()) {
      turn = index + 1;
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
      process.stdout.write(`${label} pass ${String(pass)} turn ${String(turn)} done\n`);
    }
  }

  const reported = seen.filter((row) => row.pass === 2);
  const warm = seen.filter((row) => row.pass === 1);

  return {
    label,
    rows: reported,
    requests: reported.length,
    input: reported.reduce((sum, row) => sum + row.inputTokens, 0),
    cached: reported.reduce((sum, row) => sum + row.cacheRead, 0),
    output: reported.reduce((sum, row) => sum + row.outputTokens, 0),
    warmInput: warm.reduce((sum, row) => sum + row.inputTokens, 0),
  };
}

// Off first: it leaves the shared system-prompt prefix warm for the on run, and
// the on run still gets its own discarded warm-up pass on top of that.
const off = await measure("off", false);
const on = await measure("on", true);

process.stdout.write(
  `\nmodel ${config.LLM_MODEL}  injected ${String(instructions.length)} chars\n`,
);

process.stdout.write("\n      turn  msgs   input   cached   out     ms\n");
for (const result of [off, on]) {
  for (const row of result.rows) {
    process.stdout.write(
      [
        result.label.padEnd(6),
        String(row.turn).padStart(4),
        String(row.messages).padStart(6),
        String(row.inputTokens).padStart(8),
        String(row.cacheRead).padStart(8),
        String(row.outputTokens).padStart(6),
        String(row.elapsedMs).padStart(7),
      ].join("") + "\n",
    );
  }
}

const rate = (result: { input: number; cached: number }) =>
  Math.round((result.cached / Math.max(result.input, 1)) * 100);

process.stdout.write("\nconfig  requests   input  cached    hit   output   (warm-up input)\n");
for (const result of [off, on]) {
  process.stdout.write(
    [
      result.label.padEnd(8),
      String(result.requests).padStart(8),
      String(result.input).padStart(8),
      String(result.cached).padStart(8),
      `${String(rate(result))}%`.padStart(7),
      String(result.output).padStart(9),
      String(result.warmInput).padStart(19),
    ].join("") + "\n",
  );
}

const deltaInput = on.input - off.input;
process.stdout.write(
  `\ndelta   input ${deltaInput >= 0 ? "+" : ""}${String(deltaInput)}` +
    ` (${String(Math.round((deltaInput / Math.max(off.input, 1)) * 1000) / 10)}%)` +
    `   hit ${String(rate(off))}% -> ${String(rate(on))}%\n`,
);
