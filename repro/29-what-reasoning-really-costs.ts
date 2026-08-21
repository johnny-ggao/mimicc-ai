/**
 * 屏幕上，思维链和回复各占多少？
 *
 * Run: `bun repro/29-what-reasoning-really-costs.ts`   ⚠️ **花钱**（3 个回合，见下）
 *
 * 票 01 的另一半。`28-what-reasoning-costs-the-screen.ts` 用 stub 答完了机械的三问
 * （段数规律、落盘、两条渲染路径不一致）；**剩下这三件 stub 答不了，也不许编**：
 *
 * 1. **reasoning 与正文各占多少字符 / 多少屏幕行**——这条线是因为屏幕被淹才开的，
 *    所以判据必须是屏幕行数，不是 token。
 * 2. 🔑 **真模型是不是每一跳都想？** 探针 28 证的是「如果它每跳都想，屏幕上就是这么多段」，
 *    **前半句是 provider 的行为，只有打真的才知道**。这一问直接决定票 03 第 2 问
 *    （痛的是"一段太长"还是"段数太多"）。
 * 3. **单段峰值。** 平均值会骗人——被硌到的那一下通常是峰值。
 *
 * ## 花多少钱
 *
 * 3 个回合，`maxTokens` 压到 2048。量级约 50k in / 15k out，与 `repro/27` 同一档。
 * **2026-08-21 用户批准。**
 *
 * ⚠️ **上界是必须的，不是保险。** `kimi-k3` 在 `src/models.ts` 里**没有 `maxTokens`**
 * （注释写明这是故意的：K3 认的是 `max_completion_tokens`，而 ChatOpenAI 只对 o 系列 / gpt-5
 * 发那个名字，所以干脆不发上界、让 provider 用自己的默认 131072）。
 * **对出货是对的，对探针是笔跑飞的账**——一段跑飞的思维链就是一次跑飞的付费。
 *
 * ## 怎么在不花钱的前提下验它
 *
 * `LLM_BASE_URL` 指到一个本地 stub 上跑一遍——`resolveModelConfig` 认这个环境变量，
 * 所以整条装配一个字都不用改。**这不是可选的谨慎**：第一次这么跑就抓到两个会让付费
 * 那一跑白花的错（`thread_id` 用了中文标签，过不了 `saver.ts:283` 的文件名校验；
 * 以及一处块注释被 `o*` 后面那个斜杠提前关掉）。
 * `scripts/probe-smoke.ts` 对 `PAID` 里的探针用的是同一招，只是它的 stub 回空 `choices`，
 * 只验「活到了发请求那一步」，不验报告算得对不对。
 *
 * ## 为什么用出货那套装配，而不是搭一个最小的
 *
 * 思维链多长，取决于系统提示词、取决于工具定义、取决于模型看见了什么。
 * **换一套装配量出来的数，回答的就是另一个问题。** 所以这里逐字照 `src/main.ts` 装：
 * 真 `buildSystemPrompt`、真工具、真 checkpointer。
 * ⚠️ 唯一的偏离是 `maxTokens`，而且偏离的方向是**让数偏小**——所以结论
 * 「屏幕被淹」若成立，是在保守的一侧成立的。
 *
 * ## 三个回合为什么是这三种
 *
 * 一句话问答（大概率零工具跳）、带工具的任务（那是段数规律真正咬人的地方）、
 * 一段较长的分析（正文长，用来看比例会不会反过来）。**问的是范围不是一个点**——
 * `repro/27` 的教训正是「n 太小分不出东西」，这里虽然量的是长度不是差异，
 * 但一个点同样说不出峰值。
 *
 * ## 观测面：与探针 28 同一个
 *
 * 两条流都收（`"values"` 给工具行，`"messages"` 给 reasoning 与正文），
 * 因为屏幕上把两段灰字隔开的正是工具行。理由与坑都写在 `repro/28`。
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { type BaseMessage, HumanMessage } from "@langchain/core/messages";

import { buildSystemPrompt, createUniversalAgent, DURABILITY, RECURSION_LIMIT } from "../src/agents";
import { JsonlSaver } from "../src/checkpoint";
import { loadConfig } from "../src/config";
import { fromModel } from "../src/console";
import { resolveModelConfig } from "../src/models";

const DIR = join(import.meta.dir, "..", ".mimicc", "probe-29");

/** ⚠️ 见头注释：出货故意不设上界，探针必须设。 */
const MAX_TOKENS = 2048;

