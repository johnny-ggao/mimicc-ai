/**
 * 崩溃打断一批工具调用之后，盘上还剩什么 —— 票 01 的探针。
 *
 * Run: `bun repro/13-crash-mid-tool.ts`   （不花钱，打本地 stub）
 *
 * 票 02 从源码上查明了三件事，这里给它们做实证，并回答源码答不了的两条：
 *
 * 1. **`durability: "async"`（默认档）下，先完成的那个任务的 `putWrites` 落没落盘？**
 *    引擎不 await（`pregel/loop.js:164-172` 只把 promise 收进一个 Set），
 *    但本仓库 `JsonlSaver.putWrites` 自己是 `await appendLines(...)`
 *    （`src/checkpoint/saver.ts:222-224`）—— 所以「引擎不等」不等于「没写」。
 *    这一条直接决定「已完成的调用重启后不重跑」在真实崩溃下成不成立。
 *
 * 2. **`durability: "sync"` 真的把 intent 挡在工具之前吗？**
 *    源码上屏障在 `loop.js:475`，夹在 `_putCheckpoint`(:474) 与
 *    `_prepareNextTasks`(:487) 之间 —— 位置正好是 pi 那个 intent 提交该在的地方。
 *    没跑过。
 *
 * 3. **手工调 `checkpointer.putWrites` 写一条自己的 intent，引擎会不会被噎住？**
 *    这一条决定「在 wrapToolCall 里自己落盘」那条路线成不成立。
 *
 * 4. **一批 N 个 tool_calls 真的是 N 个独立 Pregel 任务吗？**
 *    判据不看文档看 `__pregel_task_id`：两个调用拿到不同的 id 就是两个任务。
 *
 * 5. **重启之后，已完成的那个会不会被重跑？**
 *    ⚠️ 反向断言：marker 用**追加**不用覆盖，否则「重跑了但结果一样」看不出来。
 *
 * ## 为什么是父子两个进程
 *
 * SIGKILL 不能在测试里对自己发了还指望后面的断言跑得到。所以这个脚本有两个角色，
 * 靠 `PROBE_ROLE` 区分：不带它跑的是**编排者**，它 spawn 自己当**孩子**，
 * 等孩子被自己杀掉，然后读盘。
 *
 * ## 同步点不靠手速
 *
 * `fast` 工具立即返回，`slow` 工具睡 `KILL_DELAY_MS` 再自杀 —— 这段睡眠是留给
 * `fast` 的任务 settle 并触发 `putWrites` 的窗口。marker 文件是唯一的观测面。
 */
