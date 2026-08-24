/**
 * 能不能在 `wrapModelCall` 里改这一发的 `max_tokens`？—— `.scratch/output-budget/` 票 01 的地基。
 *
 * 运行：`bun repro/34-can-a-middleware-change-max-tokens.ts`
 * **不花钱**：全程打本地 stub，一个 token 都不出门。
 *
 * ## 为什么这一问决定整张票的形状
 *
 * 今天 `maxTokens` 是**构造期**烤进那一个 `ChatOpenAI` 实例的
 * （`src/agents/loop.ts:309,728`，`createModel` 全仓库只调一次）。要按剩余窗口每请求重算，
 * 就得有一个每请求的入口。`wrapModelCall` 是唯一候选——**它成不成立，读代码读不出来。**
 *
 * 读到的三件事（`node_modules`，langchain 1.5.5 / @langchain/openai）：
 *
 * 1. `ModelRequest.model` 是可写字段，handler 收整个 request
 *    （`langchain/dist/agents/nodes/types.d.ts:18`）。
 * 2. 🔑 **工具是在 middleware 之后才绑的**——`AgentNode.js:143-145` 依次
 *    `validateLLMHasNoBoundTools(request.model)` → `#bindTools(request.model, …)`。
 *    所以换掉 model **不会丢工具**，但换进去的**必须是没 bind 过工具的**。
 * 3. 🔴 `@langchain/openai/dist/chat_models/completions.js:60-61` 读的是
 *    **`this.maxTokens`（实例字段）**，不是 call options。**所以 `.bind({maxTokens})` 改不了线上的值。**
 *
 * 于是三个候选，这个探针把它们放到线上分个真假：
 *
 *   A  `handler({...request, model: 另一个实例})`   —— 预期成立
 *   B  `handler({...request, model: model.bind({maxTokens})})` —— 预期**不成立**（读的是实例字段）
 *   C  不动 model，只在 handler 之外传 options —— `wrapModelCall` 没有这个入口，不测
 *
 * ## 观测面
 *
 * 本地 stub 把收到的请求体逐字记下来，**判据是线上的 `max_tokens` 到底是几**——
 * 不是「有没有报错」，也不是「类型过不过」。
 */
import { HumanMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { ChatOpenAI } from "@langchain/openai";
import { createAgent, createMiddleware, type AnyAgentMiddleware } from "langchain";
import { z } from "zod";

interface Seen {
  max_tokens?: number;
  max_completion_tokens?: number;
  tools?: unknown[];
}
const seen: Seen[] = [];

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    seen.push((await request.json()) as Seen);
    return Response.json({
      id: "stub",
      object: "chat.completion",
      created: 0,
      model: "stub",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  },
});

const baseURL = `http://localhost:${String(server.port)}`;
function makeModel(maxTokens: number): ChatOpenAI {
  return new ChatOpenAI({
    model: "stub-model",
    apiKey: "k",
    configuration: { baseURL },
    maxTokens,
  });
}

const CONSTRUCTED = 4096;
const WANTED = 12345;

/** A：换一个 maxTokens 不同的实例。 */
function swapInstance(): AnyAgentMiddleware {
  return createMiddleware({
    name: "SwapInstance",
    wrapModelCall: (request, handler) => handler({ ...request, model: makeModel(WANTED) }),
  }) as AnyAgentMiddleware;
}

/** B：不换实例，只 bind 一个 maxTokens 上去。 */
function bindOption(): AnyAgentMiddleware {
  return createMiddleware({
    name: "BindOption",
    wrapModelCall: (request, handler) =>
      handler({
        ...request,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        model: (request.model as any).bind({ maxTokens: WANTED }),
      }),
  }) as AnyAgentMiddleware;
}

/**
 * 🔑 **注册一个真工具，不是空数组。**
 *
 * 这是这个探针的第二问，而且是会真正咬人的那一问：`AgentNode.js:145` 是
 * `#bindTools(request.model, …)` ——**绑到中间件交回去的那个 model 上**。
 * 换实例之后工具还在不在，`tools: []` 是测不出来的。判据是 stub 收到的请求体里有没有 `tools`。
 */
const PROBE_TOOL = tool(async () => "ok", {
  name: "probe_tool",
  description: "does nothing",
  schema: z.object({ q: z.string() }),
});

async function run(label: string, middleware: AnyAgentMiddleware[]): Promise<Seen> {
  seen.length = 0;
  const graph = createAgent({ model: makeModel(CONSTRUCTED), tools: [PROBE_TOOL], middleware });
  await graph.invoke({ messages: [new HumanMessage("hi")] });
  const got = seen[0] ?? {};
  process.stdout.write(
    `${label.padEnd(30)}max_tokens=${String(got.max_tokens).padStart(6)}  tools=${String(got.tools?.length ?? 0)}\n`,
  );
  return got;
}

process.stdout.write(`构造期写死 ${String(CONSTRUCTED)}，中间件想要 ${String(WANTED)}\n\n`);

const base = await run("对照 · 没有中间件", []);
const a = await run("A · 换一个实例", [swapInstance()]);

let b: Seen | undefined;
try {
  b = await run("B · bind({maxTokens})", [bindOption()]);
} catch (error) {
  process.stdout.write(
    `B · bind({maxTokens})              抛了：${error instanceof Error ? error.message : String(error)}\n`,
  );
}

server.stop(true);

const aWorks = a.max_tokens === WANTED;
const bWorks = b?.max_tokens === WANTED;

process.stdout.write(
  `\n判读\n` +
    `  对照组线上是 ${String(base.max_tokens)}${base.max_tokens === CONSTRUCTED ? " ✅ 构造期的值确实上线了" : " 🔴 连对照组都不对，下面两行不可用"}\n` +
    `  A 换实例      ${aWorks ? "✅ 成立——middleware 能决定这一发的 max_tokens" : "🔴 不成立"}\n` +
    `  A 的工具      ${a.tools?.length === 1 ? "✅ 还在——换实例不丢工具，AgentNode 在中间件之后才绑" : "🔴 丢了！换实例会丢工具绑定"}\n` +
    `  B bind        ${bWorks ? "⚠️ 也成立（与读码结论矛盾，重新读 completions.js:60-61）" : "✅ 不成立——见上面那行它抛的什么"}\n` +
    `\n${aWorks && a.tools?.length === 1 ? "→ 票 01 的形状成立：每请求换实例，工具由 AgentNode 在之后绑。" : "→ 票 01 要重画形状。"}\n`,
);
