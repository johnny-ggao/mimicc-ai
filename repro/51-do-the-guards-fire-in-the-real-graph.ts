/**
 * 装配好的图里，那几个 afterModel 守卫到底响不响？
 *
 * 运行：`bun repro/51-do-the-guards-fire-in-the-real-graph.ts`
 * **不花钱**：全程本地 stub。
 *
 * ## 起点：45 号挂住不是它烂了
 *
 * `repro/45` 单独跑十分钟什么都不回答。看起来像过期的探针该退役，**但它的工具旁挂
 * 拆穿了这个解释**：5583 圈、`intent` 与 `settlement` 各 5583 条全部善终，
 * **而旁挂没有被清空**——按 `repro/21` 量过的性质，跑完的回合会清空它。
 * 所以那个回合从来没有正常收尾。
 *
 * ADR 0009 逐字写着：*真正的护栏 = 回合预算 + loop guard + stall guard + 墙钟*。
 * 45 号是这个仓库里唯一一个把真图推进**一个老实的无限工具循环**的东西——
 * 每一圈都是成功的、参数一模一样的工具调用，不病态、不失败，只是不停。
 * **它没被拦住，就是那句话没兑现。**
 *
 * ## 为什么单测答不了这一问
 *
 * `tests/turn-budget.test.ts` 直接拿手搭的 `AIMessage` 调 `afterModel`——**它证明的是
 * 判据对**。它证明不了判据**在装配好的图里被喂进了什么**。这正是这条线吃过两次的亏
 * （交接文档的教训 ①③：判据的观测面本身要在真环境里验一次）。
 *
 * ## 三格
 *
 *   甲 守卫：`auto: true`，stub 永远回同一个 `Read`。看 `onCap`，**并且看 stub 收到的
 *          请求里有没有出现警告语**——注入的提示只有真走到那一步才会出现在下一次请求里，
 *          那是比回调更硬的观测面（同 `tests/stallguard.test.ts` 的手法）。
 *   乙 门：`auto: false`，stub 回一个 `Bash`。门是另一个 afterModel 使用者。
 *          **它拦不拦，决定这是「所有 afterModel 都瞎」还是「我们自己的守卫挑错了消息」。**
 *   丙 判据：手搭 `AIMessage` 直接调 `turnBudget` 的 `afterModel`，就像单测那样。
 *          它应该绿——**差别只在装配**。
 *
 * ## 读数（2026-08-28）
 *
 * ```
 * 甲 守卫   12048ms  715 圈  停下它的是：探针的闸
 *          onCap=（没响）  请求里出现过 [budget warning]=false  [loop warning]=false
 * 乙 门         5ms    1 圈  门拦下了=true
 * 丙 判据  注入时钟推过预算 + 手搭消息直调 afterModel，强停=true
 * ```
 *
 * **成立。** 预算配 2 秒，甲格跑了 715 圈、12 秒，`onCap` 一次没响，而且**注入的警告语
 * 从来没有出现在 stub 收到的任何一次请求里**——那两段式连第一段都没走。
 * 同一个判据在丙格里是好的，所以**差别只在装配**。
 *
 * 🔑 **乙格是这一票最要紧的一格**：门在 5 毫秒里就拦下了。所以**不是所有 afterModel
 * 都瞎**——问题不在 langchain 的钩子契约，在我们自己的守卫**挑哪一条消息**。
 * 给 `turnBudget.afterModel` 加打印看到的是：`beforeAgent` 只跑一次（对）、
 * `afterModel` 每圈都跑（对）、`elapsed` 涨到预算的 6.6 倍，**但从第二圈起
 * `state.messages` 的最后一条是 `ToolMessage` 而不是 `AIMessage`**，于是那句
 * `if (last === undefined || !AIMessage.isInstance(last)) return;` 每圈提前返回。
 *
 * ⚠️ **本探针只钉住「不响」，不主张怎么修。** 「往回找最后一条 AIMessage」是显然的补法，
 * 但显然的补法正是这条线反复吃亏的地方——先量清楚 `loopGuard` / `emptyReplyGuard`
 * 是不是同一个病、以及为什么门不受影响，再定方案。
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

function stub(toolName: string, seen: Seen): ReturnType<typeof Bun.serve> {
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
        id: "stub",
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
                        ? JSON.stringify({ path: "package.json" })
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
await serverA.stop(true);

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
  `\n甲 守卫  ${String(msA).padStart(6)}ms  ${String(seenA.calls)} 圈  ` +
    `停下它的是：${stoppedByA}\n` +
    `         onCap=${caps.length > 0 ? caps.join(",") : "（没响）"}  ` +
    `请求里出现过 [budget warning]=${String(budgetWarned)}  [loop warning]=${String(loopWarned)}\n` +
    `乙 门    ${String(msB).padStart(6)}ms  ${String(seenB.calls)} 圈  门拦下了=${String(gateParked)}\n` +
    `丙 判据  注入时钟推过预算 + 手搭消息直调 afterModel，强停=${String(criterionWorks)}\n`,
);

console.log("—— 判读 ——");
if (!criterionWorks) {
  console.log("🔴 丙格就不绿，判据本身坏了，甲格的读数另有解释。");
} else if (caps.length === 0 && !budgetWarned) {
  console.log(
    `🔴 成立：预算 ${String(BUDGET_MS / 1000)} 秒，跑了 ${String(seenA.calls)} 圈、` +
      `${String(Math.round(msA / 1000))} 秒，**一次都没响**，而同一个判据在丙格里是好的。\n` +
      "   差别只在装配——ADR 0009 的「真正的护栏 = 回合预算 + loop guard」在真图里没兑现。\n" +
      `   ⚠️ 而门在乙格里${gateParked ? "**照常拦下了**" : "也没拦"}：` +
      `${gateParked ? "所以不是所有 afterModel 都瞎，是我们自己的守卫挑错了那条消息。" : "那范围比守卫更大，先查 afterModel 拿到的是什么。"}`,
  );
} else {
  console.log(
    `✅ 推翻：守卫响了（onCap=${caps.join(",")}，budget warning=${String(budgetWarned)}）。` +
      "「护栏在真图里不响」这句话不成立，别写进票里。",
  );
}