/**
 * 一段文字在给定宽度的终端上占几个屏幕行。
 *
 * ⚠️ **CJK 占两列**，这是「字符数」与「屏幕行数」分家的主要原因，不能省——
 * 这条线上的思维链大部分是中文。宽度取真实终端；不是 TTY 时退回 80，
 * 并在报告里说明，免得一个管道里跑出来的数被当成屏幕上的数。
 */
function screenLines(text: string, width: number): number {
  let lines = 0;
  for (const logical of text.split("\n")) {
    let columns = 0;
    for (const ch of logical) {
      const code = ch.codePointAt(0) ?? 0;
      const wide =
        (code >= 0x1100 && code <= 0x115f) ||
        (code >= 0x2e80 && code <= 0xa4cf) ||
        (code >= 0xac00 && code <= 0xd7a3) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xfe30 && code <= 0xfe6f) ||
        (code >= 0xff00 && code <= 0xff60) ||
        (code >= 0xffe0 && code <= 0xffe6);
      columns += wide ? 2 : 1;
    }
    lines += Math.max(1, Math.ceil(columns / width));
  }
  return lines;
}

const config = loadConfig();
const model = resolveModelConfig(config);

/**
 * `main.ts` 的 `describeEnvironment` 是私有的，所以这里重写一份。
 *
 * ⚠️ 抄一份通常是错的，这里可以接受的理由很窄：**它只是四个事实**（cwd、平台、日期、
 * 是不是 git 仓库），而且**这个探针要的正是"提示词有多大"这个量级，不是它逐字相同**。
 * 若哪天提示词开始按环境分叉，这条就不成立了——那时该把它从 `main.ts` 提出来。
 */
const environment = {
  cwd: process.cwd(),
  platform: process.platform,
  today: new Date().toISOString().slice(0, 10),
  isGitRepo: true,
};

// 秤要在装配之前声明：回调是稍后才被调用的，但读起来该是先有秤后有量。
let reasoningTokens = 0;
let outputTokens = 0;
let inputTokens = 0;
let cachedTokens = 0;

await rm(DIR, { recursive: true, force: true });

const graph = createUniversalAgent({
  baseURL: model.baseURL,
  apiKey: model.apiKey,
  model: model.model,
  maxTokens: MAX_TOKENS,
  window: { limit: model.windowLimit },
  systemPrompt: buildSystemPrompt(environment),
  checkpointer: new JsonlSaver(DIR),
  stateDir: DIR,
  onUsage: (usage) => {
    // 独立的第二把尺。屏幕行数是这条线的判据，但 `reasoningTokens` 是 provider 自己报的，
    // 两者对不上就说明有一侧数错了——⚠️ 它**不能**代替屏幕行数（票 01 判据写死了这条）。
    reasoningTokens += usage.reasoningTokens ?? 0;
    outputTokens += usage.outputTokens;
    inputTokens += usage.inputTokens;
    cachedTokens += usage.cacheRead;
  },
});

const WIDTH = process.stdout.columns ?? 80;
const IS_TTY = process.stdout.isTTY === true;

interface Turn {
  label: string;
  ask: string;
  laps: number;
  /** 屏幕上一个连续的灰字块。 */
  segments: string[];
  prose: string;
}

const TURNS: { label: string; ask: string }[] = [
  { label: "一句话问答", ask: "用一句话说：这个仓库的包管理器是什么？" },
  {
    label: "带工具的任务",
    ask: "看一下 src/console/spend.ts，告诉我它为什么不打印金额。引用它的注释。",
  },
  {
    label: "较长的分析",
    ask: "读 src/console/markdown.ts，说明它为什么自己折行而不交给终端软换行，以及这个选择的代价。",
  },
];

