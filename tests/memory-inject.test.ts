import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { createUniversalAgent, DURABILITY, RECURSION_LIMIT } from "@/agents";
import { isPinned } from "@/context";
import {
  MAX_INJECTED_BYTES,
  MEMORY_ID,
  MemoryStore,
  render,
  select,
  type Memory,
  type MemoryDirs,
  type WriteContext,
} from "@/memory";

/**
 * What injection costs, measured rather than asserted.
 *
 * The design decision this file defends was made against my recommendation
 * (2026-08-17): memory is re-injected live rather than frozen for the session,
 * and the price is that a turn which changes memory breaks the provider's cached
 * prefix from that message onwards. "The price is acceptable" is a claim about
 * bytes, so the end-to-end tests below read the bytes that actually went to the
 * provider — a stub records every request body — and pin *where* the two
 * requests stop matching.
 *
 * Without that measurement the argument would rest on nobody having checked.
 */

interface StubRequest {
  messages: { role: string; content?: unknown }[];
}

let server: ReturnType<typeof Bun.serve>;
let seen: StubRequest[] = [];
/** Set per test: the tool calls the stub emits, one entry per reply. */
let scripted: { name: string; args: unknown }[][] = [];

let root: string;
let dirs: MemoryDirs;
let store: MemoryStore;

