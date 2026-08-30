/**
 * DeepSeek 的窗口，是只算输入，还是「输入 + max_tokens」一起算？
 *
 * 运行：`bun repro/33-does-output-share-the-window.ts`
 * ⚠️ **这个探针花钱**，约 70 万未命中输入 ≈ $0.10 量级。
 *
 * ## 为什么这一问是必须的
 *
 * 2026-08-24 注册表从 `maxTokens: 4096` 改成发 provider 的真实上限 393,216
 * （用户定的规则：每个模型必须有真实值，4096 只作缺省）。**如果窗口把输出也算进去**，
 * 这一改会让有效输入上限变成 1,048,576 − 393,216 = **655,360**——
 * 而 `src/context/compaction.ts` 的压缩阈值是 **80% × 1,048,576 = 838,861**。
 *
 * 🔴 **于是 65.5 万 ~ 83.9 万之间的请求会在压缩来得及触发之前就被拒**，
 * 而那正是溢出保护存在的理由。**这不是理论风险，是那次改动直接制造的。**
 *
 * ## 两发就能判
 *
 *   A：70 万输入 + `max_tokens: 393_216`  → 700_000 + 393_216 = 1_093_216 > 窗口
 *   B（仅当 A 是 400 才发）：同一段输入 + `max_tokens: 4_096` → 远在窗口内
 *
 *   A=400, B=200  → **窗口算输入+输出**，注册表发满值会砸掉溢出保护
 *   A=200         → **窗口只算输入**，发满值是安全的
 *   A=400, B=400  → 输入本身就超了，这一发的尺寸选错了，重挑
 *
 * `repro/08-overflow.ts` 已经量到 **628,676 token 仍然 HTTP 200**（那次 `max_tokens: 16`），
 * 所以 B 应当通过；它在这里是对照组，用来排除「是输入本身太大」。
 *
 * ## 2026-08-30：两个写死的数拿掉了，因为第三家把它们证伪了
 *
 * 这个探针原来写死两件事，两件都只对 DeepSeek 成立：
 *
 * 1. **`TARGET_INPUT = 700_000`**。它要满足的其实是一条不等式——
 *    `输入 < 窗口 < 输入 + 真实输出上限`。DeepSeek 的上限是 393,216，70 万正好落进去；
 *    智谱的上限只有 131,072，同样的 70 万会让 A 臂**根本超不了窗**，于是 A 是 200、
 *    探针得出「窗口只算输入」——**一个由尺寸选错造出来的错误结论，而且看起来完全正常。**
 *    现在按 `窗口 − 上限 + 5% 窗口` 算；代进 DeepSeek 得 707,788，与原来的 70 万同义。
 * 2. **「约 2 字符/token」**。那是十六进制填充在 DeepSeek 分词器下的比例；同一段填充在
 *    智谱是 **1.45 字符/token**（实测 40,000 字符 = 27,561 token）。差 38%，足够让上面
 *    那条不等式两边都踩空。现在**每次开跑先标定**：一发小的，从 `prompt_tokens` 反推比例。
 *    标定这一发要花钱（约 1 万 token），比量错一发 90 万便宜两个数量级。
 *
 * ## 结果：两家，两个相反的答案
 *
 * ```
 * deepseek-v4-flash  A=400, B=200  → 窗口算「输入 + max_tokens」
 * glm-5.3-flash      A=200         → 窗口只算输入
 * ```
 *
 * 智谱那一发逐字：`prompt_tokens = 971,327` 配 `max_tokens: 131,072`，两者之和
 * 1,102,399 **超过窗口 1,048,576，照样 200**。
 *
 * 🔴 **所以「要多少输出就少多少历史」不是一条关于窗口的普遍事实，是 DeepSeek 的事实。**
 * `OUTPUT_BUDGET` 那一整段论证（发满 393,216 会把有效输入压到 655,360、低于压缩阈值）
 * 只对 DeepSeek 成立。**这不是说那个额度该调大**——它今天是 16,384，对两家都安全，
 * 而安全的那一侧不需要理由；这是说**别把这条约束写成「窗口就是这样算的」**。
 * ⚠️ 第三家是这么被发现的，第四家也可能再翻一次：这个探针每接一家就该跑一遍。
 */
import { loadConfig } from "../src/config";
import { TRIGGER_FRACTION } from "../src/context/compaction";
import { resolveModelConfig } from "../src/models";

const config = loadConfig();
const resolved = resolveModelConfig(config);

