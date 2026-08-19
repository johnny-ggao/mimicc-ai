import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

import { createUniversalAgent, EXPLORE_TOOLS, subagentSpecs } from "@/agents";
import { JsonlSaver } from "@/checkpoint";
import { createTaskTool, TASK_TOOL_NAME, type SubagentSpec } from "@/tools";
import type { WindowEvent } from "@/context";
import type { ModelUsage } from "@/usage";

/**
 * The explore agent runs against the same stubbed endpoint as its parent, because they
 * share a model instance — that is the decision under test as much as anything
 * else. Requests are told apart by their system message: the explore agent's prompt is
 * not the agent's.
 */
let server: ReturnType<typeof Bun.serve>;
let requests: { messages: { role: string; content?: string }[] }[] = [];
let exploreReply: "answer" | "empty" = "answer";
let inFlight = 0;
let peakInFlight = 0;
/** How many tool laps the explore agent takes before it answers. */
let exploreLaps = 0;
/** What the stub reports as prompt_tokens — the anchor the window counts from. */
let promptTokens = 1;

const completion = (id: string, message: Record<string, unknown>, finish: string) => ({
  id,
  object: "chat.completion",
  created: 0,
  model: "stub",
  choices: [{ index: 0, message, finish_reason: finish }],
  usage: {
    prompt_tokens: promptTokens,
    completion_tokens: 1,
    total_tokens: promptTokens + 1,
  },
});

function isExplore(body: (typeof requests)[number]): boolean {
  const system = body.messages.find((message) => message.role === "system");
  return (system?.content ?? "").includes("Explore agent");
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as (typeof requests)[number];
      requests.push(body);

      const system = body.messages.find((message) => message.role === "system");
      const prompt = system?.content ?? "";

      // A summarising call carries the transcript and no system message at all —
      // it is `model.invoke` on the bare instance, not an agent turn.
      if (
        body.messages.some(
          (message) =>
            typeof message.content === "string" &&
            message.content.includes("<conversation>"),
        )
      ) {
        return Response.json(
          completion(
            `sum-${String(requests.length)}`,
            { role: "assistant", content: "condensed earlier work" },
            "stop",
          ),
        );
      }

      // Two kinds registered only by the guard tests, told apart the same way as
      // the explore agent: by their own system prompt.
      if (prompt.includes("looper")) {
        // Never stops asking for a tool, so the subagent runs out of steps.
        return Response.json(
          completion(
            `loop-${String(requests.length)}`,
            {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: `call_${String(requests.length)}`,
                  type: "function",
                  function: { name: "Ping", arguments: "{}" },
                },
              ],
            },
            "tool_calls",
          ),
        );
      }

      if (prompt.includes("waiter")) {
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        // Long enough that five dispatches genuinely overlap; the gate is what
        // has to keep them from overlapping more than three at a time.
        await Bun.sleep(20);
        inFlight -= 1;
        return Response.json(
          completion(
            `wait-${String(requests.length)}`,
            { role: "assistant", content: "waited" },
            "stop",
          ),
        );
      }

      if (isExplore(body)) {
        // A failing explore agent is stubbed as 200 with no choices, never as an error
        // status. Any failure status code is retried six times by AsyncCaller —
        // a test written that way measures the retry policy, not the failure.
        if (exploreReply === "empty") {
          return Response.json({ id: "x", object: "chat.completion", choices: [] });
        }
        if (exploreLaps > 0) {
          exploreLaps -= 1;
          return Response.json(
            completion(
              `explore-${String(requests.length)}`,
              {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: `read_${String(requests.length)}`,
                    type: "function",
                    function: { name: "Read", arguments: '{"path":"package.json"}' },
                  },
                ],
              },
              "tool_calls",
            ),
          );
        }
        return Response.json(
          completion(
            `explore-${String(requests.length)}`,
            { role: "assistant", content: "src/config.ts:17 sets the default model" },
            "stop",
          ),
        );
      }

      // The parent dispatches an explore agent on its first lap and answers on its second.
      const dispatched = requests.some((seen) => isExplore(seen));
      return Response.json(
        dispatched
          ? completion(
              `parent-${String(requests.length)}`,
              { role: "assistant", content: "the default model is set in config" },
              "stop",
            )
          : completion(
              `parent-${String(requests.length)}`,
              {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: {
                      name: TASK_TOOL_NAME,
                      arguments:
                        '{"description":"find where the default model is set","subagent_type":"explore"}',
                    },
                  },
                ],
              },
              "tool_calls",
            ),
      );
    },
  });
});

