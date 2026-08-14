/**
 * What contextEditingMiddleware actually does to a thread — probe for issue 06.
 *
 * Run: `bun repro/06-context-editing.ts`
 *
 * Two questions the source cannot settle on its own, both structural:
 *
 * 1. **Does the pruning reach state, or only the request?** The middleware hangs
 *    off `wrapModelCall` and mutates `request.messages` in place
 *    (contextEditing.js:160 replaces `messages[idx]`), while AgentNode builds
 *    that request with `messages: state.messages` — the array itself, not a copy
 *    (AgentNode.js:331). If the mutation reaches the channel, pruning is
 *    permanent and happens once; if it does not, the full history stays in the
 *    checkpointer and the edit is recomputed from scratch on every model call.
 *    The two have opposite consequences for the cache prefix, and reading the
 *    code does not settle which one it is.
 *
 * 2. **Is the tool_call / tool_result pairing preserved on the wire?** The source
 *    says yes — it builds a replacement ToolMessage carrying the same
 *    `tool_call_id` rather than deleting the message — but that is the one
 *    constraint the provider rejects outright, so it gets checked rather than
 *    assumed.
 *
 * A stub model server, so this costs nothing and the message sequence is fixed.
 */
import { ClearToolUsesEdit, contextEditingMiddleware, createAgent } from "langchain";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { MemorySaver } from "@langchain/langgraph";

import { TOOLS } from "../src/tools";

const requests: { messages: { role: string; content?: unknown; tool_calls?: unknown }[] }[] = [];

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    requests.push((await request.json()) as (typeof requests)[number]);
    const lap = requests.length;

    // Two laps that each read a file, then an answer. Two tool results is the
    // smallest history where "keep the most recent 1" has something to clear.
    const wantsTool = lap <= 2;
    return Response.json({
      id: `chatcmpl-${String(lap)}`,
      object: "chat.completion",
      created: 0,
      model: "stub",
      choices: [
        {
          index: 0,
          message: wantsTool
            ? {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: `call_${String(lap)}`,
                    type: "function",
                    function: { name: "Read", arguments: '{"path":"package.json"}' },
                  },
                ],
              }
            : { role: "assistant", content: "done" },
          finish_reason: wantsTool ? "tool_calls" : "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  },
});

const agent = createAgent({
  model: new ChatOpenAI({
    model: "stub",
    apiKey: "test-key",
    configuration: { baseURL: `http://localhost:${String(server.port)}` },
  }),
  tools: TOOLS,
  checkpointer: new MemorySaver(),
  middleware: [
    contextEditingMiddleware({
      // Trigger at 1 token, so it fires on every call — the default is 100_000
      // and nothing this project measures comes near it.
      edits: [new ClearToolUsesEdit({ trigger: { tokens: 1 }, keep: { messages: 1 } })],
    }),
  ],
});

const config = { configurable: { thread_id: "probe-06" } };
const out = (await agent.invoke(
  { messages: [new HumanMessage("read package.json twice")] },
  config,
)) as { messages: BaseMessage[] };

process.stdout.write("=== what went on the wire ===\n");
requests.forEach((request, index) => {
  const shape = request.messages
    .map((message) => {
      const content = JSON.stringify(message.content ?? "");
      const cleared = content.includes("[cleared]") ? " CLEARED" : "";
      const size = content.length;
      return `${message.role}(${String(size)}${cleared})`;
    })
    .join(" ");
  process.stdout.write(`  request ${String(index + 1)}: ${shape}\n`);
});

process.stdout.write("\n=== pairing on the last request ===\n");
const last = requests.at(-1)?.messages ?? [];
const calls = last.filter((message) => Array.isArray(message.tool_calls)).length;
const results = last.filter((message) => message.role === "tool").length;
process.stdout.write(`  assistant turns with tool_calls: ${String(calls)}\n`);
process.stdout.write(`  tool results: ${String(results)}\n`);

process.stdout.write("\n=== what the thread kept ===\n");
for (const [index, message] of out.messages.entries()) {
  const content = JSON.stringify(message.content);
  process.stdout.write(
    `  ${String(index)} ${message.getType().padEnd(6)} ${String(content.length).padStart(6)} chars` +
      `${content.includes("[cleared]") ? "  <-- cleared in state" : ""}\n`,
  );
}

server.stop(true);
