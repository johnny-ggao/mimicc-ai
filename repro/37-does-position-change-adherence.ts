/**
 * 同一条规则，放在三个位置，深上下文里还照做吗？——票 02（`.scratch/view-layout/`）
 *
 * 运行：`bun repro/37-does-position-change-adherence.ts`
 * ⚠️ **这个探针花钱**：深档每臂约 29 万 input token，跑完最后一行印实际总数。
 *
 * ## 要答的是一个是非题
 *
 * [票 01](../.scratch/view-layout/issues/01-the-cache-bill.md) 已经用**成本**定了方向
 * （每轮变的块放头部 = 前缀缓存基本全废，HEAD 4.0% vs TAIL 39.3%）。
 * 本探针不重新决定方向，它只回答：
 *
 *   **位置轴要不要加第三条判据（注意力）——还是「变化频率」这一条已经够了？**
 *
 * 🔑 **为什么这个区分要紧**：成本论证 = 变化频率论证，而 `CONTEXT.md` 那条轴今天就写着
 * *「它决定这段该排在哪——不由重要性决定」*，一个字都不用改。**只有注意力这条独立成立，
 * 那句话才需要重写**（等于承认位置也由重要性决定）。
 *
 * ## 三个臂 × 两档深度
 *
 *   SYSTEM  规则写在系统提示词里          ← 用户开线时说的「字面那条」
 *   HEAD    规则是消息数组的第一条        ← 钉住块的位置，「改写那条」
 *   TAIL    规则是最后一条（问题之前）    ← 票 01 判出来该去的地方
 *
 *   浅档 ≈ 2k    —— **对照组**：三个位置几乎挨着，此处若已有差异，说明探针本身有问题
 *   深档 ≈ 29 万 —— 真实会话到过的量级
 *
 * ## 两个观测面，分开发两次
 *
 * - **遵循**：问一个和规则无关的问题，看回复照没照做。
 * - **取回**：直接问规则是什么，看还复述得出来。
 *
 * ⚠️ **必须分开发**，不能在同一发里同时问——把规则拿出来问，会让它在这一发里变得显眼，
 * 从而污染遵循那一面。`bench/instructions-probe.ts` 踩过这个。
 *
 * 🔑 **取回 ≠ 遵循，这个仓库实测过它们会分叉**：`instructions-probe` 里模型每次都答对
 * 「有没有项目指令」，**却照样先 Glob 一遍，三次里三次**。
 * 病因决定解空间：取回坏了 → 该动排布；取回好、遵循坏 → **动排布没用，那是权限门的活**。
 */
import { readFileSync } from "node:fs";

import { loadConfig } from "../src/config";
import { resolveModelConfig } from "../src/models";

const resolved = resolveModelConfig(loadConfig());

/** 规则本身。二值、可机械判定、且不是模型的默认行为。 */
const MARK = "SIGNOFF-7Q2";
const RULE =
  `Rule R7: every reply you write must end with the exact line \`${MARK}\`. ` +
  `This applies to every reply, without exception, however short.`;

/** 和规则无关的问题——照没照做，从回复自己就能看出来。 */
const TASK = "What is 2 + 2? Answer with just the number.";
/** 直接问规则。**另发一次**，不和上面那发混在一起。 */
const RECALL = "Quote the exact line that Rule R7 says every reply must end with.";

/**
 * 填充物：真实源码，也就是 `Read` 工具返回的那种东西。
 *
 * ⚠️ **不用合成噪声**：噪声不跟规则抢注意力，真实工具返回会——两者不是同一个测试。
 */
const SOURCES = [
  "src/context/compaction.ts",
  "src/context/projection.ts",
  "src/agents/loop.ts",
  "src/agents/prompt.ts",
  "src/tools/permission.ts",
  "CONTEXT.md",
  "README.md",
];
const CORPUS = SOURCES.map(
  (path) => `[tool result: Read ${path}]\n${readFileSync(path, "utf8")}`,
).join("\n\n");

function fillerOf(targetChars: number): string {
  let out = "";
  let round = 0;
  while (out.length < targetChars) {
    out += `\n\n=== pass ${String(round)} ===\n\n${CORPUS}`;
    round += 1;
  }
  return out.slice(0, targetChars);
}

type Arm = "SYSTEM" | "HEAD" | "TAIL";
const ARMS: Arm[] = ["SYSTEM", "HEAD", "TAIL"];
const SAMPLES = 5;