afterAll(() => void server.stop(true));

function build(projectInstructions?: string) {
  requests = [];
  exploreReply = "answer";
  exploreLaps = 0;
  promptTokens = 1;
  return createUniversalAgent({
    baseURL: `http://localhost:${String(server.port)}/v1`,
    apiKey: "stub",
    model: "stub",
    systemPrompt: "you are the parent agent",
    ...(projectInstructions !== undefined ? { projectInstructions } : {}),
  });
}

/**
 * Awaits a rejection and hands back the message. Same reason as the copies in
 * checkpoint.test.ts and window.test.ts: the lint rule reads
 * `expect(...).rejects` as non-thenable, the `await` gets dropped, and the
 * unfinished turn runs into the next test and eats its stub calls.
 */
async function failureFrom(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return String(error);
  }
  throw new Error("expected this to fail, but it succeeded");
}

/** MessageContent is a string or an array of blocks; narrow before comparing. */
function text(message: BaseMessage | undefined): string {
  const content = message?.content;
  return typeof content === "string" ? content : JSON.stringify(content);
}

async function runTurn(
  graph: ReturnType<typeof build>,
  thread: string,
): Promise<BaseMessage[]> {
  const result = (await graph.invoke(
    { messages: [new HumanMessage("where is the default model set?")] },
    { configurable: { thread_id: thread } },
  )) as { messages: BaseMessage[] };
  return result.messages;
}

const stubModel = (): ChatOpenAI => new ChatOpenAI({ model: "stub", apiKey: "stub" });

describe("the tool defines no subagents of its own", () => {
  /**
   * The claim this whole file is arranged around: `Task` is a mechanism, and the
   * kinds are data. A made-up spec proves it in a way asserting on the shipped
   * registry never could — that one would pass just as well if `explore agent` were
   * hard-coded inside the tool.
   */
  test("dispatches a kind it has never heard of", () => {
    const invented: SubagentSpec = {
      name: "surveyor",
      description: "invented for this test",
      prompt: "you are a surveyor",
      tools: [],
    };

    const built = createTaskTool({ model: stubModel(), subagents: [invented] });

    expect(built.description).toContain("- surveyor: invented for this test");
    expect(built.description).not.toContain("explore");
  });

  // Registering a kind and telling the model about it have to be one act. A kind
  // the description forgets is a kind the model never dispatches, and nothing
  // else in the program would notice.
  test("the description lists every registered kind", () => {
    const specs = subagentSpecs({ model: stubModel() });
    const built = createTaskTool({ model: stubModel(), subagents: specs });

    for (const spec of specs) {
      expect(built.description).toContain(`- ${spec.name}: `);
    }
  });

  // Advertising a capability that can only fail is worse than not having it.
  test("refuses to build with nothing to dispatch", () => {
    expect(() => createTaskTool({ model: stubModel(), subagents: [] })).toThrow();
  });

  // The seam that keeps the dependency graph acyclic: the task tool is built by
  // a factory the agent assembles, never by importing the agent back. The second
  // assertion is the one that keeps the mechanism generic — the tool must not
  // reach for the registry either.
  test("task.ts imports neither the agent nor the registry", async () => {
    const source = await Bun.file("src/tools/task.ts").text();

    expect(source).not.toContain('from "../agent"');
    expect(source).not.toContain('from "../kinds"');
  });
});

