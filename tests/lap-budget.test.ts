import { describe, expect, test } from "bun:test";
import type { AnyAgentMiddleware } from "langchain";

import { agentStack, LAP_BUDGET, NODES_PER_LAP, RECURSION_LIMIT } from "../src/agents";

/**
 * Pins the arithmetic that turns a lap budget into a node ceiling.
 *
 * ## Why this test exists
 *
 * The ceiling used to be written directly in node executions, which made the
 * usable lap count a silent function of how many middlewares were installed —
 * add a guard, lose a lap, and nothing says so. These assertions are where that
 * now becomes loud: a new `afterModel` middleware changes `perLap`, and this
 * file goes red until someone decides what it costs.
 *
 * ⚠️ **The numbers here are not independent of `loop.ts` — they are the same
 * decision, asserted against the assembled stack rather than against a comment.**
 * That is the point: a comment cannot fail.
 */

/** Hooks langchain turns into graph nodes (`ReactAgent.js` `addNode` calls). */
type NodeHook = "beforeAgent" | "beforeModel" | "afterModel" | "afterAgent";

function countHook(stack: AnyAgentMiddleware[], hook: NodeHook): number {
  return stack.filter(
    (middleware) =>
      typeof (middleware as unknown as Record<string, unknown>)[hook] === "function",
  ).length;
}

function mainStack(): AnyAgentMiddleware[] {
  // The environment is stubbed: this reads the stack's *shape* — which hooks
  // become graph nodes — and never runs a model or a memory search.
  return agentStack("main", {
    model: { model: "stub" },
    instructions: "instructions",
    memory: { search: () => Promise.resolve([]) },
  } as unknown as Parameters<typeof agentStack>[1]);
}

describe("the lap budget is what the ceiling is made of", () => {
  test("the ceiling is derived from the budget, not chosen", () => {
    // 6 once-per-turn nodes on top; the shape, not a magic total.
    expect(RECURSION_LIMIT).toBe(6 + LAP_BUDGET * NODES_PER_LAP);
  });

  test("a lap costs the model node, every afterModel node, and the tools node", () => {
    const stack = mainStack();
    // `agentStack` carries no afterModel of its own — the guards that do are
    // added in `loop.ts` for the main agent alone. Counting them here would
    // need the private assembly, so the shared half is what this pins: it must
    // stay at zero, because a new afterModel here would cost every turn a lap
    // on *every* kind, subagents included.
    expect(countHook(stack, "afterModel")).toBe(0);
    expect(countHook(stack, "beforeModel")).toBe(0);
  });

  test("the shared stack's once-per-turn nodes stay within the allowance", () => {
    const stack = mainStack();
    const onceOff = countHook(stack, "beforeAgent") + countHook(stack, "afterAgent");
    // Four today: ProjectInstructions, Memory, PinTurnTask, StaleReads. The
    // allowance is 6, leaving room for the main-agent-only additions.
    expect(onceOff).toBeLessThanOrEqual(6);
  });

  test("the budget is a number a person chose, and it is bigger than the longest turn we have seen", () => {
    // 8 laps was the longest turn across this repository's own sessions, and it
    // sat exactly on the old ceiling. The budget is deliberately above it.
    expect(LAP_BUDGET).toBeGreaterThan(8);
  });

  test("the ceiling buys at least the budget, whatever the stack costs per lap", () => {
    // The property that actually matters: a turn gets its laps. Written as an
    // inequality rather than an equality so a cheaper stack is not a failure.
    const onceOff = 6;
    expect(RECURSION_LIMIT - onceOff).toBeGreaterThanOrEqual(
      LAP_BUDGET * NODES_PER_LAP,
    );
  });
});
