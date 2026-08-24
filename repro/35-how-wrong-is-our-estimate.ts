/**
 * `estimate()` 到底偏多少？——`.scratch/output-budget/` 票 01 的安全余量要靠这个数。
 *
 * 运行：`bun repro/35-how-wrong-is-our-estimate.ts`
 * ⚠️ **这个探针花钱**，约 3 万 input token，量级 $0.01。
 *
 * ## 为什么要量
 *
 * 票 01 要把输出额度改成 `窗口 − 估算的输入 − 安全余量`。**那个安全余量的全部工作，
 * 就是吸收「估算的输入」和真实 token 数之间的差**。抄一个数（pi 用 4096）等于假装
 * 两边的估算器一样准。
 *
 * `src/context/projection.ts` 的 `estimate()` 是 **字符数 ÷ 4**，而
 * `src/context/compaction.ts` 的文件头早就写着 *characters-per-token is not a constant*。
 * 这个探针把「不是常数」变成一张表。
 *
 * ## 🔴 一条要更正的
 *
 * 图和票里一度写着「实测偏 22%」。**那个数是错的**——22% 是
 * `repro/33-does-output-share-the-window.ts` 里**填充脚本自己**的字符/token 假设偏了，
 * 不是 `estimate()` 偏了。按 `estimate()` 算，那段 1,400,000 字符的十六进制会被估成
 * **350,000** token，实际是 **856,548**——**低估 2.4 倍**。
 * 那是高熵内容的极端；真实内容在哪，就是下面这张表。
 *
 * ## 判读
 *
 * 每一行给 `估算 / 实际`。**小于 1 是低估，是危险的方向**——
 * 低估意味着我们以为还有空间、其实没有，而那正好是 400 的形状。
 */
import { HumanMessage } from "@langchain/core/messages";
import { readFileSync } from "node:fs";

import { loadConfig } from "../src/config";
import { resolveModelConfig } from "../src/models";
import { estimate } from "../src/context";
import { STATIC_PROMPT } from "../src/agents";

const resolved = resolveModelConfig(loadConfig());

/** 把一段文本重复到大约这么多字符，好让固定开销可以忽略。 */
const TARGET_CHARS = 24_000;
function sized(seed: string): string {
  if (seed.length === 0) return "";
  let out = seed;
  while (out.length < TARGET_CHARS) out += `\n${seed}`;
  return out.slice(0, TARGET_CHARS);
}

function hex(chars: number): string {
  const parts: string[] = [];
  let seed = 0x9e3779b9;
  while (parts.length * 17 < chars) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    parts.push(
      seed.toString(16).padStart(8, "0") + (seed ^ 0x5bf03635).toString(16).padStart(8, "0"),
    );
  }
  return parts.join(" ").slice(0, chars);
}

const SAMPLES: { label: string; text: string }[] = [
  // 我们自己发给模型的英文散文——最有代表性的一类常驻内容。
  { label: "英文散文（系统提示词）", text: sized(STATIC_PROMPT) },
  // 真实源码：Read 工具返回的就是这种东西。
  {
    label: "TypeScript 源码",
    text: sized(readFileSync("src/context/projection.ts", "utf8")),
  },
  // 🔑 中文：用户就是用中文提问的，而且 AGENTS.md 也可能是中文。
  { label: "中文（CONTEXT.md）", text: sized(readFileSync("CONTEXT.md", "utf8")) },
  // 结构化工具返回。
  {
    label: "JSON（工具返回形状）",
    text: sized(
      JSON.stringify(
        Array.from({ length: 20 }, (_, i) => ({
          path: `src/module-${String(i)}/index.ts`,
          bytes: 1024 + i,
          modified: "2026-08-24T00:00:00Z",
          tags: ["source", "typescript"],
        })),
        null,
        2,
      ),
    ),
  },
  // 高熵，作为上界——`repro/33` 用的就是它。
  { label: "高熵十六进制（上界）", text: hex(TARGET_CHARS) },
];

async function promptTokensOf(text: string): Promise<number> {
  const response = await fetch(`${resolved.baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${resolved.apiKey}`,
    },
    body: JSON.stringify({
      model: resolved.model,
      max_tokens: 1,
      messages: [{ role: "user", content: text }],
    }),
  });
  const body = (await response.json()) as { usage?: { prompt_tokens?: number } };
  const tokens = body.usage?.prompt_tokens;
  if (tokens === undefined) {
    throw new Error(`no usage in response: ${JSON.stringify(body).slice(0, 200)}`);
  }
  return tokens;
}

// 固定开销：一条几乎空的消息也要花掉几个 token，先量出来再从每一行里减掉。
const overhead = await promptTokensOf("x");

process.stdout.write(
  `model ${resolved.model}\n固定开销 ${String(overhead)} token（每行都已扣除）\n\n`,
);
process.stdout.write("内容类型                        字符   估算    实际   估算/实际  字符/token\n");

let worst = Number.POSITIVE_INFINITY;
let worstLabel = "";
for (const sample of SAMPLES) {
  const guessed = estimate([new HumanMessage(sample.text)]);
  const actual = (await promptTokensOf(sample.text)) - overhead;
  const ratio = guessed / actual;
  if (ratio < worst) {
    worst = ratio;
    worstLabel = sample.label;
  }
  process.stdout.write(
    `${sample.label.padEnd(26)}${String(sample.text.length).padStart(8)}` +
      `${String(guessed).padStart(7)}${String(actual).padStart(8)}` +
      `${ratio.toFixed(2).padStart(10)}${(sample.text.length / actual).toFixed(2).padStart(11)}\n`,
  );
}

process.stdout.write(
  `\n判读\n` +
    `  最坏的一类是「${worstLabel}」，估算只有实际的 ${(worst * 100).toFixed(0)}%\n` +
    `  → 一段被估成 N token 的内容，真实可能是 ${(1 / worst).toFixed(1)}N\n` +
    `  ⚠️ **安全余量必须按最坏那一类定，不是按平均**——溢出保护按最坏情况算，\n` +
    `     这条写在 CONTEXT.md 的「溢出保护」词条里。\n`,
);
