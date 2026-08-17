/**
 * 崩溃打断的是**我们自己的 agent**，而不是一张手搭的图 —— 票 08 留下的那道缝。
 *
 * Run: `bun repro/14-recovery-end-to-end.ts`   （不花钱，打本地 stub）
 *
 * `repro/13` 证明的是 LangGraph 那一侧：`durability: "sync"` 下检查点在工具开跑前落盘，
 * 重启是真恢复。`tests/recovery.test.ts` 证明的是恢复逻辑：预置一份「有 intent 没
 * settlement」的日志，中间件会短路或合成。**两段都对，但没人证明过它们接在一起。**
 *
 * 这个探针把它们接上：一批两个调用，一个跑完，另一个把进程 SIGKILL 掉；重启之后看
 * **跑完的那个会不会再跑一次**。
 *
 * ## 为什么不需要「工具注入的缝」
 *
 * 票 08 结的时候把这道缝归因于「`createUniversalAgent` 不接受注入工具，而唯一能自杀的
 * 真工具 `Bash` 被确认门拦着」。**后半句是错的**：门不是障碍，它是一个提问，而探针可以
 * 像用户一样回答它 —— `Command({ resume: { decisions: [{ type: "approve" }, …] } })`。
 *
 * 所以这里一个新 API 都没有，用的是出货的那套工具、那道门、那条循环。**这比注入一个假工具
 * 更可信**：注入的版本证明「恢复逻辑对」，这一版证明「装在真 agent 上之后仍然对」。
 *
 * ## 观测面是追加，不是覆盖
 *
 * 第一个调用是 `echo tick >> marker`。**追加**，所以「跑了两次」看得见；`Write` 那种
 * 覆盖语义下，重跑一次和没重跑长得一模一样。
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { HumanMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";

import { createUniversalAgent, RECURSION_LIMIT } from "../src/agents";
import { JsonlSaver } from "../src/checkpoint";

const PROBE_DIR = join(import.meta.dir, "..", ".mimicc", "probe-14");
const MARKER = join(PROBE_DIR, "marker.log");
const THREAD = "probe-14";

// ---------------------------------------------------------------- 孩子那一侧

function startStub(): ReturnType<typeof Bun.serve> {
  let replies = 0;
  return Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { messages: { role: string }[] };
      const answered = body.messages.some((message) => message.role === "tool");
      replies += 1;

      return Response.json({
        // 每条回复一个不同的 id：消息按 id 合并，复用会让后一条原地覆盖前一条，
        // 整跳连同它的 tool_calls 从 state 里消失。
        id: `chatcmpl-${String(replies)}`,
        object: "chat.completion",
        created: 0,
        model: "stub",
        choices: [
          {
            index: 0,
            message: answered
              ? { role: "assistant", content: "done" }
              : {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "call_tick",
                      type: "function",
                      function: {
                        name: "Bash",
                        // 追加，所以重跑看得见。
                        arguments: JSON.stringify({ command: `echo tick >> ${MARKER}` }),
                      },
                    },
                    {
                      id: "call_kill",
                      type: "function",
                      function: {
                        name: "Bash",
                        // 睡一下，让上面那个跑完并把 settlement 写下去，然后杀掉
                        // 自己的父进程 —— Bash 工具是 Bun.spawn(["/bin/sh","-c",…])，
                        // 所以 $PPID 就是这个 bun 进程。
                        arguments: JSON.stringify({
                          command: "sleep 0.4; kill -9 $PPID",
                        }),
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

async function runChild(): Promise<void> {
  const phase = process.env["PHASE"] ?? "crash";
  const server = startStub();
  const agent = createUniversalAgent({
    baseURL: `http://localhost:${String(server.port)}`,
    apiKey: "sk-stub",
    model: "stub",
    checkpointer: new JsonlSaver(PROBE_DIR),
    stateDir: PROBE_DIR,
  });
  const config = {
    recursionLimit: RECURSION_LIMIT,
    configurable: { thread_id: THREAD },
  };

  try {
    if (phase === "crash") {
      // 门会停在这里 —— 两个 Bash 都要问。
      await agent.invoke({ messages: [new HumanMessage("go")] }, config);
      process.stdout.write("    门停下来了，批准两个\n");
      await agent.invoke(
        new Command({
          resume: { decisions: [{ type: "approve" }, { type: "approve" }] },
        }),
        config,
      );
      process.stdout.write("    ⚠️ 没被杀掉 —— 探针失效\n");
    } else {
      // ⚠️ 恢复必须传 null。传任何 input 都会从 START 开一个新 run。
      await agent.invoke(null, config);
      process.stdout.write("    恢复跑完\n");
    }
  } catch (error) {
    process.stdout.write(`    抛了：${String(error).slice(0, 120)}\n`);
  }
  server.stop(true);
}

// ------------------------------------------------------------ 编排者那一侧

async function spawnChild(phase: string): Promise<number | null> {
  const proc = Bun.spawn({
    cmd: ["bun", join(import.meta.dir, "14-recovery-end-to-end.ts")],
    env: { ...process.env, PROBE_ROLE: "child", PHASE: phase },
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
  return proc.signalCode === null ? proc.exitCode : null;
}

function ticks(): number {
  if (!existsSync(MARKER)) return 0;
  return readFileSync(MARKER, "utf8").split("\n").filter(Boolean).length;
}

function journalLines(): string[] {
  const path = join(PROBE_DIR, `${THREAD}.tools.jsonl`);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean);
}

if (process.env["PROBE_ROLE"] === "child") {
  await runChild();
} else {
  rmSync(PROBE_DIR, { recursive: true, force: true });
  mkdirSync(PROBE_DIR, { recursive: true });

  process.stdout.write("一批两个 Bash：一个 echo 追加，一个 sleep 后 SIGKILL 自己\n\n");
  process.stdout.write("=== ① 跑到一半崩溃 ===\n");
  const crashed = await spawnChild("crash");
  process.stdout.write(
    `  子进程结束方式: ${crashed === null ? "被信号杀死 (SIGKILL)" : `退出码 ${String(crashed)}`}\n`,
  );
  const before = ticks();
  process.stdout.write(`  marker 行数: ${String(before)}\n`);
  process.stdout.write(`  日志里的行:\n`);
  for (const line of journalLines()) process.stdout.write(`    ${line.slice(0, 150)}\n`);

  process.stdout.write("\n=== ② 同 thread_id 重启 ===\n");
  const resumed = await spawnChild("resume");
  process.stdout.write(
    `  恢复进程: ${resumed === null ? "被信号杀死" : `退出码 ${String(resumed)}`}\n`,
  );
  const after = ticks();
  process.stdout.write(`  marker 行数: ${String(after)}\n`);

  process.stdout.write("\n=== 判据 ===\n");
  process.stdout.write(
    `  🔑 跑完的那个调用重跑了吗: ${after > before ? "⚠️ 重跑了" : "没有"}` +
      `   （崩溃前 ${String(before)} 行，恢复后 ${String(after)} 行）\n`,
  );
  const journal = journalLines().join("\n");
  process.stdout.write(
    `  被打断的那个落成 interrupted 了吗: ${journal.includes("interrupted") ? "是" : "否"}\n`,
  );
  process.stdout.write(`\n探针目录: ${PROBE_DIR}\n`);
}