describe("the guards", () => {
  const liveModel = (): ChatOpenAI =>
    new ChatOpenAI({
      model: "stub",
      apiKey: "stub",
      configuration: { baseURL: `http://localhost:${String(server.port)}/v1` },
    });

  /**
   * The fork bomb has no downstream stop: `recursionLimit` bounds one graph, and
   * every generation of subagent is a fresh graph with a fresh budget. So the
   * refusal has to happen where the registry is read, and it has to happen at
   * construction — a run-time symptom would arrive as a bill.
   */
  test("refuses a kind that carries Task itself", () => {
    const nesting: SubagentSpec = {
      name: "recursor",
      description: "carries the dispatch tool",
      prompt: "you are a recursor",
      tools: [
        createTaskTool({
          model: stubModel(),
          subagents: subagentSpecs({ model: stubModel() }),
        }),
      ],
    };

    expect(() => createTaskTool({ model: stubModel(), subagents: [nesting] })).toThrow(
      /may not dispatch subagents/,
    );
  });

  // ToolNode already turns a throw into a tool message; what this adds is a
  // message the model can act on. Running out of steps is the one failure with
  // an obvious next move, so it gets named.
  test("running out of steps says so, in words the parent can use", async () => {
    const looper: SubagentSpec = {
      name: "looper",
      description: "never stops",
      prompt: "you are a looper",
      tools: [
        tool(() => Promise.resolve("pong"), {
          name: "Ping",
          description: "answers pong",
          schema: z.object({}),
        }),
      ],
    };

    const failure = await failureFrom(
      createTaskTool({
        model: liveModel(),
        subagents: [looper],
        recursionLimit: 4,
      }).invoke({ description: "go forever", subagent_type: "looper" }),
    );

    expect(failure).toContain("used all 4 steps");
    expect(failure).toContain("Narrow the objective");
    // The framework's own wording, and its documentation URL, stay out of it.
    expect(failure).not.toContain("GraphRecursionError");
  });

  /**
   * `ToolNode` runs a lap's tool calls concurrently with no throttle, so five
   * dispatches in one turn means five agents unless something says otherwise.
   * The assertion is on what the server saw, not on what the gate believes.
   */
  test("runs at most three subagents at once, and still finishes all five", async () => {
    inFlight = 0;
    peakInFlight = 0;

    const waiter: SubagentSpec = {
      name: "waiter",
      description: "sleeps briefly",
      prompt: "you are a waiter",
      tools: [],
    };

    const dispatch = createTaskTool({ model: liveModel(), subagents: [waiter] });
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        dispatch.invoke({
          description: `wait ${String(index)}`,
          subagent_type: "waiter",
        }),
      ),
    );

    expect(results).toHaveLength(5);
    expect(peakInFlight).toBeLessThanOrEqual(3);
    // Guards against the opposite failure: a gate that serialises everything
    // would also satisfy the line above, and would throw away the whole point.
    expect(peakInFlight).toBeGreaterThan(1);
  });
});

describe("the explore agent's boundaries", () => {
  // The safety story lives in the registry, not in the tool: an explore agent cannot
  // change anything, and cannot dispatch explore agents of its own, because of what this
  // list contains.
  test("carries exactly the three read-only tools", () => {
    expect(EXPLORE_TOOLS.map((tool) => tool.name)).toEqual(["Read", "Glob", "Grep"]);
  });

  test("no registered kind can change anything", () => {
    for (const spec of subagentSpecs({ model: stubModel() })) {
      const names = spec.tools.map((tool) => ("name" in tool ? tool.name : ""));
      for (const forbidden of ["Write", "Edit", "Bash", TASK_TOOL_NAME]) {
        expect(names).not.toContain(forbidden);
      }
    }
  });
});

describe("cancellation", () => {
  // Measured, not assumed: ToolNode hands the tool a merged abort signal
  // (nodes/ToolNode.js:241) and core's mergeConfigs combines signals with
  // AbortSignal.any (runnables/config.js:37-40). So forwarding the runtime into
  // the explore agent's invoke is the whole of Ctrl+C support — there is no second
  // cancellation path to build, and this test is what says so.
  test("an aborted parent aborts the explore agent", async () => {
    requests = [];
    const model = new ChatOpenAI({
      model: "stub",
      apiKey: "stub",
      configuration: { baseURL: `http://localhost:${String(server.port)}/v1` },
    });

    const failure = await failureFrom(
      createTaskTool({
        model,
        subagents: subagentSpecs({ model: stubModel() }),
      }).invoke(
        { description: "find something", subagent_type: "explore" },
        { signal: AbortSignal.abort() },
      ),
    );

    expect(failure).toMatch(/abort/i);
    expect(requests.filter(isExplore)).toHaveLength(0);
  });
});

