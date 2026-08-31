import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";

import { FakeListChatModel } from "@langchain/core/utils/testing";

import {
  CONFIRMATION_POLICY,
  createUniversalAgent,
  RECURSION_LIMIT,
  registeredTools,
} from "@/agents";

import { MemoryStore } from "@/memory";
import { SKILL_TOOL_NAME, SkillRegistry } from "@/skills";
import { CLARIFY_TOOL_NAME, TASK_TOOL_NAME, TOOLS } from "@/tools";
import { decide } from "@/tools/permission";
import type { ModelUsage } from "@/usage";

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

/**
 * `createUniversalAgent` compiles with a checkpointer — `interrupt()` requires
 * one — and a checkpointer makes `thread_id` mandatory on every call. Passing it
 * to both builders keeps the shared assertions shared; the one without a
 * checkpointer ignores it.
 */
const CONFIG = { configurable: { thread_id: "test-thread" } };

const start: BaseMessage[] = [
  new SystemMessage("be terse"),
  new HumanMessage("what is package.json?"),
];

/**
 * The loop itself — the four properties that have to hold whatever middleware is
 * installed.
 *
 * These used to run twice, against `createUniversalAgent` and against a
 * hand-drawn `StateGraph` kept as a control. The control was deleted once it
 * could no longer disagree — see docs/adr/0002. The assertions are the half of it
 * worth keeping: they describe the loop, not the builder.
 */
