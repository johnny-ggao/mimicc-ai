/** 摘要一直失败时，一个回合还能不能走完。stub，不花钱。 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HumanMessage } from "@langchain/core/messages";
import { createUniversalAgent, RECURSION_LIMIT } from "../src/agent";
import { JsonlSaver } from "../src/checkpoint";

let calls = 0;
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as { messages: { content?: unknown }[] };
    const summarising = body.messages.some(
      (m) => typeof m.content === "string" && m.content.includes("<conversation>"),
    );
    calls += 1;
    process.stdout.write(`  call#${String(calls)} ${summarising ? "SUMMARY(坏)" : "agent"}\n`);
    if (summarising) {
      return Response.json({
        id: "empty", object: "chat.completion", created: 0, model: "stub",
        choices: [], usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
      });
    }
    return Response.json({
      id: `c${String(calls)}`, object: "chat.completion", created: 0, model: "stub",
      choices: [{ index: 0, message: { role: "assistant", content: `answer ${String(calls)}` }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1900, completion_tokens: 1, total_tokens: 1900 },
    });
  },
});

const graph = createUniversalAgent({
  baseURL: `http://localhost:${String(server.port)}`,
  apiKey: "k", model: "stub",
  checkpointer: new JsonlSaver(mkdtempSync(join(tmpdir(), "mimicc-sf-"))),
  projectInstructions: "<project-instructions path='AGENTS.md'>be terse</project-instructions>",
  window: { limit: 2000, keepFraction: 0.05 },
  onWindow: (e) => process.stdout.write(`  [event] ${JSON.stringify(e)}\n`),
});
const bulky = (l: string) => `${l} ${"padding ".repeat(40)}`;
const cfg = { recursionLimit: RECURSION_LIMIT, configurable: { thread_id: "t" } };

for (const label of ["first", "second"]) {
  process.stdout.write(`turn ${label}\n`);
  const t0 = Date.now();
  try {
    await graph.invoke({ messages: [new HumanMessage(bulky(label))] }, cfg);
    process.stdout.write(`  完成 ${String(Date.now() - t0)}ms\n`);
  } catch (e) {
    process.stdout.write(`  抛了（${String(Date.now() - t0)}ms）: ${String(e).slice(0, 120)}\n`);
  }
}
server.stop(true);
