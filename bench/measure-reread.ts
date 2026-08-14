/**
 * Does the model re-read a file it just edited? — the premise issue 05 rests on.
 *
 * Run: `bun bench/measure-reread.ts`
 *
 * `src/agents/prompt.ts` says "Read before you edit; do not re-read after you edit",
 * and issue 05 proposes turning that from advice into a constraint by recording
 * what has been read into state. The whole ticket is worth doing only if the
 * advice is actually being ignored — and the comment on that rule says outright
 * that the failure it targets was observed on a pre-v4 model and never retested.
 * So this measures it before anything is built.
 *
 * ## Why it cannot use the existing bench
 *
 * `measure.ts` is three read-only turns and never edits, so the behaviour under
 * test cannot occur in it. It also reads `fixture/`, which is frozen — this
 * scenario has to modify a file. Hence a second frozen source
 * (`fixture-edit/scheduler.ts`) that is *copied* into a working directory at the
 * start of every pass. The original is never touched, and every pass starts from
 * identical bytes, which is what makes two passes comparable.
 *
 * That working copy sits at `bench-work/` in the repository root rather than
 * inside a dot-directory, and the reason is a defect found while building this: our
 * `Glob` and `Grep` pass no `dot` option to `Bun.Glob().scan()`, which never
 * descends into dot-directories — not even when the pattern names one outright
 * (a recursive pattern rooted at `.scratch` returns nothing, measured). The
 * prompt tells the model to
 * Glob when it is not certain a path exists, so a working copy in a dot-directory
 * had it searching in circles and never editing anything. Moving the copy is a
 * workaround; the tool defect is separate and unfixed.
 *
 * ## What is counted
 *
 * Every tool call, in order, with its path. The number that matters is
 * `redundant`: a `Read` of a path already read earlier in the same thread. That
 * is exactly the waste the ticket proposes to eliminate, and its token cost is
 * the file's size times how often it happens.
 *
 * Same two-pass rule as measure.ts: DeepSeek's prefix cache outlives the
 * process, so pass one is discarded and only the warm pass is reported.
 *
 * ## Why it has to answer the confirmation gate
 *
 * measure.ts avoids Bash by asking only read-only questions, and notes that an
 * interrupt would hang an unattended script. An *editing* task cannot dodge it
 * that way: the prompt tells the model to verify with the project's own checks,
 * so it reaches for Bash on its own. Leaving the interrupt unanswered is not
 * merely a hang — the next turn sends a user message after an assistant turn
 * whose tool_calls were never answered, and the provider rejects the request
 * outright (`insufficient tool messages following tool_calls message`).
 *
 * So the gate is answered here the way the console answers it, with a rejection
 * carrying a reason the model can read. Rejections are counted and printed: if
 * the model spends the run arguing with the gate, the scenario is measuring the
 * gate rather than re-reading, and the numbers should not be trusted.
 */
import { cpSync, mkdirSync, rmSync } from "node:fs";

