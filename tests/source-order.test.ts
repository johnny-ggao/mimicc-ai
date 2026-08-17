import { afterAll, beforeAll, expect, test } from "bun:test";

import { HumanMessage } from "@langchain/core/messages";
import type { AIMessage, BaseMessage, ToolMessage } from "@langchain/core/messages";

import { createUniversalAgent, RECURSION_LIMIT } from "@/agents";

/**
 * Tool results enter the history in the order the model asked for them.
 *
 * ## What this is defending, since it will look like noise otherwise
 *
 * This test is green today and is expected to stay green. It exists because
 * there is a specific, written-down change that would turn it red, and the
 * damage it would do is invisible at the point of making it.
 *
 * `.scratch/context-engineering/research/08-message-persistence.md` recommends
 * swapping the default `messages` channel for `MessagesDeltaValue`. Under that
 * channel, parallel tool writes are regrouped by task id
 * (`@langchain/langgraph/dist/pregel/algo.js:131-141`) rather than kept in the
 * order the tasks were created — so a batch of tool calls comes back in an order
 * derived from a uuid5 hash instead of from the assistant message that issued
 * them.
 *
 * Nothing fails when that happens. The conversation is still valid: every call
 * has its result, the pairing holds, the model reads it fine. What breaks is
 * quieter — **the same history stops projecting to the same view**. `CONTEXT.md`
 * calls that the 投影, and its being a projection rather than an edit is the
 * claim the whole `src/context/` module exists to support. Two runs of one
 * conversation would produce two different contexts, and every cache-prefix
 * argument in this repository rests on them producing one.
 *
 * ⚠️ **The recommendation is also superseded**, which is the part most likely to
 * be missed by whoever reads that research next. It was aimed at O(n²) disk
 * growth, and that was solved instead inside `src/checkpoint/saver.ts:113-150` —
 * message bodies stored once, id lists appended rather than repeated, measured
 * flat at 2.0x per doubling. **Switching the channel now would trade source
 * order for a benefit this repository already has.**
 *
 * ## Why five calls and no timing games
 *
 * The failure mode is not "a slow tool finishes late". It is a reordering by
 * hash, which is independent of how long anything took — so there is nothing to
 * simulate, and a test that tried to force one tool to finish before another
 * would be testing the scheduler instead. Five is simply enough that hash order
 * and source order are not going to coincide.
 */

let server: ReturnType<typeof Bun.serve>;
let replies = 0;
const CALL_IDS = ["c1", "c2", "c3", "c4", "c5"];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { messages: { role: string }[] };
      const answered = body.messages.some((message) => message.role === "tool");
      replies += 1;

      return Response.json({
        // Distinct per reply: messages merge by id, so a reused one makes the
        // second answer overwrite the first in place and the whole lap — tool
        // calls included — vanishes from state. Same trap as in
        // tests/checkpoint.test.ts, and it cost this test one debugging round.
        id: `chatcmpl-${String(replies)}`,
        object: "chat.completion",
        created: 0,
        model: "stub",
        choices: [
          {
            index: 0,
            message: answered
              ? { role: "assistant", content: "done" }
              : {
                  role: "assistant",
                  content: "",
                  tool_calls: CALL_IDS.map((id) => ({
                    id,
                    type: "function",
                    function: { name: "Read", arguments: '{"path":"package.json"}' },
                  })),
                },
            finish_reason: answered ? "stop" : "tool_calls",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
});

afterAll(() => void server.stop(true));

test("a batch of tool results lands in the order the model asked for them", async () => {
  const graph = createUniversalAgent({
    baseURL: `http://localhost:${String(server.port)}`,
    apiKey: "sk-stub",
    model: "stub",
  });

  const out = (await graph.invoke(
    { messages: [new HumanMessage("read it five times")] },
    { recursionLimit: RECURSION_LIMIT, configurable: { thread_id: "source-order" } },
  )) as { messages: BaseMessage[] };

  const issued = out.messages
    .filter((message): message is AIMessage => message.getType() === "ai")
    .flatMap((message) => message.tool_calls ?? [])
    .map((call) => call.id);
  const answers = out.messages
    .filter((message): message is ToolMessage => message.getType() === "tool")
    .map((message) => message.tool_call_id);

  // The batch really did go out as one — otherwise this asserts nothing about
  // parallel ordering, only that a sequence of single calls stayed in sequence.
  expect(issued).toEqual(CALL_IDS);
  expect(answers).toEqual(CALL_IDS);
});
