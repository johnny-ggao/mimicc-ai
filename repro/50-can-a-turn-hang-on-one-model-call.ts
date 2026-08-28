/**
 * 一个回合能不能**永远**挂在一次模型调用上，而 600 秒的回合墙钟一次表都不看？
 *
 * 运行：`bun repro/50-can-a-turn-hang-on-one-model-call.ts`
 * **不花钱**：全程本地 stub。
 *
 * ## 为什么读代码读不出来
 *
 * 读出来的是三个互相矛盾的半截事实，拼不出结论：
 *
 * 1. `src/agents/turnBudget.ts` 的时间判据写在 **`afterModel`** 里——它是**查表**，
 *    不是定时器。查表要等模型这一跳先返回。
 * 2. 单次请求的钟没人写下来，是 openai SDK 的默认值（`node_modules/openai/client.js:747`
 *    `DEFAULT_TIMEOUT = 600000`），而 `@langchain/openai` 给 SDK 客户端配的是
 *    `maxRetries: 0`（`chat_models/base.js:314`），重试改由 `AsyncCaller` 做，默认 6 次。
 * 3. 那个钟在 `fetchWithTimeout` 的 `finally` 里被 **`clearTimeout`**
 *    （`openai/client.js:531-556`）——**fetch 一 resolve 就清掉**。
 *    流式请求里 fetch 在**响应头到达**时就 resolve 了，body 是之后才读的。
 *
 * 第 3 条推出来的结论是「流开始之后没有钟」，但那是**推的**：body 的读取由 undici 做，
 * 谁也没保证那里没有别的空闲超时；而且主 agent 到底走不走流式、langgraph 的 `stream`
 * 会不会自己插一层，都不是这三处代码能答的。**这一环得量。**
 *
 * ## 三格
 *
 *   甲 对照：发完一片 → 补 `finish_reason: "stop"` → `[DONE]` → **关流**
 *   乙 主格：发完一片 → **永远沉默，也不关流**
 *   丙 总闸：同乙，但走 `--print` 的真路（`runOnce`）并给一个 4 秒的总闸
 *
 * 两格都把回合墙钟压到 5 秒（`turnBudget.timeBudgetMs`），远小于探针自己的忍耐
 * （默认 12 秒，`PROBE_PATIENCE_MS` 可调）。所以判据很硬：**乙如果是被探针自己的 abort
 * 停下来的，就说明这段时间里程序里没有任何一个钟醒过——包括那个自称 5 秒的。**
 *
 * ⚠️ **这个探针不测 600 秒那个常数**。它测的是形状：字节开始流之后，那个钟还在不在。
 * 常数是从 SDK 源码读来的，上面标了行号。
 *
 * ## 读数（2026-08-28）
 *
 * ```
 * 甲 关流        40ms  停下它的是：程序  onCap=（没响）
 * 乙 不关流   12011ms  停下它的是：探针  onCap=（没响）   ← 忍耐 12s
 * 乙 不关流   25008ms  停下它的是：探针  onCap=（没响）   ← 忍耐 25s，同样一路挂到底
 * ```
 *
 * 忍耐调到哪，它就挂到哪——**读数跟着探针的钟走，说明被测的程序里没有自己的钟。**
 *
 * **成立。** 服务端只是不关流，回合就挂满探针的整个忍耐窗口，其间那个自称 5 秒的
 * 回合墙钟一次都没醒。停下它的是探针自己的 abort——而当时 `--print` 里没有这样一把：
 * `src/console/once.ts` 造了一个 `AbortController`，**全文件没有一处调用它的 `abort()`**，
 * 它只是为了给 `signal` 一个值。
 *
 * 🔑 所以「回合墙钟 600s」这个名字是错的。它是**「不早于 600 秒，且要等模型这一跳先回来」**——
 * 而模型这一跳自己没有上界。
 *
 * ## 丙的读数（装上总闸之后，同一天）
 *
 * ```
 * 丙 总闸 4s     4008ms  ok=false  run deadline reached after 4s — stopped with no final answer
 * ```
 *
 * 判据是两条，缺一条都不算过：**它自己停下来了**（4008ms 对配的 4000ms），
 * **并且说得出是哪只钟**——一个说 `interrupted` 的停止和一个说 `run deadline` 的停止
 * 在终端上一样长，含义相反（ADR 0010）。
 *
 * ⚠️ 乙格没有跟着变绿，**那是对的**：乙不给总闸，而没有总闸的时候本来就该没有钟
 * （交互式那一格，人就是那把钟）。乙留在这里是这条不变式的红检——**谁把总闸摘了，
 * 丙会变红，而乙照旧，两格一起才说得清是哪一半塌了。**
 */
