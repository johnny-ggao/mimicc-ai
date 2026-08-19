/**
 * 一个回合**失败**之后，历史里留下什么？
 *
 * Run: `bun repro/24-what-a-failed-turn-leaves.ts`   （不花钱，打本地 stub）
 *
 * 问的是 `CONTEXT.md` 里「失败」那个词的边界：它逐字写着**失败是可救活的状态、不是终点**，
 * 但没写**它在历史里留下什么**。
 *
 * 🔑 **跑之前的答案是错的，这就是为什么要跑。** 旧 `README.md` 记着「一轮失败会留下一条
 * 没被回答的 user 消息」，理由是那条消息在模型这一跳之前就被 checkpointer 提交了，
 * 而 REPL 不回滚它。那一节 2026-08-20 随 README 重写删掉了，撤之前来核一遍——
 * **核出来它已经不成立了**：失败的回合留下的是 `human → ai`，那条 ai 是
 * **harness 自己写的失败标记**（`src/agents/outcome.ts` 的 `FAILURE_PREFIX`），
 * 给下一个回合读的。那条 user 消息**是被回答了的，只是回答它的不是模型。**
 *
 * 说明这个探针问的其实是两件事：形状是什么，以及**谁在回答**。
 *
 * ⚠️ **让调用失败不能用失败状态码**：带失败码的响应会被 `AsyncCaller` 重试六次
 * （`repro/README.md` 顶上那条警告，`repro/19` 实测打了服务器 7 遍）。
 * 用 **200 + 空 `choices`**——那条警告自己给的解法，不触发重试。
 *
 * 观测面是**盘上的 state**，不是终端：问的是「历史里留下什么」，
 * 而历史是 checkpointer 说了算的。
 */
import { HumanMessage } from "@langchain/core/messages";

import { createUniversalAgent, DURABILITY, RECURSION_LIMIT } from "../src/agents";
import { FAILURE_PREFIX } from "../src/agents/outcome";

const server = Bun.serve({
  port: 0,
  fetch() {
    // 200，但一个 choice 都没有。模型这一跳因此失败，而不是重试。
    return Response.json({
      id: "chatcmpl-empty",
      object: "chat.completion",
      created: 0,
      model: "stub",
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
    });
  },
});

const graph = createUniversalAgent({
  baseURL: `http://localhost:${String(server.port)}`,
  apiKey: "sk-stub",
  model: "stub",
});
const config = {
  recursionLimit: RECURSION_LIMIT,
  durability: DURABILITY,
  configurable: { thread_id: "probe-24" },
};

const shape = async (): Promise<string> => {
  const state = await graph.getState(config);
  return (state.values.messages ?? []).map((message) => message.getType()).join(" → ");
};

const dump = async (): Promise<void> => {
  const state = await graph.getState(config);
  for (const message of state.values.messages ?? []) {
    const bag = message as unknown as { content?: unknown; name?: string };
    process.stdout.write(
      `    · ${message.getType()}${bag.name === undefined ? "" : `(${bag.name})`}: ` +
        `${JSON.stringify(bag.content).slice(0, 100)}\n`,
    );
  }
};

process.stdout.write("① 一个回合，模型这一跳失败\n");
try {
  await graph.invoke({ messages: [new HumanMessage("第一句")] }, config);
  process.stdout.write("  ⚠️ 没失败 —— 探针失效，换个让它失败的办法\n");
} catch (error) {
  process.stdout.write(`  抛了：${String(error).slice(0, 90)}\n`);
}
process.stdout.write(`  失败之后盘上是：[${await shape()}]\n`);
await dump();
process.stdout.write("\n");

process.stdout.write("② 再敲一句（「新输入能救活失败」——词表里失败那条这么写的）\n");
try {
  await graph.invoke({ messages: [new HumanMessage("第二句")] }, config);
} catch (error) {
  process.stdout.write(`  又抛了：${String(error).slice(0, 60)}\n`);
}
const after = await shape();
process.stdout.write(`  盘上是：[${after}]\n\n`);

server.stop(true);

process.stdout.write("=== 判据 ===\n");
const shapes = after.split(" → ");
const marked = (await graph.getState(config)).values.messages?.some(
  (message) =>
    message.getType() === "ai" &&
    typeof message.content === "string" &&
    message.content.startsWith(FAILURE_PREFIX),
);

if (marked === true && shapes.join(" → ") === "human → ai → human → ai") {
  process.stdout.write(
    "  ✅ **失败留下的是一条 harness 写的 ai 标记，不是一条没人回答的 user 消息。**\n" +
      `     形状：[${after}]，两条 ai 都以 \`${FAILURE_PREFIX}\` 开头。\n` +
      "     所以「失败」这个词的边界是：**它在历史里留下自己的记录**——而「中止」不留\n" +
      "     （\`outcome.ts\` 的模块注释逐字：*abort … no marker is written*）。\n" +
      "     ⚠️ 旧 \`README.md\` 记的「留下一条没被回答的 user 消息」**已经不成立**，\n" +
      "     2026-08-20 撤掉它之前核出来的。\n",
  );
} else {
  process.stdout.write(
    `  🔴 形状是 [${after}]，标记 ${marked === true ? "在" : "不在"} —— 和上面写的不一样了，\n` +
      "     去核 `src/agents/outcome.ts`，并把 `CONTEXT.md`「失败」那条改掉。\n",
  );
}
