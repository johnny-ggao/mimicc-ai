/**
 * 门**还开着**的时候进程被杀掉，重启之后那道门还在不在？
 *
 * Run: `bun repro/18-resume-at-an-open-gate.ts`   （不花钱，打本地 stub）
 *
 * `repro/14` 崩的是**门批准之后**——工具已经开跑，问的是「跑完的会不会再跑一次」。
 * 这个探针崩在**一个决定都还没做**的时候：模型要了一次 `Bash`，门停下来问人，人还没
 * 回答，进程就没了。重启之后，那个「等着被回答的问题」是**盘上的状态**，还是**只活在
 * 上一个进程的内存里**？
 *
 * 这道题不是终端 UX：控制台的 `pending` 只活在内存里（`src/console/repl.ts`），所以
 * 「列出历史 session 并续聊」这件事到底是「把消息喂回去」还是「把循环状态接回来」，
 * 完全取决于这里的答案。
 *
 * ## 三条恢复路径，各跑一遍
 *
 * 崩溃只跑一次，然后把崩溃后的 session 文件复制三份，每条路径在自己的目录里冷启动：
 *
 * - `null`     —— `repro/14` 用的那条（它的注释：传任何 input 都会从 START 开新 run）
 * - `message`  —— **今天的 REPL 会做的事**：拿旧 id 起来，用户直接敲一句话
 * - `command`  —— 像用户回答那道门一样：`Command({ resume: { decisions: […] } })`
 *
 * ## 观测面
 *
 * 一个 marker 文件，**追加**，每行带标签（`repro/14` 的同一个理由：覆盖语义下重跑看不见）。
 * 崩溃时那次调用的命令是 `echo gate >> marker`，**命令串是崩溃前就烧进检查点的**——
 * 所以 marker 里出现 `gate` 一行，证明的是**那个悬着的调用**跑了；出现 `resume-*` 一行，
 * 证明的是**一个新调用**跑了。两者分得开，这是这个探针唯一需要的分辨力。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { HumanMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";

import { createUniversalAgent, DURABILITY, RECURSION_LIMIT } from "../src/agents";
import { JsonlSaver } from "../src/checkpoint";

const PROBE_DIR = join(import.meta.dir, "..", ".mimicc", "probe-18");
const CRASH_DIR = join(PROBE_DIR, "crashed");
const MARKER = join(PROBE_DIR, "marker.log");
const THREAD = "probe-18";
const CASES = ["null", "message", "command"] as const;

// ---------------------------------------------------------------- 孩子那一侧

/** 每次请求要一次 Bash，命令串带标签，所以 marker 里分得出是谁跑的。 */
function startStub(tag: string): ReturnType<typeof Bun.serve> {
  let replies = 0;
  return Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { messages: { role: string }[] };
      const answered = body.messages.some((message) => message.role === "tool");
      replies += 1;

      return Response.json({
        id: `chatcmpl-${tag}-${String(replies)}`,
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
                      id: `call_${tag}_${String(replies)}`,
                      type: "function",
                      function: {
                        name: "Bash",
                        arguments: JSON.stringify({
                          command: `echo ${tag} >> ${MARKER}`,
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
  const directory = process.env["CASE_DIR"] ?? CRASH_DIR;
  // 崩溃那一跑用 `gate` 当标签：这四个字母会被烧进检查点里的命令串。
  const server = startStub(phase === "crash" ? "gate" : `resume-${phase}`);
  const agent = createUniversalAgent({
    baseURL: `http://localhost:${String(server.port)}`,
    apiKey: "sk-stub",
    model: "stub",
    checkpointer: new JsonlSaver(directory),
    stateDir: directory,
  });
  const config = {
    recursionLimit: RECURSION_LIMIT,
    // 出货用的档位。`"async"` 下检查点可能还没落盘（repro/13），那样测的就不是这道题了。
    durability: DURABILITY,
    configurable: { thread_id: THREAD },
  };

  if (phase === "crash") {
    const state = await agent.invoke({ messages: [new HumanMessage("go")] }, config);
    const stopped = (state as { __interrupt__?: unknown[] }).__interrupt__;
    process.stdout.write(`    门停下来了吗: ${stopped === undefined ? "否" : "是"}\n`);
    // 一个决定都不做，直接死。这是「门开着的时候断电」。
    process.kill(process.pid, "SIGKILL");
    return;
  }

  // ——— 冷启动之后，先问盘上还剩什么，再动手 ———
  const snapshot = await agent.getState(config);
  const tasks = snapshot.tasks ?? [];
  const waiting = tasks.flatMap((task) => task.interrupts ?? []);
  process.stdout.write(
    `    getState: next=${JSON.stringify(snapshot.next)}` +
      ` tasks=${String(tasks.length)} interrupts=${String(waiting.length)}\n`,
  );
  if (waiting.length > 0) {
    process.stdout.write(`    等着的那个: ${JSON.stringify(waiting[0]).slice(0, 220)}\n`);
  }

  const input =
    phase === "null"
      ? null
      : phase === "message"
        ? { messages: [new HumanMessage("接着聊")] }
        : new Command({ resume: { decisions: [{ type: "approve" }] } });

  try {
    const after = (await agent.invoke(input, config)) as {
      messages?: { getType(): string }[];
      __interrupt__?: unknown[];
    };
    const kinds = (after.messages ?? []).map((message) => message.getType()).join(",");
    process.stdout.write(
      `    invoke 回来了: 又停在门上=${after.__interrupt__ === undefined ? "否" : "是"}` +
        ` 消息=[${kinds}]\n`,
    );
  } catch (error) {
    process.stdout.write(`    抛了：${String(error).slice(0, 160)}\n`);
  }
  server.stop(true);
}

// ------------------------------------------------------------ 编排者那一侧

async function spawnChild(phase: string, caseDir?: string): Promise<number | null> {
  const proc = Bun.spawn({
    cmd: ["bun", join(import.meta.dir, "18-resume-at-an-open-gate.ts")],
    env: {
      ...process.env,
      PROBE_ROLE: "child",
      PHASE: phase,
      ...(caseDir !== undefined ? { CASE_DIR: caseDir } : {}),
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
  return proc.signalCode === null ? proc.exitCode : null;
}

function markerLines(): string[] {
  if (!existsSync(MARKER)) return [];
  return readFileSync(MARKER, "utf8").split("\n").filter(Boolean);
}

if (process.env["PROBE_ROLE"] === "child") {
  await runChild();
} else {
  rmSync(PROBE_DIR, { recursive: true, force: true });
  mkdirSync(CRASH_DIR, { recursive: true });

  process.stdout.write("一次 Bash 调用，门停下来问人，人还没回答就 SIGKILL\n\n");
  process.stdout.write("=== ① 门开着的时候崩溃 ===\n");
  const crashed = await spawnChild("crash");
  process.stdout.write(
    `  子进程结束方式: ${crashed === null ? "被信号杀死 (SIGKILL)" : `⚠️ 退出码 ${String(crashed)} —— 探针失效`}\n`,
  );
  process.stdout.write(`  marker 行数: ${String(markerLines().length)}（应为 0：门还没放行）\n`);

  for (const name of CASES) {
    const caseDir = join(PROBE_DIR, `case-${name}`);
    // 每条路径拿一份崩溃现场的干净拷贝，冷启动，互不污染。
    cpSync(CRASH_DIR, caseDir, { recursive: true });
    const before = markerLines().length;

    process.stdout.write(`\n=== ② 同 id 冷启动 —— 恢复方式：${name} ===\n`);
    const code = await spawnChild(name, caseDir);
    process.stdout.write(
      `  进程: ${code === null ? "被信号杀死" : `退出码 ${String(code)}`}\n`,
    );
    const fresh = markerLines().slice(before);
    process.stdout.write(
      `  新增 marker 行: ${fresh.length === 0 ? "（无）" : fresh.join(" / ")}\n`,
    );
    process.stdout.write(
      `  🔑 悬着的那个调用跑了吗: ${fresh.includes("gate") ? "跑了" : "没跑"}\n`,
    );
  }

  process.stdout.write(`\n探针目录: ${PROBE_DIR}\n`);
}
