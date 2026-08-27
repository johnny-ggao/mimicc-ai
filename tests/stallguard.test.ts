import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HumanMessage } from "@langchain/core/messages";
import { Command, interrupt } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { createAgent, tool } from "langchain";
import { z } from "zod";

import { createUniversalAgent, RECURSION_LIMIT } from "@/agents";
import { stallGuard } from "@/agents/stallguard";
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
    // The stub never stops, and the step axis is gone (turn-budget ticket 02):
    // a turn now ends at the token/time budget, not at a node ceiling. A short
    // wall clock stands in for the old recursion limit so the test stays fast.
    turnBudget: { timeBudgetMs: 200 },
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
    // The stub keeps asking for Read, so the turn runs until the wall-clock
    // budget caps it. The hint is what is under test, not the turn's end.
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

/**
 * The one throw that is not a failure.
 *
 * LangGraph implements `interrupt()` as a throw, so a guard whose whole job is
 * "turn a throw into a ToolMessage the model can read" will answer the human's
 * question on the human's behalf: measured in `repro/25` before the fix, the
 * graph never stopped and the model read back
 * `"GraphInterrupt: […] Please fix your mistakes."`.
 *
 * Built on `createAgent` rather than `createUniversalAgent`, because the case is
 * a tool body that calls `interrupt()` and none of this program's tools do — the
 * confirmation gate interrupts from `afterModel`, where no `wrapToolCall` can
 * see it. This pins the guard so the first tool that wants to pause finds the
 * door open.
 */
test("an interrupt from a tool body passes through the guard", async () => {
  const stub = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { messages: { role: string }[] };
      const answered = body.messages.some((message) => message.role === "tool");
      return Response.json({
        id: `chatcmpl-ask-${answered ? "2" : "1"}`,
        object: "chat.completion",
        created: 0,
        model: "stub",
        choices: [
          {
            index: 0,
            message: answered
              ? { role: "assistant", content: "noted" }
              : {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "call_ask",
                      type: "function",
                      function: {
                        name: "Ask",
                        arguments: JSON.stringify({ q: "which?" }),
                      },
                    },
                  ],
                },
            finish_reason: answered ? "stop" : "tool_calls",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });

  const ask = tool(
    (args: { q: string }) => `answered ${args.q}: ${String(interrupt(args.q))}`,
    {
      name: "Ask",
      description: "asks the human",
      schema: z.object({ q: z.string() }),
    },
  );

  const graph = createAgent({
    model: new ChatOpenAI({
      model: "stub",
      apiKey: "sk-stub",
      configuration: { baseURL: `http://localhost:${String(stub.port)}` },
    }),
    tools: [ask],
    checkpointer: new JsonlSaver(mkdtempSync(join(tmpdir(), "mimicc-stall-ask-"))),
    middleware: [stallGuard()],
  });
  const config = { configurable: { thread_id: "ask" }, durability: "sync" as const };

  try {
    const paused = (await graph.invoke(
      { messages: [new HumanMessage("go")] },
      config,
    )) as {
      __interrupt__?: { value?: unknown }[];
    };
    // The question got out. Swallowed, this is `undefined` and the turn is over.
    expect(paused.__interrupt__?.[0]?.value).toBe("which?");

    const done = (await graph.invoke(
      new Command({ resume: "the second one" }),
      config,
    )) as {
      messages: { content: unknown; getType: () => string }[];
    };
    const answer = done.messages.find((message) => message.getType() === "tool");

    // …and the human's answer, not an apology, is what the model ends up holding.
    expect(answer?.content).toBe("answered which?: the second one");
  } finally {
    await stub.stop(true);
  }
});
