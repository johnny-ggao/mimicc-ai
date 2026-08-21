/**
 * 那一行思考，在**真终端**上到底印成了什么？
 *
 * Run: `bun repro/30-the-thinking-row-on-a-real-terminal.ts`   （不花钱，连模型都没有）
 *
 * 票 05 落地时留了一条没核过的：**状态行与子 agent 的点共用「活着的区域」**。
 * 代码里已经处理了（点也走 `settleThinking()`），注释里写着理由——
 * *不能靠「子 agent 只在工具调用里跑、那时主模型不在流」推掉，块要到 values 事件才关*。
 * **但那是推理，不是实测。** 这个探针把它变成量出来的。
 *
 * 顺带兑现票 03 定的验收：**灰字永久行数 = 段数**。
 * ⚠️ 这条**只有在真终端上量才算数**：活着那一行是被 `\x1b[2K` 擦掉的，
 * 「擦干净了没有」正是要问的东西，而单元测试问不了它——它测的是写出去的字节，
 * 不是终端收下之后剩下什么。
 *
 * ## 为什么用假图
 *
 * 要测的是**控制台**，不是循环。假图能精确造出那个竞态：
 * **思考块还开着的时候，子 agent 的 chunk 到了**（中间没有 values 事件）。
 * 真 agent 上这要靠运气，假图上是三行代码。
 * ⚠️ 出货的两个判定**照调不抄**：`fromModel` 只看类型，`fromSubagent` 只看
 * `checkpoint_ns` 里有没有 `|`（`src/console/repl.ts:1113,1132`）——
 * 假图按那个形状发，走的就是同一条路。
 *
 * ## 为什么要 pty
 *
 * `runRepl` 在管道下明确走另一条分支，而**状态行本身就是 TTY 才有的东西**
 * （`isTTY` 为假时它一个字都不画）。管道上量到的是「管道那一侧的契约」，
 * 不是用户看见的。`expect` 自己开 pty——同 `repro/15`，理由也一样：
 * `script -q /dev/null` 要求自己的 stdin 是 tty，而我们只给得出管道。
 */
import { AIMessage, AIMessageChunk, ToolMessage } from "@langchain/core/messages";

import type { AgentGraph } from "../src/agents";
import { runRepl } from "../src/console/repl";

/** 埋在思考块**中间**的记号——它不是任何一句的结尾，所以永远不该出现在屏幕上。 */
const BURIED = "«BURIED»";

/** 子 agent 的点被节流到一秒一个，所以块之间要跨过这个门槛才数得出第二个点。 */
const DOT_MS = 1100;

/** 读不到宽度时出货代码用的回退值（`src/console/reasoning.ts` 的 `UNKNOWN_WIDTH`）。 */
const FALLBACK_WIDTH = 80;

// ---------------------------------------------------------------- 孩子那一侧

const chunk = (reasoning: string, namespace: string): [string, unknown] => [
  "messages",
  [
    new AIMessageChunk({ content: "", additional_kwargs: { reasoning_content: reasoning } }),
    { checkpoint_ns: namespace },
  ],
];

const prose = (text: string): [string, unknown] => [
  "messages",
  [new AIMessageChunk({ content: text }), { checkpoint_ns: "model_request:main" }],
];

/** 主 agent 与子 agent 的区别只有一个：命名空间里有没有 `|`。 */
const MAIN = "model_request:main";
const SUB = "tools:abc|model_request:sub";

