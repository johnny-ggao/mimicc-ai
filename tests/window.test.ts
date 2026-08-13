import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { createUniversalAgent, RECURSION_LIMIT } from "@/agent";
import { JsonlSaver } from "@/checkpoint";
import { PROJECT_INSTRUCTIONS_ID } from "@/instructions";
import { SUMMARY_SOURCE, type WindowEvent } from "@/window";

/**
 * One seam, two observation points — which is the whole reason this ticket can
 * be tested at all.
 *
 * **What the model saw** is the stub's request log: that *is* the context
 * window, byte for byte. **What was kept** is the thread file the previous
 * ticket introduced. The claim under test is that the first can shrink while the
 * second does not, and nothing short of watching both at once demonstrates it.
 */

interface StubRequest {
  messages: { role: string; content?: unknown; tool_calls?: unknown[] }[];
}

let server: ReturnType<typeof Bun.serve>;
let seen: StubRequest[] = [];

/** Set per test to steer the stub. */
let promptTokens = 1;
let failures: ("overflow" | "summary" | "none")[] = [];
/** Summarising fails for the whole test. A one-shot 500 is simply retried. */
let summaryAlwaysFails = false;

const OVERFLOW_BODY = {
  error: {
    // The provider's own wording. `maximum context length` is the phrase the
    // framework matches on to raise a typed overflow error, and that it matches
    // at all was verified against the real API rather than assumed.
    message:
      "This model's maximum context length is 1048576 tokens. However, you requested 2000000 tokens.",
    type: "invalid_request_error",
    code: "invalid_request_error",
  },
};

/** A summarising call is the one carrying the conversation transcript. */
function isSummaryCall(body: StubRequest): boolean {
  return body.messages.some(
    (message) =>
      typeof message.content === "string" && message.content.includes("<conversation>"),
  );
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as StubRequest;
      const summarising = isSummaryCall(body);
      if (!summarising) seen.push(body);

      // Peek, and only consume when this call is the kind the entry is about —
      // otherwise a summarising call silently eats a failure meant for an agent
      // call and the test asserts something it never set up.
      const next = failures[0];
      if (next === "overflow" && !summarising) {
        failures.shift();
        return Response.json(OVERFLOW_BODY, { status: 400 });
      }
      if (summaryAlwaysFails && summarising) {
        // A 200 carrying no choices, not an error status. Anything with a
        // failing status code is retried six times with backoff — measured, and
        // the reason this test used to run past its timeout. This fails once,
        // immediately, which is the case being asserted.
        return Response.json({
          id: "empty",
          object: "chat.completion",
          created: 0,
          model: "stub",
          choices: [],
          usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
        });
      }

      return Response.json({
        id: `chatcmpl-${String(seen.length)}-${summarising ? "s" : "a"}`,
        object: "chat.completion",
        created: 0,
        model: "stub",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: summarising
                ? "condensed earlier work"
                : `answer ${String(seen.length)}`,
            },
            finish_reason: "stop",
          },
        ],
        // Drives the hybrid token count: this is the "last real input_tokens"
        // the middleware anchors on, so a test can put the thread just under or
        // just over the line without generating the tokens for real.
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
  seen = [];
  promptTokens = 1;
  failures = [];
  summaryAlwaysFails = false;
});

const events: WindowEvent[] = [];

/**
 * Big enough that a few turns exceed `keep`.
 *
 * Not decoration: if the tail already fits in the retention budget there is
 * nothing to cut, and the middleware correctly does nothing. A test built on
 * tiny messages passes for the wrong reason, or fails for one.
 */
function bulky(label: string): string {
  return `${label} ${"padding ".repeat(40)}`;
}

function agent(window?: { limit?: number; keepFraction?: number }) {
  events.length = 0;
  return createUniversalAgent({
    baseURL: `http://localhost:${String(server.port)}`,
    apiKey: "sk-stub",
    model: "stub",
    checkpointer: new JsonlSaver(mkdtempSync(join(tmpdir(), "mimicc-window-"))),
    projectInstructions:
      "<project-instructions path='AGENTS.md'>be terse</project-instructions>",
    // trigger at 1,600 tokens, keep 100 — small enough that a handful of turns
    // crosses both lines without generating eight hundred thousand tokens.
    window: { limit: 2_000, keepFraction: 0.05, ...window },
    onWindow: (event) => events.push(event),
  });
}

