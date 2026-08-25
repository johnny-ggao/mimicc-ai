/**
 * 同一条要求，写进「自动检查」那一步 vs 只写在「风格要求」里，遵守率会变吗？
 * —— 票 02（[`.scratch/deterministic-gate/`](../.scratch/deterministic-gate/map.md)）
 *
 * 运行：`bun repro/39-does-the-check-slot-matter.ts`
 * ⚠️ **这个探针花钱**：真模型、真工具、真循环，两臂各 3 次。量与 `repro/38` 同级。
 *
 * ## 它检验的是文章的核心主张
 *
 * `repro/38` 测的是**有检查项**的要求（亮点 >= 2），结论是「模型停下来问」。
 * 但那条检查非常显眼，而报告 §04 指出的那条根本没测：
 * `AGENTS.md` 的风格要求里写着*「避免"扎实推进""锐意进取"等套话」*，
 * 而三个检查项**没有一条测它**。
 *
 * 所以这一发问的是更硬的一个问题：
 *
 *   **把同一条要求从「风格要求」挪进「自动检查」那一步，遵守率会变吗？**
 *
 *   会变 -> 「反馈控制」这个槽位有机械效力，即使它只是文本。徐昊那条「缺一不可」成立。
 *   不变 -> 写成「检查」的文本只是**更多的前馈**；`repro/38` 的结果就要重新解读。
 *
 * **这是唯一一个能把两种解读分开的实验。**
 *
 * ## 一个变量，两个臂
 *
 *   BASE     `AGENTS.md` 原样        —— 套话只出现在「风格要求」里
 *   CHECKED  第 4 步加一句「是否有套话？」
 *
 * 输入两臂完全相同，且**三件事都带数据**——否则会触发「亮点必须有数据」那条，
 * 把结论搅浑。唯一处在压力下的要求就是「避免套话」。
 *
 * ## 臂内自带对照：点名的 vs 没点名的
 *
 * `AGENTS.md` 逐字点名了「扎实推进」「锐意进取」。所以输入里两类都放：
 *
 *   被点名   扎实推进、锐意进取                        -> 字符串匹配就够
 *   没点名   赋能、抓手、闭环、深耕、堵点、方法论、组合拳 -> 要理解「套话」这个类别
 *
 * **这是这个探针最锋利的地方**：删掉「扎实推进」却留着「赋能」，
 * 说明它做的是字符串匹配而不是类别判断——而 `AGENTS.md` 写的是「**等**套话」。
 *
 * ## 空结果的风险，先说在前面
 *
 * 两臂都干净是很有可能的结果——`AGENTS.md` 把两个词逐字列了出来，提示极强。
 * **空结果也是结果**（说明这条软要求光靠前馈就够），
 * **但那样的话这个探针没能把两种解读分开**，不许把它说成支持任何一边。
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PROBE_DIR = join(import.meta.dir, "..", ".mimicc", "probe-39");
const REPORTS = join(PROBE_DIR, "reports");

const OPEN = "<<<PROBE39";
const CLOSE = "PROBE39>>>";

/**
 * 01 讲那份 `AGENTS.md` 的第 4 步。**两个臂的唯一差别就是这一行。**
 *
 * `repro/38` 立过「一个字不改」的规矩；这一票要改，**因为改它就是实验本身**。
 * 除这一行外其余逐字不动。
 */
const STEP_4 = {
  BASE: "4. **自动检查**：是否有至少 2 个亮点？亮点是否有数据？阻塞项是否有责任人？",
  CHECKED:
    "4. **自动检查**：是否有至少 2 个亮点？亮点是否有数据？阻塞项是否有责任人？是否有套话？",
} as const;

type ArmName = keyof typeof STEP_4;
const ARMS: ArmName[] = ["BASE", "CHECKED"];
const RUNS = 3;

function agentsMd(arm: ArmName): string {
  return `## 周报编写

### 项目结构
reports/ <- 存放所有历史周报，按周归档
├── 2026-W01.md <- 第 1 周周报
├── 2026-W02.md <- 第 2 周周报
└── ...

### 工作流程
1. 用户提供本周的工作要点
2. **阅读 reports/ 目录下最近 8 周的周报**，了解进展和风格
3. 按结构生成周报
${STEP_4[arm]}
5. 以 Markdown 表格输出并存入 reports/ 目录，按周命名
6. 如果没有之前的周报，则需要用户给出大致的项目背景和说明

### 结构
1. 本周亮点（列出 2-3 个具体的成果，每个附带数据）
2. 完成事项（列表，每行一个事项）
3. 阻塞项（如有，注明责任人和原因）
4. 下周计划（列表）

### 风格要求
- 使用客观陈述语气，避免"扎实推进""锐意进取"等套话
- 每个亮点必须有具体结果：什么、效果、数据
`;
}

/**
 * 预置的历史。同 `repro/38`：只为关掉第 6 步那条分支。
 *
 * ⚠️ **历史本身必须是干净的**——一份带套话的历史会变成第二条前馈
 * （工作流程第 2 步逐字要求「了解进展和**风格**」），那就不是一个变量了。
 */
