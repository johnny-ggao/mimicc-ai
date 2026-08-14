/**
 * 父的消息流里，怎么认出一条 chunk 是子 agent 的？—— 票 T5 的前提。
 * Run: `bun repro/12-subagent-stream.ts`
 *
 * 已知：`streamMode: ["messages", …]` 会把**嵌套 run 的 token 一起给**，而且这条通道走
 * AsyncLocalStorage 传播——不传 `configurable` 也堵不住（票 01/02 实测）。所以 T5 的修点在
 * 渲染那一侧，而渲染要能区分来源。
 *
 * 候选的区分依据有三个，全是推测，这个脚本把它们量出来：
 *   A. `chunk.name` —— 落盘的消息里父是 `"model"`、探子是 `"explore"`，但**流式 chunk 上有没有**未知。
 *   B. 元组第二个元素（metadata）里的 `checkpoint_ns` / `langgraph_node` / `tags`。
 *   C. 什么都没有 —— 那 T5 就要换设计。
 *
 * stub server，不花钱。
 */

import { HumanMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { createAgent } from "langchain";

import { createTaskTool } from "../src/tools";

const completion = (id: string, message: Record<string, unknown>, finish: string) => ({
  id,
  object: "chat.completion",
  created: 0,
  model: "stub",
  choices: [{ index: 0, delta: message, message, finish_reason: finish }],
});

// 流式：一次一个 SSE 事件，最后一个 [DONE]。两边都走这条路，父和探子的区别才是唯一变量。
function sse(chunks: Record<string, unknown>[]): Response {
  const body = chunks
    .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
    .concat("data: [DONE]\n\n")
    .join("");
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

let seen = 0;
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as {
      messages: { role: string; content?: string }[];
    };
    seen += 1;
    const system = body.messages.find((message) => message.role === "system");
    const isExplore = (system?.content ?? "").includes("explore");

    if (isExplore) {
      return sse([
        completion(`explore-${String(seen)}`, { role: "assistant", content: "REPORT" }, ""),
        completion(`explore-${String(seen)}`, { content: "-BODY" }, "stop"),
      ]);
    }

    // 第一次：派探子。第二次：回答。
    return sse(
      seen === 1
        ? [
            completion(
              `parent-${String(seen)}`,
              {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "Task",
                      arguments: '{"description":"go look","subagent_type":"explore"}',
                    },
                  },
                ],
              },
              "tool_calls",
            ),
          ]
        : [
            completion(
              `parent-${String(seen)}`,
              { role: "assistant", content: "PARENT-ANSWER" },
              "stop",
            ),
          ],
    );
  },
});

const model = new ChatOpenAI({
  model: "stub",
  apiKey: "stub",
  configuration: { baseURL: `http://localhost:${String(server.port)}/v1` },
  streaming: true,
});

const agent = createAgent({
  model,
  tools: [
    createTaskTool({
      model,
      subagents: [
        {
          name: "explore",
          description: "read-only explore agent",
          prompt: "you are an explore agent",
          tools: [],
        },
      ],
    }),
  ],
  systemPrompt: "you are the parent agent",
});

const stream = (await agent.stream(
  { messages: [new HumanMessage("go")] },
  { streamMode: ["messages", "values"], recursionLimit: 12 },
)) as AsyncIterable<[string, unknown]>;

process.stdout.write(
  "content        | chunk.name | metadata keys / values\n" + "-".repeat(96) + "\n",
);

for await (const [mode, payload] of stream) {
  if (mode !== "messages") continue;
  const [chunk, metadata] = payload as [
    { name?: string; content?: unknown },
    Record<string, unknown> | undefined,
  ];

  const content =
    typeof chunk.content === "string" && chunk.content.length > 0
      ? chunk.content
      : "(empty)";
  const interesting = ["langgraph_node", "checkpoint_ns", "tags", "name", "ls_model_type"];
  const shown = interesting
    .filter((key) => metadata?.[key] !== undefined)
    .map((key) => `${key}=${JSON.stringify(metadata?.[key])}`)
    .join("  ");

  process.stdout.write(
    `${content.slice(0, 14).padEnd(14)} | ${(chunk.name ?? "-").padEnd(10)} | ${shown || "(no metadata)"}\n`,
  );
}

await server.stop(true);
