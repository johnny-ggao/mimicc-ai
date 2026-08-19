import { describe, expect, test } from "bun:test";

import {
  AIMessageChunk,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";

import {
  describeError,
  fromModel,
  fromSubagent,
  readDecision,
  summarizeCall,
} from "@/console";
import type { Pending } from "@/console";

/**
 * The console is a debugging shell and mostly out of scope for tests — but this
 * one predicate decides whether a subagent's tokens reach the terminal, and it
 * is built on a string shape that belongs to langgraph. If that shape changes,
 * the symptom is either an unreadable console or a silent one, and neither
 * announces itself. Every value below was measured by
 * `repro/12-subagent-stream.ts` rather than imagined.
 */
/**
 * The other half of the same question. `fromSubagent` asks *whose* chunk it is;
 * this asks whether a chunk is speech at all — and getting it wrong is not a
 * cosmetic problem, it prints the injected context at the user.
 *
 * The `"messages"` stream carries node output alongside model tokens, and the
 * dedup that hides that only covers messages already in the node's input. So a
 * `beforeAgent` injection is emitted on the first turn of a session and rendered
 * as the model's reply — which is exactly what shipped, for both injectors, in
 * the order they run (`repro/22-injected-messages-hit-the-message-stream.ts`).
 */
describe("telling the model's speech from what a node wrote into state", () => {
  test("the model's own chunks are prose", () => {
    expect(fromModel(new AIMessageChunk({ content: "答案" }))).toBe(true);
  });

  // The injected catalogue and the project instructions are both HumanMessages
  // returned from a beforeAgent hook. This is the bug, pinned by its own shape.
  test("an injected human message is not", () => {
    expect(
      fromModel(new HumanMessage({ id: "skill-catalog", content: "<skill-catalog>" })),
    ).toBe(false);
  });

  test("a tool result is not — it is drawn from state instead", () => {
    expect(fromModel(new ToolMessage({ content: "ok", tool_call_id: "call_1" }))).toBe(
      false,
    );
  });

  test("a system message is not", () => {
    expect(fromModel(new SystemMessage("you are"))).toBe(false);
  });
});

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

describe("turning a thrown error into one line", () => {
  test("abort, recursion and llm status keep their exact wording", () => {
    expect(describeError({ name: "AbortError" })).toBe("^C interrupted");
    expect(describeError({ name: "GraphRecursionError" })).toBe(
      "stopped after 48 steps without a final answer",
    );
    expect(describeError({ status: 429, message: "rate" })).toBe(
      "llm 429: rate (rate limited, or out of balance)",
    );
    expect(describeError({ status: 401, message: "bad key" })).toBe(
      "llm 401: bad key (check the provider's API key)",
    );
    expect(describeError({ status: 402, message: "empty" })).toBe(
      "llm 402: empty (insufficient balance)",
    );
  });

  test("anything else falls back to the error message", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
  });
});

/**
 * An empty line at the confirmation gate.
 *
 * This is the console's one safety property, and it was wrong in shipped code:
 * `""` shared a branch with `"a"`, so an Enter pressed out of impatience — which
 * readline buffers during a turn and replays when the gate opens — approved a
 * `Bash` command the user had never seen (`repro/15-typing-during-a-turn.ts`,
 * measured on a TTY as well as a pipe).
 *
 * Pinned in both directions, because the fix has an obvious wrong version:
 * deleting `|| input === ""` turns the same keystroke into a rejection carrying
 * an empty reason, which is a *different* decision rather than none at all.
 */
describe("an empty line is not a decision", () => {
  const gate = (): Pending => ({
    requests: [{ name: "Bash", args: { command: "rm -rf /" } }],
    decisions: [],
    editing: false,
  });

  /** The gate re-prints itself when it declines a line; that is not the assertion. */
  const quietly = <T>(body: () => T): T => {
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = () => true;
    try {
      return body();
    } finally {
      process.stdout.write = original;
    }
  };

  test("it neither approves nor rejects — the batch is untouched", () => {
    const pending = gate();
    const resumed = quietly(() => readDecision("", pending));

    expect(resumed).toBeNull();
    expect(pending.decisions).toEqual([]);
  });

  test("an explicit `a` still approves", () => {
    const pending = gate();
    const resumed = quietly(() => readDecision("a", pending));

    expect(resumed).not.toBeNull();
    expect(pending.decisions).toEqual([{ type: "approve" }]);
  });

  test("anything else is still a rejection carrying the reason", () => {
    const pending = gate();
    quietly(() => readDecision("not on production", pending));

    expect(pending.decisions).toEqual([
      { type: "reject", message: "not on production" },
    ]);
  });

  // The same shape one state along: an empty replacement would have run an empty
  // command, so `edit` has to decline it too rather than commit it.
  test("an empty replacement command is declined, and editing stays open", () => {
    const pending = gate();
    quietly(() => readDecision("e", pending));
    expect(pending.editing).toBe(true);

    const resumed = quietly(() => readDecision("", pending));
    expect(resumed).toBeNull();
    expect(pending.editing).toBe(true);
    expect(pending.decisions).toEqual([]);
  });
});
