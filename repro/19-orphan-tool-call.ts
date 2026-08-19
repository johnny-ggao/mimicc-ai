/**
 * 一个 `tool_calls` 后面没有 tool 结果的历史，**真 provider 认不认**？
 *
 * Run: `bun repro/19-orphan-tool-call.ts`   ⚠️ **花钱**（三次小请求，合计 < $0.001）
 *
 * `repro/18` 造出过这种历史：一条 session 停在确认门上，如果拿旧 id 起来直接敲一句话，
 * 消息会变成 `[human, ai(tool_calls), human, ai]` —— 那个悬着的调用**从没跑过、
 * 也从没被拒绝**，就挂在历史里。但 `repro/18` 打的是 stub，**stub 不挑**。
 *
 * ⚠️ **这个探针今天不挡任何东西**：出货路径造不出 orphan（恢复时永远先摆门，
 * 见 `src/console/repl.ts` 的 `adopt`）。它要把一条**靠不变式挡着的风险**变成已知量：
 * 如果 provider 会 400，那么将来任何一条造出 orphan 的路就不是「难看」而是**当场崩**，
 * 那道防线就必须有；如果 provider 不在乎，那道防线永远不用写。
 *
 * ## 三个用例，后两个是为了让第三个能被读懂
 *
 * ① **平的**（`human, ai("done"), human`）——证明 key 与 endpoint 是通的。
 * ② **完整的工具轮**（`human, ai(tool_calls), tool, human`）——控制组。
 *    ⚠️ 它存在是因为一个已知的混淆：`src/agents/model.ts` 记着 DeepSeek
 *    *only insists [on the reasoning echo] when the assistant round carries a
 *    tool_call whose id it did not itself sign* —— 而这里三个用例的 tool_call id
 *    **全是我们编的**。所以 ③ 失败时，只有 ② 成功才能说明失败的原因是 orphan。
 * ③ **orphan**（`human, ai(tool_calls), human`）——要问的那一个。
 *
 * 读法写在最后的判据里：**②成功且③失败 = 悬空的 tool_call 是硬错误；
 * 两个都失败 = 这个探针没答上来**（原因是编造的 tool_call id，不是 orphan）。
 */
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";

import { createChatModel } from "../src/agents/model";
import { loadConfig } from "../src/config";
import { resolveModelConfig } from "../src/models";

const CALL_ID = "call_orphan_probe";

const toolCall = {
  name: "Bash",
  args: { command: "echo gate" },
  id: CALL_ID,
  type: "tool_call" as const,
};

const CASES = [
  {
    name: "① 平的（控制组：key 与 endpoint 通不通）",
    messages: () => [
      new HumanMessage("说一个字：好"),
      new AIMessage({ content: "好" }),
      new HumanMessage("再说一个字"),
    ],
  },
  {
    name: "② 完整的工具轮（控制组：编造的 tool_call id 本身认不认）",
    messages: () => [
      new HumanMessage("跑一下"),
      new AIMessage({ content: "", tool_calls: [toolCall] }),
      new ToolMessage({ content: "gate", tool_call_id: CALL_ID }),
      new HumanMessage("接着聊"),
    ],
  },
  {
    name: "③ orphan：tool_calls 后面没有 tool 结果",
    messages: () => [
      new HumanMessage("跑一下"),
      new AIMessage({ content: "", tool_calls: [toolCall] }),
      new HumanMessage("接着聊"),
    ],
  },
];

const config = loadConfig();
const model = resolveModelConfig(config);
process.stdout.write(
  `provider=${model.provider} model=${model.model} baseURL=${model.baseURL}\n\n`,
);

const results: { name: string; ok: boolean; detail: string; retries: number }[] = [];

for (const probe of CASES) {
  let retries = 0;
  const chat = createChatModel({
    model: model.model,
    apiKey: model.apiKey,
    baseURL: model.baseURL,
    // 小上限：这个探针问的是「收不收」，不是模型会说什么。
    maxTokens: 16,
    // README 记过一次坑：带失败码的响应会被 AsyncCaller 重试六次。这里不压制它
    // （压不了，`createChatModel` 没暴露 maxRetries），但**数出来**——
    // 「一次 400 打了服务器七遍」本身是要报告的事实。
    onFailedAttempt: () => {
      retries += 1;
    },
  });

  process.stdout.write(`=== ${probe.name} ===\n`);
  try {
    const reply = await chat.invoke(probe.messages());
    const text = typeof reply.content === "string" ? reply.content : "(非字符串)";
    results.push({ name: probe.name, ok: true, detail: text.slice(0, 60), retries });
    process.stdout.write(`  收了。回复：${text.slice(0, 60)}\n\n`);
  } catch (error) {
    const status = (error as { status?: number }).status;
    const message = (error as { message?: string }).message ?? String(error);
    results.push({
      name: probe.name,
      ok: false,
      detail: `${status === undefined ? "" : `${String(status)} `}${message.slice(0, 200)}`,
      retries,
    });
    process.stdout.write(
      `  拒了。${status === undefined ? "" : `status=${String(status)} `}${message.slice(0, 200)}\n\n`,
    );
  }
}

process.stdout.write("---------------------------------------------------\n\n");
for (const result of results) {
  process.stdout.write(
    `${result.ok ? "✅" : "❌"} ${result.name}` +
      `${result.retries > 0 ? `（重试 ${String(result.retries)} 次）` : ""}\n   ${result.detail}\n\n`,
  );
}

const [flat, whole, orphan] = results;
process.stdout.write("=== 判据 ===\n");
if (flat?.ok !== true) {
  process.stdout.write("  ⚠️ 连①都没过 —— key / endpoint / 余额的问题，这次什么都没答上。\n");
} else if (whole?.ok !== true) {
  process.stdout.write(
    "  ⚠️ ②就没过 —— 失败的原因是**我们编造的 tool_call id**，不是 orphan。\n" +
      "     这个探针没答上来；要答得换成一条真跑出来的历史（例如从 .mimicc 里取一条）。\n",
  );
} else if (orphan?.ok === true) {
  process.stdout.write(
    "  🔑 orphan **被接受**。悬空的 tool_call 不是硬错误，只是难看。\n" +
      "     那道防线不用写；出货路径造不出 orphan 这条不变式仍然值得守，但它不再是悬崖边。\n",
  );
} else {
  process.stdout.write(
    "  🔴 orphan **被拒**，而完整的工具轮被接受 —— 悬空的 tool_call 是**硬错误**。\n" +
      "     任何一条造出它的路都是当场崩，不是难看。恢复路径「永远先摆门」那条不变式\n" +
      "     从此是承重的，且需要一道防线兜住它（例如恢复时发现悬空调用就先收口）。\n",
  );
}