/** 高熵十六进制填充，长度按字符给——字符与 token 的比例由 provider 的分词器说了算。 */
function filler(chars: number): string {
  const chunks: string[] = [];
  let seed = 0x9e3779b9;
  while (chunks.length * 17 < chars) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    chunks.push(
      seed.toString(16).padStart(8, "0") + (seed ^ 0x5bf03635).toString(16).padStart(8, "0"),
    );
  }
  return chunks.join(" ").slice(0, chars);
}

/**
 * 一发小的，问 provider 这段填充在**它的**分词器下是多少 token。
 *
 * 🔑 **不估，问。** 这个探针的两臂都建立在「输入正好落在窗口和上限之间」上，估歪 38%
 * （DeepSeek 与智谱的实际差距）就会让结论倒过来，而且倒得毫无征兆。
 */
async function charsPerToken(): Promise<number> {
  const sample = filler(40_000);
  const response = await fetch(`${resolved.baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${resolved.apiKey}`,
    },
    body: JSON.stringify({
      model: resolved.model,
      max_tokens: 1,
      messages: [{ role: "user", content: sample }],
    }),
  });
  const body = (await response.json()) as { usage?: { prompt_tokens?: number } };
  const tokens = body.usage?.prompt_tokens;
  if (tokens === undefined || tokens === 0) {
    process.stdout.write(`标定失败，无法继续：${JSON.stringify(body).slice(0, 300)}\n`);
    process.exit(1);
  }
  return sample.length / tokens;
}

const ratio = await charsPerToken();

/**
 * 要满足 `输入 < 窗口 < 输入 + 真实输出上限`，中间留 5% 窗口的余量。
 * 代进 DeepSeek（1,048,576 / 393,216）得 707,788——与这个探针原来写死的 70 万同义。
 */
const TARGET_INPUT =
  resolved.windowLimit - resolved.maxOutputTokens + Math.floor(resolved.windowLimit * 0.05);
const body = filler(Math.floor(TARGET_INPUT * ratio));

async function shoot(label: string, maxTokens: number) {
  const started = Date.now();
  const response = await fetch(`${resolved.baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${resolved.apiKey}`,
    },
    body: JSON.stringify({
      model: resolved.model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: `Reply with the single word OK.\n\n${body}` }],
    }),
  });
  const text = await response.text();
  const usage = (JSON.parse(text) as { usage?: { prompt_tokens?: number } }).usage;
  process.stdout.write(
    `\n${label}\n  max_tokens=${String(maxTokens)}  HTTP ${String(response.status)}  ${String(Date.now() - started)}ms\n`,
  );
  if (usage?.prompt_tokens !== undefined) {
    process.stdout.write(`  实际 prompt_tokens = ${String(usage.prompt_tokens)}\n`);
  } else {
    process.stdout.write(`  响应逐字：${text.slice(0, 400)}\n`);
  }
  return response.status;
}

/** 压缩阈值：溢出保护本该先于 provider 的拒绝触发的那条线。 */
const trigger = Math.floor(resolved.windowLimit * TRIGGER_FRACTION);

process.stdout.write(
  `model ${resolved.model} / window ${String(resolved.windowLimit)} / 真实输出上限 ${String(resolved.maxOutputTokens)}\n` +
    `标定 ${ratio.toFixed(4)} 字符/token（实测，不是估的）\n` +
    `目标输入 ≈ ${String(TARGET_INPUT)} token（${String(body.length)} 字符），压缩阈值 ${String(trigger)}\n`,
);

const a = await shoot("A · 输入 + 满输出上限（两者之和超窗口）", resolved.maxOutputTokens);

if (a === 200) {
  process.stdout.write(
    "\n✅ **窗口只算输入。** 发 provider 的满输出上限不会吃掉输入预算，\n" +
      `   压缩阈值 ${String(trigger)} 仍然是先触发的那一个。\n`,
  );
  process.exit(0);
}

const b = await shoot("B · 同一段输入 + 小输出上限（对照组）", 4_096);

process.stdout.write(
  b === 200
    ? "\n🔴 **窗口算「输入 + max_tokens」。** 发满值会把有效输入上限压到 " +
        `${String(resolved.windowLimit - resolved.maxOutputTokens)}，对比压缩阈值 ${String(trigger)}——\n` +
        "   低于阈值就意味着溢出保护来不及触发。**注册表发到线上的那个值必须留出余量。**\n"
    : "\n⚠️ 两发都被拒——这一发的输入尺寸本身就超了，判不了。换个更小的 TARGET_INPUT 重跑。\n",
);
