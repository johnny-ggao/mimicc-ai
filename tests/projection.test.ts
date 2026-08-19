import { describe, expect, test } from "bun:test";

import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";

import {
  closeDangling,
  estimate,
  PINNED,
  planCut,
  project,
  requestTokens,
  tailWithin,
} from "@/context";

/**
 * The projection, asked questions directly.
 *
 * Every assertion here used to require starting an agent and a stub server,
 * because the arithmetic lived inside a middleware as private functions. That is
 * the whole case for the extraction, and the cost of not having done it is on
 * the record: the `requestTokens` / `planCut` mismatch at the bottom of this file
 * existed for the life of the code and was found by a probe against the real
 * provider, not by a test — because there was no way to put the two side by side.
 *
 * The adapter's tests stay where they are, on a stub server (`window.test.ts`).
 * Both bugs this feature has actually shipped were in adapters, not in
 * arithmetic; see `docs/adr/0004`.
 */

const human = (text: string, id?: string): BaseMessage =>
  new HumanMessage(id === undefined ? { content: text } : { content: text, id });

/** A message its producer marked as one that must survive a cut. */
const stuck = (text: string): BaseMessage =>
  new HumanMessage({ content: text, additional_kwargs: { ...PINNED } });

/**
 * An assistant reply carrying the provider's own token count, as one arrives.
 *
 * The cast is the fourth appearance of one declaration defect, and it is
 * quarantined here for the same reason it is in `usage.ts`, `agents/loop.ts` and
 * `projection.ts`: `usage_metadata` is declared through the generic
 * message-structure machinery and collapses to `undefined` when the structure
 * parameter is left at its default, so the compiler believes the field can never
 * hold a value. The runtime object is correct — this is the shape the provider
 * actually returns. Retry all four on the next @langchain/core bump.
 */
const ai = (text: string, inputTokens?: number): BaseMessage =>
  new AIMessage({
    content: text,
    ...(inputTokens === undefined
      ? {}
      : {
          usage_metadata: {
            input_tokens: inputTokens,
            output_tokens: 1,
            total_tokens: inputTokens + 1,
          },
        }),
  } as unknown as ConstructorParameters<typeof AIMessage>[0]);

const calls = (ids: string[]): BaseMessage =>
  new AIMessage({
    content: "",
    tool_calls: ids.map((id) => ({ id, name: "Read", args: {} })),
  });

const results = (ids: string[]): BaseMessage[] =>
  ids.map((id) => new ToolMessage({ content: "ok", tool_call_id: id }));

describe("project — what the model is sent", () => {
  test("an uncut history is passed through untouched", () => {
    const history = [human("one"), ai("two")];

    // Both halves matter: no cut and no summary each mean "nothing to project",
    // and returning a rebuilt array in either case would be a needless copy that
    // a reducer could mistake for a change.
    expect(project(history, { at: 0 })).toBe(history);
    expect(project(history, { at: 2 })).toBe(history);
  });

  test("the summary stands in for everything before the cut", () => {
    const history = [human("one"), human("two"), human("three"), human("four")];
    const view = project(history, { at: 2, summary: human("condensed") });

    expect(view.map((message) => message.text)).toEqual(["condensed", "three", "four"]);
  });

  /**
   * The reason pinning exists at all.
   *
   * A resident message is injected under a fixed id and `messagesStateReducer`
   * replaces by id *in place* — so it never moves from its position near the
   * front, and every cut ever made passes over it. Re-injecting it each turn
   * does not help; only rebuilding the view does.
   */
  test("a pinned message survives a cut that passed over it", () => {
    const history = [stuck("resident"), human("old"), human("new")];
    const view = project(history, { at: 2, summary: human("condensed") });

    expect(view.map((message) => message.text)).toEqual([
      "resident",
      "condensed",
      "new",
    ]);
  });

  test("several can be pinned, and the unpinned one beside them is not", () => {
    // The control lives inside this case on purpose: an assertion that pinned
    // messages come back is also satisfied by a projection that cuts nothing, so
    // "old" being absent is what makes the other half mean anything.
    const history = [stuck("a"), stuck("b"), human("old"), human("new")];
    const view = project(history, { at: 3, summary: human("condensed") });

    expect(view.map((message) => message.text)).toEqual(["a", "b", "condensed", "new"]);
  });

  test("a pinned message after the cut is not duplicated", () => {
    const history = [human("old"), stuck("resident"), human("new")];
    const view = project(history, { at: 1, summary: human("condensed") });

    expect(view.filter((message) => message.text === "resident")).toHaveLength(1);
  });
});

