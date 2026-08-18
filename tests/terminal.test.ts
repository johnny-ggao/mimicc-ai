import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HumanMessage } from "@langchain/core/messages";

import { createUniversalAgent, RECURSION_LIMIT } from "@/agents";
import { JsonlSaver } from "@/checkpoint";

/**
 * A turn that runs a tool and then produces an empty final answer must not end
 * blank. Retry once with a reminder; if the retry is empty too, persist a canned
 * fallback so the turn is visibly complete.
 */

let server: ReturnType<typeof Bun.serve>;
let replies = 0;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch() {
      replies += 1;
      if (replies === 1) {
        return Response.json({
          id: `c${String(replies)}`,
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
      }
      return Response.json({
        id: `c${String(replies)}`,
        object: "chat.completion",
        created: 0,
        model: "stub",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
});

afterAll(() => void server.stop(true));
beforeEach(() => {
  replies = 0;
});

function build() {
  return createUniversalAgent({
    baseURL: `http://localhost:${String(server.port)}`,
    apiKey: "sk-stub",
    model: "stub",
    checkpointer: new JsonlSaver(mkdtempSync(join(tmpdir(), "mimicc-term-"))),
  });
}

test("an empty terminal response retries once then falls back", async () => {
  const graph = build();

  const out = (await graph.invoke(
    { messages: [new HumanMessage("go")] },
    { recursionLimit: RECURSION_LIMIT, configurable: { thread_id: "t1" } },
  )) as { messages: { content: unknown }[] };

  const last = out.messages.at(-1);
  const text =
    typeof last?.content === "string" ? last.content : JSON.stringify(last?.content);
  expect(text).toContain("no final response");
});
