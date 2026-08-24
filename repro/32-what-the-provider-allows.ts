/**
 * 每个注册型号的真实输出上限是多少？——注册表 `maxOutputTokens` 的证据指针。
 *
 * 运行：`bun repro/32-what-the-provider-allows.ts`
 * **不花钱**：每一发都是 400，一个 token 都不会被计费。
 *
 * ## 为什么是撞错误，不是查接口
 *
 * 2026-08-24 核过：DeepSeek 的 `GET /models` 只返回 `id` / `object` / `owned_by`,
 * **没有任何上限字段**。所以「主动通过 API 获取」这条路在 provider 侧不存在——
 * 能拿到真实值的唯一方式，是拿一个不可能的 `max_tokens` 去撞，从拒绝里把数读出来：
 *
 *   {"error":{"message":"Invalid max_tokens value, the valid range of max_tokens is [1, 393216]", …}}
 *
 * 🔴 **正因如此，这个探针是探针，不是启动时的一步。** 它依赖错误文案的措辞：
 * provider 改一个字，解析就静默失效。把它放进上线路径，等于把一条真实约束挂在
 * 一句没有契约的英文上。**注册表里存静态值、这里存重新核它的办法**，是这两者之间
 * 唯一诚实的分工。
 *
 * ## 怎么读
 *
 * 打印每个型号的「注册表写的」与「provider 说的」。两者不一致就是注册表该改了——
 * ⚠️ **但先看清楚是哪一侧变了**：provider 调整上限，和我们抄错一个数，长得一模一样。
 *
 * 只跑当前 `.env` 选中的那个 provider 的型号——另一家的 key 不在环境里就够不着。
 */
import { loadConfig } from "../src/config";
import { PROVIDERS, type ProviderId } from "../src/models";

const config = loadConfig();
const provider = PROVIDERS[config.LLM_PROVIDER as ProviderId] as
  | (typeof PROVIDERS)[ProviderId]
  | undefined;

if (provider === undefined) {
  process.stdout.write(`unknown LLM_PROVIDER "${config.LLM_PROVIDER}"\n`);
  process.exit(1);
}

const key = config[provider.keyEnvVar] ?? config.LLM_API_KEY;
if (key === undefined) {
  process.stdout.write(
    `no key for "${provider.id}": set ${provider.keyEnvVar}. ` +
      `另一家的型号这次核不了——那不是失败，是够不着。\n`,
  );
  process.exit(1);
}

/** 从拒绝文案里把上界抠出来。抠不到就原样打印,别猜。 */
function ceilingFrom(body: string): number | undefined {
  const match = /range of max_(?:tokens|completion_tokens) is \[\d+,\s*(\d+)\]/.exec(body);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

// `LLM_BASE_URL` wins when set, so `scripts/probe-smoke.ts` can point this at its
// local stub and keep the smoke run off the network entirely. The stub answers
// 200 with no error body, the ceiling parses as "读不出", and the probe still
// proves the thing smoke asks about: that it lives long enough to send a request.
const baseURL = config.LLM_BASE_URL ?? provider.baseURL;

process.stdout.write(`provider ${provider.id} — ${baseURL}\n\n`);
process.stdout.write("型号                              注册表    provider    一致?\n");

let drift = 0;
for (const [model, spec] of Object.entries(provider.models)) {
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 999_999_999,
    }),
  });
  const body = await response.text();
  const actual = ceilingFrom(body);

  if (actual === undefined) {
    process.stdout.write(
      `${model.padEnd(32)}${String(spec.maxOutputTokens).padStart(9)}${"读不出".padStart(11)}    ⚠️\n` +
        `    status ${String(response.status)}: ${body.slice(0, 160)}\n`,
    );
    drift++;
    continue;
  }

  const agrees = actual === spec.maxOutputTokens;
  if (!agrees) drift++;
  process.stdout.write(
    `${model.padEnd(32)}${String(spec.maxOutputTokens).padStart(9)}${String(actual).padStart(12)}${(agrees ? "    ✅" : "    🔴").padStart(9)}\n`,
  );
}

process.stdout.write(
  drift === 0
    ? "\n✅ 注册表和 provider 一致。\n"
    : `\n🔴 ${String(drift)} 个对不上——改注册表之前先弄清是哪一侧变了。\n`,
);
