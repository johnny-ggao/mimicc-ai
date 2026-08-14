/**
 * 摘要之后，完整对话历史还在 checkpointer 里吗？—— 票 08 的前提测试。
 *
 * Run: `bun repro/08-transcript-survival.ts`
 *
 * 设计里说「对话历史永远不可以被丢弃，用 checkpointer 存」。但 summarization 返回的是
 * `[RemoveMessage(REMOVE_ALL_MESSAGES), 摘要, ...preserved]` —— 它写进的正是 checkpointer。
 * 于是有两种可能，读代码分不出来：
 *
 *   A. checkpointer 的**最新**检查点被裁剪了，但**旧检查点仍在** → 全量历史可经 time travel 召回
 *   B. 旧检查点也没了 / 拿不到 → 全量历史真的丢了，必须另起一个存储
 *
 * 两者对票 08 的结论完全相反。stub server，不花钱。
 */
import { summarizationMiddleware, createAgent } from "langchain";
import { HumanMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { MemorySaver } from "@langchain/langgraph";

let lap = 0;
const server = Bun.serve({
  port: 0,
  async fetch() {
    lap += 1;
    return Response.json({
      id: `chatcmpl-${String(lap)}`,
      object: "chat.completion",
      created: 0,
      model: "stub",
      choices: [{ index: 0, message: { role: "assistant", content: `回答 ${String(lap)}` }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    });
  },
});

const model = new ChatOpenAI({
  model: "stub",
  apiKey: "sk-stub",
  configuration: { baseURL: `http://localhost:${String(server.port)}/v1` },
  streaming: false,
});

const graph = createAgent({
  model,
  tools: [],
  checkpointer: new MemorySaver(),
  middleware: [
    summarizationMiddleware({
      model,
      // 低到每个回合都触发，好在几步之内看到形状。
      trigger: { messages: 4 },
      keep: { messages: 2 },
    }),
  ],
});

const thread = "transcript-probe";
const cfg = { configurable: { thread_id: thread } };

for (const text of ["第一个问题".repeat(3), "第二个问题".repeat(3), "第三个问题".repeat(3), "第四个问题".repeat(3)]) {
  await graph.invoke({ messages: [new HumanMessage(text)] }, cfg);
}

const current = await graph.getState(cfg);
process.stdout.write("=== 最新检查点（模型下次会看到的）===\n");
for (const m of current.values.messages) {
  process.stdout.write(`  ${m.getType().padEnd(6)} ${String(m.content).slice(0, 34)}\n`);
}

process.stdout.write("\n=== 检查点历史（getStateHistory，新→旧）===\n");
let n = 0;
let maxLen = 0;
let everyContent = new Set<string>();
for await (const snap of graph.getStateHistory(cfg)) {
  n += 1;
  const msgs = snap.values.messages ?? [];
  maxLen = Math.max(maxLen, msgs.length);
  for (const m of msgs) everyContent.add(String(m.content).slice(0, 20));
  if (n <= 12) {
    process.stdout.write(
      `  #${String(n).padStart(2)} msgs=${String(msgs.length).padStart(2)}  step=${String(snap.metadata?.step)}  ` +
        `first="${String(msgs[0]?.content ?? "").slice(0, 18)}"\n`,
    );
  }
}
process.stdout.write(`  … 共 ${String(n)} 个检查点，单个检查点最多 ${String(maxLen)} 条消息\n`);

process.stdout.write("\n=== 四个原始提问，在整段检查点历史里还找得到几个？===\n");
for (const q of ["第一个问题", "第二个问题", "第三个问题", "第四个问题"]) {
  const found = [...everyContent].some((c) => c.startsWith(q));
  process.stdout.write(`  ${q}: ${found ? "找得到" : "**没了**"}\n`);
}

// 写放大：checkpointer 存的是「每个 super-step 一份全量快照」，不是一条追加日志。
let snapshotBytes = 0;
let transcriptBytes = 0;
const byId = new Map<string, string>();
for await (const snap of graph.getStateHistory(cfg)) {
  const msgs = snap.values.messages ?? [];
  snapshotBytes += JSON.stringify(msgs.map((m) => ({ t: m.getType(), c: m.content }))).length;
  for (const m of msgs) if (m.id) byId.set(m.id, String(m.content));
}
for (const c of byId.values()) transcriptBytes += c.length;
process.stdout.write(
  `\n=== 写放大 ===\n` +
    `  去重后的真实对话（按消息 id 合并）: ${String(byId.size)} 条 / ${String(transcriptBytes)} 字符\n` +
    `  检查点历史序列化后总量        : ${String(snapshotBytes)} 字符\n` +
    `  放大倍数                      : ${(snapshotBytes / Math.max(transcriptBytes, 1)).toFixed(1)}x\n`,
);

server.stop();