async function turn(graph: ReturnType<typeof agent>, thread: string, text: string) {
  return graph.invoke(
    { messages: [new HumanMessage(text)] },
    { recursionLimit: RECURSION_LIMIT, configurable: { thread_id: thread } },
  );
}

/**
 * Awaits a rejection and hands back the message.
 *
 * Written out rather than using `expect(...).rejects`, because the lint rule
 * treats that matcher as non-thenable and so the `await` gets dropped — which
 * leaves the turn running into the *next* test, quietly consuming its stub
 * calls. Cost an hour of chasing the wrong failure.
 */
async function failureFrom(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return String(error);
  }
  throw new Error("expected this to fail, but it succeeded");
}

function lastRequest(): StubRequest {
  const request = seen.at(-1);
  if (request === undefined) throw new Error("the stub was never called");
  return request;
}

/**
 * The claim of the whole ticket, in one test: the view shrank, the record did
 * not.
 */
test("summarising shortens what the model sees and nothing else", async () => {
  const graph = agent();
  // The anchor is the last input_tokens the provider *reported*, so it has to be
  // set before the turn that produces it, not before the turn that reads it.
  promptTokens = 1_900;
  await turn(graph, "t", bulky("first"));
  await turn(graph, "t", bulky("second"));
  const state = await turn(graph, "t", bulky("third"));

  expect(events.some((event) => event.type === "summarized")).toBe(true);

  const shown = lastRequest().messages;
  const kept = (state as { messages: BaseMessage[] }).messages;
  expect(shown.length).toBeLessThan(kept.length);

  // Every turn is still in state, in order, including the ones the model can no
  // longer see.
  const texts = kept.map((message) =>
    typeof message.content === "string" ? message.content : "",
  );
  expect(texts.some((text) => text.startsWith("first"))).toBe(true);
  expect(texts.some((text) => text.startsWith("second"))).toBe(true);
  expect(texts.some((text) => text.startsWith("third"))).toBe(true);
});

test("what the model sees carries a summary in place of the cut messages", async () => {
  const graph = agent();
  promptTokens = 1_900;
  await turn(graph, "t", bulky("first"));
  await turn(graph, "t", bulky("second"));
  await turn(graph, "t", bulky("third"));

  const contents = lastRequest().messages.map((message) =>
    typeof message.content === "string" ? message.content : "",
  );
  expect(contents.some((text) => text.startsWith("Summary of the earlier part"))).toBe(
    true,
  );
});

/**
 * The pin. Injected instructions sit near the front under a fixed id, and the
 * reducer replaces by id *in place* — so they never move, and every cut made
 * from here on is behind them. Re-injecting does not help; only the view can.
 */
test("the repository's instructions stay visible after a summary", async () => {
  const graph = agent();
  promptTokens = 1_900;
  await turn(graph, "t", bulky("first"));
  await turn(graph, "t", bulky("second"));
  await turn(graph, "t", bulky("third"));

  const contents = lastRequest().messages.map((message) =>
    typeof message.content === "string" ? message.content : "",
  );
  expect(contents.some((text) => text.includes("<project-instructions"))).toBe(true);
  // And it leads, so the stable part of the prefix stays stable.
  expect(contents.findIndex((text) => text.includes("<project-instructions"))).toBe(0);
});

test("below the threshold the model sees the history unchanged", async () => {
  const graph = agent();
  const state = await turn(graph, "t", bulky("first"));

  expect(events).toEqual([]);
  const shown = lastRequest().messages;
  const kept = (state as { messages: BaseMessage[] }).messages;
  // One fewer on the wire: the model's reply is in state but was not part of
  // the request that produced it.
  expect(shown.length).toBe(kept.length - 1);
});

test("a second summary builds on the first rather than restarting", async () => {
  const graph = agent();
  promptTokens = 1_900;
  await turn(graph, "t", bulky("first"));
  await turn(graph, "t", bulky("second"));
  await turn(graph, "t", bulky("third"));
  await turn(graph, "t", bulky("fourth"));

  const summaries = events.filter((event) => event.type === "summarized");
  expect(summaries.length).toBeGreaterThanOrEqual(2);

  // Exactly one summary is ever visible: the newer one replaces the older, it
  // does not stack.
  const shown = lastRequest().messages.map((message) =>
    typeof message.content === "string" ? message.content : "",
  );
  expect(
    shown.filter((text) => text.startsWith("Summary of the earlier part")).length,
  ).toBe(1);
});