const CONTEXT: WriteContext = { threadId: "t", callId: "c" };

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as StubRequest;
      seen.push(body);
      const calls = scripted.shift() ?? [];
      return Response.json({
        // A distinct id per reply: messages merge by id, and reusing one makes
        // the later reply overwrite the earlier one in place.
        id: `chatcmpl-${String(seen.length)}`,
        object: "chat.completion",
        created: 0,
        model: "stub",
        choices: [
          {
            index: 0,
            message:
              calls.length > 0
                ? {
                    role: "assistant",
                    content: "",
                    tool_calls: calls.map((call, index) => ({
                      id: `call-${String(seen.length)}-${String(index)}`,
                      type: "function",
                      function: {
                        name: call.name,
                        arguments: JSON.stringify(call.args),
                      },
                    })),
                  }
                : { role: "assistant", content: "ok" },
            finish_reason: calls.length > 0 ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
});

afterAll(() => server.stop(true));

beforeEach(() => {
  seen = [];
  scripted = [];
  root = mkdtempSync(join(tmpdir(), "mimicc-inject-"));
  dirs = { global: join(root, "global"), project: join(root, "project") };
  store = new MemoryStore(dirs);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function agent(withMemory: boolean) {
  return createUniversalAgent({
    baseURL: `http://localhost:${String(server.port)}/v1`,
    apiKey: "sk-stub",
    model: "stub",
    systemPrompt: "stub prompt",
    ...(withMemory ? { memory: dirs } : {}),
  });
}

async function turn(
  graph: ReturnType<typeof createUniversalAgent>,
  text: string,
  thread: string,
): Promise<BaseMessage[]> {
  const result = (await graph.invoke(
    { messages: [new HumanMessage(text)] },
    {
      recursionLimit: RECURSION_LIMIT,
      durability: DURABILITY,
      configurable: { thread_id: thread },
    },
  )) as { messages: BaseMessage[] };
  return result.messages;
}

/** The index of the first message where two requests stop being identical. */
function divergence(a: StubRequest, b: StubRequest): number {
  const shared = Math.min(a.messages.length, b.messages.length);
  for (let i = 0; i < shared; i += 1) {
    if (JSON.stringify(a.messages[i]) !== JSON.stringify(b.messages[i])) return i;
  }
  return shared;
}

/* ---------- 注入本身 ---------- */

// The control case, and the one that has to be free. Nothing remembered is not
// an empty section — an empty tag would spend tokens on every request, forever,
// saying what the absent tag already says.
test("an empty memory injects nothing at all", async () => {
  const messages = await turn(agent(true), "hello", "t1");
  expect(messages.find((message) => message.id === MEMORY_ID)).toBeUndefined();
  expect(JSON.stringify(seen[0])).not.toContain("<memory>");
});

test("a remembered fact arrives as a pinned human message under a fixed id", async () => {
  store.add("writes in Chinese", "user", CONTEXT);

  const messages = await turn(agent(true), "hello", "t1");
  const injected = messages.find((message) => message.id === MEMORY_ID);

  expect(injected).toBeDefined();
  expect(injected?.getType()).toBe("human");
  // Not `system`: every line of this was written by the agent itself, so putting
  // it in system would let the model's own output carry the authority of its
  // safety rules.
  expect(
    seen[0]?.messages.some(
      (message) =>
        message.role === "system" && String(message.content).includes("<memory>"),
    ),
  ).toBe(false);
  // Pinned, or a long session would silently trim the memory back out.
  expect(isPinned(injected as BaseMessage)).toBe(true);
});

test("control: no store means no middleware, not an empty one", async () => {
  store.add("writes in Chinese", "user", CONTEXT);
  const messages = await turn(agent(false), "hello", "t1");

  expect(messages.find((message) => message.id === MEMORY_ID)).toBeUndefined();
  expect(JSON.stringify(seen[0])).not.toContain("writes in Chinese");
});

/* ---------- 缓存前缀的账 ---------- */

test("a turn that changes nothing sends a byte-identical prefix", async () => {
  store.add("writes in Chinese", "user", CONTEXT);
  const graph = agent(true);

  await turn(graph, "first", "same");
  await turn(graph, "second", "same");

  const [one, two] = seen;
  expect(one).toBeDefined();
  expect(two).toBeDefined();

  // Everything the first request contained is still there, unchanged, in the
  // same order. That is exactly the condition a provider's prefix cache needs,
  // and it is the whole claim that live re-injection is cheap when memory is
  // quiet.
  expect(divergence(one as StubRequest, two as StubRequest)).toBe(
    (one as StubRequest).messages.length,
  );
});

test("a turn that changes memory diverges at the memory message, and not before", async () => {
  store.add("writes in Chinese", "user", CONTEXT);
  const graph = agent(true);

  await turn(graph, "first", "same");
  store.add("prefers Bun over Node", "user", { threadId: "t", callId: "c2" });
  await turn(graph, "second", "same");

  const [one, two] = seen;
  const at = divergence(one as StubRequest, two as StubRequest);

  // The cost is real — this is the turn that pays it. What is being pinned is
  // that it is paid *at the memory message* rather than at the system prompt:
  // everything before it still caches, which is why the message is injected here
  // and not prepended to the prompt.
  expect(at).toBeLessThan((one as StubRequest).messages.length);
  expect(String((one as StubRequest).messages[at]?.content)).toContain("<memory>");
  for (let i = 0; i < at; i += 1) {
    expect(JSON.stringify((one as StubRequest).messages[i])).toBe(
      JSON.stringify((two as StubRequest).messages[i]),
    );
  }
  expect(String((two as StubRequest).messages[at]?.content)).toContain(
    "prefers Bun over Node",
  );
});

/* ---------- 选择：优先级、预算、整条 ---------- */

function fake(category: Memory["category"], content: string, created: string): Memory {
  return { id: content, content, category, source: "", created };
}

test("corrections outrank preferences, which outrank project facts and references", () => {
  const kept = select(
    [
      fake("reference", "r", "2026-01-04"),
      fake("project", "p", "2026-01-03"),
      fake("user", "u", "2026-01-02"),
      fake("feedback", "f", "2026-01-01"),
    ],
    MAX_INJECTED_BYTES,
  );

  // Oldest-first input, so a stable sort that ignored priority would return the
  // input order and this would pass by accident. It does not: the order is
  // exactly reversed.
  expect(kept.map((memory) => memory.content)).toEqual(["f", "u", "p", "r"]);
});

test("within one category the newest wins", () => {
  const kept = select(
    [fake("user", "older", "2026-01-01"), fake("user", "newer", "2026-06-01")],
    MAX_INJECTED_BYTES,
  );
  expect(kept.map((memory) => memory.content)).toEqual(["newer", "older"]);
});

test("the budget stops at a whole memory and never mid-sentence", () => {
  const long = "x".repeat(300);
  const kept = select(
    [fake("user", long, "2026-01-02"), fake("user", `${long}y`, "2026-01-01")],
    400,
  );

  expect(kept).toHaveLength(1);
  // Half of "never run this against production" is an instruction to run it.
  expect(kept[0]?.content).toHaveLength(300);
});

test("a memory that does not fit does not let a later shorter one jump the queue", () => {
  const kept = select(
    [
      fake("user", "x".repeat(300), "2026-01-03"),
      fake("user", "x".repeat(300), "2026-01-02"),
      fake("user", "tiny", "2026-01-01"),
    ],
    400,
  );

  // `select` breaks rather than continues, so what is injected never depends on
  // the sizes of what came before: adding one long memory cannot silently swap
  // out an unrelated short one.
  expect(kept.map((memory) => memory.content)).toEqual(["x".repeat(300)]);
});

test("control: everything fits when the budget is not the constraint", () => {
  const memories = [
    fake("feedback", "f", "2026-01-01"),
    fake("user", "u", "2026-01-02"),
    fake("project", "p", "2026-01-03"),
  ];
  expect(select(memories, MAX_INJECTED_BYTES)).toHaveLength(3);
});

/* ---------- 渲染 ---------- */

test("the rendered block groups by category and shows the id the tools take", () => {
  const text = render([fake("feedback", "ask first", "2026-01-01")]);

  expect(text).toContain("<feedback>");
  expect(text).toContain("[ask first] ask first");
  // The id is shown so a model that spots a stale memory can update or delete it
  // without a search round-trip first.
  expect(text).toContain("MemoryDelete");
});

test("nothing rendered from nothing, so the caller can tell empty from absent", () => {
  expect(render([])).toBeUndefined();
});

/* ---------- 票 12 与票 13 接起来 ---------- */

test("what the model remembered in one turn comes back in the next", async () => {
  // The two tickets are only useful joined: 12 proves a memory can be written,
  // 13 proves one can be injected, and neither proves the model's own write is
  // the thing that comes back. This drives the shipped tools through the shipped
  // middleware — no store methods called directly.
  scripted = [
    [{ name: "MemoryAdd", args: { content: "prefers Bun", category: "user" } }],
  ];

  const graph = agent(true);
  await turn(graph, "remember that I prefer Bun", "joined");

  // Turn one could not have carried it: the memory did not exist when
  // `beforeAgent` ran. Without this the next assertion would also pass if the
  // block had simply always been there.
  //
  // The block, not the text. Asserting the *content* was absent nearly passed
  // for the wrong reason — the user message in this very turn says "I prefer
  // Bun", one letter away from the memory being searched for.
  expect(JSON.stringify(seen[0])).not.toContain("<memory>");

  seen = [];
  await turn(graph, "and now?", "joined");

  const injected = (seen[0] as StubRequest).messages.find((message) =>
    String(message.content).includes("<memory>"),
  );
  expect(String(injected?.content)).toContain("prefers Bun");
  // Provenance is the harness's, not the model's: it never appeared in the tool
  // arguments, so a source in the file can be trusted when the memory turns out
  // to be wrong.
  expect(store.all()[0]?.source).toContain("thread=joined");
});