import { HumanMessage, type BaseMessage, type AIMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";

import { createUniversalAgent, RECURSION_LIMIT } from "../src/agents";
import { loadConfig } from "../src/config";
import { buildSystemPrompt } from "../src/agents";
import type { ModelUsage } from "../src/usage";

const BENCH = "bench";
const SOURCE = `${BENCH}/fixture-edit`;
const WORK = "bench-work";
const FILE = `${WORK}/scheduler.ts`;

/**
 * Turn 1 forces Read-then-Edit. Turn 2 asks for a second change to the same
 * file: the model already holds its contents from turn 1 and has been told not
 * to re-read, so a Read here is the failure under test. Turn 3 is pure recall —
 * the answer was in its own edit.
 */
const TURNS = [
  `In ${FILE}, change RETRY_BACKOFF_MS from 250 to 400.`,
  `In ${FILE}, change MAX_ATTEMPTS to 8.`,
  `What are RETRY_BACKOFF_MS and MAX_ATTEMPTS in ${FILE} now?`,
];

const config = loadConfig();

const systemPrompt = buildSystemPrompt({
  cwd: process.cwd(),
  platform: process.platform,
  today: "2026-08-13",
  isGitRepo: true,
});

interface Call {
  turn: number;
  name: string;
  path: string;
}

async function pass(index: number) {
  // Fresh copy, so pass two faces the same file pass one did.
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  cpSync(SOURCE, WORK, { recursive: true });

  const usage: ModelUsage[] = [];
  const calls: Call[] = [];
  let turn = 0;

  const graph = createUniversalAgent({
    baseURL: config.LLM_BASE_URL,
    apiKey: config.LLM_API_KEY,
    model: config.LLM_MODEL,
    maxTokens: 4096,
    systemPrompt,
    onUsage: (row) => usage.push(row),
  });

  const thread = crypto.randomUUID();
  let seen = 0;
  let rejected = 0;
  let history: BaseMessage[] = [];

  /** Drains one stream, returning the tool calls the gate stopped, if any. */
  async function drain(
    input: { messages: BaseMessage[] } | Command,
  ): Promise<{ name: string }[] | null> {
    const stream = (await graph.stream(input, {
      streamMode: ["messages", "values"],
      recursionLimit: RECURSION_LIMIT,
      signal: AbortSignal.timeout(180_000),
      configurable: { thread_id: thread },
    })) as AsyncIterable<[string, unknown]>;

    let stopped: { name: string }[] | null = null;
    for await (const [mode, payload] of stream) {
      if (mode !== "values") continue;
      const state = payload as {
        messages?: BaseMessage[];
        __interrupt__?: { value?: { actionRequests?: { name: string }[] } }[];
      };
      // An interrupt event carries only `__interrupt__` — no messages key.
      if (state.messages !== undefined) history = state.messages;
      const requests = state.__interrupt__?.[0]?.value?.actionRequests;
      if (requests !== undefined) stopped = requests;
    }
    return stopped;
  }

  for (const [position, text] of TURNS.entries()) {
    turn = position + 1;
    let stopped = await drain({ messages: [new HumanMessage(text)] });

    // Answer the gate the way the console does. Bounded, so a model that keeps
    // asking cannot spin the script forever.
    for (let attempt = 0; stopped !== null && attempt < 4; attempt += 1) {
      rejected += stopped.length;
      stopped = await drain(
        new Command({
          resume: {
            decisions: stopped.map(() => ({
              type: "reject",
              message: "shell commands are unavailable in this run",
            })),
          },
        }),
      );
    }

    // Tool calls are read off the thread rather than the stream, so this walks
    // only what is new since the previous turn.
    for (const message of history.slice(seen)) {
      if (message.getType() !== "ai") continue;
      for (const call of (message as AIMessage).tool_calls ?? []) {
        const args = call.args as { path?: string };
        calls.push({ turn, name: call.name, path: args.path ?? "-" });
      }
    }
    seen = history.length;

    process.stdout.write(`pass ${String(index)} turn ${String(turn)} done\n`);
  }

  return { usage, calls, rejected };
}

await pass(1);
const { usage, calls, rejected } = await pass(2);

process.stdout.write(`\nmodel ${config.LLM_MODEL}\n\nturn  tool   path\n`);
const readsByPath = new Map<string, number>();
let redundant = 0;
for (const call of calls) {
  let flag = "";
  if (call.name === "Read") {
    const before = readsByPath.get(call.path) ?? 0;
    readsByPath.set(call.path, before + 1);
    if (before > 0) {
      redundant += 1;
      flag = "   <-- re-read";
    }
  }
  process.stdout.write(
    `${String(call.turn).padStart(4)}  ${call.name.padEnd(6)} ${call.path}${flag}\n`,
  );
}

const input = usage.reduce((sum, row) => sum + row.inputTokens, 0);
const cached = usage.reduce((sum, row) => sum + row.cacheRead, 0);
process.stdout.write(
  `\nrequests ${String(usage.length)}  input ${String(input)}  ` +
    `cached ${String(cached)} (${String(Math.round((cached / Math.max(input, 1)) * 100))}%)  ` +
    `output ${String(usage.reduce((sum, row) => sum + row.outputTokens, 0))}\n` +
    `tool calls ${String(calls.length)}  reads ${String(calls.filter((call) => call.name === "Read").length)}  ` +
    `redundant reads ${String(redundant)}  gate rejections ${String(rejected)}\n`,
);
