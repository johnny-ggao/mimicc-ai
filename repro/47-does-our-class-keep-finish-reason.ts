/**
 * `finish_reason` 走到**我们自己的模型类**手里，还在不在？
 *
 * 运行：`bun repro/47-does-our-class-keep-finish-reason.ts`
 * **不花钱**：全程本地 stub。
 *
 * ## 为什么再问一遍（`repro/36` 已经问过了）
 *
 * 🔴 **`repro/36` 量的是 `ChatOpenAI`，不是我们的类。** 它 `new ChatOpenAI(...)`
 * 直接打 stub，结论「流式非流式都读得到」对**库**成立，对
 * `src/agents/model.ts` 的 `ReasoningEchoCompletions` 没说过一个字——
 * 而真正跑的是后者。
 *
 * 2026-08-28 的验证跑逐字揭穿了这个缺口：`grid-pattern-transform` 那条
 * 32768 全烧在 reasoning 上的回复，存下来的 `response_metadata` 是
 *
 * ```json
 * {"model_provider":"openai","usage":{...},"model":"deepseek-v4-flash"}
 * ```
 *
 * **没有 `finish_reason`**，于是 `answerEnding` 返回 `undefined`，
 * `answer_cut` 事件没报、标记没盖、`emptyReplyGuard` 的新分支没触发——
 * 26cca50 那条修复在真 provider 上**是空转的**。
 *
 * ⚠️ 旁证：`model.ts:257-262` 那个 `if (choice.finish_reason != null)` 里
 * 同时会写 `system_fingerprint` / `model_name` / `service_tier`，
 * **这三个也一个都没有**——像是整个分支没进去过。
 *
 * ## 观测面
 *
 * 用**我们的类**打 stub，两条路各问一次：最终那条消息的
 * `response_metadata.finish_reason` 还在不在。
 *
 * stub 发的是 OpenAI 兼容端点的常见形状（内容一片 → 只带 finish_reason 一片 →
 * 只带 usage 一片），与 `repro/36` 逐字相同，好让两个探针可比。
 *
 * ⚠️ 这个探针答不了「DeepSeek 到底发没发」——它只能把「我们的类会不会丢」
 * 和「provider 没发」分开。**先分开，再决定去查哪一边。**
 *
 * ## 结果（2026-08-28）
 *
 * ```
 * invoke（非流式）  finish_reason=length  keys=["tokenUsage","finish_reason","model_provider","model_name"]
 * stream（图走的）  finish_reason=length  keys=["prompt","completion","model_provider","usage","finish_reason","system_fingerprint","model_name","service_tier"]
 * ```
 *
 * **两条都不丢。** 所以真跑里那条消息没有 `finish_reason`，是 **provider 没发**。
 * 🔑 逐字对得上：真跑的 keys 是 `["model_provider","usage","model"]`——
 * `model.ts:257-262` 那个 `if (choice.finish_reason != null)` 块里会一起写的
 * `system_fingerprint` / `service_tier` **一个都没有**，说明那个分支从没进去过。
 *
 * **由此定的方案**：`answerEnding` 不再只认 `finish_reason`。
 * **额度花光这件事，两半都是我们自己的**——帽子是我们定的，token 是我们数的，
 * 所以 provider 沉默时它自己站得住（`src/context/compaction.ts`）。
 * ⚠️ **只在沉默时**：`finish_reason` 说了 `stop`，那是 provider 在回答这个问题。
 */
import { concat } from "@langchain/core/utils/stream";
import { HumanMessage, type AIMessageChunk } from "@langchain/core/messages";

import { createChatModel } from "@/agents/model";

const CONTENT = "";
const OUTPUT_TOKENS = 7;

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as { stream?: boolean };
    const usage = {
      prompt_tokens: 11,
      completion_tokens: OUTPUT_TOKENS,
      total_tokens: 18,
      completion_tokens_details: { reasoning_tokens: OUTPUT_TOKENS },
    };

    if (body.stream !== true) {
      return Response.json({
        id: "stub",
        object: "chat.completion",
        created: 0,
        model: "stub",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: CONTENT },
            finish_reason: "length",
          },
        ],
        usage,
      });
    }

    const frames = [
      { choices: [{ index: 0, delta: { role: "assistant", content: CONTENT } }] },
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

const base = {
  model: "stub-model",
  apiKey: "k",
  baseURL: `http://localhost:${String(server.port)}`,
  maxTokens: OUTPUT_TOKENS,
};

function read(label: string, message: unknown): boolean {
  const meta = (message as { response_metadata?: Record<string, unknown> })
    .response_metadata;
  const usage = (message as { usage_metadata?: { output_tokens?: number } })
    .usage_metadata;
  process.stdout.write(
    `${label.padEnd(22)}finish_reason=${String(meta?.["finish_reason"]).padEnd(10)}` +
      `output_tokens=${String(usage?.output_tokens).padEnd(6)}` +
      `keys=${JSON.stringify(Object.keys(meta ?? {}))}\n`,
  );
  return meta?.["finish_reason"] === "length";
}

// `invoke()`：langchain 把 `generationInfo` 提升进 `response_metadata`。
const plain = await createChatModel(base).invoke([new HumanMessage("hi")]);
const plainOk = read("invoke（非流式）", plain);

// 🔑 `stream()`：图跑的就是这条。分片拼起来的消息只带 **分片自己的**
// `response_metadata`——`generationInfo` 不在拼装范围内。
// ⚠️ `repro/36` 和本探针的第一版都只问了 `invoke()`，所以都给了假的安心。
let merged: AIMessageChunk | undefined;
for await (const chunk of await createChatModel(base).stream([new HumanMessage("hi")])) {
  merged = merged === undefined ? chunk : concat(merged, chunk);
}
const streamOk = read("stream（图走的）", merged);

server.stop(true);

process.stdout.write(
  `\n判读\n` +
    `  invoke  ${plainOk ? "✅ 读得到" : "🔴 丢了"}\n` +
    `  stream  ${streamOk ? "✅ 读得到" : "🔴 丢了 —— 图走的就是这条"}\n` +
    `\n${plainOk && streamOk ? "→ 两条都不丢。那真跑里没有 finish_reason 就是 provider 没发——下一步去抓真实帧。" : "→ 缺口在 src/agents/model.ts：finish_reason 只写进了 generationInfo，没写进分片的 response_metadata。"}\n`,
);
