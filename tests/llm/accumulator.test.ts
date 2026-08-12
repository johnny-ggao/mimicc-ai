import { expect, test } from "bun:test";

// Imported directly rather than through the `@/llm` barrel: pulling in the
// barrel would also load the network adapter, which no unit test covers and
// which would then drag down the coverage threshold in bunfig.toml.
import { collect } from "@/llm/accumulator";
import type { Delta } from "@/llm/types";

// A fixture stream: nothing to await, but the shape has to be async to match
// what the adapter produces.
// eslint-disable-next-line @typescript-eslint/require-await
async function* replay(deltas: Delta[]): AsyncIterable<Delta> {
  for (const delta of deltas) yield delta;
}

test("assembles interleaved tool calls from fragmented argument chunks", async () => {
  const { message, finishReason } = await collect(
    replay([
      { kind: "tool_call", index: 0, id: "call_a", name: "read_file" },
      { kind: "tool_call", index: 1, id: "call_b", name: "list_dir" },
      { kind: "tool_call", index: 0, argsChunk: '{"pa' },
      { kind: "tool_call", index: 1, argsChunk: '{"di' },
      { kind: "tool_call", index: 0, argsChunk: 'th":"a.ts"}' },
      { kind: "tool_call", index: 1, argsChunk: 'r":"src"}' },
      { kind: "done", finishReason: "tool_calls" },
    ]),
  );

  expect(finishReason).toBe("tool_calls");
  expect(message.content).toBe("");
  expect(message.toolCalls).toEqual([
    { id: "call_a", name: "read_file", arguments: '{"path":"a.ts"}' },
    { id: "call_b", name: "list_dir", arguments: '{"dir":"src"}' },
  ]);
});

test("orders tool calls by provider index, not by arrival", async () => {
  const { message } = await collect(
    replay([
      { kind: "tool_call", index: 2, id: "c", name: "third", argsChunk: "{}" },
      { kind: "tool_call", index: 0, id: "a", name: "first", argsChunk: "{}" },
      { kind: "tool_call", index: 1, id: "b", name: "second", argsChunk: "{}" },
      { kind: "done", finishReason: "tool_calls" },
    ]),
  );

  expect(message.toolCalls?.map((call) => call.name)).toEqual([
    "first",
    "second",
    "third",
  ]);
});

test("separates reasoning from content and omits empty optionals", async () => {
  const { message, finishReason, usage } = await collect(
    replay([
      { kind: "reasoning", text: "let me " },
      { kind: "reasoning", text: "think" },
      { kind: "text", text: "4" },
      { kind: "text", text: "2" },
      {
        kind: "done",
        finishReason: "stop",
        usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 },
      },
    ]),
  );

  expect(message.reasoning).toBe("let me think");
  expect(message.content).toBe("42");
  expect(message).not.toHaveProperty("toolCalls");
  expect(finishReason).toBe("stop");
  expect(usage?.totalTokens).toBe(10);
});

test("reports an unknown finish reason and no usage for a truncated stream", async () => {
  const { message, finishReason, usage } = await collect(
    replay([{ kind: "text", text: "partial" }]),
  );

  expect(message.content).toBe("partial");
  expect(message).not.toHaveProperty("reasoning");
  expect(finishReason).toBe("unknown");
  expect(usage).toBeUndefined();
});
