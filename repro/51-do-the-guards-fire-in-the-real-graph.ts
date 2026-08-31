/**
 * 装配好的图里，那几个 afterModel 守卫到底响不响？
 *
 * 运行：`bun repro/51-do-the-guards-fire-in-the-real-graph.ts`
 * **不花钱**：全程本地 stub。
 *
 * ## 结论：响。ADR 0009 那句「真正的护栏」是兑现的
 *
 * ```
 * 甲 病态     54ms    5 圈  停下它的是：程序自己  onCap=loop_capped      [loop warning]=true
 * 乙 门        6ms    1 圈  门拦下了=true
 * 丁 健康地忙 2039ms 190 圈  停下它的是：程序自己  onCap=budget_exhausted [budget warning]=true
 * 丙 判据    注入时钟推过预算 + 手搭消息直调 afterModel，强停=true
 * ```
 *
 * **重复调用由 `loopGuard` 停，每圈都不一样的「健康地忙」由回合预算停，门照常拦。**
 * 丁格是最要紧的一格——ADR 0009 删掉步数预算，护的正是这一种回合
 * （csv-to-parquet 每圈修不同的 bug，被步数上限误杀过三次）。
 *
 * ## 🔴 但这个探针第一版说的是反话，而错在仪器
 *
 * 第一版的 stub 每次都回 `id: "stub"`。**`add_messages` 按 id upsert**，
 * 于是每条新 AI 消息**覆写**上一条，整段历史长成这样：
 *
 * ```
 * [#1] n=2  human>ai
 * [#2] n=3  human>ai>tool
 * [#4] n=5  ai>tool>tool>tool
 * [#5] n=6  tool>tool>tool>tool      ← 从此「最后一条」永远是 tool
 * ```
 *
 * `turnBudget` / `loopGuard` 判的是 `state.messages` 的**最后一条**，
 * 那句 `if (!AIMessage.isInstance(last)) return;` 于是每圈提前返回——
 * **两个守卫一起假性哑掉，而被测的程序一点毛病没有。**
 * 我据此写过一份「护栏在真图里不响」的报告，**整份都是错的**。
 *
 * 🔑 **教训不是「stub 要写对」，是这一条**：
 * **一个只在 stub 上成立的失败，和一个真实的失败长得一模一样。**
 * 这条线上一次栽在反方向（stub 太像成功、机制早就死了四天没人知道），
 * 这次栽在正方向。**两次的解药是同一个：判据的观测面本身要有对照格。**
 * 丙格（同一判据、手搭消息）就是那个对照——它当时是绿的，
 * 而我把「甲红丙绿」读成了「装配有问题」，**没想到第三种解释：喂进去的东西不真实。**
 *
 * ## 四格
 *
 *   甲 病态：`auto: true`，stub 每圈回**同一个** `Read`。期待 `loop_capped`。
 *   乙 门：`auto: false`，stub 回一个 `Bash`。门是另一个 afterModel 使用者。
 *   丁 健康地忙：每圈换参数，绕开 `loopGuard`。**只有回合预算能停它。**
 *   丙 判据：手搭 `AIMessage` 直接调 `turnBudget` 的 `afterModel`，像单测那样。
 *
 * ⚠️ 观测面是**双份**：`onCap` 回调，**以及 stub 收到的请求里有没有出现警告语**
 * ——注入的提示只有真走到那一步才会出现在下一次请求里，那比回调更硬
 * （同 `tests/stallguard.test.ts` 的手法）。
 *
 * ## 顺带量到、没解释的一条
 *
 * 第一版（同 id、跑 700 多圈）里，中止**确实停住了循环**（闸落下 722 圈，
 * stub 之后一次请求都没再收到），但**从打印完到进程真的退出要 80~95 秒且时快时慢**
 * （12.3s / 92.5s / 107.3s）。修好 id 之后整个探针 2 秒跑完，这个现象跟着消失了——
 * 所以它大概率是「700 圈攒下的状态在拆卸」，**但没有证据，只记不判**。
 */
import { AIMessage, HumanMessage } from "@langchain/core/messages";

import { createUniversalAgent, RECURSION_LIMIT, turnBudget } from "../src/agents";

/** 探针自己的闸。它是最后一道，不是被测的那道。 */
const PATIENCE_MS = Number(process.env["PROBE_PATIENCE_MS"] ?? 12_000);
/** 压到很小，好让「它早就该响了」这件事毫无争议。 */
const BUDGET_MS = 2_000;

interface Seen {
  /** stub 收到的每一次请求里的全部消息文本，拼在一起。 */
  text: string;
  calls: number;
}

