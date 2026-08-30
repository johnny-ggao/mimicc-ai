/**
 * 窗口撑爆时，那个错误**以什么形状**到我们手里？——`isOverflow` 认不认得出来。
 *
 * 运行：`bun repro/53-does-the-overflow-reach-us.ts`
 * **不花 token**：唯一那一发是 400，一个 token 都不会生成、不会计费。
 * （代价只有一个 8MB 左右的请求体，跑之前先看一眼你在什么网络上。）
 *
 * ## 为什么问
 *
 * `src/context/compaction.ts` 的溢出保护**自己不认错误**：它只问
 * `ContextOverflowError.isInstance`，而这个类由 langchain 抛，langchain 认溢出
 * 靠三句写死的英文（`@langchain/openai/dist/utils/client.js:5-9`）：
 *
 * ```
 * context_length_exceeded / Input tokens exceed the configured limit
 * exceeds the context window / maximum context length
 * ```
 *
 * DeepSeek 恰好命中第三句——**那是当年核过的，不是假定的**。第三家 provider 是
 * 用来检验「恰好」还成不成立的：2026-08-30 直接对智谱发过一发超长请求，返回
 *
 * ```json
 * {"error":{"code":"1261","message":"Prompt exceeds max length"}}
 * ```
 *
 * 三句一句都不沾。**但那一发是裸 fetch，不是我们的调用栈。**「provider 说了什么」
 * 和「我们的类手里剩下什么」是两个问题，这个探针只答后者——先分开，再决定改哪边。
 *
 * ## 观测面
 *
 * 用 `createChatModel`（真的那个类，不是 `ChatOpenAI`）发一发必然超窗的请求，把
 * 抛出来的东西整条 cause 链摊开：类名、`status`、`code`、`message`，末尾问一句
 * `isOverflow` 的判决。**判据是最后那一行**，其余是为了让「该往哪儿修」看得见。
 *
 * ⚠️ 它答不了「摘要路径能不能救回来」——那要一条真的满窗对话。这里只问认不认得出。
 *
 * ## 结果（2026-08-30，glm-5.3-flash / coding plan 端点）
 *
 * ```
 * [0] BadRequestError status=400 code=1261
 *     message: 400 Prompt exceeds max length
 * ```
 *
 * `overflowCodes` 补进注册表**之前**判决是 `false`——一次教科书式的超窗，摘要路径
 * 一次都不会跑。补进之后是 `true`。**这个探针要一直能跑**：它守的是「注册表里那个
 * 码还对不对」，而不是「当年修过一次」。
 */
import { ContextOverflowError } from "@langchain/core/errors";

import { loadConfig } from "../src/config";
import { createChatModel } from "../src/agents/model";
import { isOverflow } from "../src/context/compaction";
import { resolveModelConfig } from "../src/models";

const model = resolveModelConfig(loadConfig());

// 每 token 按 4 字符估，再乘 2 —— 估歪了也仍然稳稳超窗，而超窗就是 400，多估不花钱。
const filler = "hello world ".repeat(Math.ceil((model.windowLimit * 8) / 12));

process.stdout.write(
  `provider ${model.provider} / ${model.model} — ${model.baseURL}\n` +
    `窗口上限 ${model.windowLimit.toLocaleString("en-US")} tokens，` +
    `请求体 ${(filler.length / 1_000_000).toFixed(1)}MB\n\n`,
);

let caught: unknown;
try {
  await createChatModel({
    model: model.model,
    apiKey: model.apiKey,
    baseURL: model.baseURL,
    ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
  }).invoke(filler);
  process.stdout.write("🔴 没抛——这一发没有超窗，探针问的问题没被问到。\n");
  process.exit(1);
} catch (error) {
  caught = error;
}

process.stdout.write("cause 链：\n");
for (
  let current: unknown = caught, depth = 0;
  depth < 10 && current !== null && current !== undefined;
  depth += 1
) {
  const e = current as {
    constructor?: { name?: string };
    status?: unknown;
    code?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  const bits = [
    `  [${String(depth)}] ${e.constructor?.name ?? "?"}`,
    e.status === undefined ? "" : ` status=${String(e.status)}`,
    e.code === undefined ? "" : ` code=${String(e.code)}`,
    ContextOverflowError.isInstance(current) ? "  ← ContextOverflowError" : "",
  ].join("");
  process.stdout.write(
    `${bits}\n      message: ${String(e.message).slice(0, 200).replace(/\n/g, " ")}\n`,
  );
  current = typeof current === "object" ? e.cause : undefined;
}

const verdict = isOverflow(caught, model.overflowCodes);
process.stdout.write(
  `\n判决：isOverflow = ${String(verdict)}\n` +
    (verdict
      ? "✅ 认得出来——摘要路径会被触发。\n"
      : "🔴 认不出来——`compaction.ts` 的溢出保护对这个 provider 是空转的：\n" +
        "   请求直接失败，摘要一次都不会跑。\n"),
);
