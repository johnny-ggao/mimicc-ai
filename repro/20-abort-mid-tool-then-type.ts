/**
 * Ctrl+C 打断一个正在跑工具的回合，然后敲下一句话 —— 历史里会不会留下一个悬空的
 * `tool_calls`？
 *
 * Run: `bun repro/20-abort-mid-tool-then-type.ts`   （不花钱，打本地 stub）
 *
 * `repro/19` 已经证了后半段：悬空的 `tool_calls`（后面没有 tool 结果）被真 provider
 * **400 拒**，错误串逐字 *an assistant message with 'tool_calls' must be followed by
 * tool messages responding to each 'tool_call_id'*。而历史是**只增不减**的，所以这种形状
 * 一旦落进去，**之后每一次请求都带着它 → 那条 session 永久 400**。
 *
 * 前半段没测过：**出货路径造不造得出这种形状。** 那条 `ai(tool_calls)` 在模型节点的
 * 检查点里就落盘了（`durability: "sync"`，工具还没开跑），而那条 `tool` 要等工具节点跑完。
 * 夹在中间停下来的有三种——确认门、中止、崩溃：
 *
 * - **门**：`repro/18` 实测能造出来，但出货路径已经堵上（恢复时永远先摆门）。
 * - **崩溃**：`toolRecovery` 会合成一条结果——**但只在图真的接着跑那一批工具时**。
 * - **中止**：没测。`repro/14` 记着「传任何 input 都会从 START 开一个新 run」，
 *   那么 Ctrl+C 之后敲的下一句话，就是「从 START 开新 run」而不是「把那批工具跑完」。
 *
 * ## 观测面：stub 收到的请求体，不是 state
 *
 * 问的是「**会不会有这种东西发给 provider**」，那就直接看发出去的是什么。stub 记下每次
 * 请求的 `messages`，最后扫一遍：有没有一条带 `tool_calls` 的 assistant 消息，它的某个
 * `tool_call_id` 后面找不到对应的 tool 消息。**这比读 state 更接近那个 400。**
 *
 * 中止发生在「工具还在跑」是被证过的、不是赌时序：Bash 跑 `sleep 3`，父侧在工具开跑之后
 * 才 abort（stub 一收到第二次请求就说明模型这一跳结束了，工具紧接着开跑）。
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { HumanMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";

import { createUniversalAgent, DURABILITY, RECURSION_LIMIT } from "../src/agents";
import { JsonlSaver } from "../src/checkpoint";

const PROBE_DIR = join(import.meta.dir, "..", ".mimicc", "probe-20");
const THREAD = "probe-20";

interface Body {
  messages: { role: string; content?: unknown; tool_calls?: { id: string }[] }[];
}

const bodies: Body[] = [];

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as Body;
    bodies.push(body);
    const asked = bodies.length;

    // 第一次要一个慢工具，之后一律收尾。
    const message =
      asked === 1
        ? {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_slow",
                type: "function",
                function: { name: "Bash", arguments: JSON.stringify({ command: "sleep 3" }) },
              },
            ],
          }
        : { role: "assistant", content: "done" };

    return Response.json({
      id: `chatcmpl-${String(asked)}`,
      object: "chat.completion",
      created: 0,
      model: "stub",
      choices: [{ index: 0, message, finish_reason: asked === 1 ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  },
});

rmSync(PROBE_DIR, { recursive: true, force: true });
mkdirSync(PROBE_DIR, { recursive: true });

const graph = createUniversalAgent({
  baseURL: `http://localhost:${String(server.port)}`,
  apiKey: "sk-stub",
  model: "stub",
  checkpointer: new JsonlSaver(PROBE_DIR),
  stateDir: PROBE_DIR,
});
const base = {
  recursionLimit: RECURSION_LIMIT,
  durability: DURABILITY,
  configurable: { thread_id: THREAD },
};

// ① 一个回合，停在门上（Bash 要问）。
await graph.invoke({ messages: [new HumanMessage("go")] }, base);
process.stdout.write("① 门停下来了\n");

// ② 批准 → 工具开跑（sleep 3）→ 中止。
const controller = new AbortController();
setTimeout(() => {
  controller.abort();
}, 600);
try {
  await graph.invoke(new Command({ resume: { decisions: [{ type: "approve" }] } }), {
    ...base,
    signal: controller.signal,
  });
  process.stdout.write("⚠️ 没被中止 —— 探针失效\n");
} catch (error) {
  process.stdout.write(`② 中止了：${String(error).slice(0, 60)}\n`);
}

const before = bodies.length;

// ③ 提示符回来，敲下一句话。这就是出货路径上「Ctrl+C 之后接着聊」。
try {
  await graph.invoke({ messages: [new HumanMessage("接着聊")] }, base);
  process.stdout.write("③ 下一句话跑完了\n\n");
} catch (error) {
  process.stdout.write(`③ 抛了：${String(error).slice(0, 100)}\n\n`);
}

server.stop(true);

/**
 * 一条带 tool_calls 的 assistant 消息，后面**紧跟着**的不是它的结果。
 *
 * ⚠️ 「紧跟着」不是讲究，是实测：`repro/19` 的第四格把结果补在用户那句话**后面**，
 * 同样 400。provider 的检查是**按位置**的，所以这里也必须按位置查——只数
 * `tool_call_id` 出现过没有，会把一个仍然会被拒的形状判成绿的。
 */
function orphansIn(body: Body): string[] {
  const bad: string[] = [];
  for (const [index, message] of body.messages.entries()) {
    const calls = message.tool_calls ?? [];
    for (const [offset, call] of calls.entries()) {
      const answer = body.messages[index + 1 + offset];
      const id = (answer as unknown as { tool_call_id?: string } | undefined)?.tool_call_id;
      if (answer?.role !== "tool" || id !== call.id) bad.push(call.id);
    }
  }
  return bad;
}

process.stdout.write("=== 发给 provider 的每一次请求 ===\n");
for (const [index, body] of bodies.entries()) {
  const shape = body.messages.map((message) => message.role).join(" → ");
  const orphans = orphansIn(body);
  process.stdout.write(
    `  #${String(index + 1)}${index + 1 > before ? " （中止之后那句话）" : ""}: ${shape}` +
      `${orphans.length > 0 ? `   🔴 悬空: ${orphans.join(",")}` : ""}\n`,
  );
}

const after = bodies.slice(before);
const bad = after.filter((body) => orphansIn(body).length > 0);

process.stdout.write("\n=== 判据 ===\n");
if (after.length === 0) {
  process.stdout.write("  ⚠️ 中止之后那句话根本没发出请求 —— 换个读法，探针没答上来。\n");
} else if (bad.length > 0) {
  process.stdout.write(
    "  🔴 **出货路径造得出 orphan。** 中止之后敲的那句话，发出去的请求里带着一个\n" +
      "     没有结果的 tool_call —— 而 repro/19 证明真 provider 对这个形状 400。\n" +
      "     历史只增不减，所以这不是一次失败，是**那条 session 从此不能用了**。\n",
  );
} else {
  process.stdout.write(
    "  ✅ **回归护栏（2026-08-19 修）**：中止之后那次请求里，那个调用的结果紧跟在它后面。\n" +
      "     补刀的是 `context/projection.ts` 的 `closeDangling` —— 在**投影**里补，不动历史：\n" +
      "     检查按位置做，而 `beforeAgent` 的状态更新只能追加（那时用户那句话已经在 state 里了），\n" +
      "     所以历史侧补不出正确的位置，除非把只追加的存储重写成可插入的。\n",
  );
}
