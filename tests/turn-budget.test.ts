import { describe, expect, test } from "bun:test";

import { AIMessage, HumanMessage } from "@langchain/core/messages";

import { turnBudget } from "@/agents";

/**
 * The turn-budget tripwire, fired and not fired.
 *
 * The design (turn-budget ticket 01): the step axis is gone — peers pi and DSH
 * run unbounded loops and let the model decide turn length, guarded by time,
 * tokens and retries. mimicc's budget now sits on the token axis (window × 4 per
 * turn) with a wall-clock backstop (10 minutes). Exhaustion is not a kill: the
 * model gets one chance to hand in an answer without further tool calls
 * (DSH-style natural end); only if it keeps calling tools is the message
 * stripped and the turn capped, reported through onCap like loopGuard's
 * loop_capped.
 *
 * Green tests prove nothing here — only a deliberately over-budget turn that
 * gets capped proves the tripwire bites. Token accumulation and the clock are
 * injected, so the whole state machine is exercised without a model.
 */

const aiWithTools = () =>
  new AIMessage({
    content: "planning",
    tool_calls: [{ name: "Bash", args: { command: "ls" }, id: "c1", type: "tool_call" }],
  });

const aiFinal = () => new AIMessage({ content: "done, here is the answer" });

/** A model reply carrying usage, as the provider reports it. */
const aiUsage = (inputTokens: number) => {
  // The constructor's field type does not include usage_metadata in this
  // langchain version — attach it the way the provider result carries it.
  const message = new AIMessage({ content: "step" });
  (message as unknown as { usage_metadata: unknown }).usage_metadata = {
    input_tokens: inputTokens,
    output_tokens: 10,
    total_tokens: inputTokens + 10,
  };
  return message;
};

/** Drive one model round through the middleware and return the request the handler saw. */
async function round(
  middleware: ReturnType<typeof turnBudget>,
  usage: number,
): Promise<{ messages: unknown[] }> {
  let seen: { messages: unknown[] } = { messages: [] };
  // The real request is a full ModelRequest; the budget only reads messages,
  // so a bare request stands in for it here.
  const wrap = middleware.wrapModelCall as unknown as (
    request: { messages: unknown[] },
    handler: (request: { messages: unknown[] }) => Promise<AIMessage>,
  ) => Promise<unknown>;
  await wrap({ messages: [] }, async (request) => {
    seen = request;
    return aiUsage(usage);
  });
  return seen;
}

/** The afterModel hook, unwrapped from the function-or-{hook} union. */
function afterModel(middleware: ReturnType<typeof turnBudget>) {
  const hook = middleware.afterModel;
  return (typeof hook === "function" ? hook : hook?.hook) as (
    state: { messages?: unknown[] },
  ) => { messages?: unknown[] } | undefined;
}

/** The beforeAgent hook, unwrapped the same way. */
function beforeAgent(middleware: ReturnType<typeof turnBudget>) {
  const hook = middleware.beforeAgent;
  return (typeof hook === "function" ? hook : hook?.hook) as () => unknown;
}

describe("the turn budget", () => {
  test("a turn under budget passes through untouched", () => {
    const capped: string[] = [];
    const middleware = turnBudget({ tokenBudget: 1_000, timeBudgetMs: 60_000, onCap: (r) => capped.push(r) });

    beforeAgent(middleware)();
    const state = { messages: [aiWithTools()] };
    expect(afterModel(middleware)(state)).toBeUndefined();
    expect(capped).toEqual([]);
  });

  test("an over-budget turn is warned once, then capped when tools keep coming", async () => {
    const capped: string[] = [];
    const middleware = turnBudget({ tokenBudget: 100, timeBudgetMs: 60_000, onCap: (r) => capped.push(r) });

    beforeAgent(middleware)();

    // First call: 60 tokens, fine. Second: 60 more — over the 100 budget.
    await round(middleware, 60);
    expect(afterModel(middleware)({ messages: [aiWithTools()] })).toBeUndefined();
    await round(middleware, 60);
    // Now over budget with tool calls pending: flagged, no kill yet.
    expect(afterModel(middleware)({ messages: [aiWithTools()] })).toBeUndefined();
    expect(capped).toEqual([]);

    // The warning rides the next model call as a HumanMessage.
    const warned = await round(middleware, 0);
    const lastMessage = warned.messages[warned.messages.length - 1];
    expect(lastMessage).toBeInstanceOf(HumanMessage);
    expect(String((lastMessage as HumanMessage).content)).toMatch(/budget/i);

    // The model ignores the warning and calls tools again: stripped + canned + capped.
    const replaced = afterModel(middleware)({ messages: [aiWithTools()] });
    const message = (replaced?.messages ?? [])[0];
    expect(message).toBeInstanceOf(AIMessage);
    expect((message as AIMessage).tool_calls).toHaveLength(0);
    expect(String((message as AIMessage).content)).toMatch(/FORCED STOP/);
    expect(capped).toEqual(["budget_exhausted"]);
  });

  test("a model that hands in an answer after the warning ends the turn cleanly", async () => {
    const capped: string[] = [];
    const middleware = turnBudget({ tokenBudget: 100, timeBudgetMs: 60_000, onCap: (r) => capped.push(r) });

    beforeAgent(middleware)();
    await round(middleware, 150);
    afterModel(middleware)({ messages: [aiWithTools()] }); // flag it
    await round(middleware, 0); // consume the warning

    expect(afterModel(middleware)({ messages: [aiFinal()] })).toBeUndefined();
    expect(capped).toEqual([]);
  });

  test("crossing the budget on the final answer does not intervene", async () => {
    const capped: string[] = [];
    const middleware = turnBudget({ tokenBudget: 100, timeBudgetMs: 60_000, onCap: (r) => capped.push(r) });

    beforeAgent(middleware)();
    await round(middleware, 150);
    // Over budget, but the model is done — the turn ends naturally.
    expect(afterModel(middleware)({ messages: [aiFinal()] })).toBeUndefined();
    expect(capped).toEqual([]);
  });

  test("the wall clock caps a turn that spends no tokens", () => {
    const capped: string[] = [];
    let clock = 0;
    const middleware = turnBudget({
      tokenBudget: 1_000,
      timeBudgetMs: 10_000,
      now: () => clock,
      onCap: (r) => capped.push(r),
    });

    beforeAgent(middleware)();
    clock = 10_001;
    expect(afterModel(middleware)({ messages: [aiWithTools()] })).toBeUndefined(); // flagged
    const replaced = afterModel(middleware)({ messages: [aiWithTools()] });
    const message = (replaced?.messages ?? [])[0];
    expect(String((message as AIMessage).content)).toMatch(/FORCED STOP/);
    expect(capped).toEqual(["budget_exhausted"]);
  });
});
