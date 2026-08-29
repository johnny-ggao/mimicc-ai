/**
 * ⏸️ **已退役（2026-08-28）——只列不跑，留着是证据。**
 *
 * 退役的理由**只有一条半**，而且都与「它跑不动」无关（那一条已经修掉了，见下）：
 * **题面过期**——ADR 0009 把步数预算整个删了，`RECURSION_LIMIT` 今天是 `1_000_000` 的
 * 格式占位；**两个观测面都死了**——`getGraph()` 拿不到（节点表 0 个，被自己的 try/catch
 * 静默吞掉），上限也撞不到。
 *
 * 🔴 **而它今天照样印结论，且印的是错的**：
 *
 * ```
 *   上限          1000000 个节点
 *   跑了几圈      5
 *   每圈约        200000.0 个节点        ← 1000000÷5 的算术垃圾
 *   🔑 一个真实任务能用的工具往返次数就是上面那个「几圈」。   ← 错：5 是 loopGuard
 *                                                       对重复调用的阈值
 * ```
 *
 * 这正是 `README.md` 顶上那条警告的原文情形：**一个探针可以跑得起来但答错。**
 *
 * 它的问题由 ADR 0009 与 CONTEXT.md「回合预算」承接；「什么能停下一个老实的循环」
 * 这一问由 `repro/51` 接走（四格，2.2 秒，且多了它没有的「健康地忙」那一格）。
 *
 * `RECURSION_LIMIT = 48` 到底等于几圈？
 *
 * 运行：`bun repro/45-how-many-laps-fit-in-the-limit.ts`
 * **不花钱**：本地 stub server，一个字节都不出网。
 *
 * ## 🔴 订正两次（2026-08-28）：先是我判错，然后发现是它自己烂了
 *
 * **事实一（成立）**：题面过期了。ADR 0009（`5fea7ee`）把步数预算整个删了，
 * `RECURSION_LIMIT` 今天是 `1_000_000` 的格式占位，**撞不到**——
 * 「撞顶前跑了几圈」这个问题已经没有答案。
 *
 * **事实二（我判错了两轮）**：它一度单独跑 **10 分 17 秒**什么都不回答。
 * 我先据此判它退役（错），又据此判它「在报一个活的缺陷」（也错）。
 * **真因是这个探针自己的 stub**：它每次都回 `id: "stub"`，而 `add_messages` 按 id
 * upsert，于是每条新 AI 消息覆写上一条，整段历史里只剩一条 `ai` 加一串 `tool`。
 * 读「最后一条消息」的回合预算与 `loopGuard` 因此**假性哑掉**，没有人停得下它。
 * **被测的程序一点毛病没有**——`repro/51` 四格证过。
 *
 * **修了 id 之后**：**0.15 秒、5 圈、`(没有撞顶)`**，`loopGuard` 把它停住。
 * 观测面①（图的节点表）也早就是死的：`getGraph()` 今天拿不到，那个 try/catch 静默吞掉。
 *
 * 🔑 **顺序很重要，写下来给下一个人**：**先修腐烂，再判退役。**
 * 一个跑不动的探针，它跑不动的原因必须先弄清楚——否则「退役」就成了把一个
 * 没被理解的现象扫到地毯下面。
 *
 * ## 为什么问这一问
 *
 * 2026-08-26，mimicc 第一次跑外部 benchmark（Terminal-Bench 的
 * `grid-pattern-transform`）时死在 `Error: Recursion limit of 48 reached without a
 * final answer`——**只走了 7 次模型调用**。
 *
 * 而 `src/agents/loop.ts:41-48` 那段注释逐字写着：
 *
 * > The guards (loop, stall, empty reply) fire on their own thresholds well inside
 * > this budget; **this is the crash net behind them**, and it must stay wide enough
 * > that a guard always fires first.
 *
 * 🔴 **实测它不是兜底网，它是第一个拦住的东西。** 那段注释同时给了原因：
 * 图数的是**节点**不是回合，而一圈是「model 节点 + afterModel 中间件若干 + tools 节点」。
 * **这个探针把「若干」数出来。**
 *
 * ## 观测面
 *
 * ① 图里到底有哪些节点（`getGraph()` 报的名字）；
 * ② 让模型**永远只调工具、从不给最终答复**，数撞顶前跑了几圈。
 * ⚠️ 不看模型说什么——这里量的是图的算术，不是模型行为。
 *
 * ## 结果（2026-08-26）
 *
 * 🔑 **48 个节点 = 8 圈，每圈 6.0 个节点。**
 *
 * 那 6 个是：`1 (agent) + 4 (afterModel) + 1 (tools)`。
 * **而那 4 个 afterModel 全是守卫本身**——`LoopGuard`、`EmptyReplyGuard`、
 * `Clarify` 门、确认门（`agentStack` 里 afterModel 是 0，这四个是主 agent 在
 * `loop.ts` 里另加的）。
 *
 * 🔴 **所以那段注释说反了一半。** 它说守卫会「well inside this budget」先触发，
 * 但守卫的阈值判的是**病态**不是**长度**：`LoopGuard` 数的是同一个调用重复
 * （`WARN_THRESHOLD = 3` / `HARD_LIMIT = 5`），`StallGuard` 数的是连续失败
 * （`BAD_STREAK_LIMIT = 3`）。**一个老老实实跑 12 个不同工具往返的任务，
 * 一个守卫都不会响**——递归上限是唯一拦住它的东西，而它只有 8 圈。
 *
 * 🔑 **而且守卫越多，可用圈数越少**：每加一个 afterModel 守卫，
 * 每圈就多一个节点，8 圈会掉到 6.8 圈。**「兜底网」和「预算」是同一个数。**
 *
 * ## 🔴 订正：这一条后来被用户驳回，而他是对的（2026-08-26）
 *
 * 初稿写的是*「本探针不主张改这个常量，拿分数去调 harness 是判出范围的事」*。
 * **那是把两件事归成了一件。** 这道题不是「得分低」——它是**抛异常、一个答案都没给**。
 * 「调参数让分数好看」该挡；**「一个普通任务因为内部天花板做不完」是缺陷**。
 * 而且有比 benchmark 更硬的依据：**它违反了 `loop.ts` 自己写下的不变式**。
 *
 * ## 修完之后（同一支探针）
 *
 * 上限改成由**圈预算**推出来（`LAP_BUDGET = 16` → `RECURSION_LIMIT = 102`），
 * 本探针复跑：**17 次模型调用 = 16 个完整圈 + 撞顶那一次。预算兑现。**
 * 🔑 每圈仍是 6.0 个节点——**修的不是这个数，是它的单位**。
 */
