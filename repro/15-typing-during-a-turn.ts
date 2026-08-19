/**
 * 回合进行中敲进去的那一行，去了哪里 —— 票 04 的探针。
 *
 * Run: `bun repro/15-typing-during-a-turn.ts`   （不花钱，连模型都没有）
 *
 * 票 04 有一条写死的前提：*「现在的 REPL 在跑的时候根本不读输入
 * （`src/console/repl.ts` 的 `inFlight` 逻辑），所以这个区别现在不存在。」*
 * 三个队列要不要做，全建在这句上——**如果它是错的，那这个仓库已经有一个
 * 没人设计过的队列了，票 04 要答的就不是「要不要加」而是「已经有的那个算什么」。**
 *
 * 怀疑它的理由在代码形状上：`repl.ts:87` 是 `for await (const line of rl)`，
 * 而 `await runTurn(...)` 在循环体里。循环体被挂住的时候，readline **没有被暂停**，
 * 它照样收行、照样发 "line" 事件，异步迭代器把它们缓冲起来——回合结束、循环体
 * 回到 `for await` 的时候，这些行会**补放**。`inFlight` 管的只有 SIGINT 那一路
 * （`:65-72`），它从头到尾没碰过 stdin。
 *
 * ## 两个场景，第二个才是要害
 *
 * ①「跑的时候敲一行普通话」→ 它是被丢了，还是变成了下一个回合？
 *   若是后者，那就是一个**事实上的 `nextRun`**：没名字、没上界、用户看不见。
 *
 * ② 更糟的一种：**这一跳末尾是确认门**。门开着的时候，REPL 把下一行读成
 *   approve / edit / reject（`readDecision`，`:181`）。那么在**门出现之前**
 *   敲的那行普通话，会不会被门吃掉、变成一条**带理由的拒绝**？
 *   ⚠️ 反向断言：这条要是成立，它不是「缺一个功能」，是**一个正在出货的 bug**——
 *   用户敲的是给模型的话，落地成了对 `Bash` 的否决，理由栏里是那句话。
 *
 * ## 为什么是子进程 + 管道
 *
 * `runRepl` 读的是 `process.stdin`，要控制「什么时候敲进去」就得从外面喂。
 * 父进程按**子进程自己报的时点**投喂（不是 sleep 猜时序）：图一开跑就打
 * `[[GRAPH]]` 标记，父进程收到标记才写第二行——这样「这一行确实是在回合进行中
 * 敲的」是被证过的，不是被赌的。
 *
 * 假图只实现 `AgentGraph` 的 `stream`。**没有模型、没有 checkpointer、没有工具**：
 * 这个探针问的是控制台读不读输入，那三样都是噪声。
 *
 * ⚠️ 2026-08-19：`AgentGraph` 长出了第二个方法（`getState`），`ReplOptions` 多了
 * `stateDir` 与 `start` —— 这个探针**当场就跑不起来了，而 `repro/` 在 tsconfig 之外，
 * 没有任何东西会替你发现**。补法见下面的 `child`：`start` 传 `{ kind: "new" }`，
 * `getState` 留一个会抛的桩，因为走「新 session」这条路它永远不该被调用。
 */
import { Command } from "@langchain/langgraph";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";

import type { AgentGraph } from "../src/agents";
import { runRepl } from "../src/console/repl";

/** 图跑一个回合要多久。要够长，让父进程来得及在回合中间敲进去。 */
const TURN_MS = 600;

// ---------------------------------------------------------------- 孩子那一侧

/**
 * 一张只会拖时间的假图。
 *
 * `scenario === "gate"` 时第一个回合以确认门收尾——用 `__interrupt__` 那个形状
 * （`repl.ts:288`），因为控制台就是照这个形状认门的。
 */
