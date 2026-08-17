import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HumanMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";

import { createUniversalAgent, RECURSION_LIMIT } from "@/agents";
import { JsonlSaver } from "@/checkpoint";

/**
 * What survives a cut, and why it is not "what is important".
 *
 * These are wire-level: they drive the real agent until the window middleware
 * summarises, then read what actually went to the model on the last request.
 * Asserting at that level rather than against the projection's arguments is
 * deliberate — the failure this guards is *the mechanism cannot express it*, and
 * a unit test written against the mechanism cannot see that.
 *
 * Two of these were red before the marker existed, and that is the point: the
 * pin list was fixed at construction (`[PROJECT_INSTRUCTIONS_ID]`), so nothing
 * produced at runtime could ever join it.
 */

let server: ReturnType<typeof Bun.serve>;
let requests: { messages: { role: string; content?: unknown }[] }[] = [];
/** Drives the hybrid token count so a handful of turns crosses the trigger. */
let promptTokens = 1;
/** The tool the first reply of a turn asks for, or none. */
let stubTool: "none" | "Bash" = "none";

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as (typeof requests)[number];
      requests.push(body);

      // Only the turn's first reply calls a tool: the stub has no memory, so it
      // keys off whether a tool result is already present.
      const answered = body.messages.some((message) => message.role === "tool");
      const wantsTool = stubTool === "Bash" && !answered;

      return Response.json({
        id: `chatcmpl-${String(requests.length)}`,
        object: "chat.completion",
        created: 0,
        model: "stub",
        choices: [
          {
            index: 0,
            message: wantsTool
              ? {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: `call_${String(requests.length)}`,
                      type: "function",
                      function: {
                        name: "Bash",
                        arguments: '{"command":"rm -rf build"}',
                      },
                    },
                  ],
                }
              : { role: "assistant", content: `answer ${String(requests.length)}` },
            finish_reason: wantsTool ? "tool_calls" : "stop",
          },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: 1,
          total_tokens: promptTokens,
        },
      });
    },
  });
});

afterAll(() => void server.stop(true));

beforeEach(() => {
  requests = [];
  promptTokens = 1;
  stubTool = "none";
});

/**
 * Big enough that a few turns exceed the retention budget.
 *
 * Not decoration — if the tail already fits, there is nothing to cut and the
 * middleware correctly does nothing, so the test would pass for the wrong reason.
 */
function bulky(label: string): string {
  return `${label} ${"padding ".repeat(40)}`;
}

function agent() {
  return createUniversalAgent({
    baseURL: `http://localhost:${String(server.port)}`,
    apiKey: "sk-stub",
    model: "stub",
    checkpointer: new JsonlSaver(mkdtempSync(join(tmpdir(), "mimicc-pinned-"))),
    // trigger at 1,600 tokens, keep 100 — small enough that a handful of turns
    // crosses both lines without generating the tokens for real.
    window: { limit: 2_000, keepFraction: 0.05 },
  });
}

async function turn(graph: ReturnType<typeof agent>, thread: string, text: string) {
  return graph.invoke(
    { messages: [new HumanMessage(text)] },
    { recursionLimit: RECURSION_LIMIT, configurable: { thread_id: thread } },
  );
}

/** Everything the model was sent on the last request, as one searchable string. */
function lastRequestText(): string {
  return JSON.stringify(requests.at(-1)?.messages ?? []);
}

/** True once the middleware has actually summarised — otherwise nothing is proven. */
function summarised(): boolean {
  return lastRequestText().includes("Summary of the earlier part of this conversation");
}

test("the user's own words survive a cut that has passed them", async () => {
  const graph = agent();
  const thread = "task";

  await turn(graph, thread, bulky("MARKER-the-original-task"));

  // Over the trigger from here on, so every later turn tries to advance the cut.
  promptTokens = 1_900;
  for (const n of [1, 2, 3, 4]) {
    await turn(graph, thread, bulky(`filler ${String(n)}`));
  }

  expect(summarised()).toBe(true);
  expect(lastRequestText()).toContain("MARKER-the-original-task");
});

test("a rejected command's reason survives a cut that has passed it", async () => {
  const graph = agent();
  const thread = "rejection";

  // The gate stops Bash and asks; the answer is a rejection carrying a reason,
  // which comes back as a tool result — an operator-level instruction wearing a
  // tool result's clothes.
  stubTool = "Bash";
  await turn(graph, thread, bulky("please clean the build"));
  await graph.invoke(
    new Command({
      resume: { decisions: [{ type: "reject", message: "MARKER-never-delete-here" }] },
    }),
    { recursionLimit: RECURSION_LIMIT, configurable: { thread_id: thread } },
  );

  stubTool = "none";
  promptTokens = 1_900;
  for (const n of [1, 2, 3, 4]) {
    await turn(graph, thread, bulky(`filler ${String(n)}`));
  }

  expect(summarised()).toBe(true);
  expect(lastRequestText()).toContain("MARKER-never-delete-here");
});

/**
 * The control. Without it the two tests above would also pass on a projection
 * that simply never cuts anything, which is the failure mode a "does it survive"
 * assertion cannot see on its own.
 */
test("an ordinary assistant reply does not survive the same cut", async () => {
  const graph = agent();
  const thread = "control";

  await turn(graph, thread, bulky("first"));
  const early = `answer ${String(requests.length)}`;

  promptTokens = 1_900;
  for (const n of [1, 2, 3, 4]) {
    await turn(graph, thread, bulky(`filler ${String(n)}`));
  }

  expect(summarised()).toBe(true);
  expect(lastRequestText()).not.toContain(early);
});
