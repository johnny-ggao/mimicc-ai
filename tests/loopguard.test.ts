import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HumanMessage, type AIMessage } from "@langchain/core/messages";

import { createUniversalAgent, RECURSION_LIMIT } from "@/agents";
import { JsonlSaver } from "@/checkpoint";

/**
 * A model that repeats the same tool call must be force-stopped, not left to
 * spin until RECURSION_LIMIT — the hole admitted in loop.ts:22-30. This is the
 * first mechanical block of ticket 17.
 *
 * The stub always emits the same tool call (Read package.json), so the loop is
 * model -> Read -> model -> Read -> ... The guard must hard-stop at the hard
 * limit (strip tool_calls, force a canned final answer) and report loop_capped,
 * never throwing GraphRecursionError.
 */

let server: ReturnType<typeof Bun.serve>;
let replies = 0;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch() {
      replies += 1;
      // Always the same tool call, distinct ids per reply so the reducer does
      // not merge them (the "reused message id" trap).
      return Response.json({
        id: `chatcmpl-${String(replies)}`,
        object: "chat.completion",
        created: 0,
        model: "stub",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: `call_${String(replies)}`,
                  type: "function",
                  function: { name: "Read", arguments: '{"path":"package.json"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
});

afterAll(() => void server.stop(true));

function build(onCap: (reason: string) => void) {
  return createUniversalAgent({
    baseURL: `http://localhost:${String(server.port)}`,
    apiKey: "sk-stub",
    model: "stub",
    checkpointer: new JsonlSaver(mkdtempSync(join(tmpdir(), "mimicc-loop-"))),
    onCap,
  });
}

test("a looping model is force-stopped and capped", async () => {
  const caps: string[] = [];
  const graph = build((reason) => caps.push(reason));

  const out = (await graph.invoke(
    { messages: [new HumanMessage("go")] },
    { recursionLimit: RECURSION_LIMIT, configurable: { thread_id: "t1" } },
  )) as { messages: AIMessage[] };

  const last = out.messages.at(-1);
  expect(last).toBeDefined();
  expect(last?.tool_calls ?? []).toHaveLength(0);
  const text =
    typeof last?.content === "string" ? last.content : JSON.stringify(last?.content);
  expect(text).toContain("FORCED STOP");
  expect(caps).toEqual(["loop_capped"]);
});
