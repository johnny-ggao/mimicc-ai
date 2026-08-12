import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

import { createOpenAICompatibleClient } from "@/llm/openai-compatible";
import { LLMError } from "@/llm/types";
import type { Message, ToolDefinition } from "@/llm/types";

// A stub endpoint instead of the real API: these tests are about what we put on
// the wire, and that has to be checkable without a network or a key.
let server: ReturnType<typeof Bun.serve>;
let lastBody: { messages: Record<string, unknown>[] };
/** Each test swaps this out to shape the reply it needs. */
let respond: () => Response;

const SSE_BODY =
  'data: {"id":"1","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}';

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      lastBody = (await request.json()) as typeof lastBody;
      return respond();
    },
  });
});

afterAll(() => void server.stop(true));

const sse = (...chunks: string[]) =>
  new Response([...chunks, "data: [DONE]", ""].join("\n\n"), {
    headers: { "Content-Type": "text/event-stream" },
  });

const chunk = (delta: unknown, finish: string | null = null) =>
  `data: ${JSON.stringify({
    id: "1",
    object: "chat.completion.chunk",
    created: 0,
    model: "m",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}`;

beforeEach(() => {
  respond = () => sse(SSE_BODY);
});

const TOOLS: ToolDefinition[] = [
  {
    name: "Bash",
    description: "Run a shell command",
    parameters: { type: "object", properties: { command: { type: "string" } } },
  },
];

/** Drives one request and hands back the assistant message as it went out. */
async function wireAssistant(message: Message): Promise<Record<string, unknown>> {
  const client = createOpenAICompatibleClient({
    baseURL: `http://localhost:${String(server.port)}`,
    apiKey: "test-key",
    model: "deepseek-v4-flash",
  });

  const messages: Message[] = [{ role: "user", content: "ls" }, message];
  for await (const _delta of client.stream({ messages, tools: TOOLS })) {
    // Drain: the request is only issued once the generator is consumed.
  }

  const assistant = lastBody.messages.find((m) => m.role === "assistant");
  if (assistant === undefined) throw new Error("no assistant message on the wire");
  return assistant;
}

const withToolCalls = {
  role: "assistant",
  content: "",
  toolCalls: [{ id: "c1", name: "Bash", arguments: '{"command":"ls"}' }],
} satisfies Message;

// The regression this file exists for. DeepSeek v4 answers 400 — "the
// reasoning_content in the thinking mode must be passed back to the API" — when
// an assistant turn carries tool_calls without its reasoning. Dropping the field
// here breaks the agent loop on its second turn, and nothing else would catch it.
test("sends reasoning_content back on assistant turns that carry tool calls", async () => {
  const assistant = await wireAssistant({ ...withToolCalls, reasoning: "look first" });

  expect(assistant.reasoning_content).toBe("look first");
  expect(assistant.tool_calls).toHaveLength(1);
});

// Text-only turns are accepted either way, so the tokens are not worth spending.
test("omits reasoning_content on text-only turns", async () => {
  const assistant = await wireAssistant({
    role: "assistant",
    content: "done",
    reasoning: "look first",
  });

  expect(assistant).not.toHaveProperty("reasoning_content");
  expect(assistant.content).toBe("done");
});

test("omits reasoning_content when there is no reasoning to send", async () => {
  const assistant = await wireAssistant(withToolCalls);

  expect(assistant).not.toHaveProperty("reasoning_content");
});

/* ---------- delta 通道与 usage ---------- */

function client() {
  return createOpenAICompatibleClient({
    baseURL: `http://localhost:${String(server.port)}`,
    apiKey: "test-key",
    model: "deepseek-v4-flash",
  });
}

async function drain(signal?: AbortSignal) {
  const out = [];
  const messages: Message[] = [
    { role: "system", content: "be brief" },
    { role: "user", content: "ls" },
    { role: "tool", toolCallId: "c1", content: "a.txt" },
  ];
  for await (const delta of client().stream({
    messages,
    ...(signal ? { signal } : {}),
    temperature: 0,
    maxTokens: 16,
  })) {
    out.push(delta);
  }
  return out;
}

