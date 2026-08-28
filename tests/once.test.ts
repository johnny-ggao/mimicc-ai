import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import { describe, expect, test } from "bun:test";

import { parseArgs } from "../src/console/args";
import { NO_HUMAN, runOnce } from "../src/console/once";
import type { AgentGraph } from "../src/agents";

/**
 * A graph that parks a fixed number of times and records what it was answered.
 *
 * Hand-rolled rather than a mock library, for the same reason the other tests
 * here are: what is being pinned is the *shape* of the answer — a rejection
 * carrying a reason, one per request — and a matcher would hide exactly that.
 */
function stubGraph(options: {
  parks?: unknown[];
  reply?: string;
  throws?: Error;
  /**
   * 永远不回来，直到有人按下信号——一个挂住的流在图这一层看起来就是这样。
   *
   * ⚠️ 故意抛 langgraph 自己那个 `AbortError` 的壳，**不是**我们扔进去的
   * `DeadlineExceeded`：`runOnce` 必须认信号上挂的 reason 才能把它读成超期，
   * 认壳就会读成「用户按了 Ctrl+C」（ADR 0010）。
   */
  hangs?: boolean;
}): {
  graph: AgentGraph;
  answered: unknown[];
} {
  const answered: unknown[] = [];
  const parks = [...(options.parks ?? [])];
  const messages: BaseMessage[] = [];

  const graph: AgentGraph = {
    stream: (input, config) => {
      if (options.throws !== undefined) throw options.throws;
      if (options.hangs === true) {
        const signal = (config as { signal?: AbortSignal } | undefined)?.signal;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        });
      }
      if (input instanceof Command) answered.push(input.resume);
      else if (input !== null) messages.push(...input.messages);

      const parked = parks.shift();
      if (parked === undefined && options.reply !== undefined) {
        messages.push(new AIMessage(options.reply));
      }

      const events: [string, unknown][] =
        parked === undefined
          ? [["values", { messages }]]
          : [["values", { __interrupt__: [{ value: parked }] }]];

      return Promise.resolve(
        (async function* () {
          // `await` so this is a genuine async generator rather than a sync one
          // wearing the type; the graph's real stream is asynchronous.
          await Promise.resolve();
          for (const event of events) yield event;
        })(),
      );
    },
    getState: () => Promise.resolve({ values: { messages } }),
  };

  return { graph, answered };
}

describe("--print parsing", () => {
  test("takes the task as the next argument", () => {
    expect(parseArgs(["--print", "fix the build"])).toEqual({
      kind: "print",
      task: "fix the build",
      auto: false,
    });
  });

  test("accepts the short form and the inline form", () => {
    expect(parseArgs(["-p", "hi"])).toEqual({ kind: "print", task: "hi", auto: false });
    expect(parseArgs(["--print=hi there"])).toEqual({
      kind: "print",
      task: "hi there",
      auto: false,
    });
  });

  test("does not imply --auto, and carries it when given", () => {
    expect(parseArgs(["--print", "x"])).toMatchObject({ auto: false });
    expect(parseArgs(["--auto", "--print", "x"])).toMatchObject({
      kind: "print",
      auto: true,
    });
  });

  test("a bare --print is an error, not a repl", () => {
    expect(parseArgs(["--print"])).toMatchObject({ kind: "error" });
  });

  test("--print and --resume are mutually exclusive", () => {
    expect(parseArgs(["--print", "x", "--resume", "abc"])).toMatchObject({
      kind: "error",
    });
  });

  test("a task that looks like a flag is still a task", () => {
    expect(parseArgs(["--print", "--auto is a flag"])).toEqual({
      kind: "print",
      task: "--auto is a flag",
      auto: false,
    });
  });
});

// 最外层那把钟的入口（ADR 0010）。
describe("--timeout parsing", () => {
  test("跟着 --print 走，分开写和等号写都收", () => {
    expect(parseArgs(["--print", "x", "--timeout", "300"])).toEqual({
      kind: "print",
      task: "x",
      auto: false,
      timeoutSec: 300,
    });
    expect(parseArgs(["--timeout=45.5", "--print", "x"])).toMatchObject({
      timeoutSec: 45.5,
    });
  });

  test("不给就没有这个键 —— 缺省由入口决定，不由解析器编一个数", () => {
    expect(parseArgs(["--print", "x"])).not.toHaveProperty("timeoutSec");
  });

  // 打错的期限和没给的期限，后果差着数量级，而调用方看不见我们悄悄换了什么数。
  test("打错的值被拒绝，不是退回默认值", () => {
    for (const argv of [
      ["--print", "x", "--timeout"],
      ["--print", "x", "--timeout", "abc"],
      ["--print", "x", "--timeout", "0"],
      ["--print", "x", "--timeout", "-5"],
      ["--print", "x", "--timeout", "--auto"],
    ]) {
      expect(parseArgs(argv)).toMatchObject({ kind: "error" });
    }
  });

  // 交互式没有总闸，因为人就是那把钟。静默忽略会让调用方以为自己设了界限。
  test("没有 --print 的 --timeout 是错误，不是被忽略", () => {
    expect(parseArgs(["--timeout", "300"])).toMatchObject({ kind: "error" });
    expect(parseArgs(["--resume", "abc", "--timeout", "300"])).toMatchObject({
      kind: "error",
    });
  });
});

