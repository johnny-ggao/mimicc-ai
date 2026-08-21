/**
 * 终端上那段灰字：一个回合有几段、它去了哪、哪条路径会印它？
 *
 * Run: `bun repro/28-what-reasoning-costs-the-screen.ts`   （不花钱，打本地 stub）
 *
 * 票 01（`.scratch/reasoning-display/issues/01-measure-the-flood.md`）要四个答案。
 * 这个探针答其中三个——**剩下那个（真实字符数 / 屏幕行数）必须打真 provider，
 * 单独判、单独花钱，不在这里。**
 *
 * 这里答的是**机械**的三个：
 *
 * 1. **一个回合有几段 reasoning？** 痛是「一段太长」还是「段数太多」，解不一样。
 * 2. 🔑 **reasoning 落不落盘、读不读得回来？** 票 04 整个建在这上面，
 *    而且图里已经查到底并明确标了「读代码读不出来」：codec 自己列的保真清单里
 *    **没有 `additional_kwargs`**（`src/checkpoint/messages.ts:31`），而 `toDict()`
 *    返回 `this.toJSON().kwargs`——走的是 **`lc_kwargs`（构造参数）不是当前字段值**
 *    （`node_modules/@langchain/core/dist/messages/base.js:164-168`）。
 *    流式**拼**出来的 AIMessage 属于哪一种，只有跑一次才知道。
 * 3. **活着那条路径印它，恢复那条路径印不印？** 图里靠读代码断言过「恢复那条不印」，
 *    这里把它变成量出来的。
 *
 * ## 为什么 stub 答得准（而不是"因为便宜所以将就"）
 *
 * 上面三问**问的全是我们自己这一侧的代码**：langchain 的流式拼装、我们的 codec、
 * 我们的两个渲染路径。provider 在这三问里只负责**发出 `reasoning_content` 这个字段**——
 * 而那一跳是 langchain 的一等公民，逐字写在
 * `node_modules/@langchain/openai/dist/converters/completions.js:264`：
 * `if (delta.reasoning_content !== void 0) additional_kwargs.reasoning_content = delta.reasoning_content`。
 * **stub 发同样的 delta，走的就是同一条代码路径。**
 *
 * ⚠️ 反过来说清楚 stub **答不了**什么：真模型一段思维链有多长、会不会每一跳都想、
 * 中英文比例如何。**那些是 provider 的行为，这里一个字都不许编。**
 *
 * ## 观测面：流出来的 chunk，不是终端字节
 *
 * 同 `repro/22` 的理由——`src/console/repl.ts` 的 `runTurn` 对 `"messages"` 这一路
 * 只做一件过滤（`fromModel`），然后读 `additional_kwargs["reasoning_content"]`。
 * 所以「终端上出现了什么」和「这一路流出了什么」是同一个问题，而后者不用起终端、不用抓 ANSI。
 * ⚠️ 这里**调用**出货用的 `fromModel` 与 `renderHistory`，不抄它们——抄一份的话，
 * 修在 `src/` 里而探针不动，这个脚本就从护栏变成摆设。
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { isAIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { createUniversalAgent, DURABILITY, RECURSION_LIMIT } from "../src/agents";
import { JsonlSaver } from "../src/checkpoint";
import { fromModel, renderHistory } from "../src/console";

const DIR = join(import.meta.dir, "..", ".mimicc", "probe-28");
const THREAD = "probe-28";

/**
 * 一段思维链里埋的记号。
 *
 * 用一个不会自然出现的串，因为后面三处判据全靠 grep：盘上的 JSONL、读回来的消息、
 * `renderHistory` 的输出。**「像思维链的文字」和「就是那段思维链」必须分得开**——
 * 前者在别的字段里也可能出现（比如它被当成正文重复了一遍），而那正是要区分的坏法之一。
 */
const MARK = "«PROBE-28-REASONING»";

/**
 * provider 发思维链的形状：`delta.reasoning_content`，与正文同一条流、不同字段。
 *
 * ⚠️ **`id` 必须每个响应都不同。** 一开始写死成 `"stub"`，结果一个回合里两次模型调用
 * 拼出的两条 AIMessage 撞成同一个 id，被 `messagesStateReducer` 按 id 合并掉——
 * state 里只剩一条，看起来像「最后一条回复没落盘」的产品 bug，实际是探针自己造的。
 * `repro/22` 的 stub 早就是一响应一 id，这条教训在那里已经写过一次。
 */
const chunk = (id: string, delta: Record<string, unknown>, finish: string | null = null) => ({
  id,
  object: "chat.completion.chunk",
  created: 0,
  model: "stub",
  choices: [{ index: 0, delta, finish_reason: finish }],
});