import { HumanMessage } from "@langchain/core/messages";

import { createUniversalAgent, DURABILITY, RECURSION_LIMIT } from "../src/agents";
import type { TurnCapReason } from "../src/agents/loopguard";
import { runOnce } from "../src/console/once";

/** 探针自己的忍耐。它是最后一道，不是被测的那道。 */
const PATIENCE_MS = Number(process.env.PROBE_PATIENCE_MS ?? 12_000);
/** 回合墙钟压到这么小，好让「它该响了」这件事毫无争议。 */
const TURN_BUDGET_MS = 5_000;

const encoder = new TextEncoder();

function chunk(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "stub",
    object: "chat.completion.chunk",
    created: 0,
    model: "stub",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

/** 甲格关流，乙格发完第一片就闭嘴——服务端行为的唯一差别。 */
let closeTheStream = true;

const server = Bun.serve({
  port: 0,
  // 🔴 **第一版漏了这行，仪器因此说了谎。** `Bun.serve` 默认 10 秒空闲就掐连接，
  // 于是乙格在 12 秒被停下、探针打印「推翻」——**停下它的是 stub，不是被测的程序**。
  // 而它抛的那句话逐字是 `The socket connection was closed unexpectedly.`，
  // 正是 benchmark 批 1 里 `configure-git-webserver` 终端上的同一句
  // （`.scratch/external-bench/issues/06-after-run-batched.md`）——
  // 也就是说：**那句话的含义是「对面先走了」，不是「我们等超时了」。**
  idleTimeout: 0,
  fetch() {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(chunk({ role: "assistant", content: "on it" })));
        if (!closeTheStream) return; // 乙：头发了、字发了，然后什么都不再发生。
        controller.enqueue(encoder.encode(chunk({}, "stop")));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(body, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  },
});

const caps: TurnCapReason[] = [];
const graph = createUniversalAgent({
  baseURL: `http://localhost:${String(server.port)}`,
  apiKey: "sk-stub",
  model: "stub",
  turnBudget: { timeBudgetMs: TURN_BUDGET_MS },
  onCap: (reason) => caps.push(reason),
});

interface Reading {
  ms: number;
  /** 谁把它停下来的：程序自己，还是探针的 abort。 */
  stopper: "程序" | "探针" | "未停";
  detail: string;
}

async function arm(label: string, thread: string, closes: boolean): Promise<Reading> {
  closeTheStream = closes;
  caps.length = 0;

  const controller = new AbortController();
  const patience = setTimeout(() => {
    controller.abort(new Error("PROBE_PATIENCE"));
  }, PATIENCE_MS);
  const started = Bun.nanoseconds();

  let stopper: Reading["stopper"] = "未停";
  let detail = "回合自己走完了";
  try {
    const stream = await graph.stream(
      { messages: [new HumanMessage("say something")] },
      {
        recursionLimit: RECURSION_LIMIT,
        durability: DURABILITY,
        configurable: { thread_id: thread },
        streamMode: ["messages", "values"] as const,
        signal: controller.signal,
      },
    );
    for await (const _event of stream as AsyncIterable<unknown>) {
      // 只要走完，不看内容：问的是「停没停」，不是「说了什么」。
    }
    stopper = "程序";
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    // abort 过的信号只可能是探针那把——程序里没有别的地方 abort 这个 controller。
    stopper = controller.signal.aborted ? "探针" : "程序";
    detail = text.slice(0, 80);
  } finally {
    clearTimeout(patience);
  }

  const ms = Math.round((Bun.nanoseconds() - started) / 1e6);
  console.log(
    `${label}  ${String(ms).padStart(6)}ms  停下它的是：${stopper}` +
      `${caps.length > 0 ? `  onCap=${caps.join(",")}` : "  onCap=（没响）"}` +
      `  — ${detail}`,
  );
  return { ms, stopper, detail };
}

console.log(
  `回合墙钟 ${String(TURN_BUDGET_MS / 1000)}s ｜ 探针忍耐 ${String(PATIENCE_MS / 1000)}s ` +
    `｜ stub 端口 ${String(server.port)}\n`,
);

const control = await arm("甲 关流  ", "probe-50-close", true);
const hang = await arm("乙 不关流", "probe-50-hang", false);

await server.stop(true);

console.log("\n—— 甲乙判读 ——");
if (control.stopper !== "程序") {
  console.log("🔴 对照格就没跑通，stub 或装配有问题，乙格的读数不作数。");
} else if (hang.stopper === "探针") {
  console.log(
    `🔴 成立：服务端只是不关流，回合就挂了 ${String(Math.round(hang.ms / 1000))} 秒，` +
      `期间那个 ${String(TURN_BUDGET_MS / 1000)} 秒的回合墙钟一次都没响。\n` +
      "   停下它的是探针自己的 abort——**没有总闸的时候，程序里没有任何一层还持有钟。**",
  );
} else {
  console.log(
    `✅ 推翻：有东西在 ${String(hang.ms)}ms 把它停下来了（${hang.detail}）。` +
      "「流开始之后没有钟」这句话不成立，别写进 ADR。",
  );
}

// —— 丙：装上总闸之后，同一个挂住的流还挂不挂得住 ——
//
// 走的是 `--print` 的那条真路（`runOnce`），不是探针自己再造一遍。判据有两条，
// 缺一条都不算过：**它自己停下来了**，以及**它说得出是哪只钟响的**——
// 一个说 "interrupted" 的停止和一个说 "run deadline" 的停止，在终端上一样长，
// 含义相反（ADR 0010）。
closeTheStream = false;
const gateServer = Bun.serve({
  port: 0,
  idleTimeout: 0,
  fetch() {
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(chunk({ role: "assistant", content: "on it" })));
        },
      }),
      { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
    );
  },
});