describe("what reaches the parent", () => {
  test("the explore agent's own messages never enter the parent's state", async () => {
    const messages = await runTurn(build(), "explore-isolation");

    // Human, AI with the tool call, one ToolMessage, final AI. The explore agent's own
    // exchange — its system prompt, its lap, its answer as an AIMessage — is not
    // in here, and that isolation is the entire point of the ticket.
    expect(messages.filter((message) => ToolMessage.isInstance(message))).toHaveLength(
      1,
    );
    expect(messages).toHaveLength(4);
  });

  test("the report comes back as the tool result", async () => {
    const messages = await runTurn(build(), "explore-report");
    const result = messages.find((message) => ToolMessage.isInstance(message));

    expect(text(result)).toContain("src/config.ts:17");
  });

  // Borrowed from deepagents, which answers an unknown type with the list of
  // allowed ones (dist/langsmith-CUTUAjHo.js:2488-2491). A typo should cost the
  // model one lap, not the turn.
  test("an unknown type comes back as the list of allowed ones", async () => {
    const failure = await failureFrom(
      createTaskTool({
        model: stubModel(),
        subagents: subagentSpecs({ model: stubModel() }),
      }).invoke({
        description: "anything",
        subagent_type: "researcher",
      }),
    );

    expect(failure).toContain("researcher");
    expect(failure).toContain("`explore`");
  });

  test("an explore agent that fails becomes a tool message, not a dead turn", async () => {
    const graph = build();
    exploreReply = "empty";

    const messages = await runTurn(graph, "explore-failure");
    const result = messages.find((message) => ToolMessage.isInstance(message));

    // ToolNode turns a throwing tool into a message the model can read, so the
    // turn still finishes with an answer rather than an exception reaching repl.
    expect(result).toBeDefined();
    expect(messages.at(-1)?.getType()).toBe("ai");
  });
});

describe("the bill", () => {
  /**
   * A subagent is a separate agent instance, so the parent's middleware — the
   * meter included — does not reach it. Measured before this was wired up: a turn
   * that dispatched an explore agent logged two records, both the parent's, while the
   * explore agent's requests were billed and invisible.
   *
   * The label matters as much as the record. One column of numbers from two
   * spenders cannot answer the only question worth asking of it.
   */
  test("an explore's requests are metered, under its own name", async () => {
    requests = [];
    exploreReply = "answer";
    const usage: ModelUsage[] = [];

    const graph = createUniversalAgent({
      baseURL: `http://localhost:${String(server.port)}/v1`,
      apiKey: "stub",
      model: "stub",
      systemPrompt: "you are the parent agent",
      onUsage: (record) => usage.push(record),
    });

    await graph.invoke(
      { messages: [new HumanMessage("where is the default model set?")] },
      { configurable: { thread_id: "usage-explore agent" } },
    );

    const byAgent = usage.map((record) => record.agent);
    expect(byAgent.filter((agent) => agent === "main")).toHaveLength(2);
    expect(byAgent.filter((agent) => agent === "explore")).toHaveLength(1);
    // Every request the stub answered shows up exactly once. A meter that
    // double-counts is worse than no meter, and nesting middleware is exactly
    // where that happens.
    expect(usage).toHaveLength(requests.length);
  });
});