import { mkdirSync, readFileSync, rmSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";

import { tool } from "@langchain/core/tools";
import { HumanMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { createAgent } from "langchain";
import { z } from "zod";

import { JsonlSaver } from "../src/checkpoint/saver";

const PROBE_DIR = join(import.meta.dir, "..", ".mimicc", "probe-13");
const MARKERS = join(PROBE_DIR, "markers.log");
/**
 * `slow` 自杀前睡多久 —— 留给 `fast` 的任务 settle 并触发 `putWrites` 的窗口。
 *
 * ⚠️ 这个数是承重的。600ms 下 `"async"` 档也早就把盘刷完了，所以 async 与 sync
 * **测不出差别**；要看见那条 fire-and-forget 的缝，必须让工具在检查点还没落地时就死，
 * 也就是 `KILL_DELAY_MS=0` 的那两个场景。
 */
const KILL_DELAY_MS = Number(process.env["KILL_DELAY_MS"] ?? "600");

/** 追加一行，不覆盖 —— 重跑必须看得见。 */
function mark(line: string): void {
  mkdirSync(PROBE_DIR, { recursive: true });
  appendFileSync(MARKERS, `${line}\n`);
}

function readMarkers(): string[] {
  if (!existsSync(MARKERS)) return [];
  return readFileSync(MARKERS, "utf8").split("\n").filter(Boolean);
}

// ---------------------------------------------------------------- 孩子那一侧

/** 一批两个调用：`fast` 立即回，`slow` 睡一会儿再决定要不要自杀。 */
function buildTools(options: { kill: boolean; writeIntent: boolean }) {
  const fast = tool(
    (_input, config) => {
      const taskId = (config?.configurable?.["__pregel_task_id"] as string | undefined) ?? "?";
      mark(`fast ran task=${taskId}`);
      return "fast done";
    },
    {
      name: "fast",
      description: "returns immediately",
      schema: z.object({}),
    },
  );

  const slow = tool(
    async (_input, config) => {
      const configurable = config?.configurable ?? {};
      const taskId = (configurable["__pregel_task_id"] as string | undefined) ?? "?";
      mark(`slow started task=${taskId}`);

      if (KILL_DELAY_MS > 0) {
        await new Promise((resolve) => setTimeout(resolve, KILL_DELAY_MS));
      }

      if (options.writeIntent) {
        // 问题 3：手工往 checkpointer 里塞一条自己的 intent，taskId 是合成的，
        // 不匹配任何真实任务。引擎重启后会忽略它还是被它噎住？
        const saver = configurable["__pregel_checkpointer"] as JsonlSaver | undefined;
        const checkpointMap = configurable["checkpoint_map"] as
          | Record<string, string>
          | undefined;
        const checkpointId = checkpointMap?.[""] ?? configurable["checkpoint_id"];
        mark(
          `intent saver=${saver ? "yes" : "no"} checkpoint_id=${String(checkpointId ?? "none")}`,
        );
        if (saver && typeof checkpointId === "string") {
          try {
            await saver.putWrites(
              {
                configurable: {
                  thread_id: configurable["thread_id"],
                  checkpoint_ns: configurable["checkpoint_ns"] ?? "",
                  checkpoint_id: checkpointId,
                },
              },
              [["__probe_intent__", { tool: "slow", replay: "never" }]],
              "synthetic-task-id-0000",
            );
            mark("intent written ok");
          } catch (error) {
            mark(`intent write threw ${(error as Error).message}`);
          }
        }
      }

      if (options.kill) {
        mark("slow killing self");
        process.kill(process.pid, "SIGKILL");
        await new Promise(() => {}); // 到不了
      }
      mark(`slow finished task=${taskId}`);
      return "slow done";
    },
    {
      name: "slow",
      description: "sleeps, then maybe dies",
      schema: z.object({}),
    },
  );

  return [fast, slow];
}

/** stub 模型：第一跳发两个调用，之后收工。**不用失败状态码**（见 repro/README 的警告）。 */
function startStub(): ReturnType<typeof Bun.serve> {
  let lap = 0;
  return Bun.serve({
    port: 0,
    fetch() {
      lap += 1;
      const wantsTools = lap === 1;
      return Response.json({
        id: `chatcmpl-${String(lap)}`,
        object: "chat.completion",
        created: 0,
        model: "stub",
        choices: [
          {
            index: 0,
            message: wantsTools
              ? {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    { id: "call_fast", type: "function", function: { name: "fast", arguments: "{}" } },
                    { id: "call_slow", type: "function", function: { name: "slow", arguments: "{}" } },
                  ],
                }
              : { role: "assistant", content: "done" },
            finish_reason: wantsTools ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
}

async function runChild(): Promise<void> {
  const scenario = process.env["SCENARIO"] ?? "async";
  const phase = process.env["PHASE"] ?? "crash";
  const durability = scenario.startsWith("sync") ? "sync" : "async";

  const server = startStub();
  const agent = createAgent({
    model: new ChatOpenAI({
      model: "stub",
      apiKey: "test-key",
      configuration: { baseURL: `http://localhost:${String(server.port)}` },
    }),
    tools: buildTools({
      kill: phase === "crash" && scenario !== "tasks",
      writeIntent: scenario === "intent",
    }),
    checkpointer: new JsonlSaver(PROBE_DIR),
  });

  const config = {
    configurable: { thread_id: `probe-13-${scenario}` },
    ...(durability === "sync" ? { durability: "sync" as const } : {}),
  };

  try {
    // ⚠️ 恢复必须传 `null`，不能传 `{messages: []}`。
    // 传任何 input 都会让 Pregel 走 `_first` 从 START 开一个新 superstep —— 那是新 run
    // 不是恢复，判据是 task id 会变（LangGraph 的 task id 是 uuid5，同一个检查点上是确定的）。
    // 探针第一版就栽在这里，四个场景全部误报成「重跑了」。
    await agent.invoke(phase === "crash" ? { messages: [new HumanMessage("go")] } : null, config);
    mark(`invoke returned (phase=${phase})`);
  } catch (error) {
    mark(`invoke threw ${(error as Error).message.slice(0, 120)}`);
  }
  server.stop(true);
}

// ------------------------------------------------------------ 编排者那一侧

interface FileFacts {
  lines: number;
  checkpoints: number;
  writes: number;
  hasPregelTasks: boolean;
  sendToolNames: string[];
  probeIntent: boolean;
}

function inspectThread(scenario: string): FileFacts | undefined {
  const path = join(PROBE_DIR, `probe-13-${scenario}.jsonl`);
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  let checkpoints = 0;
  let writes = 0;
  let hasPregelTasks = false;
  const sendToolNames: string[] = [];
  let probeIntent = false;

  for (const line of lines) {
    if (line.includes('"kind":"checkpoint"')) checkpoints += 1;
    if (line.includes('"kind":"writes"')) writes += 1;
    if (line.includes("__pregel_tasks")) hasPregelTasks = true;
    if (line.includes("__probe_intent__")) probeIntent = true;
    // 只认 `lg_tool_call` —— 那是 Send 的载荷，也就是 intent 的实体证据。
    // ⚠️ 不能顺手也匹配 `"name":"fast"`：AIMessage 自己的 tool_calls 也长那样，
    // 会把「模型说要调」误报成「检查点里记了要调」，两者正是这张票要分开的东西。
    for (const match of line.matchAll(/"lg_tool_call":\s*\{[^{}]*"name":\s*"(\w+)"/g)) {
      if (match[1]) sendToolNames.push(match[1]);
    }
  }
  return { lines: lines.length, checkpoints, writes, hasPregelTasks, sendToolNames, probeIntent };
}

async function spawnChild(env: Record<string, string>): Promise<number | null> {
  const proc = Bun.spawn({
    cmd: ["bun", join(import.meta.dir, "13-crash-mid-tool.ts")],
    env: { ...process.env, PROBE_ROLE: "child", ...env },
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
  return proc.signalCode === null ? proc.exitCode : null;
}

function banner(text: string): void {
  process.stdout.write(`\n=== ${text} ===\n`);
}

async function scenario(name: string, label: string, env: Record<string, string>) {
  banner(label);
  rmSync(PROBE_DIR, { recursive: true, force: true });
  const exit = await spawnChild({ SCENARIO: name, PHASE: "crash", ...env });
  const crashMarkers = readMarkers();
  const facts = inspectThread(name);

  process.stdout.write(`  子进程结束方式: ${exit === null ? "被信号杀死 (SIGKILL)" : `退出码 ${String(exit)}`}\n`);
  process.stdout.write(`  崩溃前 markers:\n`);
  for (const line of crashMarkers) process.stdout.write(`    ${line}\n`);

  if (!facts) {
    process.stdout.write("  ⚠️ 线程文件不存在 —— 一个字节都没落盘\n");
    return;
  }
  process.stdout.write(
    `  盘上: ${String(facts.lines)} 行 / checkpoint ${String(facts.checkpoints)} / writes ${String(facts.writes)}\n`,
  );
  process.stdout.write(
    `  检查点里有 __pregel_tasks: ${facts.hasPregelTasks ? "有" : "没有"}` +
      `  Send 里的工具名: [${facts.sendToolNames.join(", ") || "无"}]\n`,
  );
  if (env["SCENARIO"] === "intent" || name === "intent") {
    process.stdout.write(`  手工写的 __probe_intent__ 在盘上: ${facts.probeIntent ? "在" : "不在"}\n`);
  }

  // 重启：同一个 thread_id，不带 checkpoint_id —— 就是 repl 的调用形状。
  const before = readMarkers().length;
  const resumeExit = await spawnChild({ SCENARIO: name, PHASE: "resume", ...env });
  const after = readMarkers().slice(before);
  process.stdout.write(`  --- 重启（同 thread_id，不带 checkpoint_id）---\n`);
  process.stdout.write(`  恢复进程: ${resumeExit === null ? "被信号杀死" : `退出码 ${String(resumeExit)}`}\n`);
  for (const line of after) process.stdout.write(`    ${line}\n`);
  const fastReran = after.some((line) => line.startsWith("fast ran"));
  const slowReran = after.some((line) => line.startsWith("slow started"));
  process.stdout.write(
    `  🔑 已完成的 fast 重跑了吗: ${fastReran ? "⚠️ 重跑了" : "没有"}` +
      `   被打断的 slow 重跑了吗: ${slowReran ? "重跑了" : "没有"}\n`,
  );
}

async function taskIdScenario(): Promise<void> {
  banner("④ 一批两个调用是不是两个 Pregel 任务（不杀进程）");
  rmSync(PROBE_DIR, { recursive: true, force: true });
  const exit = await spawnChild({ SCENARIO: "tasks", PHASE: "crash" });
  const markers = readMarkers();
  for (const line of markers) process.stdout.write(`    ${line}\n`);
  const ids = markers
    .map((line) => /task=(\S+)/.exec(line)?.[1])
    .filter((id): id is string => id !== undefined && id !== "?");
  const unique = new Set(ids);
  process.stdout.write(`  退出码 ${String(exit)}\n`);
  process.stdout.write(
    `  🔑 两个调用拿到的 __pregel_task_id: ${unique.size} 个不同值 → ` +
      `${unique.size >= 2 ? "是两个独立任务" : "⚠️ 同一个任务"}\n`,
  );
}

if (process.env["PROBE_ROLE"] === "child") {
  await runChild();
} else {
  process.stdout.write("票 01 崩溃探针 —— 每个场景都是「跑到一半 SIGKILL，再用同 thread_id 重启」\n");
  await scenario("async", '① durability 默认档 "async"（睡 600ms 再死）', {});
  await scenario("sync", '② durability: "sync"（睡 600ms 再死）', {});
  await scenario("intent", "③ 手工写一条 intent 再崩溃", {});
  await taskIdScenario();
  process.stdout.write(
    "\n──— 以下两个场景 KILL_DELAY_MS=0：工具第一行就自杀，" +
      "这才是 async 与 sync 唯一分得开的地方 ———\n",
  );
  await scenario("async0", '⑤ "async" + 零延迟自杀', { KILL_DELAY_MS: "0" });
  await scenario("sync0", '⑥ "sync" + 零延迟自杀', { KILL_DELAY_MS: "0" });
  process.stdout.write(`\n探针目录: ${PROBE_DIR}\n`);
}