function fakeGraph(scenario: string): AgentGraph {
  let turns = 0;

  return {
    getState() {
      // 走 `start: { kind: "new" }` 时永远不该被调用。抛出去而不是返回空对象：
      // 一个假装成功的桩会把「探针测的东西变了」伪装成「探针还是绿的」。
      throw new Error("fakeGraph.getState should not be reached in this probe");
    },
    stream(input, _options) {
      turns += 1;
      const n = turns;

      // 入参有两种：新回合是 `{messages}`，回答门是 `Command`。两种都要能认出来，
      // 因为②要证的正是「普通话被当成了门的答复」。
      const label =
        input instanceof Command
          ? `RESUME ${JSON.stringify((input as { resume?: unknown }).resume ?? (input.resume as unknown))}`
          : `PROMPT ${String((input.messages[0] as BaseMessage | undefined)?.content ?? "")}`;

      process.stdout.write(`\n[[GRAPH]] turn=${String(n)} ${label}\n`);

      const gating = scenario === "gate" && n === 1;

      async function* stream(): AsyncGenerator<[string, unknown]> {
        await Bun.sleep(TURN_MS);

        if (gating) {
          yield [
            "values",
            {
              __interrupt__: [
                {
                  value: {
                    actionRequests: [{ name: "Bash", args: { command: "echo hi" } }],
                  },
                },
              ],
            },
          ];
          return;
        }

        yield ["values", { messages: [new AIMessage(`ok ${String(n)}`)] }];
      }

      return Promise.resolve(stream());
    },
  };
}

async function child(scenario: string): Promise<void> {
  await runRepl({
    graph: fakeGraph(scenario),
    skills: { all: () => [] } as unknown as Parameters<typeof runRepl>[0]["skills"],
    // 不会被碰到：`start` 是 new，而 `/resume` 在这两个场景里没人敲。
    stateDir: "/nonexistent-probe-15",
    start: { kind: "new" },
  });
}

// ---------------------------------------------------------------- 父进程那一侧

interface Run {
  output: string;
  /** 每一次图被调用时它拿到了什么，按顺序。 */
  turns: string[];
}

/**
 * 跑一个场景：喂第一行，**等图报出它开跑了**，再喂第二行。
 *
 * 第二行是在回合进行中敲的——这一点由 `[[GRAPH]] turn=1` 那个标记保证，
 * 不由 sleep 的长短保证。
 */
/**
 * 管道那一侧：`Bun.spawn` 的 pipe stdin，`runRepl` 走 `terminal: false`。
 * 时序由子进程自报的 `[[GRAPH]]` 标记控制，不由 sleep 猜。
 */
async function runOnPipe(scenario: string, second: string): Promise<string> {
  const proc = Bun.spawn({
    cmd: ["bun", import.meta.path, "--child", scenario],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    env: { ...process.env, NO_COLOR: "1" },
  });

  let output = "";
  const reading = (async () => {
    for await (const chunk of proc.stdout) output += new TextDecoder().decode(chunk);
  })();

  const waitFor = async (needle: string): Promise<void> => {
    for (let i = 0; i < 200; i += 1) {
      if (output.includes(needle)) return;
      await Bun.sleep(20);
    }
    throw new Error(`never saw ${needle} in:\n${output}`);
  };

  await waitFor("type a message");
  proc.stdin.write("first\n");
  proc.stdin.flush();

  // 回合确实开跑了。下面这一行，是在回合进行中敲的——这一点由标记保证。
  await waitFor("[[GRAPH]] turn=1");
  proc.stdin.write(`${second}\n`);
  proc.stdin.flush();

  await Bun.sleep(TURN_MS * 3);
  proc.stdin.write("/exit\n");
  proc.stdin.flush();
  proc.stdin.end();

  await proc.exited;
  await reading;
  return output;
}

