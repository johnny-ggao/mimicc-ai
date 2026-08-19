/**
 * `beforeAgent` 注入的那条消息，会不会被 `streamMode: "messages"` 当成模型的话流出来？
 *
 * Run: `bun repro/22-injected-messages-hit-the-message-stream.ts`   （不花钱，打本地 stub）
 *
 * 症状是看得见的：第一个回合的回复正文**前面**会先出现整段
 * `<skill-catalog>…</skill-catalog>`。已知它**不是 session 线造成的**（在 HEAD 上
 * `git stash` 掉全部改动，用同一个 stub 照样出现）。
 *
 * ## 观测面：流出来的 chunk，不是终端字节
 *
 * `src/console/repl.ts` 的 `runTurn` 对 `"messages"` 这一路只做一件过滤，剩下的只要
 * `content` 是非空字符串就 `markdown.push()`。所以「终端上出现了什么」和「这一路流出了
 * 什么」是同一个问题，而后者不用起终端、不用抓 ANSI。
 *
 * ⚠️ 这里**调用**出货用的那个判定（`fromModel`），不抄它。抄一份的话，修在 repl 里而
 * 探针不动，这个脚本会一直红着——它就从护栏变成了摆设。
 *
 * ## 两个变量，一次问完
 *
 * 注入是同一个形状用了两次（`skills/inject.ts` 与 `context/instructions.ts`：
 * 固定 id 的 `HumanMessage`，`beforeAgent` 每回合原样返回，靠 `messagesStateReducer`
 * 按 id 合并去重）。所以**两个都开**：如果只有 skill 目录漏，那是 skill 那一侧的事；
 * 如果两个都漏，问题在「注入」这个形状本身，修点也就不在 `skills/`。
 *
 * ## 为什么要跑两个回合
 *
 * 推测的机制在 `@langchain/langgraph@1.4.9` 的
 * `dist/pregel/messages.js`——`StreamMessagesHandler` 的类文档逐字
 * *Collects messages from (1) chat model stream events and (2) node outputs*：
 * `handleChainEnd`（:88-102）把节点**输出**里的每条 BaseMessage 都发出来，
 * `dedupe=true`；而 `handleChainStart`（:80-85）先把节点**输入**里的每条消息记进
 * `seen`。注入的那条在第一回合不在输入里 → 发得出去；第二回合它已经在
 * `state.messages` 里 → 被 `seen` 挡掉。
 *
 * **所以这个探针的判据是「第一回合漏、第二回合不漏」**，不是「漏没漏」。
 * 只跑一个回合的话，任何一种解释都能对上。
 */
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { createUniversalAgent, DURABILITY, RECURSION_LIMIT } from "../src/agents";
import { fromModel } from "../src/console";
import { SkillRegistry } from "../src/skills";

const completion = (id: string, message: Record<string, unknown>, finish: string) => ({
  id,
  object: "chat.completion",
  created: 0,
  model: "stub",
  choices: [{ index: 0, delta: message, message, finish_reason: finish }],
});

function sse(chunks: Record<string, unknown>[]): Response {
  const body = chunks
    .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
    .concat("data: [DONE]\n\n")
    .join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

let seen = 0;
const server = Bun.serve({
  port: 0,
  fetch() {
    seen += 1;
    // 两段，因为真回复是流式来的：一条 chunk 的话就分不清「模型的话」和「整条消息
    // 被当成 chunk 发出来」了。
    return sse([
      completion(`stub-${String(seen)}`, { role: "assistant", content: "答案" }, ""),
      completion(`stub-${String(seen)}`, { content: "。" }, "stop"),
    ]);
  },
});

const graph = createUniversalAgent({
  baseURL: `http://localhost:${String(server.port)}`,
  apiKey: "sk-stub",
  model: "stub",
  // 两个注入都开。目录只要非空，内容不重要——问的是它会不会被打出来。
  skills: new SkillRegistry([
    {
      name: "probe-skill",
      description: "一个假技能，只为让目录非空",
      modelInvokable: true,
      dir: import.meta.dir,
      body: "",
      files: [],
    },
  ]),
  projectInstructions: "PROBE-PROJECT-INSTRUCTIONS",
});

const base = {
  streamMode: ["messages", "values"] as const,
  recursionLimit: RECURSION_LIMIT,
  durability: DURABILITY,
  configurable: { thread_id: "probe-22" },
};

/** 一个回合里，`runTurn` 会喂给 markdown 渲染器的那些字符串。 */
async function renderedProse(text: string): Promise<string[]> {
  const out: string[] = [];
  const stream = (await graph.stream({ messages: [new HumanMessage(text)] }, base)) as AsyncIterable<
    [string, unknown]
  >;
  for await (const [mode, payload] of stream) {
    if (mode !== "messages") continue;
    // ↓ repl.ts 的那一路，逐字：先问是不是模型的话，再把非空的 content 交给渲染器。
    const [chunk] = payload as [BaseMessage, unknown];
    if (!fromModel(chunk)) continue;
    if (typeof chunk.content === "string" && chunk.content.length > 0) out.push(chunk.content);
  }
  return out;
}

const turns = [await renderedProse("第一句"), await renderedProse("第二句")];

server.stop(true);

const leaked = (prose: string[], needle: string): boolean =>
  prose.some((piece) => piece.includes(needle));

process.stdout.write("=== 每个回合被当成「回复正文」打出去的东西 ===\n");
for (const [index, prose] of turns.entries()) {
  process.stdout.write(`\n  回合 ${String(index + 1)}：${String(prose.length)} 段\n`);
  for (const piece of prose) {
    const head = piece.replaceAll("\n", "⏎").slice(0, 72);
    process.stdout.write(`    · ${head}${piece.length > 72 ? "…" : ""}\n`);
  }
}

const catalog = turns.map((prose) => leaked(prose, "<skill-catalog>"));
const project = turns.map((prose) => leaked(prose, "PROBE-PROJECT-INSTRUCTIONS"));

process.stdout.write("\n=== 判据 ===\n");
process.stdout.write(
  `  skill 目录：      回合1 ${catalog[0] ? "🔴 漏" : "✅ 没漏"}   回合2 ${catalog[1] ? "🔴 漏" : "✅ 没漏"}\n`,
);
process.stdout.write(
  `  项目 instructions：回合1 ${project[0] ? "🔴 漏" : "✅ 没漏"}   回合2 ${project[1] ? "🔴 漏" : "✅ 没漏"}\n`,
);

if (catalog[0] === true && catalog[1] === false) {
  process.stdout.write(
    "\n  🔴 **复现，而且只在第一个回合。** 这钉死了机制：`handleChainEnd` 把节点输出里的\n" +
      "     每条消息都往 `\"messages\"` 上发，只有已经在节点**输入**里的才被 `seen` 挡掉。\n" +
      `     注入的消息第一回合不在输入里，所以漏；第二回合在，所以不漏。\n` +
      `     ${project[0] === true ? "项目 instructions 同样漏 —— 问题在「注入」这个形状，不在 skills/。" : "⚠️ 但项目 instructions 没漏 —— 两个注入有差别，去比。"}\n`,
  );
} else if (catalog[0] === true) {
  process.stdout.write("\n  🔴 漏了，但两个回合都漏 —— 上面那套去重的解释不成立，换读法。\n");
} else {
  process.stdout.write(
    "\n  ✅ **回归护栏**：注入的消息不再被当成回复正文。`\"messages\"` 这一路只放模型的话\n" +
      "     （`getType() === \"ai\"`）过去，别的一律由 `\"values\"` 那一路按结构渲染。\n",
  );
}