async function runTurn(index: number, label: string, ask: string): Promise<Turn> {
  const events: { kind: "reasoning" | "content" | "structure"; text: string }[] = [];
  let laps = 0;
  let rendered = 0;

  const stream = (await graph.stream(
    { messages: [new HumanMessage(ask)] },
    {
      streamMode: ["messages", "values"] as const,
      recursionLimit: RECURSION_LIMIT,
      durability: DURABILITY,
      // ⚠️ 序号不用标签：`saver.ts:283` 要求 thread_id 匹配 /^[\w-]{1,128}$/，
      // 中文标签过不去（dry run 抓到的）。
      configurable: { thread_id: `probe-29-${String(index)}` },
    },
  )) as AsyncIterable<[string, unknown]>;

  for await (const [mode, payload] of stream) {
    if (mode === "values") {
      const values = payload as { messages?: BaseMessage[] };
      if (values.messages === undefined) continue;
      for (const message of values.messages.slice(rendered)) {
        const type = message.getType();
        if (type === "ai") {
          laps += 1;
          const calls = (message as { tool_calls?: unknown[] }).tool_calls ?? [];
          for (const _ of calls) events.push({ kind: "structure", text: "" });
        }
        if (type === "tool") events.push({ kind: "structure", text: "" });
      }
      rendered = values.messages.length;
      continue;
    }
    const [one] = payload as [BaseMessage, unknown];
    if (!fromModel(one)) continue;
    const reasoning = one.additional_kwargs["reasoning_content"];
    if (typeof reasoning === "string" && reasoning.length > 0) {
      events.push({ kind: "reasoning", text: reasoning });
    }
    if (typeof one.content === "string" && one.content.length > 0) {
      events.push({ kind: "content", text: one.content });
    }
  }

  const segments: string[] = [];
  let prose = "";
  for (const event of events) {
    if (event.kind === "content") prose += event.text;
    if (event.kind !== "reasoning") {
      if (segments.length > 0 && segments[segments.length - 1] !== "") segments.push("");
      continue;
    }
    if (segments.length === 0 || segments[segments.length - 1] === "") {
      segments.push(event.text);
    } else segments[segments.length - 1] += event.text;
  }

  return { label, ask, laps, segments: segments.filter((one) => one !== ""), prose };
}

const results: Turn[] = [];
for (const [index, { label, ask }] of TURNS.entries()) {
  results.push(await runTurn(index, label, ask));
}

// ── 报告 ─────────────────────────────────────────────────────────────────────

const out = (line: string) => process.stdout.write(`${line}\n`);
const lines = (text: string) => screenLines(text, WIDTH);

out(`模型 ${model.provider}/${model.model}  ·  maxTokens ${String(MAX_TOKENS)}`);
out(
  `终端宽度 ${String(WIDTH)} 列${IS_TTY ? "" : " ⚠️ 不是 TTY，这是退回值——屏幕行数按它算，真实终端上会不同"}`,
);

out("");
out("=== 每个回合 ===");
let peak = 0;
let peakWhere = "";
for (const turn of results) {
  const reasoningChars = turn.segments.reduce((sum, one) => sum + one.length, 0);
  const reasoningLines = turn.segments.reduce((sum, one) => sum + lines(one), 0);
  const proseLines = turn.prose === "" ? 0 : lines(turn.prose);
  const share =
    reasoningLines + proseLines === 0
      ? 0
      : Math.round((reasoningLines / (reasoningLines + proseLines)) * 100);
  for (const one of turn.segments) {
    if (lines(one) > peak) {
      peak = lines(one);
      peakWhere = turn.label;
    }
  }
  out("");
  out(`  ${turn.label}`);
  out(`    模型调用 ${String(turn.laps)} 次 · 灰字 ${String(turn.segments.length)} 段`);
  out(
    `    reasoning ${String(reasoningChars)} 字 → ${String(reasoningLines)} 屏幕行` +
      `   |   正文 ${String(turn.prose.length)} 字 → ${String(proseLines)} 屏幕行`,
  );
  out(`    🔴 思维链占屏幕 ${String(share)}%`);
  out(
    `    段数 == 调用次数？ ${turn.segments.length === turn.laps ? "✅ 是" : `🔴 否（${String(turn.segments.length)} vs ${String(turn.laps)}）——真模型没有每一跳都想`}`,
  );
}

const allReasoningLines = results.reduce(
  (sum, turn) => sum + turn.segments.reduce((inner, one) => inner + lines(one), 0),
  0,
);
const allProseLines = results.reduce(
  (sum, turn) => sum + (turn.prose === "" ? 0 : lines(turn.prose)),
  0,
);

out("");
out("=== 合计 ===");
out(
  `  思维链 ${String(allReasoningLines)} 屏幕行  vs  正文 ${String(allProseLines)} 屏幕行` +
    `  →  🔴 思维链占 ${String(Math.round((allReasoningLines / Math.max(1, allReasoningLines + allProseLines)) * 100))}%`,
);
out(`  单段峰值：${String(peak)} 屏幕行（出现在「${peakWhere}」）`);

out("");
out("=== 第二把尺（provider 自己报的 token，用来对账，不代替屏幕行）===");
out(
  `  reasoning ${String(reasoningTokens)} / 输出 ${String(outputTokens)} tokens` +
    `  ·  输入 ${String(inputTokens)}（其中 ${String(cachedTokens)} 命中缓存）`,
);
