import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";

import { createChatModel } from "@/agents/model";

/**
 * `reasoning_content` must round-trip: when the model is called with a history
 * that contains an assistant message carrying it, the field has to reach the
 * wire on that same message. This pins the one line `ReasoningEchoCompletions`
 * changes versus langchain's own converter, which drops the field.
 */

interface CapturedMessage {
  role: string;
  content?: unknown;
  reasoning_content?: string;
}

interface CapturedBody {
  stream?: boolean;
  messages: CapturedMessage[];
}

let server: ReturnType<typeof Bun.serve>;
let seen: CapturedBody[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as CapturedBody;
      seen.push(body);

      if (body.stream === true) {
        const chunks = [
          {
            id: "chatcmpl-stub",
            object: "chat.completion.chunk",
            created: 0,
            model: "stub",
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "ok" },
                finish_reason: null,
              },
            ],
          },
          {
            id: "chatcmpl-stub",
            object: "chat.completion.chunk",
            created: 0,
            model: "stub",
            choices: [],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        ];
        const sse =
          chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") +
          "data: [DONE]\n\n";
        return new Response(sse, { headers: { "Content-Type": "text/event-stream" } });
      }

      return Response.json({
        id: "chatcmpl-stub",
        object: "chat.completion",
        created: 0,
        model: "stub",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
});

afterAll(() => void server.stop(true));

beforeEach(() => {
  seen = [];
});

function model() {
  return createChatModel({
    model: "stub",
    apiKey: "sk-stub",
    baseURL: `http://localhost:${String(server.port)}`,
  });
}

function assistantOf(body: CapturedBody | undefined): CapturedMessage | undefined {
  return body?.messages.find((m) => m.role === "assistant");
}

function thinking(): AIMessage {
  return new AIMessage({
    content: "hello",
    additional_kwargs: { reasoning_content: "i should say hello" },
  });
}

describe("reasoning_content echo", () => {
  it("echoes reasoning_content back on a streaming call", async () => {
    const messages = [new HumanMessage("hi"), thinking()];
    for await (const _chunk of await model().stream(messages)) {
      void _chunk;
    }
    expect(assistantOf(seen[0])?.reasoning_content).toBe("i should say hello");
  });

  it("echoes reasoning_content back on a non-streaming call", async () => {
    const messages = [new HumanMessage("hi"), thinking()];
    await model().invoke(messages);
    expect(assistantOf(seen[0])?.reasoning_content).toBe("i should say hello");
  });

  it("leaves an assistant message without reasoning_content alone", async () => {
    const messages = [new HumanMessage("hi"), new AIMessage({ content: "hello" })];
    await model().invoke(messages);
    expect(assistantOf(seen[0])?.reasoning_content).toBeUndefined();
  });

  it("never attaches reasoning_content to a non-assistant message", async () => {
    const messages = [
      new HumanMessage({
        content: "hi",
        additional_kwargs: { reasoning_content: "nope" },
      }),
    ];
    await model().invoke(messages);
    expect(seen[0]?.messages.every((m) => m.reasoning_content === undefined)).toBe(
      true,
    );
  });
});