/**
 * 🔴 **不是随便定的，v1 就栽在这个数上。**
 *
 * v1 用 `max_tokens: 256`，而 DeepSeek v4 的思考**计在输出里**：实测一次回答要烧
 * 560~980 字符的 `reasoning_content`，256 个输出 token 有时不够，于是
 * `finish_reason: "length"`、**正文一个字都没有**——判定当场记成「没取回」。
 * v1 浅档 TAIL 的「取回 1/3」就是这么来的：**仪器坏了，不是模型不行。**
 *
 * ⚠️ 讽刺的是这正是 `.scratch/output-budget/` 票 02 刚做出检测的那个失败模式。
 * 所以这里除了抬高额度，还**把每一发的 `finish_reason` 记下来**：
 * 被截断的样本不算「没照做」，它**根本不算样本**。
 */
const MAX_OUTPUT = 1024;

/** 系统提示词的躯干，三个臂共用；只有 SYSTEM 臂在它后面接上规则。 */
const BASE_SYSTEM = "You are a terse assistant working inside a code repository.";

interface Reply {
  text: string;
  promptTokens: number;
  /** 被输出额度掐断的一发不是样本——见 MAX_OUTPUT 的注释。 */
  truncated: boolean;
}

async function ask(system: string, messages: string[]): Promise<Reply> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${resolved.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${resolved.apiKey}`,
      },
      body: JSON.stringify({
        model: resolved.model,
        max_tokens: MAX_OUTPUT,
        messages: [
          { role: "system", content: system },
          ...messages.map((content) => ({ role: "user", content })),
        ],
      }),
    });
    if (response.status === 429 || response.status >= 500) {
      if (attempt >= 5) throw new Error(`giving up after ${String(response.status)}`);
      const wait = 2_000 * 2 ** attempt;
      process.stdout.write(`    ↻ ${String(response.status)}，${String(wait / 1000)}s\n`);
      await new Promise((resolve) => setTimeout(resolve, wait));
      continue;
    }
    const body = (await response.json()) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number };
      error?: { message?: string };
    };
    if (body.error) throw new Error(body.error.message ?? "unknown error");
    const choice = body.choices?.[0];
    return {
      text: choice?.message?.content ?? "",
      promptTokens: body.usage?.prompt_tokens ?? 0,
      truncated: choice?.finish_reason === "length",
    };
  }
}

/** 一发请求的形状：规则去哪，填充物去哪，问题永远在最后。 */
function shape(arm: Arm, filler: string, question: string): [string, string[]] {
  const body: string[] = [];
  if (arm === "HEAD") body.push(RULE);
  if (filler.length > 0) body.push(filler);
  if (arm === "TAIL") body.push(RULE);
  body.push(question);
  return [arm === "SYSTEM" ? `${BASE_SYSTEM}\n\n${RULE}` : BASE_SYSTEM, body];
}

/** 照做了吗——回复的最后一个非空行是不是那一行。 */
function obeyed(text: string): boolean {
  const lines = text.trimEnd().split("\n");
  return (lines[lines.length - 1] ?? "").trim() === MARK;
}

/** 复述得出来吗——回复里出现过那个串就算。 */
function recalled(text: string): boolean {
  return text.includes(MARK);
}

interface Cell {
  obey: number;
  recall: number;
  /** 分母：被截断的样本不进分子也不进分母。 */
  obeyOf: number;
  recallOf: number;
  promptTokens: number;
}

async function run(arm: Arm, filler: string): Promise<Cell> {
  let obey = 0;
  let obeyOf = 0;
  let recall = 0;
  let recallOf = 0;
  let promptTokens = 0;
  for (let sample = 0; sample < SAMPLES; sample++) {
    const [system, body] = shape(arm, filler, TASK);
    const answer = await ask(system, body);
    promptTokens = answer.promptTokens;
    if (!answer.truncated) {
      obeyOf += 1;
      if (obeyed(answer.text)) obey += 1;
    }

    const [recallSystem, recallBody] = shape(arm, filler, RECALL);
    const quoted = await ask(recallSystem, recallBody);
    if (!quoted.truncated) {
      recallOf += 1;
      if (recalled(quoted.text)) recall += 1;
    }
  }
  return { obey, recall, obeyOf, recallOf, promptTokens };
}

process.stdout.write(`model ${resolved.model}\n规则：回复必须以 \`${MARK}\` 结尾\n`);
process.stdout.write(`采样 ${String(SAMPLES)} 次/格，两个观测面分开发\n\n`);

const DEPTHS: { label: string; chars: number }[] = [
  { label: "浅（对照）", chars: 0 },
  { label: "深", chars: 1_100_000 },
];