describe("a subagent's own window", () => {
  /**
   * The explore agent is the one agent here that can fill a window in a single lap:
   * nothing stops a model asking for twenty Reads at once, and each is up to
   * MAX_FILE_BYTES. Without a window of its own the dispatch fails outright and
   * everything it found is thrown away — the parent gets an error where it
   * expected a report.
   *
   * The limit is overridden here for the same reason `window.test.ts` overrides
   * it: the alternative is generating eight hundred thousand tokens to watch one
   * `if`.
   */
  test("summarises rather than failing, and still reports", async () => {
    requests = [];
    exploreReply = "answer";
    exploreLaps = 3;
    promptTokens = 1_900;
    const usage: ModelUsage[] = [];

    const model = new ChatOpenAI({
      model: "stub",
      apiKey: "stub",
      configuration: { baseURL: `http://localhost:${String(server.port)}/v1` },
    });

    const events: WindowEvent[] = [];

    const report = await createTaskTool({
      model,
      subagents: subagentSpecs({
        model,
        onUsage: (record) => usage.push(record),
        onWindow: (event) => events.push(event),
        // trigger at 1,600, keep 100 — the same shape as the agent's own tests.
        window: { limit: 2_000, keepFraction: 0.05 },
      }),
    }).invoke({ description: "look at several files", subagent_type: "explore" });

    // The report now rides on a `ToolMessage` rather than being the bare string:
    // a dispatch carries what it spent, and a message is where that can live
    // (see `spentOn` in `tools/task.ts`).
    expect(report.content).toContain("src/config.ts:17");
    const spent = report.response_metadata["usage"] as { input: number };
    expect(spent.input).toBeGreaterThan(0);
    // Billed under its own name, not "summary": two agents summarising into one
    // column is the problem the label exists to prevent.
    expect(usage.some((record) => record.agent === "explore summary")).toBe(true);
    expect(usage.some((record) => record.agent === "explore")).toBe(true);

    // And the event says so too. A subagent silently compacting its own window
    // used to be invisible — this middleware was installed without a listener,
    // so the one agent here most likely to fill a window in a single lap was the
    // one nobody was told about. Isolation is of context, not of accounting: the
    // subagent's run never touches the parent's thread, while what it spent and
    // what it compacted both reach the operator's log, attributable because they
    // carry a name.
    expect(events.some((event) => event.type === "summarized")).toBe(true);
    expect(events.every((event) => event.agent === "explore")).toBe(true);
  });

  test("the explore agent's view shrinks while its dispatch still succeeds", async () => {
    requests = [];
    exploreReply = "answer";
    exploreLaps = 3;
    promptTokens = 1_900;

    const model = new ChatOpenAI({
      model: "stub",
      apiKey: "stub",
      configuration: { baseURL: `http://localhost:${String(server.port)}/v1` },
    });

    await createTaskTool({
      model,
      subagents: subagentSpecs({
        model,
        window: { limit: 2_000, keepFraction: 0.05 },
      }),
    }).invoke({ description: "look at several files", subagent_type: "explore" });

    const exploreCalls = requests.filter(isExplore);
    const first = exploreCalls[0]?.messages.length ?? 0;
    const last = exploreCalls.at(-1)?.messages.length ?? 0;

    // Four laps of Read results would grow every request. They do not: the last
    // request is no larger than a couple of messages past the first, because the
    // middle was replaced by a summary.
    expect(exploreCalls.length).toBeGreaterThan(2);
    expect(last).toBeLessThanOrEqual(first + 2);
  });
});

describe("what reaches the thread file", () => {
  /**
   * The unit of this test is the file, not the state, and that distinction is
   * why it exists at all: the parent's `state.messages` looked perfectly clean
   * while the explore agent's entire run was being written into the parent's thread file
   * under a nested namespace. Found by reading a real `.mimicc/*.jsonl` after a
   * live run — the stub tests above cannot see it, because they never persist.
   *
   * The cause was passing the tool runtime through to the subagent wholesale:
   * `configurable` carries langgraph's own keys, the checkpointer among them, so
   * the explore agent inherited the parent's saver and thread.
   */
  test("the explore agent's run is not written into the parent's thread", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mimicc-explore-"));
    requests = [];
    exploreReply = "answer";

    const graph = createUniversalAgent({
      baseURL: `http://localhost:${String(server.port)}/v1`,
      apiKey: "stub",
      model: "stub",
      systemPrompt: "you are the parent agent",
      checkpointer: new JsonlSaver(directory),
    });

    await graph.invoke(
      { messages: [new HumanMessage("where is the default model set?")] },
      { configurable: { thread_id: "explore-persistence" } },
    );

    const file = join(directory, "explore-persistence.jsonl");
    const lines = readFileSync(file, "utf8");

    // Not the task text: the parent wrote that itself, as the arguments of its
    // own tool call, and it belongs in the parent's history. What must not be
    // here is the subagent's own run — its messages carry `name: "explore"` from
    // `createAgent({ name })`, and its checkpoints would sit under a nested
    // `tools:<id>` namespace.
    expect(lines).not.toContain('"name":"explore"');
    expect(lines).not.toContain('"ns":"tools:');
    rmSync(directory, { recursive: true, force: true });
  });
});

describe("what reaches the explore agent", () => {
  test("the project instructions ride along", async () => {
    await runTurn(
      build("<project-instructions>run bun test</project-instructions>"),
      "explore-instructions",
    );

    const exploreRequest = requests.find(isExplore);
    const body = JSON.stringify(exploreRequest?.messages);
    expect(body).toContain("run bun test");
  });

  test("the parent's conversation does not", async () => {
    await runTurn(build(), "explore-no-history");

    const exploreRequest = requests.find(isExplore);
    const body = JSON.stringify(exploreRequest?.messages);
    // The user's own question stays with the parent; the explore agent only ever sees
    // the task it was handed. Leaking the history would make the isolation — and
    // therefore the whole line — pointless.
    expect(body).not.toContain("where is the default model set?");
    expect(body).toContain("find where the default model is set");
  });
});