const gated = createUniversalAgent({
  baseURL: `http://localhost:${String(gateServer.port)}`,
  apiKey: "sk-stub",
  model: "stub",
});
const GATE_MS = 4_000;
const gateStarted = Bun.nanoseconds();
const once = await runOnce({
  graph: gated,
  task: "say something",
  deadlineAt: Date.now() + GATE_MS,
});
const gateMs = Math.round((Bun.nanoseconds() - gateStarted) / 1e6);
await gateServer.stop(true);

console.log(
  `\n丙 总闸 ${String(GATE_MS / 1000)}s  ${String(gateMs).padStart(6)}ms  ` +
    `ok=${String(once.ok)}  ${once.error ?? "（没有错误）"}`,
);

console.log("\n—— 丙判读 ——");
const namedTheClock = (once.error ?? "").includes("run deadline");
if (once.ok || !namedTheClock) {
  console.log(
    "🔴 总闸没起作用，或者起了作用但没说出是自己响的" +
      `（ok=${String(once.ok)}，说的是「${once.error ?? ""}」）。`,
  );
} else {
  console.log(
    `✅ 到点自己停了（${String(gateMs)}ms，配的是 ${String(GATE_MS)}ms），` +
      "并且报的是 run deadline 而不是 interrupted。\n" +
      "   ⚠️ 这个探针**跑完就退**——闹钟没被清掉的话，它会停在这里等满总闸。",
  );
}
