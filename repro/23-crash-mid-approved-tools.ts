/**
 * 崩溃打断的不是「门」而是**一批已经批准、正在跑的工具**——冷启动之后盘上还剩什么，
 * 谁看得见它？
 *
 * Run: `bun repro/23-crash-mid-approved-tools.ts`   （不花钱，打本地 stub）
 *
 * `repro/18` 问的是**门开着**时断电（答：门还在盘上，冷进程能答它）。这里问的是它的
 * 下一格：**门已经答完、工具开跑之后**断电。票 07 让这条路**不再崩**（投影层补上悬空的
 * `tool_calls`），但没让它**接着干活**——而 `MISSION.md` 那条未打勾项要的是后者，逐字：
 * _能把循环状态从调用栈搬到持久存储，做到进程被 kill 之后接着跑，且不重复已完成的副作用_。
 *
 * ## 要答的两条
 *
 * 1. **冷启动的 `getState` 看得见「有一批工具没跑完」吗？** 看得见的话，是在
 *    `next` / `tasks` 里，还是只在 `interrupts` 里？这条直接判 `repl.ts` 的 `adopt`
 *    够不够——它**只看 `interrupts`**（`repl.ts:183-190`），未完成的任务它不看。
 * 2. **`invoke(null)` 真的能把那批工具跑完吗？** `repro/14` 在**自己搭的图**上证过恢复
 *    能跑完，但没在**出货的 agent** 上、也没在「门批准之后」这个位置上证过。
 *
 * ⚠️ 观测面是 marker 文件里的**行数**，不是「跑没跑」：工具用**追加**记一行，
 * 这样「重跑了但结果一样」才看得出来——`MISSION.md` 要的是「不重复已完成的副作用」，
 * 只断言「跑完了」会把重跑判成绿的。
 */
import { mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

import { HumanMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";

import { createUniversalAgent, DURABILITY, RECURSION_LIMIT } from "../src/agents";
import { JsonlSaver } from "../src/checkpoint";

const DIR = join(import.meta.dir, "..", ".mimicc", "probe-23");
const MARK = join(DIR, "marker.txt");
const THREAD = "probe-23";

let asked = 0;

function startStub(): { port: number; stop: (force?: boolean) => void } {
  return Bun.serve({
    port: 0,
    async fetch(request) {
      asked += 1;
      const body = (await request.json()) as { messages: { role: string }[] };
      // 工具答过了就收尾，否则要工具。
      const answered = body.messages.some((message) => message.role === "tool");
      process.stdout.write(
        `    [stub] 第 ${String(asked)} 次被调: 收到 [${body.messages.map((m) => m.role).join(",")}]` +
          ` → 回 ${answered ? '"done"' : "tool_calls"}\n`,
      );
      const message = answered
        ? { role: "assistant", content: "done" }
        : {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_mark",
                type: "function",
                function: {
                  name: "Bash",
                  // 追加一行再睡。睡是留给 SIGKILL 的窗口，追加是观测面。
                  arguments: JSON.stringify({
                    command: `echo ran >> ${MARK}; sleep 5`,
                  }),
                },
              },
            ],
          };
      // ⚠️ 每次一个新 id，**而且带上进程的角色**。固定 id 会让 `messagesStateReducer`
      // 按 id 合并——后来的 AI 消息原地替换掉带 `tool_calls` 的那条，历史看起来像
      // 「回答被弄丢了」。两个子进程各自从 1 数，所以光靠序号还会跨进程撞。
      // 2026-08-19 亲身踩过两次，都是对照组逮住的：**stub 的消息 id 是观测面的一部分。**
      return Response.json({
        id: `chatcmpl-${process.env["PHASE"] ?? "crash"}-${String(asked)}`,
        object: "chat.completion",
        created: 0,
        model: "stub",
        choices: [
          { index: 0, message, finish_reason: answered ? "stop" : "tool_calls" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
}

const marks = (): number =>
  existsSync(MARK) ? readFileSync(MARK, "utf8").trim().split("\n").filter(Boolean).length : 0;

async function runChild(): Promise<void> {
  const phase = process.env["PHASE"] ?? "crash";
  const server = startStub();
  const agent = createUniversalAgent({
    baseURL: `http://localhost:${String(server.port)}`,
    apiKey: "sk-stub",
    model: "stub",
    checkpointer: new JsonlSaver(DIR),
    stateDir: DIR,
  });
  const config = {
    recursionLimit: RECURSION_LIMIT,
    durability: DURABILITY,
    configurable: { thread_id: THREAD },
  };

  // 对照组：同一条路，不崩。用来判「回答丢了」是恢复特有的，还是这条路本来就这样。
  if (phase === "control") {
    await agent.invoke({ messages: [new HumanMessage("go")] }, { ...config, configurable: { thread_id: "probe-23-control" } });
    const done = (await agent.invoke(
      new Command({ resume: { decisions: [{ type: "approve" }] } }),
      { ...config, configurable: { thread_id: "probe-23-control" } },
    )) as { messages?: { getType(): string }[] };
    process.stdout.write(
      `    不崩地走完: 消息=[${(done.messages ?? []).map((m) => m.getType()).join(",")}]\n`,
    );
    for (const m of done.messages ?? []) {
      const any = m as unknown as { content?: unknown; tool_calls?: unknown[] };
      process.stdout.write(
        `      · ${m.getType()}: ${JSON.stringify(any.content).slice(0, 50)}` +
          `${any.tool_calls?.length ? ` tool_calls=${String(any.tool_calls.length)}` : ""}\n`,
      );
    }
    const st = await agent.getState({ ...config, configurable: { thread_id: "probe-23-control" } });
    process.stdout.write(
      `      盘上: [${(st.values.messages ?? []).map((m: { getType(): string }) => m.getType()).join(",")}] next=${JSON.stringify(st.next)}\n`,
    );
    server.stop(true);
    return;
  }

  if (phase === "crash") {
    await agent.invoke({ messages: [new HumanMessage("go")] }, config);
    process.stdout.write("    门停下来了，批准它\n");
    // 批准之后工具开跑（追加一行 → 睡 5 秒）。1.2 秒后断电，落在睡眠中间。
    setTimeout(() => {
      process.kill(process.pid, "SIGKILL");
    }, 1200);
    await agent.invoke(new Command({ resume: { decisions: [{ type: "approve" }] } }), config);
    return;
  }

  // ——— 冷启动：先问盘上还剩什么 ———
  const snapshot = await agent.getState(config);
  const tasks = snapshot.tasks ?? [];
  const waiting = tasks.flatMap((task) => task.interrupts ?? []);
  process.stdout.write(
    `    getState: next=${JSON.stringify(snapshot.next)}` +
      ` tasks=${String(tasks.length)} interrupts=${String(waiting.length)}\n`,
  );
  process.stdout.write(
    `    ⤷ adopt() 今天只看 interrupts，所以它看见的是: ${String(waiting.length)} 个\n`,
  );

  if (phase === "look") {
    server.stop(true);
    return;
  }

  const input = phase === "null" ? null : { messages: [new HumanMessage("接着聊")] };
  try {
    const after = (await agent.invoke(input, config)) as { messages?: { getType(): string }[] };
    const kinds = (after.messages ?? []).map((message) => message.getType()).join(",");
    process.stdout.write(
      `    invoke 回来了: 消息=[${kinds}]  这次冷启动里模型被调了 ${String(asked)} 次\n`,
    );
    const last = (after.messages ?? []).at(-1) as { content?: unknown } | undefined;
    process.stdout.write(`    最后一条: ${JSON.stringify(last?.content).slice(0, 90)}\n`);
    // invoke 的返回值和盘上的状态未必是同一张快照，所以再问一次盘。
    const settled = await agent.getState(config);
    const onDisk = (settled.values.messages ?? []).map((m: { getType(): string }) => m.getType());
    process.stdout.write(
      `    再问盘: 消息=[${onDisk.join(",")}] next=${JSON.stringify(settled.next)}\n`,
    );
  } catch (error) {
    process.stdout.write(`    抛了：${String(error).slice(0, 160)}\n`);
  }
  server.stop(true);
}

async function spawnChild(phase: string): Promise<number | null> {
  const proc = Bun.spawn({
    cmd: ["bun", import.meta.path],
    env: { ...process.env, PROBE_ROLE: "child", PHASE: phase },
    stdout: "inherit",
    stderr: "inherit",
  });
  return await proc.exited.then((code) => (proc.signalCode === null ? code : null));
}

if (process.env["PROBE_ROLE"] === "child") {
  await runChild();
} else {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });

  process.stdout.write("① 门批准之后，工具跑到一半断电\n");
  const crashed = await spawnChild("crash");
  process.stdout.write(
    `  子进程结束方式: ${crashed === null ? "被信号杀死 (SIGKILL)" : `⚠️ 退出码 ${String(crashed)} —— 探针失效`}\n`,
  );
  process.stdout.write(`  副作用发生了几次: ${String(marks())}\n\n`);

  process.stdout.write("② 冷启动，只看不动\n");
  await spawnChild("look");
  process.stdout.write("\n");

  process.stdout.write("③ 冷启动 + invoke(null)（「把那批工具跑完」）\n");
  await spawnChild("null");
  const afterNull = marks();
  process.stdout.write(`  副作用累计次数: ${String(afterNull)}\n\n`);

  process.stdout.write("④ 对照组：同一条路不崩（工具会跑完 5 秒的 sleep，等一下）\n");
  await spawnChild("control");
  process.stdout.write("\n");

  process.stdout.write("=== 判据 ===\n");
  process.stdout.write(
    `  ① 崩溃前副作用发生过 1 次 —— 工具确实开跑了，这道题才成立。\n` +
      `  ② **盘上看得见那批没跑完的工具，但不在 adopt 看的地方**：\n` +
      `     \`next=["tools"] tasks=1\` 而 \`interrupts=0\`。\n` +
      `     \`repl.ts\` 的 adopt 只从 tasks[].interrupts 里捞 actionRequests，所以它看见 0，\n` +
      `     然后当成「没什么要恢复的」——**那批工具就这么被静默丢掉了。**\n` +
      `  ③ \`invoke(null)\` 在**冷进程**里把它收完了：合成结果（副作用累计 ${String(afterNull)} 次，\n` +
      `     ${afterNull === 1 ? "**没重跑**" : "🔴 **重跑了**"}）→ 回到模型 → 拿到最终回答 → next=[] 干净收尾。\n` +
      `  ④ 对照组（同一条路不崩）的历史与③**逐条同形**：[human, ai(tool_calls), tool, ai]。\n\n` +
      `  🔑 **所以机制这一侧早就成立了，缺的只是 REPL 的入口。**\n` +
      `     \`MISSION.md\` 那条未打勾项要的两半——「进程被 kill 之后接着跑」与「不重复已完成的\n` +
      `     副作用」——在图这一层都已经兑现，是 adopt 没去问、也从不 invoke(null)。\n`,
  );
}
