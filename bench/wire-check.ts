/** What actually goes on the wire for each system-prompt shape. Throwaway probe. */
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";

const seen: unknown[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    seen.push(await req.json());
    return Response.json({
      id: "x", object: "chat.completion", created: 0, model: "stub",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  },
});

const model = new ChatOpenAI({
  model: "stub", apiKey: "k", configuration: { baseURL: `http://localhost:${server.port}` },
});

// A: plain-string content, what repl.ts used to build
await model.invoke([new SystemMessage("be terse"), new HumanMessage("hi")]);
// B: content-block array, what normalizeSystemPrompt builds from a string
await model.invoke([
  new SystemMessage({ content: [{ type: "text", text: "be terse" }] }),
  new HumanMessage("hi"),
]);

for (const [i, body] of seen.entries()) {
  const messages = (body as { messages: unknown[] }).messages;
  console.log(i === 0 ? "A plain string:" : "B content blocks:", JSON.stringify(messages[0]));
}
server.stop(true);
