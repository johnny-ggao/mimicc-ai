/**
 * 工具体里 `interrupt()`：问得出去吗？答得回来吗？**体会不会重跑一遍？**
 *
 * Run: `bun repro/25-interrupt-inside-a-tool-body.ts`   （不花钱，打本地 stub）
 *
 * ## 为什么问这个
 *
 * 要给 agent 一个「向用户提结构化问题」的工具（编号选项，用户敲数字）。最自然的写法
 * 是在工具体里 `interrupt()`，拿 `Command({resume})` 答。而 `src/agents/kinds.ts:228`
 * 上写着一条**反证**，是解释 Explore agent 为什么只读时写下的：
 *
 * > `interrupt()` does work inside a nested run, but it needs a checkpointer in the
 * > ambient config (langgraph/interrupt.js:54) *and* a resume path —
 * > **and a tool body is not resumable, so the parent re-runs the whole call on resume.**
 *
 * 如果「体整个重跑」成立，那问题工具要么这条路不通，要么必须严格幂等——
 * 而「幂等」这个要求得写进它的契约里，不能靠实现的人自觉。另一条路是照确认门的样子
 * 做成 `afterModel` 中间件（模型发出调用，中间件拦下来 interrupt，恢复时合成 ToolMessage）。
 *
 * **两条路选哪条取决于这里的答案，所以先量。**
 *
 * ## 观测面
 *
 * 一个 marker 文件，**追加**（`repro/14` 的同一个理由：覆盖语义下重跑看不见）。
 * 工具体在 `interrupt()` **之前**写一行 `body-entered`，之后写一行 `body-resumed`。
 * 于是：
 *
 * - `body-entered` 出现 **1 次** → 体没重跑，interrupt 是从体中间挂起再回来的
 * - `body-entered` 出现 **2 次** → 体重跑了，那条反证对工具体也成立
 * - `body-resumed` 出现 → 恢复后控制流真的回到了 `interrupt()` 之后
 *
 * 另外印出最终历史里那条 ToolMessage 的内容：模型看不看得到答案，是这条路能不能用的
 * 第二个判据（问出去了但答案回不到模型手里，等于没问）。
 *
 * ## 四个场景
 *
 * - `bare`  —— 裸 `createAgent` + checkpointer。langgraph 自己的语义，作对照。
 * - `stack` —— 加上**真的会包住工具体的那两个中间件**：`toolRecovery` 与 `stallGuard`
 *   都用 `wrapToolCall`，一个记「要跑了 / 已 settle」的旁挂日志，一个把 throw 变成
 *   ToolMessage。一个从体中间抛出去的 interrupt 长得很像一次异常，**这里是最可能出事的地方**。
 * - `recovery` / `stall` —— 两个中间件各装一个。`stack` 出事的时候，要认得出是谁干的。
 *
 * ⚠️ 确认门不在场景里，是判过的不是漏的：它是 `afterModel` 钩子、只对 `Bash` 生效
 * （`CONFIRMATION_POLICY`），不包别的工具的体。它和这道题的交互是另一个问题——
 * 「两个 interrupt 源同时在场时控制台怎么分辨」——那要等这条路先成立才谈得上。
 *
 * ## 答案（2026-08-20 初测）
 *
 * **这条路当时堵死了，而且是被我们自己的两个中间件堵的。**
 *
 * | 场景 | 停下来问 | 模型最后拿到 | body-entered |
 * | --- | --- | --- | --- |
 * | `bare` | 是 | `用户选了："2. 严格不隔夜"` | **×2** |
 * | `recovery` | 是 | `[interrupted: … no result was ever recorded]` | ×1 |
 * | `stall` | **否** | `GraphInterrupt: […] Please fix your mistakes.` | ×1 |
 * | `stack` | **否** | 同上 | ×1 |
 *
 * 三条独立的结论：
 *
 * 1. **`kinds.ts:228` 那条反证，对工具体成立。** 裸场景下 `body-entered` 出现两次——
 *    `interrupt()` 不是把体挂起，是让体整个重放，恢复时从头再跑到 `interrupt()`，
 *    这次它返回答案。所以任何在工具体里 interrupt 的工具，**体必须严格幂等**，
 *    而这是个契约要求，不能靠写的人自觉。
 *
 * 2. **`stallGuard` 把 `GraphInterrupt` 当异常吞了。** 它的活是「把 throw 变成模型读得懂的
 *    ToolMessage」，而 langgraph 的 interrupt 就是一个 throw。于是门根本没开，模型收到
 *    `"GraphInterrupt: … Please fix your mistakes."`。
 *
 * 3. **`toolRecovery` 分不清「停下来问人」和「进程死在半路」。** 单独装它时门是开的，
 *    但恢复之后它把这次调用判成「中断且不可重复」，合成 `interruptedText` 顶掉了真答案——
 *    人答了，模型收到的却是崩溃恢复的套话。
 *
 * ## 后两条是缺陷，已修（2026-08-20 复测）
 *
 * 结论 2、3 是出货代码里的缺陷，不是 langgraph 的语义，所以是去改而不是去绕：
 *
 * - `stallGuard` 遇到 `isGraphBubbleUp(error)` 原样再抛，也不计进坏运（`stallguard.ts`）。
 *   langchain 自己的 `toolErrorMiddleware` 就是这么干的（`toolError.js:51`），谓词也用它的，
 *   所以以后新增的控制流信号不用回来改这里。
 * - `toolRecovery` 遇到 bubble-up 先记一条 **suspension** 再抛。这条记录**作废它前面那条
 *   intent**（`checkpoint/journal.ts`）：intent 的语义是「盘上说不清跑到哪了」，而暂停的
 *   状态是**说得清**的——体停在 `interrupt()` 那一行，后面的代码没跑。恢复是新的一次尝试，
 *   记新的 intent，所以**那一次跑到一半崩掉，照样 fail closed**。
 *
 * 复测：四个场景全部与 `bare` 一致——都停下来问、都拿到 `用户选了："2. 严格不隔夜"`、
 * `body-entered` 都是 **×2**。回归钉在 `tests/stallguard.test.ts`、`tests/recovery.test.ts`、
 * `tests/journal.test.ts`（三处都验过：撤掉修复就红）。
 *
 * ## 选路的结论没变
 *
 * 结论 1 没被修掉，也修不掉——**体重放是 langgraph 的语义**。所以
 * **问题工具仍然走 `afterModel` 中间件，不走工具体**（和确认门同一条路：模型发出调用，
 * 中间件拦下来 interrupt，恢复时合成 ToolMessage 顶掉这次调用，工具体从不执行）。
 * 那条路上「体必须幂等」根本不适用：没有体可重跑。
 * langchain 自己的 HITL 拒绝路径就是这么干的（`agents/middleware/hitl.js:399`
 * 建 ToolMessage，`:501` 放进 afterModel 的 state update），仓库里已经在跑。
 *
 * 变的是**这条路不再是「堵死的」**：真要有工具想在体里 interrupt，门是开的，
 * 代价只剩那一条契约——体必须幂等到 `interrupt()` 为止。
 */
