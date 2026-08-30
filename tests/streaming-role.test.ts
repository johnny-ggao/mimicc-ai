import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { AIMessageChunk } from "@langchain/core/messages";

import { createChatModel } from "@/agents/model";

/**
 * A stream whose **first** delta carries no `role` must still accumulate into an
 * `AIMessage`.
 *
 * 🔴 **This is a whole-provider outage, not a type nicety.** The chunk class is
 * picked from `delta.role ?? defaultRole`, and `defaultRole` is only ever what an
 * earlier delta carried. OpenAI and DeepSeek open every stream with a role-bearing
 * delta, so the fallback never mattered; 智谱's `tool_calls` delta carries no
 * `role` and can arrive first, leaving `defaultRole` unset. The reply then
 * accumulates as a `ChatMessageChunk`, and langchain's own AgentNode refuses it —
 * *Invalid response from "wrapModelCall" … expected AIMessage or Command, got
 * object* — before a single tool runs. Measured against the live API 2026-08-30;
 * reproduced here on a stub because the provider only sometimes orders it this way.
 *
 * The stub is the shape 智谱 actually sent, verbatim in the part that matters:
 * a first delta of `{tool_calls: […]}` with no `role`, then a closing delta that
 * does name one.
 */
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch() {
      const chunks = [
        {
          id: "stub",
          object: "chat.completion.chunk",
          created: 0,
          model: "stub",
          choices: [
            {
              index: 0,
              // No `role` — the whole point of the test.
              delta: {
                tool_calls: [
                  {
                    id: "call_1",
                    index: 0,
                    type: "function",
                    function: { name: "Read", arguments: '{"path":"package.json"}' },
                  },
                ],
              },
            },
          ],
        },
        {
          id: "stub",
          object: "chat.completion.chunk",
          created: 0,
          model: "stub",
          choices: [
            {
              index: 0,
              finish_reason: "tool_calls",
              delta: { role: "assistant", content: "" },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      ];
      const sse =
        chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") +
        "data: [DONE]\n\n";
      return new Response(sse, { headers: { "Content-Type": "text/event-stream" } });
    },
  });
});

afterAll(() => void server.stop(true));

describe("a stream whose first delta has no role", () => {
  it("still accumulates into an AIMessage the agent runtime accepts", async () => {
    const model = createChatModel({
      model: "stub",
      apiKey: "stub",
      baseURL: `http://localhost:${String(server.port)}/v1`,
    });

    let accumulated: AIMessageChunk | undefined;
    for await (const chunk of await model.stream("hi")) {
      accumulated = accumulated === undefined ? chunk : accumulated.concat(chunk);
    }

    // The assertion the outage failed: a `ChatMessageChunk` is not an AIMessage,
    // and that is exactly what arrives without the fallback.
    expect(AIMessageChunk.isInstance(accumulated)).toBe(true);
    expect(accumulated?.tool_calls?.[0]?.name).toBe("Read");
  });
});
