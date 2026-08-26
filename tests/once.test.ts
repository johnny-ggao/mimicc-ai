import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import { describe, expect, test } from "bun:test";

import { parseArgs } from "../src/console/args";
import { NO_HUMAN, runOnce } from "../src/console/once";
import type { AgentGraph } from "../src/agents";

/**
 * A graph that parks a fixed number of times and records what it was answered.
 *
 * Hand-rolled rather than a mock library, for the same reason the other tests
 * here are: what is being pinned is the *shape* of the answer — a rejection
 * carrying a reason, one per request — and a matcher would hide exactly that.
 */
function stubGraph(options: { parks?: unknown[]; reply?: string; throws?: Error }): {
  graph: AgentGraph;
  answered: unknown[];
} {
  const answered: unknown[] = [];
  const parks = [...(options.parks ?? [])];
  const messages: BaseMessage[] = [];

  const graph: AgentGraph = {
    stream: (input, _config) => {
      if (options.throws !== undefined) throw options.throws;
      if (input instanceof Command) answered.push(input.resume);
      else if (input !== null) messages.push(...input.messages);

      const parked = parks.shift();
      if (parked === undefined && options.reply !== undefined) {
        messages.push(new AIMessage(options.reply));
      }

      const events: [string, unknown][] =
        parked === undefined
          ? [["values", { messages }]]
          : [["values", { __interrupt__: [{ value: parked }] }]];

      return Promise.resolve(
        (async function* () {
          // `await` so this is a genuine async generator rather than a sync one
          // wearing the type; the graph's real stream is asynchronous.
          await Promise.resolve();
          for (const event of events) yield event;
        })(),
      );
    },
    getState: () => Promise.resolve({ values: { messages } }),
  };

  return { graph, answered };
}

describe("--print parsing", () => {
  test("takes the task as the next argument", () => {
    expect(parseArgs(["--print", "fix the build"])).toEqual({
      kind: "print",
      task: "fix the build",
      auto: false,
    });
  });

  test("accepts the short form and the inline form", () => {
    expect(parseArgs(["-p", "hi"])).toEqual({ kind: "print", task: "hi", auto: false });
    expect(parseArgs(["--print=hi there"])).toEqual({
      kind: "print",
      task: "hi there",
      auto: false,
    });
  });

  test("does not imply --auto, and carries it when given", () => {
    expect(parseArgs(["--print", "x"])).toMatchObject({ auto: false });
    expect(parseArgs(["--auto", "--print", "x"])).toMatchObject({
      kind: "print",
      auto: true,
    });
  });

  test("a bare --print is an error, not a repl", () => {
    expect(parseArgs(["--print"])).toMatchObject({ kind: "error" });
  });

  test("--print and --resume are mutually exclusive", () => {
    expect(parseArgs(["--print", "x", "--resume", "abc"])).toMatchObject({
      kind: "error",
    });
  });

  test("a task that looks like a flag is still a task", () => {
    expect(parseArgs(["--print", "--auto is a flag"])).toEqual({
      kind: "print",
      task: "--auto is a flag",
      auto: false,
    });
  });
});

describe("runOnce", () => {
  test("returns the model's last reply", async () => {
    const { graph } = stubGraph({ reply: "done" });
    const result = await runOnce({ graph, task: "do it" });
    expect(result).toMatchObject({ text: "done", ok: true, refused: 0 });
  });

  test("refuses every gate request, one rejection each, with a reason", async () => {
    const { graph, answered } = stubGraph({
      parks: [{ actionRequests: [{ name: "Bash" }, { name: "Write" }] }],
      reply: "could not do it",
    });

    const result = await runOnce({ graph, task: "write a file" });

    expect(result.refused).toBe(2);
    expect(answered).toEqual([
      {
        decisions: [
          { type: "reject", message: NO_HUMAN },
          { type: "reject", message: NO_HUMAN },
        ],
      },
    ]);
  });

  test("never approves — no decision may be an approval", async () => {
    const { graph, answered } = stubGraph({
      parks: [{ actionRequests: [{ name: "Bash" }] }],
      reply: "x",
    });
    await runOnce({ graph, task: "t" });

    const decisions = (answered[0] as { decisions: { type: string }[] }).decisions;
    expect(decisions.every((one) => one.type === "reject")).toBe(true);
  });

  test("answers Clarify instead of rejecting it — it is a question, not an action", async () => {
    const { graph, answered } = stubGraph({
      parks: [{ kind: "clarify", questions: [{ header: "Scope" }] }],
      reply: "assumed the narrow one",
    });

    const result = await runOnce({ graph, task: "t" });

    expect(result.refused).toBe(0);
    const answers = answered[0] as { header: string; typed: boolean }[];
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ header: "Scope", typed: true });
  });

  test("keeps answering while the graph keeps parking", async () => {
    const { graph, answered } = stubGraph({
      parks: [
        { actionRequests: [{ name: "Bash" }] },
        { actionRequests: [{ name: "Bash" }] },
      ],
      reply: "finally",
    });

    const result = await runOnce({ graph, task: "t" });

    expect(answered).toHaveLength(2);
    expect(result).toMatchObject({ text: "finally", refused: 2, ok: true });
  });

  test("a thrown turn is not ok, and says so rather than throwing", async () => {
    const { graph } = stubGraph({ throws: new Error("provider exploded") });
    const result = await runOnce({ graph, task: "t" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("provider exploded");
  });

  test("runs on one thread, and a caller may pin it", async () => {
    let seen: string | undefined;
    const graph: AgentGraph = {
      stream: (_input, config) => {
        seen = config.configurable.thread_id;
        return Promise.resolve(
          (async function* () {
            await Promise.resolve();
            yield ["values", { messages: [new HumanMessage("t")] }] as [
              string,
              unknown,
            ];
          })(),
        );
      },
      getState: () => Promise.resolve({ values: { messages: [] } }),
    };

    await runOnce({ graph, task: "t", session: "pinned-id" });
    expect(seen).toBe("pinned-id");
  });
});
