/**
 * 撞满 deepseek-v4-flash 的 1M 窗口会发生什么？—— 票 08 的 D1。
 *
 * Run: `bun repro/08-overflow.ts`
 *
 * ⚠️ 这个脚本**花钱**：一次约 1.1M token 的未命中输入 ≈ $0.15。用户 2026-08-13 批准。
 *
 * 要拿的是**错误串的逐字原文**，因为 langchain 判定「上下文溢出」靠字符串匹配四个
 * OpenAI 措辞（@langchain/openai/dist/utils/client.js:5-9）：
 *   context_length_exceeded / Input tokens exceed the configured limit /
 *   exceeds the context window / maximum context length
 * DeepSeek 命中其中任何一个 → `ContextOverflowError` 会被抛出，兜底可以挂在它上面；
 * 一个都不命中 → 那条安全网对我们是坏的，得自己识别。
 *
 * 先打一次 1.1M（应超），再打一次 0.5M（应通），后者是对照——排除「是别的原因失败」。
 */
import { loadConfig } from "../src/config";

const config = loadConfig();

/**
 * ⚠️ 实测推翻了官方换算。DeepSeek 文档写「1 个英文字符 ≈ 0.3 token」（→3.33 字符/token），
 * 但第一轮用重复的 lorem ipsum 打过去，**实测 5.84 字符/token**
 * （1,665,000 字符 → 285,267 token；3,663,000 → 628,676）——重复文本被分词器吃得极省。
 * 所以填充物换成高熵内容（十六进制串），它反过来分得很碎，约 2 字符/token，
 * 用更少的字节够到 1M。**这条本身是个结论：字符数换 token 数取决于内容，不是一个常数。**
 */
const REPETITIVE_CHARS_PER_TOKEN = 5.84;

async function shoot(label: string, targetTokens: number) {
  // 高熵填充：每 16 个字符一段互不相同的十六进制，分词器切得很碎。
  const chunks: string[] = [];
  let seed = 0x9e3779b9;
  const approxCharsPerToken = 2;
  const chars = Math.round(targetTokens * approxCharsPerToken);
  while (chunks.length * 17 < chars) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    chunks.push(seed.toString(16).padStart(8, "0") + (seed ^ 0x5bf03635).toString(16).padStart(8, "0"));
  }
  const body = chunks.join(" ").slice(0, chars);
  void REPETITIVE_CHARS_PER_TOKEN;

  const started = Date.now();
  const response = await fetch(`${config.LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.LLM_API_KEY}` },
    body: JSON.stringify({
      model: config.LLM_MODEL,
      max_tokens: 16,
      messages: [{ role: "user", content: `Reply with the single word OK.\n\n${body}` }],
    }),
  });
  const text = await response.text();
  const ms = Date.now() - started;

  process.stdout.write(`\n=== ${label}：目标 ${String(targetTokens)} token（${String(chars)} 字符）===\n`);
  process.stdout.write(`  HTTP ${String(response.status)}  ${String(ms)}ms\n`);
  process.stdout.write(`  响应逐字：\n${text.slice(0, 1200)}\n`);

  // 对着 langchain 的四个串核一遍
  const PATTERNS = [
    "context_length_exceeded",
    "Input tokens exceed the configured limit",
    "exceeds the context window",
    "maximum context length",
  ];
  const hits = PATTERNS.filter((p) => text.includes(p));
  process.stdout.write(
    `  langchain 的四个匹配串命中：${hits.length > 0 ? hits.join(" / ") : "**一个都没有**"}\n`,
  );
  return { status: response.status, text };
}

// 第一轮（重复文本）已确认 628,676 token 仍然 HTTP 200，所以对照组从那个数往上抬。
await shoot("溢出组（目标 1.3M，应当超限）", 1_300_000);
