/**
 * 回合在哪一刻算「收口」—— 而更要紧的是**它在哪几种结尾下不收口**。
 *
 * Run: `bun repro/21-when-a-turn-closes.ts`   （不花钱，打本地 stub）
 *
 * `ToolJournal.prune()` 写好很久了，类文档拿它当「结果在盘上存了两份，这不是免费的」
 * 那句话的答案——**但它从来没有生产调用者**（实测：`.mimicc` 里一条真会话的旁挂
 * 192 KB，29 个调用全部 settle，96% 是它该扔的）。给它接上调用者，安全性全押在一句话上：
 *
 * > 已经 settle 的记录，在**回合跑完之后**就没人会再问了。
 *
 * 那句话只有在「回合跑完」被正确定义时才成立。装在 `afterAgent` 上，等于赌
 * **停在门上**与**被 Ctrl+C 中止**这两种结尾到不了它——而这两种恰恰是记录**必须留着**的：
 * 一批调用里有的已经 settle、有的还悬着，清掉前者，恢复时它就会**再跑一次**，
 * 那正是 journal 存在要防的事（`repro/13` / `repro/14`）。
 *
 * ## 观测面
 *
 * 一批两个 Bash：一个 `echo` 立刻 settle，一个 `sleep 3`。批准两个，然后在慢的那个
 * 还在跑的时候中止。**中止之后去看旁挂文件**：那条 settlement 还在不在。
 * 在 = `afterAgent` 没跑，prune 没动手，赌对了；不在 = 装错地方了。
 *
 * 第二格是对照：一个能跑完的回合，跑完之后旁挂**应该**被清空——否则 prune 等于没接。
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { HumanMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";

import { createUniversalAgent, DURABILITY, RECURSION_LIMIT } from "../src/agents";
import { JsonlSaver } from "../src/checkpoint";

const PROBE_DIR = join(import.meta.dir, "..", ".mimicc", "probe-21");
const MARKER = join(PROBE_DIR, "marker.log");

function startStub(slow: boolean): ReturnType<typeof Bun.serve> {
  let replies = 0;
  return Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { messages: { role: string }[] };
      const answered = body.messages.some((message) => message.role === "tool");
      replies += 1;
      const calls = [
        {
          id: "call_fast",
          type: "function",
          function: {
            name: "Bash",
            arguments: JSON.stringify({ command: `echo fast >> ${MARKER}` }),
          },
        },
        ...(slow
          ? [
              {
                id: "call_slow",
                type: "function",
                function: {
                  name: "Bash",
                  arguments: JSON.stringify({ command: "sleep 3" }),
                },
              },
            ]
          : []),
      ];
      return Response.json({
        id: `chatcmpl-${String(replies)}`,
        object: "chat.completion",
        created: 0,
        model: "stub",
        choices: [
          {
            index: 0,
            message: answered
              ? { role: "assistant", content: "done" }
              : { role: "assistant", content: "", tool_calls: calls },
            finish_reason: answered ? "stop" : "tool_calls",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
}

function journalOf(thread: string): string[] {
  const path = join(PROBE_DIR, `${thread}.tools.jsonl`);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean);
}

async function scenario(
  thread: string,
  slow: boolean,
): Promise<{ lines: string[]; aborted: boolean }> {
  const server = startStub(slow);
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
    configurable: { thread_id: thread },
  };

  await graph.invoke({ messages: [new HumanMessage("go")] }, base);

  const decisions = slow
    ? [{ type: "approve" }, { type: "approve" }]
    : [{ type: "approve" }];
  const controller = new AbortController();
  if (slow) {
    setTimeout(() => {
      controller.abort();
    }, 700);
  }

  let aborted = false;
  try {
    await graph.invoke(new Command({ resume: { decisions } }), {
      ...base,
      ...(slow ? { signal: controller.signal } : {}),
    });
  } catch {
    aborted = true;
  }
  server.stop(true);
  return { lines: journalOf(thread), aborted };
}

rmSync(PROBE_DIR, { recursive: true, force: true });
mkdirSync(PROBE_DIR, { recursive: true });

process.stdout.write("=== ① 一批两个，慢的那个还在跑的时候中止 ===\n");
const interrupted = await scenario("probe-21-abort", true);
process.stdout.write(`  中止了吗: ${interrupted.aborted ? "是" : "⚠️ 否 —— 探针失效"}\n`);
for (const line of interrupted.lines) process.stdout.write(`    ${line.slice(0, 120)}\n`);

process.stdout.write("\n=== ② 对照：一个能跑完的回合 ===\n");
const clean = await scenario("probe-21-clean", false);
process.stdout.write(
  `  旁挂剩下 ${String(clean.lines.length)} 行${clean.lines.length === 0 ? "（文件已删）" : ""}\n`,
);
for (const line of clean.lines) process.stdout.write(`    ${line.slice(0, 120)}\n`);

const kept = interrupted.lines.some((line) => line.includes('"kind":"settlement"'));

process.stdout.write("\n=== 判据 ===\n");
process.stdout.write(
  kept
    ? "  ✅ 中止之后，已 settle 的那条记录**还在** —— `afterAgent` 在这种结尾下不跑，\n" +
        "     prune 没有清掉恢复还要用的东西。装在 afterAgent 上是安全的。\n"
    : "  🔴 中止之后那条 settlement **没了** —— `afterAgent` 在中止时也跑了，\n" +
        "     prune 清掉了恢复唯一的依据。装错地方了，重跑那个调用会重复副作用。\n",
);
process.stdout.write(
  clean.lines.length === 0
    ? "  ✅ 跑完的回合把旁挂清空了 —— prune 确实接上了。\n"
    : "  ⚠️ 跑完的回合没清 —— prune 没被调到，或者还有未 settle 的记录。\n",
);