function stub(
  toolName: string,
  seen: Seen,
  /** 每圈换一个参数：绕开 loopGuard（它数的是重复），把判据落到回合预算上。 */
  vary = false,
): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const body = (await request.json()) as { messages?: { content?: unknown }[] };
      seen.calls += 1;
      for (const message of body.messages ?? []) {
        if (typeof message.content === "string") seen.text += `\n${message.content}`;
      }
      return Response.json({
        // 🔴 **每次必须是新的 id。** `add_messages` 按 id upsert：所有回复都叫 `stub`
        // 的话，每条新 AI 消息会**覆写**上一条，整段历史里永远只有一条 `ai`，
        // 后面跟着一串 `tool`——于是「最后一条消息」永远不是 AI 消息，
        // 任何读最后一条的判据都会假性哑掉。真 provider 每次回不同的 id。
        id: `stub-${String(seen.calls)}`,
        object: "chat.completion",
        created: 0,
        model: "stub",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: `call-${String(seen.calls)}`,
                  type: "function",
                  function: {
                    name: toolName,
                    arguments:
                      toolName === "Read"
                        ? JSON.stringify({
                            path: "package.json",
                            ...(vary ? { offset: seen.calls } : {}),
                          })
                        : JSON.stringify({ command: "echo hi" }),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    },
  });
}

// —— 甲：老实的无限工具循环，谁来拦 ——
const seenA: Seen = { text: "", calls: 0 };
const serverA = stub("Read", seenA);
const caps: string[] = [];
const agentA = createUniversalAgent({
  baseURL: `http://127.0.0.1:${String(serverA.port)}/v1`,
  apiKey: "sk-stub",
  model: "stub",
  window: { limit: 1_000_000 },
  auto: true,
  turnBudget: { timeBudgetMs: BUDGET_MS },
  onCap: (reason) => caps.push(reason),
});

const controllerA = new AbortController();
const alarmA = setTimeout(() => {
  controllerA.abort(new Error("PROBE_PATIENCE"));
}, PATIENCE_MS);
const startedA = Date.now();
let stoppedByA = "程序自己";
try {
  await agentA.invoke(
    { messages: [new HumanMessage("go")] },
    {
      recursionLimit: RECURSION_LIMIT,
      configurable: { thread_id: "probe-51-a" },
      signal: controllerA.signal,
    },
  );
} catch {
  stoppedByA = controllerA.signal.aborted ? "探针的闸" : "程序自己（抛了）";
}
clearTimeout(alarmA);
const msA = Date.now() - startedA;
// 中止之后它还在不在跑？stub 是最硬的观测面：把闸落下那一刻的圈数记住，
// 后面再看一次，涨了就说明**中止没有把循环停下来**。
const callsAtAbort = seenA.calls;
await serverA.stop(true);
const callsAfterStop = seenA.calls;

const budgetWarned = seenA.text.includes("[budget warning]");
const loopWarned = seenA.text.includes("[loop warning]");

// —— 乙：门是另一个 afterModel 使用者，它拦不拦？ ——
const seenB: Seen = { text: "", calls: 0 };
const serverB = stub("Bash", seenB);
const agentB = createUniversalAgent({
  baseURL: `http://127.0.0.1:${String(serverB.port)}/v1`,
  apiKey: "sk-stub",
  model: "stub",
  window: { limit: 1_000_000 },
  auto: false,
  turnBudget: { timeBudgetMs: BUDGET_MS },
});
const controllerB = new AbortController();
const alarmB = setTimeout(() => {
  controllerB.abort(new Error("PROBE_PATIENCE"));
}, PATIENCE_MS);
const startedB = Date.now();
let gateParked = false;
try {
  const result = (await agentB.invoke(
    { messages: [new HumanMessage("go")] },
    {
      recursionLimit: RECURSION_LIMIT,
      configurable: { thread_id: "probe-51-b" },
      signal: controllerB.signal,
    },
  )) as { __interrupt__?: unknown[] };
  gateParked = (result.__interrupt__ ?? []).length > 0;
} catch {
  gateParked = false;
}
clearTimeout(alarmB);
const msB = Date.now() - startedB;
await serverB.stop(true);

