import { describe, expect, test } from "bun:test";

import {
  AIMessageChunk,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";

import {
  describeDrops,
  describeError,
  fromModel,
  fromSubagent,
  InputQueue,
  parked,
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
    // The ceiling is now a format placeholder (1_000_000), so the message names
    // the condition rather than citing a number that carries no meaning.
    expect(describeError({ name: "GraphRecursionError" })).toBe(
      "stopped without a final answer — the graph ran away past its recursion ceiling",
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

  test("`1` approves", () => {
    const pending = gate();
    const resumed = quietly(() => readDecision("1", pending));

    expect(resumed).not.toBeNull();
    expect(pending.decisions).toEqual([{ type: "approve" }]);
  });

  test("`2` rejects", () => {
    const pending = gate();
    const resumed = quietly(() => readDecision("2", pending));

    expect(resumed).not.toBeNull();
    expect(pending.decisions).toEqual([{ type: "reject" }]);
  });

  test("anything else is still a rejection carrying the reason", () => {
    const pending = gate();
    quietly(() => readDecision("not on production", pending));

    expect(pending.decisions).toEqual([
      { type: "reject", message: "not on production" },
    ]);
  });
});

/**
 * The input queue. Every rule in here fails silently when it is wrong — the
 * symptom is a turn the user did not ask for, which on screen is indented and
 * streamed exactly like a turn they did — so each one is pinned by the scenario
 * that produced it (ticket 09; the numbers were measured on a real terminal
 * with `expect`, not imagined).
 */
describe("the input queue", () => {
  const alive = () => true;

  test("a line typed over a running turn waits, and knows it waited", () => {
    const queue = new InputQueue(true);
    queue.push("input", "排队的话", true);
    expect(queue.take("input")).toEqual({
      tag: "input",
      text: "排队的话",
      queued: true,
    });
  });

  // Five pasted lines produced five back-to-back turns and five model calls.
  test("a paste is capped at one, and says how many it refused", () => {
    const queue = new InputQueue(true);
    for (const text of ["行1", "行2", "行3", "行4", "行5"])
      queue.push("input", text, true);

    expect(queue.depth).toBe(1);
    expect(queue.take("input")?.text).toBe("行1");
    expect(describeDrops(queue.sweep(alive))).toEqual([
      "(dropped 4 lines — only one line can wait for the current turn)",
    ]);
  });

  test("one stray extra line is named rather than counted", () => {
    const queue = new InputQueue(true);
    queue.push("input", "第一句", true);
    queue.push("input", "手滑", true);
    expect(describeDrops(queue.sweep(alive))).toEqual([
      "(dropped, only one line can wait for the current turn: 手滑)",
    ]);
  });

  // The cap counts "input" alone. A batch of three tool calls is answered with
  // three lines; capping those would break the confirmation gate itself.
  test("decisions at a gate are not capped", () => {
    const queue = new InputQueue(true);
    for (const text of ["y", "y", "y"]) queue.push("gate", text, false);
    expect(queue.depth).toBe(3);
    expect(describeDrops(queue.sweep(alive))).toEqual([]);
  });

  // Ctrl+C used to stop the turn and let the queued line start the next one.
  test("an abort empties the queue and says so", () => {
    const queue = new InputQueue(true);
    queue.push("input", "排队的话", true);
    queue.clear();

    expect(queue.take("input")).toBeUndefined();
    expect(describeDrops(queue.sweep(alive))).toEqual(["(dropped, ^C: 排队的话)"]);
  });

  test("a decision whose gate is gone can never be consumed, so it is dropped out loud", () => {
    const queue = new InputQueue(true);
    queue.push("gate", "y", false);
    const drops = queue.sweep((tag) => tag !== "gate");
    expect(describeDrops(drops)).toEqual([
      "(dropped, the question it answered is gone: y)",
    ]);
    expect(queue.depth).toBe(0);
  });

  /**
   * A piped script was written before the process started: its order is
   * deliberate, and there is no stray keystroke to protect. Both rules are off
   * there — the cap especially, since every probe in the repository sends its
   * whole script up front and would otherwise lose all but the first line.
   */
  test("a pipe keeps every line, in order, whatever it was tagged", () => {
    const queue = new InputQueue(false);
    queue.push("input", "你好", false);
    queue.push("input", "/exit", false);
    queue.push("gate", "y", false);

    expect(queue.depth).toBe(3);
    expect(queue.take("input")?.text).toBe("你好");
    expect(queue.take("input")?.text).toBe("/exit");
    expect(queue.take("input")?.text).toBe("y");
    expect(describeDrops(queue.sweep(() => false))).toEqual([]);
  });
});

/**
 * What a resumed session is parked on. Both halves were measured on a real
 * crash (`repro/23-crash-mid-approved-tools.ts`): a gate parks with an
 * interrupt, a batch of approved-and-started tool calls parks with `next` and
 * **no interrupt at all**. Reading only the first half is how that batch used to
 * be dropped in silence, so both shapes are pinned here.
 */
describe("what a resumed session is parked on", () => {
  const gateStop = {
    interrupts: [
      { value: { actionRequests: [{ name: "Bash", args: { command: "ls" } }] } },
    ],
  };

  test("a session stopped at a gate reports the question", () => {
    const { requests, unfinished } = parked({ tasks: [gateStop], next: ["tools"] });
    expect(requests).toHaveLength(1);
    // A gate wins: resuming past an unanswered question would answer it for the user.
    expect(unfinished).toBe(0);
  });

  test("a session stopped mid-batch reports work, not a question", () => {
    const { requests, unfinished } = parked({ tasks: [{}], next: ["tools"] });
    expect(requests).toEqual([]);
    expect(unfinished).toBe(1);
  });

  test("a batch of two parks as two", () => {
    expect(parked({ tasks: [{}, {}], next: ["tools", "tools"] }).unfinished).toBe(2);
  });

  test("a session that finished cleanly is parked on nothing", () => {
    expect(parked({ tasks: [], next: [] })).toEqual({
      requests: [],
      questions: [],
      unfinished: 0,
    });
    expect(parked({})).toEqual({ requests: [], questions: [], unfinished: 0 });
  });

  /**
   * The third parked state, and the one that fails **open** if it is missed: an
   * unanswered `Clarify` question carries no `actionRequests`, so a reader that
   * only knows about gates sees "no gate" and falls through to `unfinished` —
   * which the console resumes automatically, answering the model's question with
   * nothing and orphaning its tool call (`repro/19`: a 400 from the provider).
   */
  test("a session parked on a question is not mistaken for unfinished work", () => {
    const asked = parked({
      tasks: [
        {
          interrupts: [
            {
              value: {
                kind: "clarify",
                questions: [{ header: "h", question: "q?", options: [] }],
              },
            },
          ],
        },
      ],
      next: ["tools"],
    });

    expect(asked.questions.map((one) => one.header)).toEqual(["h"]);
    expect(asked.requests).toEqual([]);
    // Not 1 — there is a human to ask, so nothing gets picked up automatically.
    expect(asked.unfinished).toBe(0);
  });
});
