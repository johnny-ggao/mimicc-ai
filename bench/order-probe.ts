/**
 * 探针 v2：在 DeepSeek 上，tools 和 system 谁排在缓存前缀的前面？
 *
 * v1 失败的原因：两个 system 变体共享了整段静态提示词，于是两组都只测出
 * "共享到某处为止"，识别不出顺序。v2 修掉三件事：
 *
 *   1. 两个 system **一个字节都不共享**（不是改结尾，是整段换掉）。
 *   2. 两套 tools 也一个字节都不共享。
 *   3. **把体积拉开**：tools 约 2 千 token，system 约 2 百 token。
 *      于是 cached 的数量级本身就报出谁活下来了，不需要解读。
 *
 * 判读表（cached 落在哪个量级）：
 *
 *              换 system 后          换 tools 后
 *   tools 在前   ≈ tools 的体积（大）    ≈ 0
 *   system 在前  ≈ 0                    ≈ system 的体积（小）
 */
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

import { loadConfig } from "../src/config";

const config = loadConfig();
const stamp = String(Date.now());

const model = new ChatOpenAI({
  model: config.LLM_MODEL,
  apiKey: config.LLM_API_KEY,
  configuration: { baseURL: config.LLM_BASE_URL },
  maxTokens: 8,
});

/** 约 200 token 的系统提示词。两个变体用不同词汇，避免任何公共前缀。 */
function smallSystem(seed: string, word: string): string {
  return (
    `You are ${seed}. ` +
    `${word} `.repeat(180) +
    `End of ${seed} instructions.`
  );
}

/** 约 2000 token 的工具集。描述占绝大部分体积。 */
function bigTools(seed: string, word: string) {
  return [
    tool(async () => "ok", {
      name: `${seed}_alpha`,
      description: `Tool alpha for ${seed}. ${`${word} `.repeat(900)}`,
      schema: z.object({ q: z.string().describe(`${word} argument`) }),
    }),
  ];
}

const SYS_A = smallSystem("agent-alpha", "lantern");
const SYS_B = smallSystem(`agent-beta-${stamp}`, "harbour");
const TOOLS_A = bigTools("alpha", "lantern");
const TOOLS_B = bigTools(`beta${stamp}`, "harbour");

interface Reading {
  label: string;
  input: number;
  cached: number;
}

async function call(
  label: string,
  tools: ReturnType<typeof bigTools> | null,
  system: string,
): Promise<Reading> {
  const bound = tools === null ? model : model.bindTools(tools);
  const response = await bound.invoke([new SystemMessage(system), new HumanMessage("hi")]);
  const usage = response.usage_metadata as
    | { input_tokens?: number; input_token_details?: { cache_read?: number } }
    | undefined;
  return {
    label,
    input: usage?.input_tokens ?? 0,
    cached: usage?.input_token_details?.cache_read ?? 0,
  };
}

// 标定：先量出两段各自多大，后面的 cached 才有尺子可比。
const sysOnly = await call("标定 · 只有 system", null, SYS_A);
const withTools = await call("标定 · system + tools", TOOLS_A, SYS_A);
const toolsSize = withTools.input - sysOnly.input;

// 打热 (TOOLS_A, SYS_A)。
const warm = await call("① 原样重发（已热）", TOOLS_A, SYS_A);

// 决定性的两发，都是本次运行独有、从未发过的组合。
const newSystem = await call("② 同 tools，换掉整个 system", TOOLS_A, SYS_B);
const newTools = await call("③ 同 system，换掉整个 tools", TOOLS_B, SYS_A);

process.stdout.write(`\nmodel ${config.LLM_MODEL}\n`);
process.stdout.write(
  `体积标定：system ≈ ${String(sysOnly.input)} token（含模板开销），tools ≈ ${String(toolsSize)} token\n\n`,
);
process.stdout.write("                              input   cached\n");
for (const row of [warm, newSystem, newTools]) {
  process.stdout.write(
    `${row.label.padEnd(28)}${String(row.input).padStart(6)}${String(row.cached).padStart(9)}\n`,
  );
}

const bigish = toolsSize * 0.5;
const verdict =
  newSystem.cached > bigish && newTools.cached < bigish
    ? "tools 排在 system 之前"
    : newTools.cached > 0 && newSystem.cached < bigish
      ? "system 排在 tools 之前"
      : "两发都不干净——看上面的原始数字，别信这行";
process.stdout.write(`\n判读：${verdict}\n`);