import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { HumanMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { Command, interrupt } from "@langchain/langgraph";
import { createAgent, tool, type AnyAgentMiddleware } from "langchain";
import { z } from "zod";

import { toolRecovery } from "../src/agents";
import { stallGuard } from "../src/agents/stallguard";
import { JsonlSaver } from "../src/checkpoint";

const PROBE_DIR = join(import.meta.dir, "..", ".mimicc", "probe-25");
const CASES = ["bare", "recovery", "stall", "stack"] as const;

rmSync(PROBE_DIR, { recursive: true, force: true });
mkdirSync(PROBE_DIR, { recursive: true });

// ---------------------------------------------------------------- 被测的工具

function markerOf(kase: string): string {
  return join(PROBE_DIR, `${kase}.marker.log`);
}

/**
 * 一个只会问问题的工具。体里除了写 marker 什么副作用都没有——**这正是要量的**：
 * 如果体重跑，marker 会有两行 `body-entered`，而真正的问题工具在那种语义下就必须
 * 把「体必须幂等」写进契约。
 */
function askTool(kase: string) {
  return tool(
    (args: { question: string }) => {
      appendFileSync(markerOf(kase), `body-entered ${args.question}\n`);
      const answer = interrupt({ kind: "question", question: args.question });
      appendFileSync(markerOf(kase), `body-resumed ${JSON.stringify(answer)}\n`);
      return `用户选了：${JSON.stringify(answer)}`;
    },
    {
      name: "Ask",
      description: "问用户一个问题",
      schema: z.object({ question: z.string() }),
    },
  );
}

// ---------------------------------------------------------------- stub 模型

/** 第一次要一次 Ask；看到 tool 结果就收尾。判据不看模型说了什么，看历史里那条 ToolMessage。 */
function startStub(): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { messages: { role: string }[] };
      const answered = body.messages.some((message) => message.role === "tool");

      return Response.json({
        id: "chatcmpl-probe-25",
        object: "chat.completion",
        created: 0,
        model: "stub",
        choices: [
          {
            index: 0,
            message: answered
              ? { role: "assistant", content: "收到" }
              : {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "Ask_0",
                      type: "function",
                      function: {
                        name: "Ask",
                        arguments: JSON.stringify({ question: "日内的准确含义？" }),
                      },
                    },
                  ],
                },
            finish_reason: answered ? "stop" : "tool_calls",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
}

// ---------------------------------------------------------------- 一个场景

async function runCase(kase: (typeof CASES)[number]): Promise<void> {
  const directory = join(PROBE_DIR, kase);
  mkdirSync(directory, { recursive: true });
  const server = startStub();

  const middleware: AnyAgentMiddleware[] = [
    ...(kase === "recovery" || kase === "stack" ? [toolRecovery({ directory })] : []),
    ...(kase === "stall" || kase === "stack" ? [stallGuard()] : []),
  ];

  const agent = createAgent({
    model: new ChatOpenAI({
      model: "stub",
      apiKey: "test-key",
      configuration: { baseURL: `http://localhost:${String(server.port)}` },
    }),
    tools: [askTool(kase)],
    checkpointer: new JsonlSaver(directory),
    middleware,
  });

  // `"sync"`：`repro/13` 量过，默认的 `"async"` 下检查点可能还没落盘，那样测的就不是这道题。
  const config = {
    configurable: { thread_id: `probe-25-${kase}` },
    durability: "sync" as const,
  };

  process.stdout.write(`\n=== ${kase} ===\n`);

  // ① 问出去
  const first = (await agent.invoke({ messages: [new HumanMessage("go")] }, config)) as {
    __interrupt__?: { value?: unknown }[];
  };
  const stopped = first.__interrupt__;
  process.stdout.write(
    `  ① 停下来问了吗: ${stopped === undefined ? "否" : "是"}` +
      (stopped ? `  payload=${JSON.stringify(stopped[0]?.value)}` : "") +
      "\n",
  );
  if (stopped === undefined) {
    // 没停下来才是要看的：interrupt 被谁变成了什么？
    const messages = (first as unknown as { messages?: { getType: () => string; content: unknown }[] })
      .messages ?? [];
    for (const message of messages.filter((m) => m.getType() === "tool")) {
      process.stdout.write(`     它变成了 ToolMessage: ${JSON.stringify(message.content).slice(0, 200)}\n`);
    }
    const seen = readFileSync(markerOf(kase), "utf8").trimEnd().split("\n");
    process.stdout.write(`     marker: ${JSON.stringify(seen)}\n`);
    server.stop(true);
    return;
  }

  // ② 答回来
  const done = (await agent.invoke(
    new Command({ resume: "2. 严格不隔夜" }),
    config,
  )) as { messages: { getType: () => string; content: unknown }[] };

  // ③ 模型手里拿到的是什么
  const toolMessage = done.messages.find((message) => message.getType() === "tool");
  process.stdout.write(
    `  ② 恢复后历史里的 ToolMessage: ${
      toolMessage === undefined ? "没有" : JSON.stringify(toolMessage.content)
    }\n`,
  );

  const marker = readFileSync(markerOf(kase), "utf8").trimEnd().split("\n");
  const entered = marker.filter((line) => line.startsWith("body-entered")).length;
  process.stdout.write(`  ③ marker（${String(marker.length)} 行）:\n`);
  for (const line of marker) process.stdout.write(`       ${line}\n`);
  process.stdout.write(
    `     → body-entered ×${String(entered)} ⇒ ${
      entered === 1 ? "体没重跑" : "体重跑了，反证对工具体也成立"
    }\n`,
  );

  server.stop(true);
}

for (const kase of CASES) await runCase(kase);
process.stdout.write("\n");
