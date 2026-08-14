/**
 * Does the model actually reach for Write on a file it already read? — the
 * frequency question behind issue 05.
 *
 * Run: `bun repro/05-write-lost-update.ts`
 *
 * The deterministic reproduction (05-stale-edit.ts) established that `Edit` is
 * already safe against a file changing underneath it — `locate()` refuses when
 * the target moved or became ambiguous — and that the one real hole is `Write`,
 * which replaces the whole file and silently discards anything written since the
 * read. That is a data-loss bug, but its severity depends on something not yet
 * observed: whether the model ever takes that path. `src/prompt.ts` tells it
 * Write is for "creating a new file, or replacing one you have already read in
 * full" and "never ... to make a small change", so it may never happen.
 *
 * The setup is the realistic one rather than a contrived one. Turn 1 has the
 * model read the file. Between turns — the way a user switching to their editor
 * would — the file is changed underneath it. Turn 2 asks for a restructuring that
 * touches every constant in the file, which is exactly the shape that tempts a
 * full rewrite over a series of surgical edits.
 *
 * Three things are recorded per sample: whether it re-read before writing,
 * whether it used Write on the existing file, and whether the external change is
 * still in the file afterwards. The last one is the bug; the first is the reason
 * it might not fire.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { HumanMessage, type AIMessage, type BaseMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";

import { createUniversalAgent, RECURSION_LIMIT } from "../src/agent";
import { loadConfig } from "../src/config";
import { buildSystemPrompt } from "../src/prompt";

const SOURCE = "bench/fixture-edit";
const WORK = "bench-work";
const FILE = `${WORK}/scheduler.ts`;
const SAMPLES = 3;

const TURN_1 = `Read ${FILE} and list the constants it exports, one per line.`;
const TURN_2 =
  `Restructure ${FILE}: replace the separate exported constants with a single ` +
  `exported RETRY object holding them, and update the functions to read from it.`;

/** The other writer's change. Only this version has 45_000. */
function externalEdit(text: string): string {
  return text.replace("MAX_BACKOFF_MS = 20_000", "MAX_BACKOFF_MS = 45_000");
}

const config = loadConfig();
const systemPrompt = buildSystemPrompt({
  cwd: process.cwd(),
  platform: process.platform,
  today: "2026-08-13",
  isGitRepo: true,
});

async function sample(index: number) {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  cpSync(SOURCE, WORK, { recursive: true });

  const graph = createUniversalAgent({
    baseURL: config.LLM_BASE_URL,
    apiKey: config.LLM_API_KEY,
    model: config.LLM_MODEL,
    maxTokens: 4096,
    systemPrompt,
  });

  const thread = crypto.randomUUID();
  let history: BaseMessage[] = [];
  let seen = 0;
  const calls: { turn: number; name: string }[] = [];

  async function drain(input: { messages: BaseMessage[] } | Command) {
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
      if (state.messages !== undefined) history = state.messages;
      const requests = state.__interrupt__?.[0]?.value?.actionRequests;
      if (requests !== undefined) stopped = requests;
    }
    return stopped;
  }

  async function turn(number: number, text: string) {
    let stopped = await drain({ messages: [new HumanMessage(text)] });
    for (let attempt = 0; stopped !== null && attempt < 4; attempt += 1) {
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
    for (const message of history.slice(seen)) {
      if (message.getType() !== "ai") continue;
      for (const call of (message as AIMessage).tool_calls ?? []) {
        calls.push({ turn: number, name: call.name });
      }
    }
    seen = history.length;
  }

  await turn(1, TURN_1);

  // The user switches to their editor. The model still holds the old text.
  writeFileSync(FILE, externalEdit(readFileSync(FILE, "utf8")));

  await turn(2, TURN_2);

  const final = readFileSync(FILE, "utf8");
  const turn2 = calls.filter((call) => call.turn === 2);
  const result = {
    index,
    tools: turn2.map((call) => call.name).join(",") || "none",
    reread: turn2.some((call) => call.name === "Read"),
    wrote: turn2.some((call) => call.name === "Write"),
    survived: final.includes("45_000"),
  };

  process.stdout.write(
    `\nsample ${String(index)}  turn2 tools: ${result.tools}\n` +
      `  re-read before acting: ${String(result.reread)}\n` +
      `  used Write: ${String(result.wrote)}\n` +
      `  external change survived: ${result.survived ? "yes" : "NO — lost update"}\n`,
  );
  return result;
}

process.stdout.write(`model ${config.LLM_MODEL}\n`);
const results = [];
for (let index = 1; index <= SAMPLES; index += 1) results.push(await sample(index));

process.stdout.write("\n--- summary ---\n");
process.stdout.write(
  `re-read ${String(results.filter((r) => r.reread).length)}/${String(SAMPLES)}  ` +
    `used Write ${String(results.filter((r) => r.wrote).length)}/${String(SAMPLES)}  ` +
    `lost update ${String(results.filter((r) => !r.survived).length)}/${String(SAMPLES)}\n`,
);
