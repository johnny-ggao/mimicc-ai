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
 */
import { loadConfig } from "../src/config";
import { resolveModelConfig } from "../src/models";

const config = loadConfig();
const resolved = resolveModelConfig(config);

/** 高熵十六进制填充，约 2 字符/token——理由见 `repro/08-overflow.ts` 的注释。 */
function filler(targetTokens: number): string {
  const chars = targetTokens * 2;
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

const TARGET_INPUT = 700_000;
const body = filler(TARGET_INPUT);

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

process.stdout.write(
  `model ${resolved.model} / window ${String(resolved.windowLimit)} / 真实输出上限 ${String(resolved.maxOutputTokens)}\n` +
    `目标输入 ≈ ${String(TARGET_INPUT)} token（${String(body.length)} 字符）\n`,
);

const a = await shoot("A · 输入 + 满输出上限（两者之和超窗口）", resolved.maxOutputTokens);

if (a === 200) {
  process.stdout.write(
    "\n✅ **窗口只算输入。** 发 provider 的满输出上限不会吃掉输入预算，\n" +
      "   压缩阈值 838,861 仍然是先触发的那一个。\n",
  );
  process.exit(0);
}

const b = await shoot("B · 同一段输入 + 小输出上限（对照组）", 4_096);

process.stdout.write(
  b === 200
    ? "\n🔴 **窗口算「输入 + max_tokens」。** 发满值会把有效输入上限压到 " +
        `${String(resolved.windowLimit - resolved.maxOutputTokens)}，低于压缩阈值 838,861——\n` +
        "   也就是说溢出保护会来不及触发。**注册表发到线上的那个值必须留出余量。**\n"
    : "\n⚠️ 两发都被拒——这一发的输入尺寸本身就超了，判不了。换个更小的 TARGET_INPUT 重跑。\n",
);
