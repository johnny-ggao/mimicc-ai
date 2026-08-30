/**
 * `clear_thinking: false` —— 智谱「建议」的那个开关，值不值这个价？
 *
 * 运行：`bun repro/54-what-clear-thinking-costs.ts`
 * **花 token**：四发小请求（两臂 × 两回合），合计约 1.5 万 in / 几百 out。
 *
 * ## 为什么问
 *
 * `glm-5.3-flash` 的思考**关不掉**（`thinking.type` 仅支持 `enabled`），所以问题不是
 * 开不开，而是**跨回合留不留**：`clear_thinking` 缺省 `true`（清掉），模型卡建议改成
 * `false`（留着）——语义上等于 Moonshot 的 `thinking.keep: "all"`。
 *
 * 🔴 **「文档建议」不是判据，因为文档不付这笔钱。** 留着思考链意味着每一回合的历史里
 * 多背一份 CoT，而这仓库量过它的价钱（`repro/29`：思考链是输出的大头）。这个程序今天
 * 一个 `thinking` 字段都不发，走的就是缺省的「清掉」。要改，得先看见改了什么。
 *
 * ## 观测面
 *
 * 同一段两回合工具对话跑两遍，只差一个字段：
 *
 * - 臂 A：不发 `thinking`（今天的行为）
 * - 臂 B：发 `thinking: {type:"enabled", clear_thinking:false}`
 *
 * 每回合记 `prompt_tokens` / `completion_tokens` / `reasoning_tokens` /
 * `cached_tokens`，外加第二回合**成没成**。判据有两条,顺序不能反：
 * **先看第二回合会不会报错**（那是「必须发」的证据），**再看多花了多少**（那是
 * 「值不值」的证据）。只有前者为真时，后者才不重要。
 *
 * ⚠️ 它答不了「答案变好没有」——那要一个有对错的任务和多次采样，是另一个探针。
 * 这里只回答代价和可行性。
 *
 * ## 结果（2026-08-30，glm-5.3-flash / coding plan 端点）
 *
 * ```
 * 臂 A（不发）  回合 1  in 178  cached   0  out 56  reasoning 44
 *               回合 2  in 255  cached 128  out 49  reasoning 15   ✅ 200
 * 臂 B（false） 回合 1  in 178  cached 128  out 39  reasoning 27
 *               回合 2  in 238  cached 128  out 69  reasoning 37   ✅ 200
 * ```
 *
 * **两条都答完了：不是必需的（两臂第二回合都 200），也没量出代价。** 于是保持缺省——
 * 今天这个程序一个 `thinking` 字段都不发，文档的「建议」不足以让它开始发。
 *
 * ⚠️ **这个结论的有效范围是「短对话」。** 两回合、两百多 token 的历史，留不留思考链
 * 的差额被采样噪声盖住了（臂 B 的 in 反而更低）。真要看见月租，得是一段长对话——
 * 那时再跑一次这个探针，别拿这里的数去替它回答。
 */
import { loadConfig } from "../src/config";
import { resolveModelConfig } from "../src/models";

const model = resolveModelConfig(loadConfig());

const TOOLS = [
  {
    type: "function",
    function: {
      name: "Read",
      description: "Read a file from disk",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
];

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}
interface Reply {
  status: number;
  message?: {
    role: string;
    content?: string;
    reasoning_content?: string;
    tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  };
  usage?: Usage;
  raw: string;
}

async function ask(
  messages: unknown[],
  thinking: Record<string, unknown> | undefined,
): Promise<Reply> {
  const response = await fetch(`${model.baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${model.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: model.model,
      messages,
      tools: TOOLS,
      max_tokens: 2048,
      ...(thinking === undefined ? {} : { thinking }),
    }),
  });
  const raw = await response.text();
  if (!response.ok) return { status: response.status, raw };
  const body = JSON.parse(raw) as {
    choices: { message: Reply["message"] }[];
    usage?: Usage;
  };
  return {
    status: response.status,
    ...(body.choices[0]?.message === undefined ? {} : { message: body.choices[0].message }),
    ...(body.usage === undefined ? {} : { usage: body.usage }),
    raw,
  };
}

function line(label: string, reply: Reply): string {
  if (reply.usage === undefined) {
    return `  ${label.padEnd(10)} status ${String(reply.status)} — ${reply.raw.slice(0, 120)}`;
  }
  const u = reply.usage;
  return (
    `  ${label.padEnd(10)}` +
    `in ${String(u.prompt_tokens ?? 0).padStart(6)}` +
    `  cached ${String(u.prompt_tokens_details?.cached_tokens ?? 0).padStart(6)}` +
    `  out ${String(u.completion_tokens ?? 0).padStart(5)}` +
    `  reasoning ${String(u.completion_tokens_details?.reasoning_tokens ?? 0).padStart(5)}`
  );
}

async function arm(
  name: string,
  thinking: Record<string, unknown> | undefined,
): Promise<void> {
  process.stdout.write(`\n${name}\n`);
  const history: unknown[] = [
    { role: "system", content: "You are a careful coding agent. Use the tools you are given." },
    { role: "user", content: "Read package.json and tell me the version field." },
  ];

  const first = await ask(history, thinking);
  process.stdout.write(`${line("回合 1", first)}\n`);
  const call = first.message?.tool_calls?.[0];
  if (call === undefined) {
    process.stdout.write("  🔴 第一回合没有工具调用——这一臂问不下去了。\n");
    return;
  }

  // 原样回传整条 assistant 消息（含 reasoning_content），这正是被测的那件事。
  history.push(first.message, {
    role: "tool",
    tool_call_id: call.id,
    content: '{"name":"mimicc-ai","version":"0.1.0"}',
  });

  const second = await ask(history, thinking);
  process.stdout.write(`${line("回合 2", second)}\n`);
  process.stdout.write(
    second.status === 200
      ? `  ✅ 第二回合 200，答复 ${String(second.message?.content?.length ?? 0)} 字\n`
      : `  🔴 第二回合 ${String(second.status)}\n`,
  );
}

process.stdout.write(`${model.provider} / ${model.model} — ${model.baseURL}\n`);
await arm("臂 A：不发 thinking（今天的行为）", undefined);
await arm("臂 B：thinking.clear_thinking = false（文档建议）", {
  type: "enabled",
  clear_thinking: false,
});
process.stdout.write(
  "\n读法：先比两臂第二回合成没成——都成，说明这个字段不是必需的；\n" +
    "再比 in 那一列——差额就是「留着思考链」每回合的月租。\n",
);