function sse(chunks: Record<string, unknown>[]): Response {
  const body = chunks
    .map((one) => `data: ${JSON.stringify(one)}\n\n`)
    .concat("data: [DONE]\n\n")
    .join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/**
 * 两次模型调用，因为**一个回合不等于一次模型调用**。
 *
 * 第一次：想一段，然后要调 `Read`（不设门的工具，`CONFIRMATION_POLICY` 里 `Read: false`，
 * 所以这个回合不会停在确认门上）。工具跑完，循环回到模型。
 * 第二次：再想一段，然后给正文。
 *
 * **「几段」这一问的机械答案就藏在这个结构里**：段数 = 模型调用次数 = 1 + 工具跳数。
 * ⚠️ 但**真模型会不会每一跳都想**是 provider 的行为，stub 证不了——这里只证
 * 「如果它每跳都想，终端上就是这么多段」。
 */
let calls = 0;
const server = Bun.serve({
  port: 0,
  fetch() {
    calls += 1;
    if (calls === 1) {
      return sse([
        chunk("lap-1", { role: "assistant", reasoning_content: `第一跳在想：${MARK} ` }),
        chunk("lap-1", { reasoning_content: "先看看 package.json 里有什么。" }),
        chunk("lap-1", {
          tool_calls: [
            {
              index: 0,
              id: "call_probe_28",
              type: "function",
              function: { name: "Read", arguments: JSON.stringify({ path: "package.json" }) },
            },
          ],
        }),
        chunk("lap-1", {}, "tool_calls"),
      ]);
    }
    return sse([
      chunk("lap-2", { role: "assistant", reasoning_content: `第二跳在想：${MARK} ` }),
      chunk("lap-2", { reasoning_content: "读到了，可以回答了。" }),
      chunk("lap-2", { content: "这是回复正文。" }),
      chunk("lap-2", {}, "stop"),
    ]);
  },
});

await rm(DIR, { recursive: true, force: true });

const agent = (checkpointer: JsonlSaver) =>
  createUniversalAgent({
    baseURL: `http://localhost:${String(server.port)}`,
    apiKey: "sk-stub",
    model: "stub",
    checkpointer,
    stateDir: DIR,
  });

const base = {
  streamMode: ["messages", "values"] as const,
  recursionLimit: RECURSION_LIMIT,
  durability: DURABILITY,
  configurable: { thread_id: THREAD },
};

// ── 跑一个回合，按 repl.ts 那一路收 ────────────────────────────────────────────

/**
 * 终端上依次出现的东西。`repl.ts` 就是照这个顺序写 stdout 的。
 *
 * ⚠️ **必须两条流都收。** 只收 `"messages"` 是错的观测面：屏幕上把两段灰字**隔开**的
 * 那条工具调用行走的是 `"values"` 流（`repl.ts` 的 `renderStructure`，它自己先
 * `closeDim()` 再打那一行）。只看 messages 的话，两跳的思维链会连成一段——
 * 一开始就是这么误报的。
 */
type Event = { kind: "reasoning" | "content" | "call" | "result"; text: string };
const events: Event[] = [];
/** 与 `renderStructure` 同一条水位线：只处理这次新出现的消息。 */
let rendered = 0;

const graph = agent(new JsonlSaver(DIR));
const stream = (await graph.stream(
  { messages: [new HumanMessage("随便问一句")] },
  base,
)) as AsyncIterable<[string, unknown]>;

for await (const [mode, payload] of stream) {
  if (mode === "values") {
    // ↓ renderStructure 的那一路，逐字：按水位线取新消息，ai 的每个 tool_call 一行，
    //   tool 结果一行。这两种行都会打断屏幕上的灰字块。
    const values = payload as { messages?: BaseMessage[] };
    if (values.messages === undefined) continue;
    for (const message of values.messages.slice(rendered)) {
      const type = message.getType();
      if (type === "ai") {
        const calls = (message as { tool_calls?: { name: string }[] }).tool_calls ?? [];
        for (const call of calls) events.push({ kind: "call", text: call.name });
      }
      if (type === "tool") events.push({ kind: "result", text: "" });
    }
    rendered = values.messages.length;
    continue;
  }
  const [one] = payload as [BaseMessage, unknown];
  // ↓ repl.ts:959-974 的那一路，逐字：先问是不是模型的话，再分别读两个字段。
  if (!fromModel(one)) continue;
  const reasoning = one.additional_kwargs["reasoning_content"];
  if (typeof reasoning === "string" && reasoning.length > 0) {
    events.push({ kind: "reasoning", text: reasoning });
  }
  if (typeof one.content === "string" && one.content.length > 0) {
    events.push({ kind: "content", text: one.content });
  }
}

server.stop(true);

/**
 * 「段」= 终端上一个连续的灰字块。
 *
 * `repl.ts` 开 dim、写 reasoning，**直到正文到达才关 dim 并空两行**。所以屏幕上的
 * 一段，就是一串没有被正文打断的 reasoning chunk。判据必须按这个折，
 * **不能按 chunk 数**——那是网络分片，不是人看到的东西。
 */
const blocks: string[] = [];
for (const event of events) {
  if (event.kind !== "reasoning") {
    // 正文、工具调用行、工具结果行——三者都会让 `repl.ts` 关掉 dim。
    if (blocks.length > 0 && blocks[blocks.length - 1] !== "") blocks.push("");
    continue;
  }
  if (blocks.length === 0 || blocks[blocks.length - 1] === "") blocks.push(event.text);
  else blocks[blocks.length - 1] += event.text;
}
const segments = blocks.filter((one) => one !== "");

// ── 落盘那一问 ───────────────────────────────────────────────────────────────

const onDisk = await Bun.$`grep -c reasoning_content ${DIR}/${THREAD}.jsonl`
  .quiet()
  .nothrow()
  .text()
  .then((out) => Number.parseInt(out.trim(), 10) || 0);
const markOnDisk = await Bun.$`grep -c ${MARK} ${DIR}/${THREAD}.jsonl`
  .quiet()
  .nothrow()
  .text()
  .then((out) => Number.parseInt(out.trim(), 10) || 0);

/**
 * 读回来那一问，**用一个全新的 saver**。
 *
 * 同一个进程里复用刚才那个 saver 会作弊：它手上可能还留着内存里的消息对象，
 * 那样测的就不是「盘上那份读回来还在不在」。冷读才是 `--resume` 真正走的那条路。
 */
const cold = agent(new JsonlSaver(DIR));
const state = await cold.getState({ configurable: { thread_id: THREAD } });
const restored = (state.values as { messages?: BaseMessage[] }).messages ?? [];
const restoredReasoning = restored
  .filter((one) => isAIMessage(one))
  .map((one) => one.additional_kwargs["reasoning_content"])
  .filter((one): one is string => typeof one === "string" && one.length > 0);

// ── 两条渲染路径那一问 ────────────────────────────────────────────────────────

const replayed = renderHistory(restored);
const liveShows = segments.some((one) => one.includes(MARK));
const replayShows = replayed.includes(MARK);

// ── 报告 ─────────────────────────────────────────────────────────────────────

const out = (line: string) => process.stdout.write(`${line}\n`);

out("=== 一个回合里，终端上依次出现了什么 ===");
out(`  模型被调用 ${String(calls)} 次（1 次 + ${String(calls - 1)} 个工具跳）`);
out(`  灰字段数：${String(segments.length)}`);
for (const [index, one] of segments.entries()) {
  out(`    段 ${String(index + 1)}：${String(one.length)} 字 · ${one.replaceAll("\n", "⏎")}`);
}

out("");
out("=== 判据 ①：段数 = 模型调用次数？ ===");
out(
  `  ${segments.length === calls ? "✅" : "🔴"} 段数 ${String(segments.length)} ${segments.length === calls ? "==" : "!="} 模型调用次数 ${String(calls)}`,
);
out("  → 若成立：痛随工具跳数线性增长，「把每一段整形」治不了「段数太多」。");

out("");
out("=== 判据 ②：reasoning 落盘了吗、读得回来吗？（票 04 建在这上面）===");
out(`  盘上 ${THREAD}.jsonl 含 reasoning_content 的行：${String(onDisk)} ${onDisk > 0 ? "✅" : "🔴"}`);
out(`  盘上含记号 ${MARK} 的行：              ${String(markOnDisk)} ${markOnDisk > 0 ? "✅" : "🔴"}`);
out(
  `  冷读回来、仍带 reasoning 的 AIMessage：  ${String(restoredReasoning.length)} 条 ${restoredReasoning.length > 0 ? "✅" : "🔴"}`,
);
out("  ⚠️ 两问都要看：在盘上但读不回来、读得回来但没写盘，是两种不同的坏法。");

out("");
out("=== 判据 ③：两条渲染路径印不印它？（本图判据 2）===");
out(`  活着那条（repl.ts 的 messages 流）：  ${liveShows ? "🔴 印" : "✅ 不印"}`);
out(`  恢复那条（renderHistory）：           ${replayShows ? "🔴 印" : "✅ 不印"}`);
out(
  `  → ${liveShows !== replayShows ? "🔴 两条路径不一致——这正是本图判据 2 要治的" : "✅ 一致"}`,
);