test("maps reasoning, text, fragmented tool calls and usage onto deltas", async () => {
  respond = () =>
    sse(
      chunk({ reasoning_content: "think" }),
      chunk({ content: "hi" }),
      chunk({ tool_calls: [{ index: 0, id: "c1", function: { name: "Bash" } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"cmd"' } }] }),
      chunk({}, "tool_calls"),
      `data: ${JSON.stringify({
        id: "1",
        object: "chat.completion.chunk",
        created: 0,
        model: "m",
        choices: [],
        usage: {
          prompt_tokens: 9,
          completion_tokens: 3,
          total_tokens: 12,
          prompt_cache_hit_tokens: 5,
        },
      })}`,
    );

  const deltas = await drain();

  expect(deltas.filter((d) => d.kind === "reasoning")).toHaveLength(1);
  expect(deltas.filter((d) => d.kind === "text")).toHaveLength(1);
  expect(deltas.filter((d) => d.kind === "tool_call")).toHaveLength(2);

  const done = deltas.at(-1);
  expect(done).toMatchObject({
    kind: "done",
    finishReason: "tool_calls",
    usage: { promptTokens: 9, totalTokens: 12, cachedPromptTokens: 5 },
  });
});

test("reports an unrecognised finish reason as unknown", async () => {
  respond = () => sse(chunk({ content: "x" }, "something_new"));

  const done = (await drain()).at(-1);

  expect(done).toMatchObject({ kind: "done", finishReason: "unknown" });
});

/* ---------- 错误映射 ---------- */

// The status-to-kind table is the whole reason LLMError exists; 402 in
// particular is DeepSeek-specific (insufficient balance) and has no OpenAI twin.
const STATUSES = [
  [401, "auth"],
  [403, "auth"],
  [429, "rate_limit"],
  [402, "bad_request"],
  [500, "server"],
] as const;

for (const [status, kind] of STATUSES) {
  test(`turns HTTP ${String(status)} into an LLMError of kind ${kind}`, async () => {
    respond = () =>
      new Response(JSON.stringify({ error: { message: "nope" } }), {
        status,
        headers: { "Content-Type": "application/json" },
      });

    const error = await drain().then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(LLMError);
    expect(error).toMatchObject({ kind, status });
  });
}

// Two different abort paths, and they are easy to conflate. Aborting before the
// request goes out makes the SDK raise APIUserAbortError; aborting mid-stream
// makes it end the iterator *cleanly*, so the adapter has to notice on its own
// or the contract documented on ChatOptions.signal is a lie. Both must land on
// kind "aborted", and only the second one exercises the post-loop check.
test("maps a pre-request abort onto an aborted LLMError", async () => {
  const controller = new AbortController();
  controller.abort();

  const error = await drain(controller.signal).then(
    () => undefined,
    (caught: unknown) => caught,
  );

  expect(error).toBeInstanceOf(LLMError);
  expect(error).toMatchObject({ kind: "aborted" });
});

test("notices a mid-stream abort the SDK swallowed", async () => {
  const controller = new AbortController();
  // Trickled out so the abort lands between chunks rather than before the call.
  respond = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        async start(stream) {
          const send = (text: string) => stream.enqueue(new TextEncoder().encode(text));
          send(`${chunk({ content: "partial" })}\n\n`);
          await Bun.sleep(30);
          send(`${chunk({}, "stop")}\n\ndata: [DONE]\n\n`);
          stream.close();
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );

  const error = await (async () => {
    try {
      for await (const delta of client().stream({
        messages: [{ role: "user", content: "ls" }],
        signal: controller.signal,
      })) {
        if (delta.kind === "text") controller.abort();
      }
      return undefined;
    } catch (caught: unknown) {
      return caught;
    }
  })();

  expect(error).toBeInstanceOf(LLMError);
  expect(error).toMatchObject({ kind: "aborted" });
});