/**
 * TTY 那一侧 —— 这一半才是出货时的样子，**不能省**。
 *
 * 管道下 `runRepl` 明确走的是另一条分支（`repl.ts:57` 逐字
 * *Piped stdin (tests, here-docs) must not be forced into terminal mode*），
 * 而 readline 的 `terminal: true` 是完全不同的一套读法：它自己做行编辑与回显。
 * 只在管道上证出来的结论说的是测试环境，不是用户看见的东西。
 *
 * `script -q /dev/null` 不行：它要求**自己的** stdin 是 tty，而我们只能给管道
 * （实测 `tcgetattr/ioctl: Operation not supported on socket`）。`expect` 可以：
 * 它自己开 pty，而且「等到标记出现再发下一行」本来就是它的原语——时序控制没丢。
 */
async function runOnPty(scenario: string, second: string): Promise<string> {
  const proc = Bun.spawn({
    cmd: [
      "expect",
      "-c",
      "set timeout 30",
      "-c",
      `spawn bun ${import.meta.path} --child ${scenario}`,
      "-c",
      "expect -ex {type a message}",
      "-c",
      'send "first\r"',
      // 同一个判据：回合开跑了才敲第二行。
      "-c",
      "expect -ex {[[GRAPH]] turn=1}",
      "-c",
      `send "${second}\r"`,
      "-c",
      `sleep ${String((TURN_MS * 3) / 1000)}`,
      "-c",
      'send "/exit\r"',
      "-c",
      "expect eof",
    ],
    stdout: "pipe",
    stderr: "inherit",
    env: { ...process.env, NO_COLOR: "1" },
  });

  let output = "";
  for await (const chunk of proc.stdout) output += new TextDecoder().decode(chunk);
  await proc.exited;
  return output;
}

async function run(scenario: string, second: string, tty: boolean): Promise<Run> {
  const output = tty
    ? await runOnPty(scenario, second)
    : await runOnPipe(scenario, second);

  // TTY 那一侧行尾是 CRLF，所以按「非换行符」收，别用 `.`。
  const turns = [...output.matchAll(/\[\[GRAPH\]\] turn=\d+ ([^\r\n]*)/g)].map(
    (match) => match[1] ?? "",
  );
  return { output, turns };
}

const TYPED = "TYPED-DURING-THE-TURN";

interface Verdict {
  /** 那一行有没有原样变成下一个回合。 */
  queued: boolean;
  /** 那一行有没有被确认门吃成一条拒绝。 */
  eaten: boolean;
  /** 一个空回车有没有被确认门吃成一条**批准**。 */
  approved: boolean;
  turns: string[];
}

async function probe(tty: boolean): Promise<Verdict> {
  const where = tty ? "TTY（出货时的样子）" : "管道（测试时的样子）";

  process.stdout.write(`\n=== ① 回合进行中敲一行普通话 · ${where} ===\n\n`);
  const plain = await run("plain", TYPED, tty);
  for (const turn of plain.turns) process.stdout.write(`   图收到：${turn}\n`);

  process.stdout.write(`\n=== ② 这一跳末尾是确认门，敲的是一句普通话 · ${where} ===\n\n`);
  const gate = await run("gate", TYPED, tty);
  for (const turn of gate.turns) process.stdout.write(`   图收到：${turn}\n`);

  // ③ 曾经是真正要命的那一种。②里那句话变成的是**拒绝**——方向偏安全，
  // 用户损失的只是一次工具调用；而 ③ 的方向相反：`readDecision` 的第一个分支
  // 曾是 `input === "a" || input === ""`，**空串也是批准**，而「等得不耐烦
  // 随手敲个回车」是终端里最常见的动作。
  //
  // ✅ **2026-08-19 修了**：空行在两个读行的状态里都不再是一个决定（门上重新问一遍，
  // 改写命令时再要一次）。这一格从此**不是证据，是回归护栏**——它要证明的从
  // 「这个 bug 存在」翻成了「这个 bug 没有回来」。②仍然成立，见 session 线的票 04。
  process.stdout.write(`\n=== ③ 同上，但敲的是一个空回车 · ${where} ===\n\n`);
  const blank = await run("gate", "", tty);
  for (const turn of blank.turns) process.stdout.write(`   图收到：${turn}\n`);
  process.stdout.write("\n");

  return {
    queued: plain.turns.some((turn) => turn.startsWith("PROMPT") && turn.includes(TYPED)),
    eaten: gate.turns.some((turn) => turn.startsWith("RESUME") && turn.includes(TYPED)),
    approved: blank.turns.some(
      (turn) => turn.startsWith("RESUME") && turn.includes('"type":"approve"'),
    ),
    turns: [...plain.turns, ...gate.turns, ...blank.turns],
  };
}