function fakeGraph(): AgentGraph {
  return {
    getState() {
      throw new Error("fakeGraph.getState should not be reached in this probe");
    },
    stream() {
      process.stdout.write(`\n[[COLUMNS]] ${String(process.stdout.columns ?? 0)}\n`);

      async function* stream(): AsyncGenerator<[string, unknown]> {
        // ── 第一段思考。三个 chunk，中间那个埋了记号。
        yield chunk("先看看这个文件。", MAIN);
        yield chunk(`${BURIED}还要再想想别的可能。`, MAIN);
        yield chunk("决定了，先读 package.json。", MAIN);

        // 🔑 **要害在这里**：块**还开着**，子 agent 的 chunk 就到了。
        // 中间**没有** values 事件——这正是「靠位置推不掉」的那个竞态。
        yield [
          "messages",
          [new AIMessageChunk({ content: "子 agent 在写字" }), { checkpoint_ns: SUB }],
        ];
        await Bun.sleep(DOT_MS);
        yield [
          "messages",
          [new AIMessageChunk({ content: "还在写" }), { checkpoint_ns: SUB }],
        ];

        // 工具那一跳的结构行。
        const call = new AIMessage({
          content: "",
          tool_calls: [{ id: "c1", name: "Read", args: { path: "package.json" } }],
        });
        yield ["values", { messages: [call] }];
        yield [
          "values",
          {
            messages: [
              call,
              new ToolMessage({ content: "1\t{\n2\t}", tool_call_id: "c1", name: "Read" }),
            ],
          },
        ];

        // ── 第二段思考，然后正文。
        yield chunk("读到了。", MAIN);
        yield chunk(`${BURIED}可以回答了。`, MAIN);
        yield prose("这是回复正文，它一个字都不该少。");
      }

      return Promise.resolve(stream());
    },
  };
}

if (process.argv.includes("--child")) {
  await runRepl({
    graph: fakeGraph(),
    skills: { all: () => [] } as unknown as Parameters<typeof runRepl>[0]["skills"],
    stateDir: "/nonexistent-probe-30",
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
    // ⚠️ **这个 pty 报 0 列，试过 expect 的 `stty` 也改不动它**（实测：孩子仍然读到 0）。
    // 那本身是个真发现——出货代码里的 `process.stdout.columns ?? 80` 接不住 0，
    // 整行会塌成一个省略号。已修（`src/console/reasoning.ts` 的 `UNKNOWN_WIDTH`），
    // 并在 `tests/reasoning.test.ts` 钉住。
    // **所以这一跑走的是回退路径**，而这正好是该在真 pty 上守的那条：
    // 宽度算术交给单元测试，这里守的是「读不到宽度时不会塌」。
    "-c",
    "expect -ex {type a message}",
    "-c",
    'send "问一句\r"',
    "-c",
    "expect -ex {这是回复正文}",
    "-c",
    'send "/exit\r"',
    "-c",
    "expect eof",
  ],
  stdout: "pipe",
  stderr: "inherit",
  // 同 `repro/15`：关掉颜色让输出可判读。⚠️ 这**不会**关掉状态行——
  // 重画要的是 `isTTY`，dim 要的是 `stylingEnabled()`，票 05 特意把这两个开关分开了。
  env: { ...process.env, NO_COLOR: "1" },
});

let output = "";
for await (const part of proc.stdout) output += new TextDecoder().decode(part);
await proc.exited;

// ---------------------------------------------------------------- 判读

const columns = Number.parseInt(/\[\[COLUMNS\]\] (\d+)/.exec(output)?.[1] ?? "0", 10);

/**
 * 开机横幅之后的那一段——判读只看这里。
 *
 * ⚠️ 横幅里全是 `·`（`tools  Read · Write · Edit · …`），拿整份输出数点会数出八个。
 * 第一版就是这么误报的：判据说「点落进了状态行」，而实际上点好好地在痕迹行之后。
 * **观测面切错，比没有观测面更糟——它会给你一个自信的错答案。**
 */
const body = output.slice(output.indexOf("[[COLUMNS]]"));

/**
 * 终端最终显示的东西——把 `\r` 与 `\x1b[2K` 真的执行一遍。
 *
 * 🔑 **这才是这个探针存在的理由。** 直接 grep 原始字节回答不了「屏幕上剩下什么」：
 * 被擦掉的那些字节**仍然在流里**。第一版就是这么误报的——判据说「原文出现在屏幕上」，
 * 而它其实是一次早已被擦掉的重画。
 *
 * 规则只有两条，正是这条线用到的那两条：`\r` 回到行首，`\x1b[2K` 清掉整行。
 */
const applyRow = (line: string): string => {
  let row = "";
  for (const part of line.split("\r")) {
    if (part.startsWith("\x1b[2K")) row = part.slice("\x1b[2K".length);
    else row += part;
  }
  return row;
};

