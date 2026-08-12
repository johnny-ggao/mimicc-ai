import type { AssistantMessage, Delta, FinishReason, ToolCall, Usage } from "./types";

export interface CollectedResponse {
  message: AssistantMessage;
  finishReason: FinishReason;
  usage: Usage | undefined;
}

/**
 * Rebuilds tool calls from the fragments a stream delivers.
 *
 * `id` and `name` arrive once, `arguments` arrives as slices of a JSON string,
 * and the only field on every fragment is `index` — so the only way to reassemble
 * a call is to key partials by index and concatenate. Exposed because the repl
 * has to do the same assembly while it renders, and one copy of this rule is
 * enough.
 */
export function createToolCallCollector(): {
  add: (delta: Extract<Delta, { kind: "tool_call" }>) => void;
  finish: () => ToolCall[];
} {
  const partials = new Map<number, { id: string; name: string; args: string }>();

  return {
    add(delta) {
      const partial = partials.get(delta.index) ?? { id: "", name: "", args: "" };
      if (delta.id !== undefined) partial.id = delta.id;
      if (delta.name !== undefined) partial.name = delta.name;
      if (delta.argsChunk !== undefined) partial.args += delta.argsChunk;
      partials.set(delta.index, partial);
    },
    finish() {
      return [...partials.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, partial]) => ({
          id: partial.id,
          name: partial.name,
          arguments: partial.args,
        }));
    },
  };
}

/**
 * Drains a delta stream into one complete assistant message. This is what the
 * agent loop consumes: it needs the whole message (tool calls included) before
 * it can decide what to do next.
 */
export async function collect(
  stream: AsyncIterable<Delta>,
): Promise<CollectedResponse> {
  let text = "";
  let reasoning = "";
  let finishReason: FinishReason = "unknown";
  let usage: Usage | undefined;

  const toolCalls = createToolCallCollector();

  for await (const delta of stream) {
    switch (delta.kind) {
      case "text":
        text += delta.text;
        break;
      case "reasoning":
        reasoning += delta.text;
        break;
      case "tool_call":
        toolCalls.add(delta);
        break;
      case "done":
        finishReason = delta.finishReason;
        usage = delta.usage;
        break;
    }
  }

  const assembled = toolCalls.finish();
  const message: AssistantMessage = {
    role: "assistant",
    content: text,
    ...(assembled.length > 0 ? { toolCalls: assembled } : {}),
    ...(reasoning.length > 0 ? { reasoning } : {}),
  };
  return { message, finishReason, usage };
}
