/**
 * checkpointer 到底往存储里写了多少字节？—— 票 08 的持久化调研。
 *
 * Run: `bun repro/08-delta-channel.ts`
 *
 * 第一版量错过一次，值得记：拿 `getStateHistory()` 去数字节，量到的是**重建后**的状态
 * （DeltaChannel 会replay 出完整列表），不是**落盘**的量。两种 channel 因此看起来一模一样。
 * 正确的量法是包一层 saver，数 `put()` 与 `putWrites()` 实际收到的东西。
 *
 * 两个对照：
 *   - `MessagesValue`（`createAgent` 默认）—— 每个检查点存全量消息列表
 *   - `MessagesDeltaValue`（experimental）—— 只存每步的写入 + 周期性快照
 *
 * stub server，不花钱。
 */
import { summarizationMiddleware, createAgent } from "langchain";
import { HumanMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { MemorySaver, StateSchema, MessagesDeltaValue } from "@langchain/langgraph";
import type { Checkpoint, CheckpointMetadata, PendingWrite } from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";

let lap = 0;
const server = Bun.serve({
  port: 0,
  async fetch() {
    lap += 1;
    return Response.json({
      id: `c-${String(lap)}`, object: "chat.completion", created: 0, model: "stub",
      choices: [{ index: 0, message: { role: "assistant", content: `回答 ${String(lap)}` }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    });
  },
});
const model = new ChatOpenAI({ model: "stub", apiKey: "sk-stub",
  configuration: { baseURL: `http://localhost:${String(server.port)}/v1` }, streaming: false });

/** 量的就是「落盘」这一刻。putWrites 是那条 append-only 的流。 */
class CountingSaver extends MemorySaver {
  putBytes = 0;
  putCalls = 0;
  writeBytes = 0;
  writeCalls = 0;
  messageWrites = 0;

  override async put(c: RunnableConfig, checkpoint: Checkpoint, m: CheckpointMetadata, v: Record<string, number | string>) {
    this.putCalls += 1;
    this.putBytes += JSON.stringify(checkpoint.channel_values).length;
    return super.put(c, checkpoint, m, v);
  }
  override async putWrites(c: RunnableConfig, writes: PendingWrite[], taskId: string) {
    this.writeCalls += 1;
    this.writeBytes += JSON.stringify(writes).length;
    for (const [channel] of writes) if (channel === "messages") this.messageWrites += 1;
    return super.putWrites(c, writes, taskId);
  }
}

async function run(label: string, useDelta: boolean) {
  const saver = new CountingSaver();
  const graph = createAgent({
    model, tools: [], checkpointer: saver,
    ...(useDelta ? { stateSchema: new StateSchema({ messages: MessagesDeltaValue }) } : {}),
    middleware: [summarizationMiddleware({ model, trigger: { messages: 4 }, keep: { messages: 2 } })],
  });
  const cfg = { configurable: { thread_id: `t-${label}` } };
  for (const t of ["第一个问题".repeat(3), "第二个问题".repeat(3), "第三个问题".repeat(3), "第四个问题".repeat(3)]) {
    await graph.invoke({ messages: [new HumanMessage(t)] }, cfg);
  }
  const cur = await graph.getState(cfg);
  const visible = (cur.values as { messages: unknown[] }).messages.length;
  process.stdout.write(
    `${label.padEnd(20)}` +
      `put ${String(saver.putCalls).padStart(3)} 次 / ${String(saver.putBytes).padStart(6)} 字符   ` +
      `putWrites ${String(saver.writeCalls).padStart(3)} 次 / ${String(saver.writeBytes).padStart(6)} 字符   ` +
      `合计 ${String(saver.putBytes + saver.writeBytes).padStart(6)}   最新可见 ${String(visible)} 条\n`,
  );
}

process.stdout.write("四个回合、每回合都触发摘要；真实对话 10 条消息 / 约 180 字符正文\n\n");
await run("MessagesValue", false);
await run("MessagesDeltaValue", true);

// 增长曲线：不装摘要，历史一路涨，看两种 channel 的落盘量各自怎么走。
async function grow(turns: number, useDelta: boolean) {
  const saver = new CountingSaver();
  const graph = createAgent({
    model, tools: [], checkpointer: saver,
    ...(useDelta ? { stateSchema: new StateSchema({ messages: MessagesDeltaValue }) } : {}),
  });
  const cfg = { configurable: { thread_id: `g-${String(turns)}-${String(useDelta)}` } };
  for (let i = 0; i < turns; i += 1) {
    await graph.invoke({ messages: [new HumanMessage(`问题 ${String(i)}`.repeat(4))] }, cfg);
  }
  return saver.putBytes + saver.writeBytes;
}

process.stdout.write("\n增长曲线（无摘要，历史一路涨）\n回合   MessagesValue   MessagesDeltaValue   比值\n");
for (const turns of [4, 8, 16, 32]) {
  const full = await grow(turns, false);
  const delta = await grow(turns, true);
  process.stdout.write(
    `${String(turns).padStart(4)}${String(full).padStart(16)}${String(delta).padStart(21)}${(full / delta).toFixed(1).padStart(7)}x\n`,
  );
}

server.stop();