// —— 丁：健康地忙。每圈参数都不同，loopGuard 数的是重复，所以它不该响；
//        能停下这种回合的只有回合预算——ADR 0009 要护的正是这一格
//        （csv-to-parquet 每圈都在修不同的 bug，三次被步数上限误杀）。——
const seenD: Seen = { text: "", calls: 0 };
const serverD = stub("Read", seenD, true);
const capsD: string[] = [];
const agentD = createUniversalAgent({
  baseURL: `http://127.0.0.1:${String(serverD.port)}/v1`,
  apiKey: "sk-stub",
  model: "stub",
  window: { limit: 1_000_000 },
  auto: true,
  turnBudget: { timeBudgetMs: BUDGET_MS },
  onCap: (reason) => capsD.push(reason),
});
const controllerD = new AbortController();
const alarmD = setTimeout(() => {
  controllerD.abort(new Error("PROBE_PATIENCE"));
}, PATIENCE_MS);
const startedD = Date.now();
let stoppedByD = "程序自己";
try {
  await agentD.invoke(
    { messages: [new HumanMessage("go")] },
    {
      recursionLimit: RECURSION_LIMIT,
      configurable: { thread_id: "probe-51-d" },
      signal: controllerD.signal,
    },
  );
} catch {
  stoppedByD = controllerD.signal.aborted ? "探针的闸" : "程序自己（抛了）";
}
clearTimeout(alarmD);
const msD = Date.now() - startedD;
const callsD = seenD.calls;
await serverD.stop(true);
const budgetWarnedD = seenD.text.includes("[budget warning]");

// —— 丙：判据本身。单测就是这么绿的 ——
let clock = 0;
const middleware = turnBudget({
  tokenBudget: 1_000_000_000,
  timeBudgetMs: BUDGET_MS,
  now: () => clock,
});
const before = middleware.beforeAgent;
(typeof before === "function" ? before : before?.hook)?.({} as never, {} as never);
const after = middleware.afterModel;
const afterHook = (typeof after === "function" ? after : after?.hook) as (
  state: { messages: AIMessage[] },
) => { messages?: unknown[] } | undefined;
const withCalls = () =>
  new AIMessage({
    content: "planning",
    tool_calls: [{ name: "Read", args: { path: "x" }, id: "c1", type: "tool_call" }],
  });
clock = BUDGET_MS + 1; // 注入时钟推过预算，和 `tests/turn-budget.test.ts` 同手法
afterHook({ messages: [withCalls()] }); // 第一次：越界，插警告
const forced = afterHook({ messages: [withCalls()] }); // 第二次：应该强停
const criterionWorks = JSON.stringify(forced ?? {}).includes("FORCED STOP");

console.log(
  `\n甲 守卫  ${String(msA).padStart(6)}ms  ${String(callsAtAbort)} 圈  ` +
    `停下它的是：${stoppedByA}\n` +
    `         onCap=${caps.length > 0 ? caps.join(",") : "（没响）"}  ` +
    `请求里出现过 [budget warning]=${String(budgetWarned)}  [loop warning]=${String(loopWarned)}\n` +
    `乙 门    ${String(msB).padStart(6)}ms  ${String(seenB.calls)} 圈  门拦下了=${String(gateParked)}\n` +
    `丁 忙    ${String(msD).padStart(6)}ms  ${String(callsD)} 圈  停下它的是：${stoppedByD}\n` +
    `         onCap=${capsD.length > 0 ? capsD.join(",") : "（没响）"}  ` +
    `请求里出现过 [budget warning]=${String(budgetWarnedD)}\n` +
    `丙 判据  注入时钟推过预算 + 手搭消息直调 afterModel，强停=${String(criterionWorks)}\n` +
    `   （中止落下时 ${String(callsAtAbort)} 圈，stub 关掉时 ${String(callsAfterStop)} 圈）\n`,
);
// 进程能不能干净地退出，本身是一个读数：如果这一行之后还要等很久，
// 说明中止之后还有东西在跑（实测单独跑两次：12.3s 与 116.0s，而甲格两次都只报 12s）。
console.log(`   [exit] 打印完毕 @${String(Date.now() - startedA)}ms（从甲格起跑算）`);

console.log("—— 判读 ——");
const guardStopped = caps.includes("loop_capped");
const budgetStopped = capsD.includes("budget_exhausted");
// 🔴 失败必须落在退出码上：冒烟对不花钱的探针只看退出码，只印红字不退非零，
// 守卫哑了 CI 照样绿——那是「哑掉的守卫在守哑掉的守卫」（2026-08-31 审查发现）。
if (!criterionWorks) {
  console.log("🔴 丙格就不绿，判据本身坏了，别的格另有解释。");
  process.exitCode = 1;
} else if (guardStopped && budgetStopped && gateParked) {
  console.log(
    "✅ 四格齐了：病态由 loopGuard 停（重复调用），健康地忙由回合预算停，门照常拦。\n" +
      "   ADR 0009 那句「真正的护栏」在真图里兑现。",
  );
} else {
  console.log(
    `🔴 有一格没兑现：loop_capped=${String(guardStopped)} ` +
      `budget_exhausted=${String(budgetStopped)} 门=${String(gateParked)}。\n` +
      "   ⚠️ 先查 stub：每次回复的 `id` 必须唯一，否则 `add_messages` 会按 id 覆写，\n" +
      "   整段历史里只剩一条 `ai`，所有读「最后一条消息」的判据都会假性哑掉。",
  );
  process.exitCode = 1;
}
