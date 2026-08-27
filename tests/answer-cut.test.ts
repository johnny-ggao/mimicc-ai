import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HumanMessage } from "@langchain/core/messages";

import { createUniversalAgent, RECURSION_LIMIT } from "@/agents";
import { JsonlSaver } from "@/checkpoint";

/**
 * The output ceiling eats the whole reply and the turn ends as if nothing was
 * wrong. Terminal-Bench, run `2026-08-27__22-37-36`:
 *
 * - `grid-pattern-transform`: **2 messages, 0 tool calls, 133s.** The single
 *   model call came back `completion_tokens == reasoning_tokens == 32768`,
 *   content empty, tool_calls empty. The agent exited having done nothing, and
 *   said nothing about it.
 * - `write-compressor`: the same reply twice (57144 and 58471 characters of
 *   reasoning, no content), then the canned "no final response" — which names
 *   the wrong cause.
 *
 * The stub reproduces exactly that: it echoes the ceiling it was asked for back
 * as the tokens it spent, with `finish_reason: "length"` and nothing to show.
 */

let server: ReturnType<typeof Bun.serve>;
let mode: "first-empty" | "tool-then-empty" | "plain-empty" = "first-empty";
let replies = 0;

// A distinct id per response, and it is load-bearing: langgraph keys messages by
// id, so a stub that reuses one turns the second reply into an *edit* of the
// first and the guard under test never sees two messages.
const envelope = (choice: unknown, usage: unknown) => ({
  id: `stub-${String(replies)}`,
  object: "chat.completion",
  created: 0,
  model: "stub",
  choices: [choice],
  usage,
});

/** Reasoning ate the whole ceiling: nothing to show, and the provider says why. */
const ceilingBound = (ceiling: number) =>
  Response.json(
    envelope(
      {
        index: 0,
        message: { role: "assistant", content: "" },
        finish_reason: "length",
      },
      {
        prompt_tokens: 10,
        completion_tokens: ceiling,
        total_tokens: 10 + ceiling,
        completion_tokens_details: { reasoning_tokens: ceiling },
      },
    ),
  );

/** The control: an empty reply that is *not* the ceiling's doing. */
const plainEmpty = () =>
  Response.json(
    envelope(
      { index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" },
      { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
    ),
  );

const toolCall = () =>
  Response.json(
    envelope(
      {
        index: 0,
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "Read", arguments: '{"path":"package.json"}' },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
      { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    ),
  );

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { max_tokens?: number };
      replies += 1;
      if (mode === "tool-then-empty" && replies === 1) return toolCall();
      if (mode === "plain-empty") {
        return replies === 1 ? toolCall() : plainEmpty();
      }
      return ceilingBound(body.max_tokens ?? 0);
    },
  });
});

afterAll(() => void server.stop(true));
beforeEach(() => {
  replies = 0;
});

type Event = { type: string; bound?: string; ceiling?: number; output?: number };

function run(thread: string): {
  events: Event[];
  turn: Promise<{ messages: { content: unknown }[] }>;
} {
  const events: Event[] = [];
  const graph = createUniversalAgent({
    baseURL: `http://localhost:${String(server.port)}`,
    apiKey: "sk-stub",
    model: "stub",
    checkpointer: new JsonlSaver(mkdtempSync(join(tmpdir(), "mimicc-cut-"))),
    onWindow: (event) => events.push(event),
  });
  return {
    events,
    turn: graph.invoke(
      { messages: [new HumanMessage("go")] },
      { recursionLimit: RECURSION_LIMIT, configurable: { thread_id: thread } },
    ) as Promise<{ messages: { content: unknown }[] }>,
  };
}

const text = (out: { messages: { content: unknown }[] }): string => {
  const last = out.messages.at(-1);
  return typeof last?.content === "string"
    ? last.content
    : JSON.stringify(last?.content);
};

// C1. The first model call of the turn comes back empty because the ceiling ate
// it. No tool has run, so `emptyReplyGuard` never looks — and the graph ends.
test("a first reply eaten by the ceiling does not end the turn in silence", async () => {
  mode = "first-empty";
  const { turn, events } = run("cut-1");
  const out = await turn;

  // The classification already works; only the acting on it is missing.
  expect(
    events.filter((e) => e.type === "answer_cut" && e.bound === "ceiling"),
  ).not.toEqual([]);
  // The symptom: the user is handed a blank turn with no idea why.
  expect(text(out)).not.toBe("");
  expect(text(out).toLowerCase()).toContain("output");
});

// C2. Same reply, but after a tool ran. `emptyReplyGuard` does fire — and asks
// for "a concise final response", which is not what went wrong.
test("a reply eaten by the ceiling is not reported as the model staying silent", async () => {
  mode = "tool-then-empty";
  const { turn } = run("cut-2");
  const out = await turn;

  expect(text(out).toLowerCase()).toContain("output");
  expect(text(out)).not.toContain("no final response");
  // And it does not pay for the retry. `write-compressor` burned a second
  // identical 32768-token call before giving up; the ceiling has not moved
  // between the two, so the second call cannot end differently.
  expect(replies).toBe(2);
});

// The control. Without it, a guard that shouts "ceiling" at every empty reply
// passes both tests above.
test("an empty reply that is not the ceiling's doing keeps the old handling", async () => {
  mode = "plain-empty";
  const { turn, events } = run("cut-3");
  const out = await turn;

  expect(events.filter((e) => e.type === "answer_cut")).toEqual([]);
  expect(text(out)).toContain("no final response");
  // The retry the control is protecting: tool call, empty, retry, empty.
  expect(replies).toBe(3);
});