import { join } from "node:path";

const PROBE_DIR = join(import.meta.dir, "..", ".mimicc", "probe-45");

const OPEN = "<<<PROBE45";
const CLOSE = "PROBE45>>>";

interface Payload {
  nodes: string[];
  modelCalls: number;
  error: string;
  limit: number;
}

async function runChild(): Promise<void> {
  const { HumanMessage } = await import("@langchain/core/messages");
  const { buildSystemPrompt, createUniversalAgent, RECURSION_LIMIT } = await import(
    "../src/agents"
  );
  const { OUTPUT_BUDGET } = await import("../src/models");

  let modelCalls = 0;

  // 永远回一个工具调用，永远不给最终答复 —— 把圈数逼到上限。
  const server = Bun.serve({
    port: 0,
    fetch() {
      modelCalls += 1;
      return Response.json({
        // 🔴 **每次必须是新的 id**（2026-08-28 修）。原来恒为 `"stub"`，而
        // `add_messages` 按 id upsert：每条新 AI 消息都**覆写**上一条，整段历史里
        // 永远只有一条 `ai`、后面跟着一串 `tool`。于是所有读「最后一条消息」的判据
        // （回合预算、loopGuard）都假性哑掉，这个探针因此永远停不下来。
        // **那是仪器的毛病，不是被测程序的**——`repro/51` 四格证过。
        id: `stub-${String(modelCalls)}`,
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
                  id: `call-${String(modelCalls)}`,
                  type: "function",
                  function: { name: "Read", arguments: JSON.stringify({ path: "seed.txt" }) },
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

  const agent = createUniversalAgent({
    baseURL: `http://127.0.0.1:${String(server.port)}/v1`,
    apiKey: "stub",
    model: "stub-model",
    maxTokens: 256,
    outputBudget: OUTPUT_BUDGET,
    window: { limit: 1_000_000 },
    systemPrompt: buildSystemPrompt({ cwd: process.cwd(), date: "2026-08-26" }),
    stateDir: join(process.cwd(), ".state"),
    auto: true,
  });

  // 图的节点表：这是「48 被谁吃掉」的账本。
  let nodes: string[] = [];
  try {
    const graph = (agent as { getGraph?: () => { nodes: Record<string, unknown> } }).getGraph?.();
    nodes = graph === undefined ? [] : Object.keys(graph.nodes);
  } catch {
    nodes = [];
  }

  let error = "(没有撞顶)";
  try {
    await agent.invoke(
      { messages: [new HumanMessage("开始")] },
      { recursionLimit: RECURSION_LIMIT, configurable: { thread_id: "probe-45" } },
    );
  } catch (caught) {
    error = String(caught).split("\n")[0] ?? "";
  }

  server.stop(true);
  const payload: Payload = { nodes, modelCalls, error, limit: RECURSION_LIMIT };
  process.stdout.write(`${OPEN}${JSON.stringify(payload)}${CLOSE}`);
}

async function main(): Promise<void> {
  const { mkdirSync, rmSync, writeFileSync } = await import("node:fs");
  rmSync(PROBE_DIR, { recursive: true, force: true });
  mkdirSync(PROBE_DIR, { recursive: true });
  writeFileSync(join(PROBE_DIR, "seed.txt"), "a file for the stub to read\n");

  const proc = Bun.spawn({
    cmd: ["bun", import.meta.path],
    cwd: PROBE_DIR,
    env: { ...process.env, PROBE_ROLE: "child" },
    stdout: "pipe",
    stderr: "inherit",
  });
  const raw = await new Response(proc.stdout).text();
  await proc.exited;

  const start = raw.indexOf(OPEN);
  const end = raw.indexOf(CLOSE);
  if (start < 0 || end < start) {
    process.stdout.write("子进程没交回东西\n");
    return;
  }
  const payload = JSON.parse(raw.slice(start + OPEN.length, end)) as Payload;

  const loopNodes = payload.nodes.filter(
    (name) => name !== "__start__" && name !== "__end__",
  );

  process.stdout.write(
    `\n==== 图里的节点（${String(loopNodes.length)} 个）====\n` +
      loopNodes.map((name) => `  · ${name}`).join("\n") +
      `\n\n==== 撞顶时 ====\n` +
      `  上限          ${String(payload.limit)} 个节点\n` +
      `  跑了几圈      ${String(payload.modelCalls)}（= 模型调用次数）\n` +
      `  每圈约        ${(payload.limit / Math.max(1, payload.modelCalls)).toFixed(1)} 个节点\n` +
      `  抛的          ${payload.error.slice(0, 90)}\n` +
      `\n  🔑 一个真实任务能用的工具往返次数就是上面那个「几圈」。\n`,
  );
}

if (process.env["PROBE_ROLE"] === "child") await runChild();
else await main();
