import { describe, expect, test } from "bun:test";

import { FakeListChatModel } from "@langchain/core/utils/testing";

import { agentStack, assertMeterInsideWindow, subagentSpecs } from "@/agents";
import { usageMeter } from "@/usage";
import { contextWindow } from "@/context";

/**
 * The assembler, tested directly — which is the point of it existing.
 *
 * Everything here used to be untestable without starting an agent and a stub
 * server, because the order and the labels were array literals inside two
 * `createAgent` calls. Both of the failures this file guards are silent at run
 * time: a scale installed on the wrong side of the window reports the history
 * instead of the request, and a copied kind spends under the name of the kind it
 * was copied from. Neither breaks a turn, so neither would ever fail a
 * behavioural test that was not looking for it.
 *
 * `tests/window.test.ts` still owns the *consequence* — that the number the
 * scale reports is the number of messages actually sent — and now covers both
 * kinds at once, since both are fitted from here.
 */

const model = new FakeListChatModel({ responses: ["ok"] });

/**
 * A fake environment always hands back the same fake model, whatever ceiling is
 * asked for — the point under test here is installation order, not ceilings.
 * ⚠️ The field is required rather than optional on purpose: the summarising call
 * bypasses every middleware, so "whoever assembles must say which model it gets"
 * is the property that keeps it from inheriting one by accident.
 */
const modelFor = () => model;

/** The middleware names langchain carries, in installation order. */
const namesOf = (identity: string, instructions?: string): string[] =>
  agentStack(identity, {
    model,
    modelFor,
    ...(instructions !== undefined ? { instructions } : {}),
  }).map((middleware) => middleware.name);

describe("the order every kind is assembled in", () => {
  test("the meter is installed inside the window", () => {
    const names = namesOf("main");

    // Stated as indexes rather than as a whole-array equality so the assertion
    // says what it is about. `wrapModelCall` nests and the first entry is the
    // outermost wrapper, so the window — which decides *which* messages are
    // sent — has to sit outside the meter that counts them.
    expect(names.indexOf("ContextWindow")).toBeLessThan(names.indexOf("UsageMeter"));
  });

  test("the same order holds for a subagent kind", () => {
    const explore = subagentSpecs({ model, modelFor })[0];
    const names = (explore?.middleware ?? []).map((middleware) => middleware.name);

    expect(names.indexOf("ContextWindow")).toBeLessThan(names.indexOf("UsageMeter"));
  });

  /**
   * The tripwire, fired.
   *
   * `agentStack` builds the order it then checks, so from outside it the
   * assertion can never fail — which is exactly why it is worth proving here
   * that it would. This is the edit somebody makes in a year, swapping two lines
   * of that array for a reason that looks good at the time. It is caught at
   * construction, not in CI: the whole argument for asserting rather than only
   * testing is that a test runs when someone runs it.
   */
  test("a stack with the meter outside the window is refused at assembly", () => {
    const wrong = [
      usageMeter("main", "stub", () => {}),
      contextWindow({ modelFor, outputBudget: 4096, agent: "main" }),
    ];

    expect(() => {
      assertMeterInsideWindow(wrong);
    }).toThrow(/must be installed inside the context window/);

    // And the right way round is silent — otherwise the guard above proves
    // nothing except that this function throws.
    expect(() => {
      assertMeterInsideWindow([...wrong].reverse());
    }).not.toThrow();
  });

  test("the project instructions ride along only when there are any", () => {
    // Order-independent — a beforeAgent hook — so this is about presence, not
    // position: a kind with no AGENTS.md must not carry an empty injector.
    expect(namesOf("main")).not.toContain("ProjectInstructions");
    expect(namesOf("main", "# be kind")).toContain("ProjectInstructions");
  });
});

describe("what a kind is called", () => {
  /**
   * The three names an Explore agent has are one string.
   *
   * `name` is what the model types as `subagent_type` and what the nested graph
   * runs under; the meter and the summary labels are what the log is joined on.
   * Before this they were three literals in three places, and the failure mode
   * was a second kind copied from the first, reporting its spending under a name
   * that never ran.
   */
  test("a subagent kind's registered name is the identity its stack is labelled with", () => {
    const explore = subagentSpecs({ model, modelFor })[0];

    expect(explore?.name).toBe("explore");
    // Proven through the usage records rather than by reading the middleware:
    // the label is only real if it reaches a record, and `tests/task.test.ts`
    // asserts exactly that pair of strings arriving from a live dispatch.
    expect(explore?.middleware?.map((middleware) => middleware.name)).toEqual([
      "ContextWindow",
      "UsageMeter",
      "PinTurnTask",
      "PermissionGate",
    ]);
  });
});
