/**
 * 两条反序列化路径的信任边界差别 —— 票 08 的持久化调研。
 *
 * Run: `bun repro/08-load-trust-boundary.ts`
 *
 * 流水账是**工作目录里的一个文件**。按 docs/adr/0001 的同一条判断——谁能提交这个仓库谁就能
 * 写它——它是仓库内容，不是我们写的东西。那么把它读回来的那个函数，能被这个文件指使到
 * 什么程度？不发请求。
 *
 * A · `mapStoredMessagesToChatMessages` —— 对 6 个写死的 type 做 switch，`default: throw`
 * B · `load()` —— 按行里的 `id: [...]` **查表实例化那个类并调用它的构造函数**
 */
import { AIMessage, mapStoredMessagesToChatMessages, type BaseMessage } from "@langchain/core/messages";
import { load } from "@langchain/core/load";

const honest = new AIMessage({ id: "a1", content: "它叫 mimicc-ai。" });

// 一条被手改过的流水账行：类路径换成一个根本不是消息的类。
const tampered = JSON.stringify({
  lc: 1,
  type: "constructor",
  id: ["langchain_core", "prompts", "chat", "ChatPromptTemplate"],
  kwargs: { promptMessages: [], inputVariables: [] },
});

process.stdout.write("=== B · load()：喂它一条类路径被换掉的行 ===\n");
try {
  const got = await load<BaseMessage>(tampered);
  process.stdout.write(`  没有拒绝。造出来的是: ${got.constructor.name}\n`);
  process.stdout.write(`  它是 BaseMessage 吗: ${String("getType" in got)}\n`);
} catch (error) {
  process.stdout.write(`  拒绝了: ${String(error).slice(0, 120)}\n`);
}

process.stdout.write("\n=== A · mapStoredMessagesToChatMessages：喂它同样的意图 ===\n");
try {
  const got = mapStoredMessagesToChatMessages([
    { type: "ChatPromptTemplate", data: { content: "x" } } as never,
  ]);
  process.stdout.write(`  没有拒绝。造出来的是: ${got[0].constructor.name}\n`);
} catch (error) {
  process.stdout.write(`  拒绝了: ${String(error).slice(0, 120)}\n`);
}

process.stdout.write("\n=== 两条路对「诚实的一行」都正常 ===\n");
const a = mapStoredMessagesToChatMessages([{ type: "ai", data: { content: honest.content } } as never]);
const b = await load<BaseMessage>(JSON.stringify(honest));
process.stdout.write(`  A: ${a[0].constructor.name}   B: ${b.constructor.name}\n`);

process.stdout.write(
  "\n=== 可达面 ===\n" +
    "  A: 6 个写死的 type（human/ai/system/function/tool/generic），default 直接 throw\n" +
    "     —— @langchain/core/dist/messages/utils.js:186-200\n" +
    "  B: 命名空间 langchain_core / langchain 下**全部** Serializable 类；\n" +
    "     其余包（如 @langchain/openai 的 ChatOpenAI）要调用方自己传 optionalImportsMap 才可达\n" +
    "     —— @langchain/core/dist/load/index.js:125-152\n",
);