async function main(): Promise<void> {
  let failures = 0;
  const check = (name: string, ok: boolean, detail: string): void => {
    if (!ok) failures += 1;
    process.stdout.write(`${ok ? "✅" : "❌"} ${name}\n   ${detail}\n\n`);
  };

  const pipe = await probe(false);
  const tty = await probe(true);

  process.stdout.write("---------------------------------------------------\n\n");

  check(
    "回合进行中敲的那一行没被丢，它变成了下一个回合",
    pipe.queued && tty.queued,
    `管道 ${pipe.queued ? "是" : "否"} / TTY ${tty.queued ? "是" : "否"} —— ` +
      (pipe.queued && tty.queued
        ? "REPL 在回合进行中确实在收行。票 04「跑的时候根本不读输入」那条前提是错的：" +
          "一个事实上的 nextRun 已经存在，只是没名字、没上界、用户看不见。"
        : "两种模式不一致，结论只在其中一种下成立——先查清哪一种是出货路径。"),
  );

  check(
    "⚠️ 一跳末尾是确认门时，那句普通话被吃成了「带理由的拒绝」",
    pipe.eaten && tty.eaten,
    `管道 ${pipe.eaten ? "是" : "否"} / TTY ${tty.eaten ? "是" : "否"} —— ` +
      (pipe.eaten && tty.eaten
        ? "用户敲给模型的话，落地成了对 Bash 的否决，理由栏是那句话。" +
          "TTY 上也成立，所以这是正在出货的 bug，不是测试环境的假象。"
        : "只在一种模式下成立——看上面的 RESUME 行确认它变成了什么。"),
  );

  check(
    "回归护栏：空回车**不是**一个决定（2026-08-19 修）",
    !pipe.approved && !tty.approved,
    `管道 ${pipe.approved ? "🔴 又被吃成批准" : "没被吃"} / ` +
      `TTY ${tty.approved ? "🔴 又被吃成批准" : "没被吃"} —— ` +
      (!pipe.approved && !tty.approved
        ? "那个回车既没有批准也没有拒绝，门原样再问一遍。修之前它替用户批准了一条" +
          "从没见过的 Bash 命令；②偏安全（变成拒绝），这一条方向相反，门的整个意义在那里失效。"
        : "**这个 bug 回来了。** 看上面的 RESUME 行——空行又变成了一个决定。"),
  );

  // 控制组：①②③里第一行 `first` 都是在**空闲时**敲的，六次都进了 turn=1 的 PROMPT。
  // 所以上面两条不是「管道把什么都往里灌」造成的——空闲那一行走的是同一条路，
  // 而它本来就该被读到。真正被证的是「回合进行中那条路也是通的」。
  const control = [...pipe.turns, ...tty.turns].filter((turn) =>
    turn.startsWith("PROMPT first"),
  ).length;
  check(
    "控制组：空闲时敲的那一行照常进第一个回合（六次都是）",
    control === 6,
    `命中 ${String(control)}/6 —— 这条要是不满，上面三条的读法全部作废。`,
  );

  process.stdout.write(failures === 0 ? "全部符合预期\n" : `${String(failures)} 条不符\n`);
}

if (process.argv.includes("--child")) {
  await child(process.argv[process.argv.indexOf("--child") + 1] ?? "plain");
} else {
  await main();
}
