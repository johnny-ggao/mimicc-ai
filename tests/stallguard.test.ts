import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HumanMessage } from "@langchain/core/messages";

import { createUniversalAgent, RECURSION_LIMIT } from "@/agents";
import { JsonlSaver } from "@/checkpoint";

/**
 * A run of failing tool calls must prompt the model to change approach, instead
 * of silently retrying the same broken thing until RECURSION_LIMIT. The thin
 * stall counter: three error results in a row queue one [PROGRESS HINT], a clean
 * result resets. Different paths each lap so the loop guard's hash layer (same
 * set) does not fire — this is the "different args, same failing tool" case.
 */

let server: ReturnType<typeof Bun.serve>;
const requests: { messages: { content?: unknown }[] }[] = [];
let replies = 0;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      replies += 1;
      const body = (await request.json()) as { messages: { content?: unknown }[] };
      requests.push(body);
      const path = `missing-${String(replies)}.txt`;
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
                  function: { name: "Read", arguments: JSON.stringify({ path }) },
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
beforeEach(() => {
  requests.length = 0;
  replies = 0;
});

function build() {
  return createUniversalAgent({
    baseURL: `http://localhost:${String(server.port)}`,
    apiKey: "sk-stub",
    model: "stub",
    checkpointer: new JsonlSaver(mkdtempSync(join(tmpdir(), "mimicc-stall-"))),
  });
}

test("three failing tool calls in a row inject a progress hint", async () => {
  const graph = build();

  try {
    await graph.invoke(
      { messages: [new HumanMessage("go")] },
      { recursionLimit: RECURSION_LIMIT, configurable: { thread_id: "t1" } },
    );
  } catch {
    // The stub keeps asking for Read, so the turn runs to the recursion limit.
    // The hint is what is under test, not the turn's end.
  }

  const hintSeen = requests.some((req) =>
    req.messages.some(
      (message) =>
        typeof message.content === "string" &&
        message.content.includes("[PROGRESS HINT]"),
    ),
  );
  expect(hintSeen).toBe(true);
});