const table: { depth: string; arm: Arm; cell: Cell }[] = [];
for (const depth of DEPTHS) {
  const filler = fillerOf(depth.chars);
  for (const arm of ARMS) {
    const cell = await run(arm, filler);
    table.push({ depth: depth.label, arm, cell });
    const dropped = SAMPLES * 2 - cell.obeyOf - cell.recallOf;
    process.stdout.write(
      `${depth.label.padEnd(12)}${arm.padEnd(8)}` +
        `input≈${String(cell.promptTokens).padStart(7)}  ` +
        `遵循 ${String(cell.obey)}/${String(cell.obeyOf)}   取回 ${String(cell.recall)}/${String(cell.recallOf)}` +
        `${dropped > 0 ? `   ⚠️ ${String(dropped)} 发被截断，不计` : ""}\n`,
    );
  }
  process.stdout.write("\n");
}

const at = (depth: string, arm: Arm): Cell =>
  table.find((row) => row.depth === depth && row.arm === arm)?.cell ?? {
    obey: -1,
    recall: -1,
    obeyOf: 1,
    recallOf: 1,
    promptTokens: 0,
  };
const rate = (n: number, of: number): number => (of === 0 ? -1 : n / of);

/**
 * 判读，而且**两个观测面都要过对照档**。
 *
 * 🔴 v1 只检查了遵循那一面的对照，于是**没发现取回那一面的对照是坏的**
 * （浅档 TAIL 取回 1/3——2k 上下文里规则就在问题前一条，那不可能是真的取回失败）。
 * 对照组的意义就是替测量本身背书，只检查一半等于没检查。
 */
const shallowObey = ARMS.map((arm) => rate(at("浅（对照）", arm).obey, at("浅（对照）", arm).obeyOf));
const shallowRecall = ARMS.map((arm) =>
  rate(at("浅（对照）", arm).recall, at("浅（对照）", arm).recallOf),
);
const controlClean =
  shallowObey.every((value) => value === 1) && shallowRecall.every((value) => value === 1);

const deepObey = ARMS.map((arm) => rate(at("深", arm).obey, at("深", arm).obeyOf));
const deepTail = rate(at("深", "TAIL").obey, at("深", "TAIL").obeyOf);
const deepHead = rate(at("深", "HEAD").obey, at("深", "HEAD").obeyOf);
const deepSystem = rate(at("深", "SYSTEM").obey, at("深", "SYSTEM").obeyOf);

process.stdout.write("判读\n");
process.stdout.write(
  `  对照档（两个面都要满分）：遵循 ${shallowObey.map((v) => v.toFixed(2)).join(" / ")}` +
    `，取回 ${shallowRecall.map((v) => v.toFixed(2)).join(" / ")}` +
    `${controlClean ? "  ✅ 测量有效" : "  🔴 对照组不干净——下面一律不作结论"}\n`,
);
process.stdout.write(`  深档遵循：${ARMS.map((arm, i) => `${arm} ${deepObey[i]!.toFixed(2)}`).join("  ")}\n`);
process.stdout.write(
  `  深档取回：${ARMS.map((arm) => `${arm} ${String(at("深", arm).recall)}/${String(at("深", arm).recallOf)}`).join("  ")}\n`,
);

/**
 * 🔑 **两个条件缺一不可，而且第二个是 v1 缺的那个。**
 *
 * v1 的规则是「深档三臂有任何差异就算注意力成立」，于是**一个样本的抖动就能翻结论**
 * ——n=3 时那是噪声。而且 v1 那一个样本的方向**恰好和假设相反**（TAIL 反而更差），
 * 那本身就是噪声的迹象。
 *
 * 所以现在要求：差距**不小于两个样本**，**且方向和假设一致**（尾部更好）。
 */
const margin = 2 / SAMPLES;
const tailBetter = deepTail - Math.max(deepHead, deepSystem) >= margin;

const verdict = !controlClean
  ? "**探针失效，不出结论。** 对照组自己都没满分，先修仪器。"
  : tailBetter
    ? "**注意力这条轴独立成立**——同样深度下，规则放尾部的遵循度明显高于放头部。位置轴需要第三条判据。"
    : `**注意力这条轴不独立成立**——${deepObey.every((v) => v === 1) ? `规则在 ${String(at("深", "SYSTEM").promptTokens)} token 深处、放在最前面，仍然 ${String(SAMPLES)}/${String(SAMPLES)} 被遵守` : "深档三臂没有超过噪声的差距"}。位置轴维持「由变化频率决定」。`;
process.stdout.write(`\n→ ${verdict}\n`);

if (controlClean && !tailBetter && deepObey.every((v) => v === 1)) {
  process.stdout.write(
    "\n⚠️ **天花板效应，必须跟着结论一起写下来**：三臂都满分，说明这把尺子量不出\n" +
      "   「小的差异」——它只能说「没有大到能被这个规则、这个深度测出来的效应」。\n",
  );
}
