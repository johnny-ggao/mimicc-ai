/**
 * 一条消息写成 jsonl 再读回来，还是原来那条吗？—— 票 08 的持久化调研。
 *
 * Run: `bun repro/08-jsonl-roundtrip.ts`
 *
 * 两条路头对头。不发请求。
 *
 * A · `mapChatMessagesToStoredMessages` / `mapStoredMessagesToChatMessages`
 *     —— 旧 ChatMessageHistory 的存储格式，`{type, data}`。
 * B · `JSON.stringify(msg)`（`Serializable.toJSON()`）/ `load(text)`
 *     —— **官方文档在 Messages · Serialization 一节推荐的那条**（Python 写作 `dumpd`/`load`；
 *     JS 没有 `dumpd`，因为 `Serializable` 自带 `toJSON`，`JSON.stringify` 就是它）。
 *     ⚠️ 文档自带的警告：*load() instantiates objects and can trigger side effects during
 *     deserialization. Never call load() on data from an untrusted or unauthenticated source.*
 */
import {
  AIMessage, HumanMessage, ToolMessage,
  mapChatMessagesToStoredMessages, mapStoredMessagesToChatMessages,
  type BaseMessage,
} from "@langchain/core/messages";
import { load } from "@langchain/core/load";

const original: BaseMessage[] = [
  new HumanMessage({ id: "h1", content: "读一下 package.json" }),
  new AIMessage({
    id: "a1",
    content: "",
    tool_calls: [{ id: "call_1", name: "Read", args: { path: "package.json" } }],
    response_metadata: { model_name: "deepseek-v4-flash", finish_reason: "tool_calls" },
    usage_metadata: { input_tokens: 2386, output_tokens: 18, total_tokens: 2404,
      input_token_details: { cache_read: 2304 } },
  }),
  new ToolMessage({ id: "t1", tool_call_id: "call_1", name: "Read", content: "1  {\n2    \"name\": \"mimicc-ai\"\n" }),
  new AIMessage({ id: "a2", content: "它叫 mimicc-ai。" }),
];

function score(label: string, lines: string[], restored: BaseMessage[]) {
  const checks: [string, boolean][] = [
    ["条数", restored.length === original.length],
    ["类型", restored.every((m, i) => m.getType() === original[i].getType())],
    ["id", restored.every((m, i) => m.id === original[i].id)],
    ["content", restored.every((m, i) => JSON.stringify(m.content) === JSON.stringify(original[i].content))],
    ["tool_calls", JSON.stringify((restored[1] as AIMessage).tool_calls) === JSON.stringify((original[1] as AIMessage).tool_calls)],
    ["tool_call_id", (restored[2] as ToolMessage).tool_call_id === (original[2] as ToolMessage).tool_call_id],
    ["name(ToolMessage)", restored[2].name === original[2].name],
    ["response_metadata", JSON.stringify(restored[1].response_metadata) === JSON.stringify(original[1].response_metadata)],
    ["usage_metadata", JSON.stringify((restored[1] as AIMessage).usage_metadata) === JSON.stringify((original[1] as AIMessage).usage_metadata)],
    ["还是 BaseMessage 实例", restored.every((m) => m instanceof Object && typeof m.getType === "function")],
  ];
  const ok = checks.filter(([, v]) => v).length;
  process.stdout.write(`\n${label}\n`);
  for (const [name, v] of checks) process.stdout.write(`  ${name.padEnd(22)} ${v ? "保真" : "**丢了**"}\n`);
  process.stdout.write(`  ── ${String(ok)}/${String(checks.length)}，四行合计 ${String(lines.reduce((s, l) => s + l.length, 0))} 字符\n`);
  return lines;
}

// A
const linesA = mapChatMessagesToStoredMessages(original).map((m) => JSON.stringify(m));
score("A · mapChatMessagesToStoredMessages ⇄ mapStoredMessagesToChatMessages",
  linesA, mapStoredMessagesToChatMessages(linesA.map((l) => JSON.parse(l) as never)));

// B —— 官方推荐那条
const linesB = original.map((m) => JSON.stringify(m));
const restoredB: BaseMessage[] = [];
for (const line of linesB) restoredB.push(await load<BaseMessage>(line));
score("B · JSON.stringify(Serializable.toJSON) ⇄ load()  ← 官方文档推荐", linesB, restoredB);

process.stdout.write(`\nA 的第二行：\n${linesA[1]}\n`);
process.stdout.write(`\nB 的第二行：\n${linesB[1]}\n`);
