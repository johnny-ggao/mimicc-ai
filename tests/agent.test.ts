import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";

import {
  createAgentGraph,
  createUniversalAgent,
  RECURSION_LIMIT,
  type AgentOptions,
} from "@/agent";

// A stubbed model endpoint, so the loop can be exercised without a network or a
// key. The point is the graph's wiring — the back edge, the routing, the tool
// results landing in state — none of which needs a real model.
let server: ReturnType<typeof Bun.serve>;
let requests: { messages: Record<string, unknown>[] }[] = [];

/**
 * Note the unique id. `MessagesValue` matches messages by id and updates them in
 * place, so a stub that reuses one id makes the second reply silently overwrite
 * the first — the tool_calls turn vanishes from state and the lap looks like it
 * never happened. Real completions carry distinct ids; a caching proxy might not.
 */
const completion = (id: string, message: Record<string, unknown>, finish: string) => ({
  id,
  object: "chat.completion",
  created: 0,
  model: "stub",
  choices: [{ index: 0, message, finish_reason: finish }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push((await request.json()) as (typeof requests)[number]);

      // First call asks for a tool; second one answers. That is one full lap of
      // the loop, which is exactly what needs proving.
      return Response.json(
        requests.length === 1
          ? completion(
              `chatcmpl-${String(requests.length)}`,
              {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "Read", arguments: '{"path":"package.json"}' },
                  },
                ],
              },
              "tool_calls",
            )
          : completion(
              `chatcmpl-${String(requests.length)}`,
              { role: "assistant", content: "it is a package manifest" },
              "stop",
            ),
      );
    },
  });
});

afterAll(() => void server.stop(true));

/** MessageContent is a string or an array of blocks; narrow before comparing. */
function text(message: BaseMessage | undefined): string {
  const content = message?.content;
  return typeof content === "string" ? content : JSON.stringify(content);
}

const start: BaseMessage[] = [
  new SystemMessage("be terse"),
  new HumanMessage("what is package.json?"),
];

/**
 * Both loops, held to the same four assertions.
 *
 * This is the control the comparison needs: whatever langchain's middleware
 * layer turns out to buy, it is not a different loop, and a regression on either
 * side shows up as a diff between two passing columns rather than as an argument.
 */
const IMPLEMENTATIONS: [string, (options: AgentOptions) => { invoke: InvokeFn }][] = [
  ["StateGraph", createAgentGraph],
  ["createAgent", createUniversalAgent],
];

type InvokeFn = (input: {
  messages: BaseMessage[];
}) => Promise<{ messages: BaseMessage[] }>;

describe.each(IMPLEMENTATIONS)("%s", (_name, build) => {
  function graph() {
    requests = [];
    return build({
      baseURL: `http://localhost:${String(server.port)}`,
      apiKey: "test-key",
      model: "stub",
      maxTokens: 64,
    });
  }

  // The lap: model asks for a tool, the tool runs, its result goes back into
  // state, and the model is called again. On our side `.addEdge("tools",
  // "llmCall")` is the only thing making that second call happen.
  test("runs a full lap of the loop and comes back with an answer", async () => {
    const out = await graph().invoke({ messages: start });

    expect(out.messages.map((message) => message.getType())).toEqual([
      "system",
      "human",
      "ai",
      "tool",
      "ai",
    ]);
    expect(text(out.messages.at(-1))).toBe("it is a package manifest");
  });

  test("feeds the real tool output back into state", async () => {
    const out = await graph().invoke({ messages: start });

    const toolMessage = out.messages.find((message) => message.getType() === "tool");
    // Read numbers its lines, so this is the actual file, not a fixture.
    expect(text(toolMessage)).toStartWith("1\t{");
  });

  test("advertises the tools to the model on every call", async () => {
    await graph().invoke({ messages: start });

    for (const request of requests) {
      const tools = (request as unknown as { tools?: { function: { name: string } }[] })
        .tools;
      expect(tools?.map((tool) => tool.function.name)).toEqual([
        "Read",
        "Glob",
        "Grep",
      ]);
    }
  });

  // Pairing is a provider-level constraint: an assistant turn carrying tool_calls
  // has to be followed by a result for each one, or the next request is rejected.
  test("answers every tool call before calling the model again", async () => {
    await graph().invoke({ messages: start });

    const second = requests[1]?.messages ?? [];
    const calls = second.filter((message) => Array.isArray(message.tool_calls));
    const results = second.filter((message) => message.role === "tool");

    expect(calls).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect(results[0]?.tool_call_id).toBe("call_1");
  });
});

// One lap is two nodes, so the ceiling has to be read in node executions, not
// model calls. Getting this wrong halves or doubles the real limit.
test("caps a turn at an even number of node executions", () => {
  expect(RECURSION_LIMIT % 2).toBe(0);
  expect(RECURSION_LIMIT).toBeGreaterThan(2);
});