describe("planCut — where to cut, or nothing", () => {
  test("returns null when no cut would make progress", () => {
    // The state the probe hit against the real provider: the tail already fits
    // the retention budget, so there is nothing the cutter is willing to drop.
    // It used to be an anonymous `if (next > cutoff)` with no test on the false
    // branch.
    const history = [human("a"), human("b")];

    expect(planCut(history, { at: 0 }, 10_000)).toBeNull();
  });

  test("never moves the cut backwards", () => {
    const history = [human("a".repeat(400)), human("b".repeat(400)), human("c")];

    // Already cut past everything a fresh calculation would choose: the answer
    // is "no progress", not "un-summarise what was summarised".
    expect(planCut(history, { at: 3 }, 1)).toBeNull();
  });

  test("cuts far enough back that the tail fits the budget", () => {
    const history = Array.from({ length: 6 }, (_, index) =>
      human(`${String(index)} ${"x".repeat(400)}`),
    );

    const at = planCut(history, { at: 0 }, 200);
    expect(at).not.toBeNull();
    expect(estimate(history.slice(at ?? 0))).toBeLessThanOrEqual(200 + 100);
  });

  /**
   * The provider's constraint, not a preference: an assistant message with
   * `tool_calls` must be followed by a result for each one, and a result with no
   * call ahead of it is rejected outright.
   */
  test("a cut never lands between a tool call and its results", () => {
    const history = [
      human("q"),
      calls(["c1", "c2"]),
      ...results(["c1", "c2"]),
      human("z".repeat(2_000)),
    ];

    const at = planCut(history, { at: 0 }, 100);
    expect(at).not.toBeNull();
    // Whatever it chose, the view it produces must not open with an orphan.
    const view = project(history, { at: at ?? 0, summary: human("s") });
    const firstAfterSummary = view[1];
    expect(ToolMessage.isInstance(firstAfterSummary)).toBe(false);
  });
});

describe("requestTokens — how big the next request is", () => {
  test("anchors on the last figure the provider reported", () => {
    // Not an estimate of everything: the anchor is a true number, plus an
    // estimate of only what has been added since. Characters-per-token was
    // measured between 5.84 and 1.64 while the estimator assumes 4, so anchoring
    // shrinks the error from "wrong about everything" to "wrong about the tail".
    const history = [human("q"), ai("a", 5_000), human("x".repeat(400))];

    // The anchor message is counted *and* estimated, which looks like
    // double-counting and is not: `input_tokens` is what that call was given,
    // and the reply it produced was not part of it. The reply becomes input to
    // the next call, so it belongs in the estimate on top.
    expect(requestTokens(history, { at: 0 })).toBe(5_000 + estimate(history.slice(1)));
  });

  test("falls back to a pure estimate before the provider has said anything", () => {
    const history = [human("x".repeat(400))];

    expect(requestTokens(history, { at: 0 })).toBe(estimate(history));
  });

  /**
   * The finding this module was extracted to make expressible.
   *
   * `requestTokens` measures **the request** — it anchors on the provider's
   * `input_tokens`, which includes the resident segment (system prompt plus tool
   * schemas, `CONTEXT.md`: 常驻段). `planCut` measures **the view** — it walks
   * the message array and the resident segment is not in it.
   *
   * So the two can disagree, and the disagreement is not a bug in either: it is
   * a missing term. Measured against the real provider on a small window,
   * `requestTokens` returned 4,483 against a 4,000 trigger while `planCut`
   * refused to cut, because ~2,400 of that total was resident. In production the
   * resident segment is 0.2% of the window and this is invisible.
   *
   * Pinned as a characterisation test rather than fixed: making the resident
   * segment an explicit parameter changes *when* summaries fire in production,
   * and this repository settles those from observations. `docs/adr/0004` carries
   * the debt and its trigger.
   */
  test("counts the resident segment that planCut cannot see", () => {
    const resident = 2_400;
    const history = [human("q"), ai("a", resident + 20)];
    const cut = { at: 0 };

    // Over a trigger that the messages alone come nowhere near…
    expect(requestTokens(history, cut)).toBeGreaterThan(2_000);
    expect(estimate(history)).toBeLessThan(2_000);
    // …and so the cutter, asked for a budget larger than the messages, declines.
    expect(planCut(history, cut, 2_000)).toBeNull();
  });
});