describe("createAgent", () => {
  function graph() {
    requests = [];
    return createUniversalAgent({
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
    const out = await graph().invoke({ messages: start }, CONFIG);

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
    const out = await graph().invoke({ messages: start }, CONFIG);

    const toolMessage = out.messages.find((message) => message.getType() === "tool");
    // Read numbers its lines, so this is the actual file, not a fixture.
    expect(text(toolMessage)).toStartWith("1\t{");
  });

  test("advertises the tools to the model on every call", async () => {
    await graph().invoke({ messages: start }, CONFIG);

    for (const request of requests) {
      const tools = (request as unknown as { tools?: { function: { name: string } }[] })
        .tools;
      // Order is pinned because tools are serialised ahead of messages, so a
      // reshuffle breaks the cached prefix for every request that follows. Task
      // was added after the other six and went last for that reason; Clarify was
      // added after Task and goes after it for the same one. **A new tool
      // appends** — that is the whole rule this list exists to hold.
      expect(tools?.map((tool) => tool.function.name)).toEqual([
        "Read",
        "Write",
        "Edit",
        "Bash",
        "Glob",
        "Grep",
        "WebFetch",
        TASK_TOOL_NAME,
        CLARIFY_TOOL_NAME,
      ]);
    }
  });

  // Pairing is a provider-level constraint: an assistant turn carrying tool_calls
  // has to be followed by a result for each one, or the next request is rejected.
  test("answers every tool call before calling the model again", async () => {
    await graph().invoke({ messages: start }, CONFIG);

    const second = requests[1]?.messages ?? [];
    const calls = second.filter((message) => Array.isArray(message.tool_calls));
    const results = second.filter((message) => message.role === "tool");

    expect(calls).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect(results[0]?.tool_call_id).toBe("call_1");
  });

  test("a forwarded method survives the failure-marker proxy", () => {
    // withFailureMarker wraps invoke/stream and forwards the rest through a
    // Proxy. Every forwarded method reads `this.#graph`, so `this` must be the
    // graph, not the proxy — before the bind fix this threw a TypeError.
    const g = graph();
    expect(() => g.getState({ configurable: { thread_id: "t" } })).not.toThrow();
  });
});

/* ---------- 以下是能力，不是循环 ---------- */

/**
 * The gate is fail-open: `humanInTheLoopMiddleware` auto-approves any tool that
 * has no entry in `interruptOn`. That makes silence the dangerous answer — a
 * tool added later would run unconfirmed, and nothing would say so. This test is
 * the thing that says so.
 */
test("every registered tool has an explicit confirmation decision", () => {
  // Asked of the same function the program calls, not of a list copied beside
  // it. The copy was `[...TOOLS.map(n), TASK_TOOL_NAME]` — correct on the day it
  // was written and unable to notice a second tool assembled the way `Task` is,
  // which is exactly the kind this gate must not miss.
  //
  // A fake model because `registeredTools` builds the dispatch tool and that
  // needs one; nothing here calls it.
  //
  // Memory is supplied, and it has to be: the policy map lists every tool this
  // program *can* register, while `registeredTools` only returns the ones the
  // current environment asked for. Comparing against a partial registration
  // would let a memory tool ship with no confirmation decision — and a tool
  // missing from the map is auto-approved, so that gap fails open. The
  // directories are never touched; nothing here invokes a tool.
  //
  // Skills are supplied for the same reason: the Skill tool is registered
  // whenever a registry exists, even an empty one, so it too must have a
  // decision in the policy.
  //
  // The fake search backend, likewise: WebSearch only registers when a backend
  // resolved, and a conditional tool shipping without a confirmation decision
  // is exactly the fail-open gap this test exists to close.
  const registered = registeredTools(
    {
      model: new FakeListChatModel({ responses: ["unused"] }),
      modelFor: () => new FakeListChatModel({ responses: ["unused"] }),
      memory: new MemoryStore({
        global: "/nonexistent/global",
        project: "/nonexistent/project",
      }),
      webSearch: { id: "fake", search: () => Promise.resolve([]) },
    },
    new SkillRegistry([]),
  ).map((tool) => tool.name);

  expect(Object.keys(CONFIRMATION_POLICY).sort()).toEqual(registered.sort());
});

// The Skill tool joins Task as a tool assembled outside `TOOLS` — the base
// registration (no skills, no memory) stays the six plus Task, and with a
// registry it gains Skill, after Task in the order the prompt advertises.
test("the Skill tool is registered when a registry exists, after Task", () => {
  const registered = registeredTools(
    {
      model: new FakeListChatModel({ responses: ["unused"] }),
      modelFor: () => new FakeListChatModel({ responses: ["unused"] }),
    },
    new SkillRegistry([]),
  ).map((tool) => tool.name);

  expect(registered).toEqual([
    ...TOOLS.map((tool) => tool.name),
    TASK_TOOL_NAME,
    SKILL_TOOL_NAME,
    // Appended after the optional ones, so adding a tool never shifts an
    // existing tail — see the note beside `clarifyTool` in `registeredTools`.
    CLARIFY_TOOL_NAME,
  ]);
});

// The other half of the same claim, and it needs saying separately: the test
// above passes if both sides are wrong together. This one pins what the set
// actually contains, so dropping a tool from `TOOLS` and from the policy in one
// commit still fails.
// Deliberately *without* memory: this pins the base registration, which is what
// the system prompt describes and what the cached prefix depends on. The memory
// tools are optional and tested where they are wired (`tests/memory.test.ts`).
test("the registered set is the six plus the dispatch tool", () => {
  const registered = registeredTools({
    model: new FakeListChatModel({ responses: ["unused"] }),
    modelFor: () => new FakeListChatModel({ responses: ["unused"] }),
  }).map((tool) => tool.name);

  expect(registered).toEqual([
    ...TOOLS.map((tool) => tool.name),
    TASK_TOOL_NAME,
    CLARIFY_TOOL_NAME,
  ]);
});

// Mutating tools ask by default; the read-only and frequent ones do not. The
// decision lives in the rule engine's baseline, not in a per-tool flag — ask is
// one of `decide`'s three outcomes, alongside allow and deny.
test("Write, Edit and Bash ask by default; the rest allow", () => {
  const asking = registeredTools({
    model: new FakeListChatModel({ responses: ["unused"] }),
    modelFor: () => new FakeListChatModel({ responses: ["unused"] }),
  })
    .map((tool) => tool.name)
    .filter((name) => decide({ tool: name }).decision === "ask");

  expect(asking.sort()).toEqual(["Bash", "Edit", "Write"]);
});

// One lap is two nodes, so the ceiling has to be read in node executions, not
// model calls. Getting this wrong halves or doubles the real limit.
test("caps a turn at an even number of node executions", () => {
  expect(RECURSION_LIMIT % 2).toBe(0);
  expect(RECURSION_LIMIT).toBeGreaterThan(2);
});

/**
 * The scale weighs one request, not one turn. A per-turn total cannot show what a
 * context middleware did to lap two — which is the whole question the
 * context-engineering work asks. One lap is two requests, so two records, and the
 * second one is handed more messages than the first.
 */
test("meters every model request separately", async () => {
  requests = [];
  const seen: ModelUsage[] = [];

  const graph = createUniversalAgent({
    baseURL: `http://localhost:${String(server.port)}`,
    apiKey: "test-key",
    model: "stub",
    maxTokens: 64,
    onUsage: (usage) => seen.push(usage),
  });

  await graph.invoke({ messages: start }, CONFIG);

  expect(seen).toHaveLength(2);
  expect(seen.map((usage) => usage.inputTokens)).toEqual([1, 1]);
  expect(seen[1]?.messages ?? 0).toBeGreaterThan(seen[0]?.messages ?? 0);
  // The stub reports no prompt_tokens_details, so nothing was served from cache.
  // The meter has to say 0 rather than leaving the field out — a missing number
  // and a zero read the same way in a log line, and only one of them is true.
  expect(seen[0]?.cacheRead).toBe(0);
});

/**
 * The invariant this whole move exists to create: the system prompt is sent, but
 * it is not in the thread.
 *
 * `summarizationMiddleware` rewrites `state.messages` — it returns
 * `[RemoveMessage(REMOVE_ALL_MESSAGES), summary, ...preserved]` and its
 * `preserved` never includes message zero. Anything living in state is therefore
 * summarisable, and a summarised system prompt is a paraphrase of the rules
 * rather than the rules. Keeping it out of state is what makes it unreachable.
 */
test("sends the system prompt without putting it in the thread", async () => {
  requests = [];

  const graph = createUniversalAgent({
    baseURL: `http://localhost:${String(server.port)}`,
    apiKey: "test-key",
    model: "stub",
    maxTokens: 64,
    systemPrompt: "be terse",
  });

  const out = await graph.invoke(
    { messages: [new HumanMessage("what is package.json?")] },
    CONFIG,
  );

  // Every request to the provider carries it, once, in front.
  for (const request of requests) {
    const system = request.messages.filter((message) => message.role === "system");
    expect(system).toHaveLength(1);
    expect(request.messages[0]?.role).toBe("system");
  }

  // And the thread never sees it.
  expect(out.messages.map((message) => message.getType())).toEqual([
    "human",
    "ai",
    "tool",
    "ai",
  ]);
});

/**
 * The failure mode the console used to be one line away from: seeding a
 * SystemMessage *and* passing systemPrompt sends both. There is no dedup and no
 * error — the prompt is silently doubled, and so is its share of the cache
 * prefix. This test exists so that re-adding the seed to repl.ts fails here
 * rather than in a bill.
 */
test("does not dedup a seeded system message against the parameter", async () => {
  requests = [];

  const graph = createUniversalAgent({
    baseURL: `http://localhost:${String(server.port)}`,
    apiKey: "test-key",
    model: "stub",
    maxTokens: 64,
    systemPrompt: "be terse",
  });

  await graph.invoke({ messages: start }, CONFIG);

  const system = (requests[0]?.messages ?? []).filter(
    (message) => message.role === "system",
  );
  expect(system).toHaveLength(2);
});

/**
 * Pins the serialisation, not just the presence.
 *
 * `normalizeSystemPrompt` passes a SystemMessage through untouched but turns a
 * plain string into content blocks, and the two go on the wire differently:
 * `content: "..."` versus `content: [{ type: "text", text: "..." }]`. The prompt
 * in src/agents/prompt.ts is built to be a byte-stable cache prefix, so which one we
 * send is not cosmetic — and nothing else in the codebase would notice if it
 * flipped.
 */
test("sends the system prompt as plain string content, not blocks", async () => {
  requests = [];

  const graph = createUniversalAgent({
    baseURL: `http://localhost:${String(server.port)}`,
    apiKey: "test-key",
    model: "stub",
    maxTokens: 64,
    systemPrompt: "be terse",
  });

  await graph.invoke({ messages: [new HumanMessage("what is package.json?")] }, CONFIG);

  expect(requests[0]?.messages[0]).toEqual({ role: "system", content: "be terse" });
});
