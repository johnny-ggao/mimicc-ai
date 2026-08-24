/**
 * 流式路径上，`finish_reason` 到底有没有落到最终那条 AIMessage 上？
 * —— `.scratch/output-budget/` 票 02 的观测面。
 *
 * 运行：`bun repro/36-does-finish-reason-survive-streaming.ts`
 * **不花钱**：全程本地 stub。
 *
 * ## 为什么读代码读不出来
 *
 * 主 agent 是流式的。`src/agents/model.ts:183-187` 在流式分片上把 `finish_reason` 塞进
 * `generationInfo`，`:256-257` 在非流式分支上塞进另一处。**分片是被拼起来的**，
 * 而「拼完之后它还在不在最终那条消息的 `response_metadata` 里」是拼装逻辑的性质，
 * 不是这两处代码能回答的。
 *
 * 🔑 **这正是票 02 的地基**：读不到 `finish_reason`，「被我们的帽子卡住」和「模型写完了」
 * 就永远分不开，而[票 01](../.scratch/output-budget/issues/01-clamp-to-the-remaining-window.md)
 * 刚把「被卡住」变成了日常。
 *
 * ## 三个观测点
 *
 * 1. **非流式**（子 agent 走 `graph.invoke` 的那条路）
 * 2. **流式**（主 agent 那条路）
 * 3. `usage.output` 有没有跟着回来——pi 判「是谁截的」要拿它和额度比
 *    （`packages/ai/src/utils/overflow.ts:171`）
 */
import { HumanMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";

/** stub 回一个 `finish_reason: "length"` 的回复，模拟被额度砍断。 */
const TRUNCATED_CONTENT = "I was cut off mid-sen";
const OUTPUT_TOKENS = 7;

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as { stream?: boolean };
    const usage = { prompt_tokens: 11, completion_tokens: OUTPUT_TOKENS, total_tokens: 18 };

    if (body.stream !== true) {
      return Response.json({
        id: "stub",
        object: "chat.completion",
        created: 0,
        model: "stub",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: TRUNCATED_CONTENT },
            finish_reason: "length",
          },
        ],
        usage,
      });
    }

    // 流式：内容一片，然后一片只带 finish_reason，最后一片带 usage —— 这是
    // OpenAI 兼容端点的常见形状，`stream_options.include_usage` 打开时如此。
    const frames = [
      { choices: [{ index: 0, delta: { role: "assistant", content: TRUNCATED_CONTENT } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "length" }] },
      { choices: [], usage },
    ];
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const frame of frames) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ id: "stub", object: "chat.completion.chunk", created: 0, model: "stub", ...frame })}\n\n`,
              ),
            );
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  },
});

const model = new ChatOpenAI({
  model: "stub-model",
  apiKey: "k",
  configuration: { baseURL: `http://localhost:${String(server.port)}` },
  maxTokens: OUTPUT_TOKENS,
  streaming: false,
});

function read(label: string, message: unknown): boolean {
  const meta = (message as { response_metadata?: Record<string, unknown> }).response_metadata;
  const usage = (message as { usage_metadata?: { output_tokens?: number } }).usage_metadata;
  const reason = meta?.["finish_reason"];
  process.stdout.write(
    `${label.padEnd(18)}finish_reason=${String(reason).padEnd(10)}` +
      `output_tokens=${String(usage?.output_tokens)}\n`,
  );
  return reason === "length";
}

process.stdout.write(`stub 每次都回 finish_reason="length"，completion_tokens=${String(OUTPUT_TOKENS)}\n\n`);

const plain = await model.invoke([new HumanMessage("hi")]);
const plainOk = read("非流式", plain);

const streaming = new ChatOpenAI({
  model: "stub-model",
  apiKey: "k",
  configuration: { baseURL: `http://localhost:${String(server.port)}` },
  maxTokens: OUTPUT_TOKENS,
  streaming: true,
  streamUsage: true,
});
const streamed = await streaming.invoke([new HumanMessage("hi")]);
const streamOk = read("流式", streamed);

server.stop(true);

const usage = (streamed as { usage_metadata?: { output_tokens?: number } }).usage_metadata;
const sameAsCeiling = usage?.output_tokens === OUTPUT_TOKENS;

process.stdout.write(
  `\n判读\n` +
    `  非流式读得到 finish_reason  ${plainOk ? "✅" : "🔴"}\n` +
    `  流式读得到 finish_reason    ${streamOk ? "✅" : "🔴 —— 主 agent 走的就是这条，读不到就没有观测面"}\n` +
    `  流式带回 output_tokens      ${usage?.output_tokens !== undefined ? "✅" : "🔴"}` +
    `${sameAsCeiling ? "（且等于额度 → 判「我们卡的」）" : ""}\n` +
    `\n${plainOk && streamOk && usage?.output_tokens !== undefined ? "→ 票 02 的观测面成立：两条路径都读得到，且能和额度比。" : "→ 观测面有缺口，票 02 要先补它。"}\n`,
);