describe("the shared ruler", () => {
  test("tailWithin keeps the longest tail that fits", () => {
    const history = [human("a".repeat(400)), human("b".repeat(400)), human("c")];

    expect(tailWithin(history, 1).map((message) => message.text)).toEqual(["c"]);
    expect(tailWithin(history, 10_000)).toHaveLength(3);
  });

  test("estimate counts tool call arguments, not only content", () => {
    // A lap of tool calls is mostly arguments, and an estimator blind to them
    // would put the cut in the wrong place on exactly the turns that need one.
    const bare = new AIMessage({ content: "" });
    const withCalls = calls(["c1"]);

    expect(estimate([withCalls])).toBeGreaterThan(estimate([bare]));
  });
});

/**
 * Unanswered tool calls, and why the view repairs them instead of the history.
 *
 * A provider rejects an assistant message whose `tool_calls` have no results —
 * HTTP 400, measured (`repro/19-orphan-tool-call.ts`) — and the shape is
 * reachable by pressing Ctrl+C while a tool runs and then typing
 * (`repro/20-abort-mid-tool-then-type.ts`). History only grows, so one of those
 * left behind ends the session rather than one turn.
 *
 * The **position** assertions are the ones that matter: the same probe measured
 * that a result appended after the following user message is rejected too, which
 * is what ruled out repairing this from a `beforeAgent` hook (state updates
 * append) and left the projection as the only place that can put it right.
 */
describe("closing unanswered tool calls", () => {
  const calling = (id: string, name = "Bash") =>
    new AIMessage({
      content: "",
      tool_calls: [{ id, name, args: { command: "echo hi" }, type: "tool_call" }],
    });

  test("an unanswered call gets a result immediately after it", () => {
    const view = closeDangling([
      new HumanMessage("跑一下"),
      calling("call_1"),
      new HumanMessage("接着聊"),
    ]);

    expect(view.map((message) => message.getType())).toEqual([
      "human",
      "ai",
      "tool",
      "human",
    ]);
    expect((view[2] as ToolMessage).tool_call_id).toBe("call_1");
    expect(view[2]?.content).toContain("abandoned");
  });

  test("a call that already has its result is left exactly as it was", () => {
    const messages: BaseMessage[] = [
      calling("call_1"),
      new ToolMessage({ content: "hi", tool_call_id: "call_1" }),
    ];

    // The same array, not a copy: this runs on every single request.
    expect(closeDangling(messages)).toBe(messages);
  });

  test("each call of a batch gets its own result, in order", () => {
    const batch = new AIMessage({
      content: "",
      tool_calls: [
        { id: "a", name: "Read", args: {}, type: "tool_call" },
        { id: "b", name: "Grep", args: {}, type: "tool_call" },
      ],
    });
    const view = closeDangling([batch, new HumanMessage("接着聊")]);

    expect(view.map((message) => message.getType())).toEqual([
      "ai",
      "tool",
      "tool",
      "human",
    ]);
    expect((view[1] as ToolMessage).tool_call_id).toBe("a");
    expect((view[2] as ToolMessage).tool_call_id).toBe("b");
    // Named, because the text tells the model which call it is reading about.
    expect(view[1]?.content).toContain("Read");
    expect(view[2]?.content).toContain("Grep");
  });

  test("project() closes them, and does it after the cut arithmetic", () => {
    const history: BaseMessage[] = [
      new HumanMessage("一"),
      new HumanMessage("二"),
      calling("call_1"),
      new HumanMessage("接着聊"),
    ];
    // A cut at 2 keeps the tail from `calling` onwards. Repairing before the cut
    // would have moved that index out from under it.
    const view = project(history, { at: 2, summary: new AIMessage("提要") });

    expect(view.map((message) => message.getType())).toEqual([
      "ai",
      "ai",
      "tool",
      "human",
    ]);
    expect((view[2] as ToolMessage).tool_call_id).toBe("call_1");
  });
});