const HISTORY: Record<string, string> = {
  "2026-W32.md": `# 2026-W32 周报

## 本周亮点
- 搜索接口 P99 从 820ms 降到 310ms，压测 QPS 提升 2.1 倍
- 支付回调重试机制上线，失败订单积压从 47 单降到 3 单

## 完成事项
- 搜索接口加二级缓存
- 支付回调重试
- 修复优惠券叠加计算错误

## 阻塞项
- 风控接口限流阈值待确认（负责人：李工，等风控团队回复）

## 下周计划
- 商品详情页接口合并
- 补搜索链路的监控埋点
`,
  "2026-W33.md": `# 2026-W33 周报

## 本周亮点
- 商品详情页接口从 6 个合并为 1 个，首屏请求数下降 83%
- 搜索链路监控埋点补齐，故障定位平均耗时从 25 分钟降到 6 分钟

## 完成事项
- 商品详情页接口合并
- 搜索链路埋点
- 清理三个废弃的定时任务

## 阻塞项
- 无

## 下周计划
- 用户反馈功能上线
- 跟进风控限流阈值
`,
};

/**
 * 两臂共用的输入：三件事都带数据，**通篇套话**。
 *
 * 数据齐全是刻意的——「亮点 >= 2」「亮点有数据」两条都能满足，
 * 于是唯一处在压力下的就是「避免套话」。
 */
const INPUT =
  "本周工作要点：" +
  "1) 扎实推进订单导出性能攻坚，打通链路堵点，导出 10 万行从超时失败变为 42 秒完成；" +
  "2) 锐意进取深耕消息推送体系，重构重试队列形成效率闭环，到达率从 71% 提升到 94%；" +
  "3) 以权限模块为抓手，沉淀可复用的方法论，打出重构组合拳为后续迭代赋能，" +
  "权限判定代码从 1200 行减到 380 行。";

/** `AGENTS.md` 里逐字点名的两个。**字符串匹配就够。** */
const NAMED = ["扎实推进", "锐意进取"];
/** 没点名的。**要理解「套话」这个类别才删得掉。** */
const UNNAMED = ["赋能", "抓手", "闭环", "深耕", "堵点", "方法论", "组合拳", "攻坚", "沉淀"];

interface Payload {
  calls: string[];
  finalText: string;
  input: number;
  output: number;
  error?: string;
}

// ------------------------------------------------------------------ 子进程侧

async function runChild(): Promise<void> {
  // 这些 import 在子进程里跑，而它的 cwd 已经是 PROBE_DIR —— `workspace.ts` 的
  // ROOT 在 import 时固化（`src/tools/workspace.ts:2`），所以顺序是有意义的。
  const { HumanMessage } = await import("@langchain/core/messages");
  const { buildSystemPrompt, createUniversalAgent, RECURSION_LIMIT } = await import(
    "../src/agents"
  );
  const { JsonlSaver } = await import("../src/checkpoint");
  const { loadConfig } = await import("../src/config");
  const { OUTPUT_BUDGET, resolveModelConfig } = await import("../src/models");

  const arm = (process.env["ARM"] ?? "BASE") as ArmName;
  const run = process.env["RUN"] ?? "1";
  const model = resolveModelConfig(loadConfig());
  const stateDir = join(process.cwd(), ".state");

  const payload: Payload = { calls: [], finalText: "", input: 0, output: 0 };

  try {
    const agent = createUniversalAgent({
      baseURL: model.baseURL,
      apiKey: model.apiKey,
      model: model.model,
      ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
      outputBudget: model.maxTokens ?? OUTPUT_BUDGET,
      window: { limit: model.windowLimit },
      systemPrompt: buildSystemPrompt({ cwd: process.cwd(), date: "2026-08-25" }),
      projectInstructions: agentsMd(arm),
      checkpointer: new JsonlSaver(stateDir),
      stateDir,
      auto: true,
    });

    const result = await agent.invoke(
      { messages: [new HumanMessage(INPUT)] },
      {
        recursionLimit: RECURSION_LIMIT,
        configurable: { thread_id: `probe-39-${arm}-${run}` },
      },
    );

    type AiLike = {
      getType(): string;
      content: unknown;
      tool_calls?: { name: string }[];
      usage_metadata?: { input_tokens?: number; output_tokens?: number };
    };
    for (const message of result.messages as AiLike[]) {
      if (message.getType() !== "ai") continue;
      for (const call of message.tool_calls ?? []) payload.calls.push(call.name);
      if (typeof message.content === "string" && message.content.trim() !== "") {
        payload.finalText = message.content;
      }
      payload.input += message.usage_metadata?.input_tokens ?? 0;
      payload.output += message.usage_metadata?.output_tokens ?? 0;
    }
  } catch (error) {
    payload.error = String(error).slice(0, 300);
  }

  process.stdout.write(`${OPEN}${JSON.stringify(payload)}${CLOSE}`);
}

// ------------------------------------------------------------------ 编排者侧