describe("runOnce", () => {
  test("returns the model's last reply", async () => {
    const { graph } = stubGraph({ reply: "done" });
    const result = await runOnce({ graph, task: "do it" });
    expect(result).toMatchObject({ text: "done", ok: true, refused: 0 });
  });

  test("refuses every gate request, one rejection each, with a reason", async () => {
    const { graph, answered } = stubGraph({
      parks: [{ actionRequests: [{ name: "Bash" }, { name: "Write" }] }],
      reply: "could not do it",
    });

    const result = await runOnce({ graph, task: "write a file" });

    expect(result.refused).toBe(2);
    expect(answered).toEqual([
      {
        decisions: [
          { type: "reject", message: NO_HUMAN },
          { type: "reject", message: NO_HUMAN },
        ],
      },
    ]);
  });

  test("never approves — no decision may be an approval", async () => {
    const { graph, answered } = stubGraph({
      parks: [{ actionRequests: [{ name: "Bash" }] }],
      reply: "x",
    });
    await runOnce({ graph, task: "t" });

    const decisions = (answered[0] as { decisions: { type: string }[] }).decisions;
    expect(decisions.every((one) => one.type === "reject")).toBe(true);
  });

  test("answers Clarify instead of rejecting it — it is a question, not an action", async () => {
    const { graph, answered } = stubGraph({
      parks: [{ kind: "clarify", questions: [{ header: "Scope" }] }],
      reply: "assumed the narrow one",
    });

    const result = await runOnce({ graph, task: "t" });

    expect(result.refused).toBe(0);
    const answers = answered[0] as { header: string; typed: boolean }[];
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ header: "Scope", typed: true });
  });

  test("keeps answering while the graph keeps parking", async () => {
    const { graph, answered } = stubGraph({
      parks: [
        { actionRequests: [{ name: "Bash" }] },
        { actionRequests: [{ name: "Bash" }] },
      ],
      reply: "finally",
    });

    const result = await runOnce({ graph, task: "t" });

    expect(answered).toHaveLength(2);
    expect(result).toMatchObject({ text: "finally", refused: 2, ok: true });
  });

  test("a thrown turn is not ok, and says so rather than throwing", async () => {
    const { graph } = stubGraph({ throws: new Error("provider exploded") });
    const result = await runOnce({ graph, task: "t" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("provider exploded");
  });

  test("runs on one thread, and a caller may pin it", async () => {
    let seen: string | undefined;
    const graph: AgentGraph = {
      stream: (_input, config) => {
        seen = config.configurable.thread_id;
        return Promise.resolve(
          (async function* () {
            await Promise.resolve();
            yield ["values", { messages: [new HumanMessage("t")] }] as [
              string,
              unknown,
            ];
          })(),
        );
      },
      getState: () => Promise.resolve({ values: { messages: [] } }),
    };

    await runOnce({ graph, task: "t", session: "pinned-id" });
    expect(seen).toBe("pinned-id");
  });
});

/**
 * 一个挂住的回合会不会自己停下来 —— 这条不变式真正要的那件事（ADR 0010）。
 *
 * 🔑 **这里用 stub 图问的是「停不停、话说得对不对」；「真的会挂住」那一半是
 * `repro/50` 打真模型栈量的**：服务端只要发完响应头和一片字节就闭嘴，回合就一直挂着，
 * 而在这之前 `runOnce` 造的那个 `AbortController` 从没有一处调用过它的 `abort()`。
 */
describe("总闸", () => {
  test("到点自己停下，并说出是哪只钟、过了多久", async () => {
    const { graph } = stubGraph({ hangs: true });
    const started = Date.now();

    const result = await runOnce({ graph, task: "hang", deadlineAt: Date.now() + 120 });

    expect(result.ok).toBe(false);
    // 不是 "interrupted"：没有人按 Ctrl+C，是钟响了。这两句话在终端上一模一样，
    // 而它们的含义相反——这正是这条不变式要治的病。
    expect(result.error).not.toBe("interrupted");
    expect(result.error).toContain("run deadline");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("不给期限就没有钟 —— 交互式那一格靠的是这个", async () => {
    const { graph } = stubGraph({ reply: "done" });
    const result = await runOnce({ graph, task: "x" });
    expect(result).toMatchObject({ ok: true, text: "done" });
  });

  test("期限没到就不碍事：回合照常收尾", async () => {
    const { graph } = stubGraph({ reply: "done" });
    const result = await runOnce({
      graph,
      task: "x",
      deadlineAt: Date.now() + 60_000,
    });
    expect(result).toMatchObject({ ok: true, text: "done" });
  });
});

/**
 * ⚠️ **这里量不到的那一样：闹钟有没有被清掉。**
 *
 * 一个还挂着的 `setTimeout` 会把事件循环撑住，于是一次早早结束的 `--print` 要一直等到
 * 期限才肯退出——一个专门用来防挂死的机制，自己变成挂死的原因。`once.ts` 在两个出口
 * 各清一次，但**从测试进程里看不见它**：`process.getActiveResourcesInfo()` 在 bun 上
 * 恒返回 `[]`（实测），而 `bun test` 自己会结束进程，泄漏的定时器不会让这个文件变慢。
 *
 * 看得见它的是 `repro/50`：那个探针跑真的 `runOnce`，**跑完就退**——闹钟没清的话，
 * 它会停在那里等到期限。这一条写在这里，是为了下一个删掉那两行 `clearTimeout` 的人
 * 至少知道去哪看，而不是以为「测试全绿」等于「没漏」。
 */
