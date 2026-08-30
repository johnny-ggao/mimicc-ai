/**
 * 注册表写的窗口上限，是不是**低报**了？
 *
 * 运行：`bun repro/55-is-the-registered-window-the-real-one.ts`
 * **注册表没低报时不花钱**（那一发是 400）；低报了才花——而且正好花掉一个窗口的输入。
 * 代价的不对称是这个探针的形状本身，见下。
 *
 * ## 为什么需要它
 *
 * `windowLimit` 是溢出保护的唯一输入，而它有两种来路：**实测**（DeepSeek 的
 * 1,048,576，`repro/08` 撞出来的）和**文档**。文档这条来路会含糊：智谱所有页面都只写
 * 「1M」，从不写整数，而 1,000,000 与 1,048,576 差 48,576 token。
 *
 * 🔴 **两个方向的错不等价。** 写低了，摘要早跑一点，浪费；写高了，请求直接失败——
 * 而在一个 langchain 认不出其溢出码的 provider 上（`repro/53`），那次失败连摘要都不会
 * 触发。所以注册表在拿不准时**故意取低**，而这个探针问的正是那句「取低」有没有取过头。
 *
 * ## 观测面
 *
 * 拿一段比注册值**略大**的输入去撞，`max_tokens` 给 1（把输出这边的干扰降到最小）：
 *
 *   400 → 真实上限 < 这一发的大小 → **注册值没有低报**（它可能仍偏低，但没低到这里）
 *   200 → 真实上限 ≥ 这一发的大小 → **注册值低报了**，而且这一发的输入照价计费
 *
 * ⚠️ **它给的是上界,不是等号。** 单独一发只能说「真实值不超过这里」；要把区间的下沿也
 * 钉住，需要一发**成功的**大请求——`repro/33` 的 B 臂正好是那一发，跑完它两边就都有了。
 *
 * ⚠️ **贵的那一边正好是有信息的那一边。** 这是这类边界探针的通病：证实预期免费，
 * 推翻预期收费。所以别为了「更准」把裕度调小——调小只会让 400 变成 200。
 *
 * ## 结果（2026-08-30，zhipu-cn / glm-5.3-flash）
 *
 * 跑了两次，中间改了一次注册表：
 *
 * ```
 * 注册值 1,000,000 → 打 1,020,000：HTTP 200，实际 prompt_tokens = 1,021,379   🔴 低报
 * 注册值 1,048,576 → 打 1,069,547：HTTP 400 {"code":"1261",…}                 ✅ 没低报
 * ```
 *
 * 所以真实窗口落在 **[1,021,379, 1,069,547)**，即 **1,048,576 = 2^20**——
 * 与智谱写「128K」而 API 参考写 131,072 是同一套写法。
 *
 * 🔴 **注册表原来取的「低读法」是错的，而且是这个探针唯一贵的那一发才问出来的。**
 * 取低的理由本身没错（在一个溢出码认不出来的 provider 上，读高了是请求直接失败）——
 * 错的是把它当成结论留在注册表里。**保守的猜测仍然是猜测。**
 */
import { loadConfig } from "../src/config";
import { resolveModelConfig } from "../src/models";

const resolved = resolveModelConfig(loadConfig());

/** 高熵十六进制填充，长度按字符给——比例由 provider 的分词器说了算。 */
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

async function shoot(chars: number, maxTokens: number) {
  const response = await fetch(`${resolved.baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${resolved.apiKey}`,
    },
    body: JSON.stringify({
      model: resolved.model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: filler(chars) }],
    }),
  });
  const text = await response.text();
  const usage = (JSON.parse(text) as { usage?: { prompt_tokens?: number } }).usage;
  return { status: response.status, tokens: usage?.prompt_tokens, text };
}

// 标定：同一段填充在 DeepSeek 是约 2 字符/token，在智谱是 1.45——差 38%，不能估。
const sample = await shoot(40_000, 1);
if (sample.tokens === undefined || sample.tokens === 0) {
  process.stdout.write(`标定失败：${sample.text.slice(0, 300)}\n`);
  process.exit(1);
}
const ratio = 40_000 / sample.tokens;

// 裕度 2%：够大，能盖住标定误差；够小，仍然落在两个候选读法之间（1,000,000 与 1,048,576
// 之间差 4.86%，2% 的一发落在 1,020,000 附近，两头都不贴边）。
const target = Math.floor(resolved.windowLimit * 1.02);

process.stdout.write(
  `model ${resolved.model} — 注册表窗口 ${resolved.windowLimit.toLocaleString("en-US")}\n` +
    `标定 ${ratio.toFixed(4)} 字符/token（实测）\n` +
    `这一发 ≈ ${target.toLocaleString("en-US")} token（注册值 +2%）\n\n`,
);

const shot = await shoot(Math.floor(target * ratio), 1);
process.stdout.write(
  `HTTP ${String(shot.status)}` +
    (shot.tokens === undefined ? "" : `  实际 prompt_tokens = ${String(shot.tokens)}`) +
    "\n",
);

if (shot.status === 200) {
  process.stdout.write(
    `\n🔴 **注册表低报了。** 真实上限至少 ${String(shot.tokens ?? target)}，` +
      `注册值 ${String(resolved.windowLimit)} 比它小。\n` +
      "   改注册表之前先想清楚：低报只是浪费，所以这不是紧急的；\n" +
      "   但既然已经花了这一发的钱，把测到的下界写进注释，别让下一个人再花一次。\n",
  );
} else {
  process.stdout.write(
    `\n✅ **注册值没有低报。** 真实上限落在注册值 ${String(resolved.windowLimit)} 与\n` +
      `   这一发 ${String(target)} 之间，拒绝逐字：${shot.text.slice(0, 160)}\n` +
      "   ⚠️ 这是上界。区间的下沿要靠一发成功的大请求——`repro/33` 的 B 臂。\n",
  );
}