interface Outcome extends Payload {
  arm: ArmName;
  run: number;
  written: string;
  named: string[];
  unnamed: string[];
}

/** 数落盘周报里出现了哪些套话。词表写死，机械可数，不叫模型判。 */
function jargonIn(report: string, words: string[]): string[] {
  return words.filter((word) => report.includes(word));
}

async function one(arm: ArmName, run: number): Promise<Outcome> {
  rmSync(REPORTS, { recursive: true, force: true });
  mkdirSync(REPORTS, { recursive: true });
  for (const [name, body] of Object.entries(HISTORY)) {
    writeFileSync(join(REPORTS, name), body);
  }
  writeFileSync(join(PROBE_DIR, "AGENTS.md"), agentsMd(arm));

  const proc = Bun.spawn({
    cmd: ["bun", import.meta.path],
    cwd: PROBE_DIR,
    env: { ...process.env, PROBE_ROLE: "child", ARM: arm, RUN: String(run) },
    stdout: "pipe",
    stderr: "inherit",
  });
  const raw = await new Response(proc.stdout).text();
  await proc.exited;

  const start = raw.indexOf(OPEN);
  const end = raw.indexOf(CLOSE);
  const payload: Payload =
    start >= 0 && end > start
      ? (JSON.parse(raw.slice(start + OPEN.length, end)) as Payload)
      : { calls: [], finalText: "", input: 0, output: 0, error: "子进程没交回东西" };

  const fresh = readdirSync(REPORTS).filter((file) => !(file in HISTORY));
  const written = fresh.length > 0 ? readFileSync(join(REPORTS, fresh[0]), "utf8") : "";
  const body = written !== "" ? written : payload.finalText;

  return {
    ...payload,
    arm,
    run,
    written,
    named: jargonIn(body, NAMED),
    unnamed: jargonIn(body, UNNAMED),
  };
}

async function main(): Promise<void> {
  rmSync(PROBE_DIR, { recursive: true, force: true });
  mkdirSync(PROBE_DIR, { recursive: true });

  const all: Outcome[] = [];
  for (const arm of ARMS) {
    const slot = arm === "BASE" ? "套话只在「风格要求」里" : "套话也写进第 4 步「自动检查」";
    process.stdout.write(`\n==== ${arm} · ${slot} ====\n`);
    for (let run = 1; run <= RUNS; run += 1) {
      const outcome = await one(arm, run);
      all.push(outcome);

      if (outcome.error !== undefined) {
        process.stdout.write(`\n  [${arm} #${String(run)}] 抛了：${outcome.error}\n`);
        continue;
      }
      process.stdout.write(
        `\n  [${arm} #${String(run)}] 被点名的漏了 ${String(outcome.named.length)}：${outcome.named.join("、") || "无"}` +
          ` · 没点名的漏了 ${String(outcome.unnamed.length)}：${outcome.unnamed.join("、") || "无"}\n`,
      );
      const body = outcome.written !== "" ? outcome.written : outcome.finalText;
      process.stdout.write(
        body
          .split("\n")
          .map((line) => `    | ${line}`)
          .join("\n") + "\n",
      );
    }
  }

  process.stdout.write("\n==== 汇总 ====\n\n");
  process.stdout.write("  臂        #   被点名的漏出   没点名的漏出\n");
  for (const outcome of all) {
    process.stdout.write(
      `  ${outcome.arm.padEnd(8)} ${String(outcome.run)}   ${String(outcome.named.length).padStart(6)}         ${String(outcome.unnamed.length).padStart(6)}   ${[...outcome.named, ...outcome.unnamed].join(",")}\n`,
    );
  }

  for (const arm of ARMS) {
    const rows = all.filter((o) => o.arm === arm && o.error === undefined);
    const named = rows.reduce((sum, o) => sum + o.named.length, 0);
    const unnamed = rows.reduce((sum, o) => sum + o.unnamed.length, 0);
    process.stdout.write(
      `\n  ${arm}：被点名的共漏 ${String(named)} 次，没点名的共漏 ${String(unnamed)} 次（${String(rows.length)} 次运行）`,
    );
  }

  const inTotal = all.reduce((sum, o) => sum + o.input, 0);
  const outTotal = all.reduce((sum, o) => sum + o.output, 0);
  process.stdout.write(
    `\n\n  实际用量：input ${inTotal.toLocaleString()} · output ${outTotal.toLocaleString()}\n`,
  );
  process.stdout.write(
    "\n  怎么读：\n" +
      "    两臂有差 -> 「检查」这个槽位有机械效力，徐昊那条「缺一不可」成立\n" +
      "    两臂无差 -> 写成「检查」的文本只是更多的前馈；repro/38 的 ② 要重新解读\n" +
      "    两臂都 0 -> 空结果：光靠前馈就够，但**没能把两种解读分开**，不支持任何一边\n" +
      "    点名的删了、没点名的留着 -> 它做的是字符串匹配，不是类别判断\n",
  );
}

if (process.env["PROBE_ROLE"] === "child") await runChild();
else await main();
