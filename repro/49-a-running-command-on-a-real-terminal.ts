/**
 * 一条正在跑的命令，在**真终端**上印成了什么？
 *
 * Run: `bun repro/49-a-running-command-on-a-real-terminal.ts`  （不花钱，连模型都没有）
 *
 * ## 为什么问这一问
 *
 * 票 07 定了：`Bash` 默认不设超时这件事，pi 敢做是因为**人看得见**——它流式吐输出，
 * 用户按 Esc 就中断。我们两条腿只有一条：中断有（C3 之后），**可见没有**。
 * `runCommand` 把输出攒在数组里，命令跑的整段时间**屏幕上什么都没有**，
 * 于是「沉默 30 秒」和「挂死 30 秒」长得一模一样。
 *
 * 这个探针量的是补上那条腿之后**屏幕上真正剩下什么**。
 *
 * ## 为什么用假图
 *
 * 要测的是**控制台**，不是命令。假图能精确造出要看的那几拍：思考块还开着的时候
 * 工具跳了、心跳一拍一拍到、结果落地。真 agent 上这要靠运气和真等几十秒。
 * ⚠️ 出货的判定照调不抄：心跳走 `["custom", payload]`，正是
 * `src/tools/mutating.ts` 的 `dispatchCustomEvent(COMMAND_TICK_EVENT, …)`
 * 在图上呈现的形状。
 *
 * ## 为什么要 pty
 *
 * 同 `repro/30`：状态行本身就是 TTY 才有的东西（`isTTY` 为假时它一个字都不画），
 * 而「擦干净了没有」只有把 `\r` 与 `\x1b[2K` 真的执行一遍才答得上来。
 * ⚠️ 这个 pty 报 0 列，所以走的是 `UNKNOWN_WIDTH` 回退路径——和 `repro/30` 一样。
 *
 * ## 结果（2026-08-28）
 *
 * ```
 * 重画次数 6，其中心跳 5
 *   │ npm test -- --runInBand · 1s · 0.0 KB
 *   │ npm test -- --runInBand · 2s · 0.0 KB
 *   │ npm test -- --runInBand · 3s · 0.0 KB
 *   │ npm test -- --runInBand · 4s · 2.0 KB
 *   │ npm test -- --runInBand · 5s · 9.0 KB
 *   心跳画出来了 ✅ ／ 0 字节那几拍看得出还活着 ✅ ／ 字节数会涨 ✅
 *   结果落地后不留痕 ✅ ／ 正文完整 ✅
 * ```
 *
 * 🔑 **前三拍 `0.0 KB` 就是这条腿的全部意义**：一条挂死的命令在屏幕上不再是空白，
 * 而是「还活着、但一个字都没吐」——人看得见，于是人能按下中断。
 */
import { AIMessage, AIMessageChunk, ToolMessage } from "@langchain/core/messages";

import type { AgentGraph } from "../src/agents";
import { runRepl } from "../src/console/repl";

const MAIN = "model_request:main";
const COMMAND = "npm test -- --runInBand";

const think = (text: string): [string, unknown] => [
  "messages",
  [
    new AIMessageChunk({ content: "", additional_kwargs: { reasoning_content: text } }),
    { checkpoint_ns: MAIN },
  ],
];

/** 心跳。前三拍 0 字节——**这正是挂死的样子**，也是这条腿要照出来的东西。 */
const tick = (elapsedMs: number, bytes: number): [string, unknown] => [
  "custom",
  { command: COMMAND, elapsedMs, bytes },
];

function fakeGraph(): AgentGraph {
  return {
    getState() {
      throw new Error("fakeGraph.getState should not be reached in this probe");
    },
    stream() {
      process.stdout.write(`\n[[COLUMNS]] ${String(process.stdout.columns ?? 0)}\n`);

      async function* stream(): AsyncGenerator<[string, unknown]> {
        yield think("先把测试跑一遍。");

        const call = new AIMessage({
          content: "",
          tool_calls: [{ id: "c1", name: "Bash", args: { command: COMMAND } }],
        });
        yield ["values", { messages: [call] }];

        // 一拍一拍地跑。0 字节的那几拍是重点：屏幕上要看得出「还活着，但没吐东西」。
        yield tick(1000, 0);
        yield tick(2000, 0);
        yield tick(3000, 0);
        yield tick(4000, 2048);
        yield tick(5000, 9216);

        yield [
          "values",
          {
            messages: [
              call,
              new ToolMessage({ content: "3 passed", tool_call_id: "c1", name: "Bash" }),
            ],
          },
        ];

        yield [
          "messages",
          [new AIMessageChunk({ content: "测试过了。" }), { checkpoint_ns: MAIN }],
        ];
      }

      return Promise.resolve(stream());
    },
  };
}

if (process.argv.includes("--child")) {
  await runRepl({
    graph: fakeGraph(),
    skills: { all: () => [] } as unknown as Parameters<typeof runRepl>[0]["skills"],
    stateDir: "/nonexistent-probe-49",
    start: { kind: "new" },
  });
  process.exit(0);
}

// ---------------------------------------------------------------- 父进程那一侧

const proc = Bun.spawn({
  cmd: [
    "expect",
    "-c",
    "set timeout 30",
    "-c",
    `spawn bun ${import.meta.path} --child`,
    "-c",
    "expect -ex {type a message}",
    "-c",
    'send "跑一下测试\r"',
    "-c",
    "expect -ex {passed}",
    "-c",
    'send "/exit\r"',
    "-c",
    "expect eof",
  ],
  stdout: "pipe",
  stderr: "inherit",
  // 关颜色让输出可判读。⚠️ 这**不会**关掉状态行——重画要的是 `isTTY`。
  env: { ...process.env, NO_COLOR: "1" },
});

let output = "";
for await (const part of proc.stdout) output += new TextDecoder().decode(part);
await proc.exited;

// ---------------------------------------------------------------- 判读

/** 开机横幅之后的那一段——横幅里也有 `·`，拿整份输出数会数错（`repro/30` 踩过）。 */
const body = output.slice(output.indexOf("[[COLUMNS]]"));

/** 每一次重画，以及它画上去的可见内容。 */
const paints = [...body.matchAll(/\r\x1b\[2K([^\r\n\x1b]*)/g)]
  .map((m) => m[1] ?? "")
  .filter((one) => one !== "");

const heartbeats = paints.filter((one) => one.includes("KB"));

process.stdout.write("\n──────── 判读 ────────\n");
process.stdout.write(`重画次数 ${String(paints.length)}，其中心跳 ${String(heartbeats.length)}\n\n`);
process.stdout.write("心跳每一拍在屏幕上的样子：\n");
for (const one of heartbeats) process.stdout.write(`  │ ${one}\n`);

/** 结果落地之后，那一行还在不在。 */
const afterResult = body.slice(body.lastIndexOf("3 passed"));
const leftover = /\d+s · \d+\.\d KB/.test(afterResult);

process.stdout.write(
  `\n  心跳画出来了            ${heartbeats.length >= 5 ? "✅" : "🔴"}\n` +
    `  0 字节那几拍看得出还活着  ${heartbeats.some((one) => one.includes("0.0 KB")) ? "✅" : "🔴"}\n` +
    `  字节数会涨              ${heartbeats.some((one) => one.includes("9.0 KB")) ? "✅" : "🔴"}\n` +
    `  结果落地后不留痕        ${leftover ? "🔴 还留着" : "✅"}\n` +
    `  正文完整                ${body.includes("测试过了") ? "✅" : "🔴"}\n`,
);
