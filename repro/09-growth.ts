/**
 * 票 09 的验收判据：落盘量随回合数怎么涨。
 *
 * Run: `bun repro/09-growth.ts`
 *
 * 两个对照：**存量**（`MessagesValue` 全量通道 + 每步一份完整快照，也就是
 * `createAgent` + `MemorySaver` 的形状）与 **JsonlSaver**。量的都是「落盘那一侧」——
 * 包一层数 `put()`/`putWrites()` 收到的字节，对 jsonl 则直接量文件。
 * 不花钱。
 */
import { mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { MemorySaver, MessagesValue, START, END, StateGraph, StateSchema } from "@langchain/langgraph";
import type { Checkpoint, CheckpointMetadata, PendingWrite } from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";

import { JsonlSaver } from "../src/checkpoint";

const S = new StateSchema({ messages: MessagesValue });
const BODY = "这是一条大约两百字符的回答，让消息本体不至于比 id 还小，否则量出来的只是 id 列表。".repeat(3);

/** 存量形状：每个检查点存一份完整 channel_values。 */
class CountingMemorySaver extends MemorySaver {
  bytes = 0;
  override async put(c: RunnableConfig, cp: Checkpoint, m: CheckpointMetadata, v: Record<string, number | string>) {
    this.bytes += JSON.stringify(cp.channel_values).length;
    return super.put(c, cp, m, v);
  }
  override async putWrites(c: RunnableConfig, w: PendingWrite[], t: string) {
    this.bytes += JSON.stringify(w).length;
    return super.putWrites(c, w, t);
  }
}

async function drive(turns: number, saver: MemorySaver | JsonlSaver) {
  const g = new StateGraph(S)
    .addNode("echo", () => ({ messages: [new AIMessage(BODY)] }))
    .addEdge(START, "echo")
    .addEdge("echo", END)
    .compile({ checkpointer: saver as never });
  const cfg = { configurable: { thread_id: "t" } };
  for (let i = 0; i < turns; i++) {
    await g.invoke({ messages: [new HumanMessage(`问题 ${String(i)} ${BODY}`)] }, cfg);
  }
}

async function dirBytes(dir: string) {
  let total = 0;
  for (const f of await readdir(dir)) total += (await stat(join(dir, f))).size;
  return total;
}

process.stdout.write("回合    存量(全量快照)   比值      JsonlSaver   比值      改善\n");
let prevFull = 0;
let prevJsonl = 0;
for (const turns of [4, 8, 16, 32, 64]) {
  const full = new CountingMemorySaver();
  await drive(turns, full);

  const dir = await mkdtemp(join(tmpdir(), "mimicc-growth-"));
  await drive(turns, new JsonlSaver(dir));
  const jsonl = await dirBytes(dir);

  process.stdout.write(
    String(turns).padStart(4) +
      String(full.bytes).padStart(16) +
      (prevFull ? (full.bytes / prevFull).toFixed(2) : "-").padStart(8) + "x" +
      String(jsonl).padStart(14) +
      (prevJsonl ? (jsonl / prevJsonl).toFixed(2) : "-").padStart(8) + "x" +
      `${(full.bytes / jsonl).toFixed(1)}x`.padStart(10) + "\n",
  );
  prevFull = full.bytes;
  prevJsonl = jsonl;
}
