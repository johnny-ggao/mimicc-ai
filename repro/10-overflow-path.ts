/** 票 10 兜底路径的诊断：溢出被接住了吗，接住之后切点动了吗。stub，不花钱。 */
import { HumanMessage } from "@langchain/core/messages";
import { createUniversalAgent, RECURSION_LIMIT } from "../src/agent";
import type { WindowEvent } from "../src/window";

let promptTokens = 1;
let overflowNext = false;
let summaryBroken = false;
let calls = 0;
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as { messages: { content?: unknown }[] };
    const summarising = body.messages.some(
      (m) => typeof m.content === "string" && m.content.includes("<conversation>"),
    );
    calls += 1;
    process.stdout.write(`  call#${String(calls)} ${summarising ? "SUMMARY" : "agent"} msgs=${String(body.messages.length)}${overflowNext && !summarising ? "  -> 400" : ""}\n`);
    if (summaryBroken && summarising) {
      return Response.json({
        id: "empty", object: "chat.completion", created: 0, model: "stub",
        choices: [], usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
      });
    }
    if (overflowNext && !summarising) {
      overflowNext = false;
      return Response.json(
        { error: { message: "This model's maximum context length is 1048576 tokens.", type: "invalid_request_error" } },
        { status: 400 },
      );
    }
    return Response.json({
      id: `c${String(calls)}`, object: "chat.completion", created: 0, model: "stub",
      choices: [{ index: 0, message: { role: "assistant", content: summarising ? "summary" : `answer ${String(calls)}` }, finish_reason: "stop" }],
      usage: { prompt_tokens: promptTokens, completion_tokens: 1, total_tokens: promptTokens },
    });
  },
});

const events: WindowEvent[] = [];
const graph = createUniversalAgent({
  baseURL: `http://localhost:${String(server.port)}`,
  apiKey: "k", model: "stub",
  window: { limit: 2000, keepFraction: 0.05 },
  onWindow: (e) => { events.push(e); process.stdout.write(`  [event] ${JSON.stringify(e)}\n`); },
});
const bulky = (l: string) => `${l} ${"padding ".repeat(40)}`;
const cfg = { recursionLimit: RECURSION_LIMIT, configurable: { thread_id: "t" } };

promptTokens = 1900;
for (const label of ["first", "second"]) {
  process.stdout.write(`turn ${label}\n`);
  await graph.invoke({ messages: [new HumanMessage(bulky(label))] }, cfg);
}
process.stdout.write("turn third (溢出一次)\n");
overflowNext = true;
try {
  await graph.invoke({ messages: [new HumanMessage(bulky("third"))] }, cfg);
  process.stdout.write("  完成，没有抛错\n");
} catch (e) {
  process.stdout.write(`  抛了: ${String(e).slice(0, 100)}\n`);
}
process.stdout.write("\n=== 另起一条 thread：摘要从一开始就坏 ===\n");
summaryBroken = true;
const cfg2 = { recursionLimit: RECURSION_LIMIT, configurable: { thread_id: "broken" } };
for (const label of ["one", "two"]) {
  process.stdout.write(`turn ${label}\n`);
  const t0 = Date.now();
  try {
    await graph.invoke({ messages: [new HumanMessage(bulky(label))] }, cfg2);
    process.stdout.write(`  完成 ${String(Date.now() - t0)}ms\n`);
  } catch (e) {
    process.stdout.write(`  抛了（${String(Date.now() - t0)}ms）: ${String(e).slice(0, 90)}\n`);
  }
}


process.stdout.write(`\nevents: ${JSON.stringify(events)}\n`);
server.stop(true);