/** 每一次重画，以及它画上去的可见内容。 */
const paints = [...body.matchAll(/\r\x1b\[2K([^\r\n\x1b]*)/g)].map((m) => m[1] ?? "");
const painted = paints.filter((one) => one !== "");

const traces = [...body.matchAll(/· 思考 (\d+) 字/g)].map((m) => Number(m[1]));
const calls = [...body.matchAll(/· (Read|Task)\b/g)].length;
/**
 * 子 agent 的那串点。
 *
 * 认的是**整段只有点**的那种 dim 段（`repl.ts` 的 `openDim()` + `·` + `RESET`）——
 * 痕迹行与结构行也以 `· ` 开头，但它们后面还有字，所以正则要求 `·+` 之后直接收尾。
 */
const dotRuns = [...body.matchAll(/\x1b\[2m(·+)\x1b\[0m/g)].map((m) => m[1] ?? "");
const dots = dotRuns.reduce((sum, run) => sum + run.length, 0);

/** 屏幕列宽，CJK 两列——与 `src/console/reasoning.ts` 同一套算法。 */
const columnsOf = (text: string): number => {
  let total = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    total +=
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)
        ? 2
        : 1;
  }
  return total;
};

const widest = painted.reduce((max, one) => Math.max(max, columnsOf(one)), 0);

/** 屏幕上剩下的东西。判据 ①③⑤ 全部只看它。 */
const screen = body.split("\n").map(applyRow).join("\n");
const effective = columns > 0 ? columns : FALLBACK_WIDTH;

/**
 * 点有没有落进状态行。
 *
 * 判据是**顺序**不是数量：接线的规矩是「任何其它输出之前先收口」，所以第一个点
 * 必须出现在**第一条痕迹行之后**。反过来就说明点被写进了还开着的那一行——
 * 而那一行随后会被擦掉，**点会无声消失**。
 */
const firstTrace = body.indexOf("· 思考");
const firstDot = body.search(/\x1b\[2m·+\x1b\[0m/);
const firstDotAfterTrace = firstTrace >= 0 && firstDot >= 0 && firstDot > firstTrace;

const out = (line: string) => process.stdout.write(`${line}\n`);

out(
  `pty 报的宽度 ${String(columns)} 列${columns > 0 ? "" : "（这个 pty 不报窗口大小，走回退）"} → 实际预算 ${String(effective)} 列`,
);
out("");
out("=== 判据 ①：灰字永久行数 = 段数（票 03 的验收）===");
out(`  痕迹行 ${String(traces.length)} 条：${traces.map((n) => `思考 ${String(n)} 字`).join(" · ")}`);
out(`  ${traces.length === 2 ? "✅" : "🔴"} 两段思考 → ${String(traces.length)} 行灰字`);

out("");
out("=== 判据 ②：活着那一行真的被用了，而且没超宽 ===");
out(`  重画 ${String(paints.length)} 次，最宽一次 ${String(widest)} 列`);
out(`  ${paints.length > 0 ? "✅" : "🔴"} 在真终端上确实重画了（管道上这里会是 0）`);
out(
  `  ${widest > 1 ? "✅" : "🔴"} 没有塌成一个省略号（塌了就说明宽度没读到——那正是本探针抓到的那个 bug）`,
);
out(
  `  ${widest > 0 && widest < effective ? "✅" : "🔴"} 最宽的一次窄于 ${String(effective)} 列——没有软换行，所以擦得干净`,
);
if (painted.length > 0) out(`  最后一次画的是：${painted[painted.length - 1] ?? ""}`);

out("");
out("=== 判据 ③：擦干净了吗（把 \\r 与 \\x1b[2K 真的执行一遍之后）===");
out(
  `  ${screen.includes(BURIED) ? "🔴 思考原文留在了屏幕上" : "✅ 屏幕上没有思考原文——重画全被擦干净了"}`,
);

out("");
out("=== 判据 ④：子 agent 的点与状态行（票 05 留下的那条没核过的）===");
out(`  点 ${String(dots)} 个 · 结构行 ${String(calls)} 条`);
out(`  ${dots > 0 ? "✅" : "🔴"} 点没有被状态行吃掉`);
out(
  `  ${firstDotAfterTrace ? "✅" : "🔴"} 第一个点出现在第一条痕迹行之后——点到达时那一行已经收口`,
);

out("");
out("=== 判据 ⑤：正文一行不许少 ===");
out(
  `  ${screen.includes("这是回复正文，它一个字都不该少。") ? "✅ 正文完整" : "🔴 正文被动过"}`,
);