/**
 * The provider rejects an assistant message whose tool calls have no results,
 * and results with no call ahead of them. A cut landing inside a batch of
 * results would produce the second, so it has to move.
 */
test("a cut never separates a tool call from its results", async () => {
  const graph = agent();
  promptTokens = 1_900;
  await turn(graph, "t", bulky("first"));
  await turn(graph, "t", bulky("second"));
  await turn(graph, "t", bulky("third"));

  for (const request of seen) {
    const callIds = new Set<string>();
    for (const message of request.messages) {
      for (const call of (message.tool_calls ?? []) as { id: string }[])
        callIds.add(call.id);
    }
    for (const message of request.messages) {
      if (message.role !== "tool") continue;
      const id = (message as unknown as { tool_call_id: string }).tool_call_id;
      expect(callIds.has(id)).toBe(true);
    }
  }
});

/**
 * The threshold is defended by an estimate that measurement showed can be
 * several times wrong, so the line does get crossed. Catching it turns a hard
 * failure into a slower turn.
 */
test("an overflow rejection is absorbed by summarising and retrying once", async () => {
  const graph = agent();
  promptTokens = 1_900;
  await turn(graph, "t", bulky("first"));
  await turn(graph, "t", bulky("second"));

  failures = ["overflow"];
  const state = await turn(graph, "t", bulky("third"));

  expect(
    events.some((event) => event.type === "summarized" && event.reason === "overflow"),
  ).toBe(true);
  expect((state as { messages: BaseMessage[] }).messages.at(-1)?.getType()).toBe("ai");
});

test("a second overflow is reported rather than retried again", async () => {
  const graph = agent();
  promptTokens = 1_900;
  await turn(graph, "t", bulky("first"));
  await turn(graph, "t", bulky("second"));

  failures = ["overflow", "overflow"];
  expect(await failureFrom(turn(graph, "t", bulky("third")))).toMatch(
    /maximum context length/,
  );
});

/**
 * A failed summary must not take the turn down with it: the threshold leaves a
 * fifth of the window spare, so the request still fits. Dropping the oldest
 * messages without summarising is the option deliberately not taken — it would
 * lose context with nothing said.
 */
test("a failed summary is reported and the turn still completes", async () => {
  const graph = agent();
  // Broken from the start, so the very first turn that crosses the threshold is
  // the one that fails. Waiting until later turns does not work: once the cut
  // has nowhere further to move, no summary is attempted at all — correctly.
  summaryAlwaysFails = true;
  promptTokens = 1_900;
  await turn(graph, "t", bulky("first"));
  const state = await turn(graph, "t", bulky("second"));

  expect(events.some((event) => event.type === "summary_failed")).toBe(true);
  expect((state as { messages: BaseMessage[] }).messages.at(-1)?.getType()).toBe("ai");
});

test("the summary is marked, so a later reader can tell it apart from a real turn", async () => {
  const graph = agent();
  promptTokens = 1_900;
  await turn(graph, "t", bulky("first"));
  await turn(graph, "t", bulky("second"));
  const state = await turn(graph, "t", bulky("third"));

  // It is not in state — the view is computed, so the summary lives on the
  // private key rather than being spliced into the record.
  const kept = (state as { messages: BaseMessage[] }).messages;
  expect(
    kept.some((message) => message.additional_kwargs.lc_source === SUMMARY_SOURCE),
  ).toBe(false);
});

test("the pinned instructions are the injected message, not a copy", async () => {
  const graph = agent();
  const state = await turn(graph, "t", bulky("first"));
  const kept = (state as { messages: BaseMessage[] }).messages;

  expect(kept.filter((message) => message.id === PROJECT_INSTRUCTIONS_ID).length).toBe(
    1,
  );
});

test("a summarised thread still reads back whole from disk", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mimicc-window-"));
  const graph = createUniversalAgent({
    baseURL: `http://localhost:${String(server.port)}`,
    apiKey: "sk-stub",
    model: "stub",
    checkpointer: new JsonlSaver(directory),
    window: { limit: 2_000 },
    onWindow: (event) => events.push(event),
  });

  events.length = 0;
  promptTokens = 1_900;
  await turn(graph, "durable", bulky("first"));
  await turn(graph, "durable", bulky("second"));
  await turn(graph, "durable", bulky("third"));

  const file = readFileSync(join(directory, "durable.jsonl"), "utf8");
  // The record on disk keeps both turns, whatever the model was shown.
  expect(file).toContain("first");
  expect(file).toContain("second");
});
