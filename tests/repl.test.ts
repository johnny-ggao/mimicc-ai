import { describe, expect, test } from "bun:test";

import { fromSubagent, summarizeCall } from "@/console";

/**
 * The console is a debugging shell and mostly out of scope for tests — but this
 * one predicate decides whether a subagent's tokens reach the terminal, and it
 * is built on a string shape that belongs to langgraph. If that shape changes,
 * the symptom is either an unreadable console or a silent one, and neither
 * announces itself. Every value below was measured by
 * `repro/12-subagent-stream.ts` rather than imagined.
 */
describe("telling a subagent's chunks from the agent's", () => {
  test("the agent's own model chunks are not nested", () => {
    expect(
      fromSubagent({
        langgraph_node: "model_request",
        checkpoint_ns: "model_request:12f86faa-0e95-5821-98c7-1b93bd996ce7",
      }),
    ).toBe(false);
  });

  test("a subagent's model chunks are", () => {
    expect(
      fromSubagent({
        langgraph_node: "model_request",
        checkpoint_ns:
          "tools:2ab0e2f8-7c60-5861-9333-dbdb3e35aaa9|model_request:2ab35805-0573-5074-9be7-6b016ae5c591",
      }),
    ).toBe(true);
  });

  // The parent's own tools node runs at `tools:<id>` — one segment, no pipe. It
  // is the shallowest thing that could be mistaken for a subagent, so it is the
  // case worth pinning.
  test("the agent's tool node is not a subagent", () => {
    expect(
      fromSubagent({
        langgraph_node: "tools",
        checkpoint_ns: "tools:2ab0e2f8-7c60-5861-9333-dbdb3e35aaa9",
      }),
    ).toBe(false);
  });

  test("missing metadata is treated as the agent's own", () => {
    expect(fromSubagent(undefined)).toBe(false);
    expect(fromSubagent({})).toBe(false);
    expect(fromSubagent({ checkpoint_ns: 42 })).toBe(false);
  });
});

/**
 * Three concurrent dispatches used to print three identical lines: the arguments
 * are serialised JSON, and `{"description":"Read /Users/johnny/…` is the same for
 * the first sixty characters whatever the objective is. Being able to tell them
 * apart is the reason the console shows them at all.
 */
describe("naming a tool call in one line", () => {
  test("a dispatch leads with the kind, then the objective", () => {
    const line = summarizeCall("Task", {
      description: "Read src/window.ts and report the summary trigger",
      subagent_type: "explore",
    });

    expect(line).toStartWith("Task[explore] Read src/window.ts");
  });

  test("two dispatches into the same directory still differ", () => {
    const prefix = "Read /Users/johnny/Work/Project/mimicc-ai/src/";
    const first = summarizeCall("Task", {
      description: `${prefix}window.ts and report the trigger`,
      subagent_type: "explore",
    });
    const second = summarizeCall("Task", {
      description: `${prefix}subagents.ts and count the kinds`,
      subagent_type: "explore",
    });

    expect(first).not.toBe(second);
  });

  test("every other tool keeps the plain serialised form", () => {
    expect(summarizeCall("Read", { path: "src/main.ts" })).toBe(
      'Read {"path":"src/main.ts"}',
    );
  });

  test("a long argument is clipped rather than wrapped", () => {
    const line = summarizeCall("Bash", { command: "x".repeat(400) });

    expect(line.length).toBeLessThan(90);
    expect(line).toEndWith("...");
  });
});
