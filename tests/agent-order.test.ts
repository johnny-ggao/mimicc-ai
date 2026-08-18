import { expect, test } from "bun:test";
import { createMiddleware, type AnyAgentMiddleware } from "langchain";

import { assertLoopGuardBeforeGate } from "@/agents";

/**
 * The main agent has one load-bearing middleware order: the loop guard must
 * run before the confirmation gate, because both hook `afterModel` and the
 * guard hashes the tool-call set — it must see the raw model output, not
 * whatever the gate did to it (ticket 02).
 *
 * The assertion throws on the wrong order *and* on a missing half, because
 * both are installed unconditionally for the main agent: a missing loop guard
 * is as silent a break as a reorder. This is the tripwire, fired with a
 * deliberately wrong stack, exactly as kinds.test.ts fires
 * assertMeterInsideWindow.
 */

const named = (name: string): AnyAgentMiddleware => createMiddleware({ name });

test("a gate installed before the loop guard is refused at assembly", () => {
  const wrong = [named("HumanInTheLoopMiddleware"), named("LoopGuard")];

  expect(() => assertLoopGuardBeforeGate(wrong)).toThrow(
    /must be installed before the confirmation gate/,
  );

  // And the right way round is silent — otherwise the throw above proves
  // nothing except that this function throws.
  expect(() => assertLoopGuardBeforeGate([...wrong].reverse())).not.toThrow();
});

test("a stack missing either half is refused too", () => {
  expect(() => assertLoopGuardBeforeGate([named("LoopGuard")])).toThrow();
  expect(() =>
    assertLoopGuardBeforeGate([named("HumanInTheLoopMiddleware")]),
  ).toThrow();
  expect(() => assertLoopGuardBeforeGate([])).toThrow();
});
