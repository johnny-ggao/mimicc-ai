import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { createUniversalAgent, RECURSION_LIMIT } from "@/agents";
import type { ModelUsage } from "@/usage";
import { JsonlSaver } from "@/checkpoint";
import {
  MIN_OUTPUT_TOKENS,
  PROJECT_INSTRUCTIONS_ID,
  SUMMARY_OUTPUT_BUDGET,
  SUMMARY_SOURCE,
  type WindowEvent,
} from "@/context";
import { OUTPUT_BUDGET } from "@/models";

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
  /** What the request actually asked the provider to reserve for the reply. */
  max_tokens?: number;
}

let server: ReturnType<typeof Bun.serve>;
let seen: StubRequest[] = [];
/** Summarising calls, kept apart — `seen` is only ever the agent's own turns. */
let seenSummaries: StubRequest[] = [];

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
      if (summarising) seenSummaries.push(body);
      else seen.push(body);

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
  seenSummaries = [];
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

function agent(
  window?: { limit?: number; keepFraction?: number },
  onUsage?: (usage: ModelUsage) => void,
) {
  events.length = 0;
  return createUniversalAgent({
    ...(onUsage !== undefined ? { onUsage } : {}),
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
 *
 * They used to be asserted to lead the view, and that stopped being true when
 * what the user typed started being pinned too: pinned messages come back in
 * history order, and the turn's own message reaches state before `beforeAgent`
 * injects these. What that assertion was protecting is the *prefix*, not the
 * index — and the prefix is still stable, because the pinned block only ever
 * grows by appending. So the position is no longer asserted; being ahead of the
 * summary is, which is the part the cache and the reader both depend on.
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
  const instructions = contents.findIndex((text) =>
    text.includes("<project-instructions"),
  );
  const summary = contents.findIndex((text) =>
    text.startsWith("Summary of the earlier part"),
  );

  expect(instructions).toBeGreaterThanOrEqual(0);
  expect(summary).toBeGreaterThan(instructions);
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

/**
 * Over the line, and nothing worth cutting — the branch that had no name.
 *
 * `planCut` returning `null` is a state the program reaches in production, not a
 * defensive case: measured against the real provider on a small window, where
 * the resident segment counted by `requestTokens` pushed the total past the
 * trigger while the messages alone still fitted the retention budget. Until the
 * projection was extracted this was an anonymous `if (next > cutoff)` at two
 * call sites, and no test had ever taken the false branch.
 *
 * The correct behaviour is to do nothing and carry on: the turn is not failed,
 * no summarising call is billed, and — this is the part worth pinning — no
 * `summarized` event is reported, because none happened. An event here would
 * make the log claim a compaction that never took place.
 */
test("over the threshold with nothing to cut, the turn proceeds and says nothing", async () => {
  // Two turns, and that is load-bearing. `requestTokens` anchors on an
  // `input_tokens` the provider has actually reported, so on turn one there is
  // no anchor and the total is a small estimate — the threshold is not crossed
  // and this test would pass without ever reaching the branch it is about.
  //
  // The keep budget is larger than the whole history, so every candidate cut
  // leaves a tail that already fits and the cutter declines.
  const graph = agent({ limit: 2_000, keepFraction: 5 });
  promptTokens = 1_900;
  await turn(graph, "uncuttable", bulky("first"));
  const state = await turn(graph, "uncuttable", bulky("second"));

  expect(events).toEqual([]);
  const shown = lastRequest().messages;
  const kept = (state as { messages: BaseMessage[] }).messages;
  expect(shown.length).toBe(kept.length - 1);
  expect(
    shown.some(
      (message) =>
        typeof message.content === "string" && message.content.includes("Summary of"),
    ),
  ).toBe(false);
});

test("the same two turns DO summarise once the keep budget is realistic", async () => {
  // The positive control for the test above. Without it, "no events" proves
  // nothing: a threshold that was never crossed looks exactly like a cut that
  // was declined, and the assertion would hold for the wrong reason.
  const graph = agent({ limit: 2_000, keepFraction: 0.05 });
  promptTokens = 1_900;
  await turn(graph, "cuttable", bulky("first"));
  await turn(graph, "cuttable", bulky("second"));

  expect(events.some((event) => event.type === "summarized")).toBe(true);
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

/**
 * The scale and the window, which are easy to get wrong together.
 *
 * Both facts here were blind spots found by reading the code rather than by a
 * failing test, and both made the log lie in the one place it is relied on: a
 * turn that summarises. The meter used to sit outside the window middleware, so
 * it counted the whole history rather than the messages actually sent, and the
 * summarising call — the largest single request this program can make — went
 * through `model.invoke` directly and was never metered at all.
 */
/**
 * The scale and the window, which are easy to get wrong together.
 *
 * Both facts here were blind spots found by reading the code rather than by a
 * failing test, and both made the log lie in the one place it is relied on: a
 * turn that summarises. The meter used to sit outside the window middleware, so
 * it counted the whole history rather than the messages actually sent; and the
 * summarising call — the largest single request this program can make — goes
 * through `model.invoke` directly, where no middleware can see it.
 */
describe("what the scale sees when the window cuts", () => {
  test("meters the summarising call under its own name", async () => {
    const usage: ModelUsage[] = [];
    const graph = agent(undefined, (record) => usage.push(record));

    promptTokens = 1_900;
    await turn(graph, "usage-summary", bulky("first"));
    await turn(graph, "usage-summary", bulky("second"));
    await turn(graph, "usage-summary", bulky("third"));

    // `"main summary"`, not a bare `"summary"`: the label is derived from the
    // agent's identity, so every kind's summarising call is billed under a name
    // that says whose it was. There is no unlabelled default left to fall into.
    const summaries = usage.filter((record) => record.agent === "main summary");
    expect(usage.some((record) => record.agent === "main")).toBe(true);
    // One record per summarising call, not one per turn that happened to
    // summarise: a request is a record, which is the whole contract of the scale.
    expect(summaries).toHaveLength(
      events.filter((event) => event.type === "summarized").length,
    );
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries[0]?.messages).toBe(1);
  });

  test("counts the messages that were sent, not the ones that were kept", async () => {
    const usage: ModelUsage[] = [];
    const graph = agent(undefined, (record) => usage.push(record));

    promptTokens = 1_900;
    await turn(graph, "usage-view", bulky("first"));
    await turn(graph, "usage-view", bulky("second"));
    const state = (await turn(graph, "usage-view", bulky("third"))) as {
      messages: BaseMessage[];
    };

    const sent = usage.filter((record) => record.agent === "main").at(-1);

    // The history keeps growing; the view does not. With the meter outside the
    // window middleware these two were equal, and the log reported a request
    // larger than the one that was actually made.
    expect(events.some((event) => event.type === "summarized")).toBe(true);
    expect(sent?.messages ?? 0).toBeLessThan(state.messages.length);
  });
});

/**
 * The summarising call asks for its own ceiling; the agent asks for its own.
 *
 * ## Why this is a wire test and not a unit test
 *
 * The claim is about a request nobody wraps. Summarising is a raw
 * `model.invoke` outside the graph, so every middleware this program installs
 * misses it. Only the stub's request log proves what the provider was asked for.
 *
 * ⚠️ **The two numbers have to differ for this to prove anything**, which is why
 * the budgets are checked separately. They were briefly both 4096, and this test
 * could not have told inheritance from choice.
 */
test("the summarising call asks for its own ceiling, the agent asks for its own", async () => {
  const graph = agent();
  promptTokens = 1_900;
  await turn(graph, "budget", bulky("first"));
  await turn(graph, "budget", bulky("second"));

  expect(events.some((event) => event.type === "summarized")).toBe(true);
  expect(seenSummaries.length).toBeGreaterThan(0);

  // This test's window is 2,000 tokens, far under the safety margin, so every
  // ceiling here floors. That is the clamp working, and it is why the assertion
  // is a range rather than a constant: what is shown is that each caller
  // computes its own, not that either lands on a particular number.
  for (const request of seenSummaries) {
    expect(request.max_tokens).toBeLessThanOrEqual(SUMMARY_OUTPUT_BUDGET);
    expect(request.max_tokens).toBeGreaterThanOrEqual(MIN_OUTPUT_TOKENS);
  }
  for (const request of seen) {
    expect(request.max_tokens).toBeLessThanOrEqual(OUTPUT_BUDGET);
    expect(request.max_tokens).toBeGreaterThanOrEqual(MIN_OUTPUT_TOKENS);
  }
});

/**
 * The ceiling on the wire tracks how full the context is — the whole point of
 * the ticket, asserted where it is observable.
 */
test("the ceiling on the wire shrinks as the context fills", async () => {
  const graph = agent({ limit: 200_000 });

  promptTokens = 1;
  await turn(graph, "roomy", "hello");
  expect(seen.at(-1)?.max_tokens).toBe(OUTPUT_BUDGET);

  // 190,000 of a 200,000 window already spoken for: what is left is less than
  // the budget, so the answer has to be smaller.
  //
  // ⚠️ **Two turns, not one, and that is the mechanism rather than a workaround.**
  // The ceiling is computed before the request goes out, from the anchor the
  // *previous* answer left behind (`requestTokens` in `src/context/projection.ts`).
  // So the turn that first reports a full context still asks for the full budget;
  // the one after it is the first that can know.
  promptTokens = 190_000;
  await turn(graph, "roomy", "hello again");
  await turn(graph, "roomy", "and again");
  const full = seen.at(-1)?.max_tokens;
  expect(full).toBeLessThan(OUTPUT_BUDGET);
  expect(full).toBeGreaterThanOrEqual(MIN_OUTPUT_TOKENS);
});
