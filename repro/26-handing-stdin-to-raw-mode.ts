/**
 * 把 stdin 从 readline 手里接过来给 raw-mode 用，**用完还得回去**。丢字吗？串吗？
 *
 * Run: `bun repro/26-handing-stdin-to-raw-mode.ts`   （不花钱，连模型都没有）
 *
 * ## 为什么问这个
 *
 * `Clarify` 要一个方向键选单（← → 切题、↑ ↓ 选项、`❯` 原地重绘）。而 `picker.ts:14`
 * 顶上写着一条**判过的反方向**：
 *
 * > That is also what makes it testable without a terminal, which was the whole
 * > argument for a numbered list over an arrow-key selector.
 *
 * 理由是「控制台只有一个 readline，两个 line 事件消费者会变成时序竞争」。那条理由
 * 后来被 `queue.ts` 的 `Tag` 削弱了一半（多消费者靠打标签解决），但**剩下的一半没人量过**：
 * readline 和 raw-mode 争的不是「line 事件」，是 **stdin 的 data 事件本身**。
 *
 * 而 `queue.ts` 的整条规则建立在「行有到达时刻」之上——**raw mode 下没有「行」这个东西**。
 * 所以这里真正要答的是三件事，第三件最要命：
 *
 * - ① 选单开着时按的键，readline 会不会也收到一份（回显串行 / 双消费）
 * - ② 选单关掉之后，readline 还活着吗（还是 stdin 被永久夺走了）
 * - ③ **选单打开之前**排队的那一行——回合进行中敲的那种（`repro/15` 证过它会被缓冲重放）
 *      ——会不会被选单当成按键吃掉
 *
 * ③ 要是成立，它不是「缺个功能」，是**和确认门当年同一个形状的出货 bug**：用户敲给模型的
 * 一句话，落地成了对一道选择题的按键。
 *
 * ## 为什么必须上 pty
 *
 * `repro/15` 的同一条理由，逐字适用：管道下 `runRepl` 走 `terminal: false` 的另一条分支，
 * 而 `terminal: true` 的 readline 自己做行编辑与回显——**这道题问的正是那套行编辑归谁**，
 * 在管道上证出来的东西说的是测试环境，不是用户看见的东西。`script -q /dev/null` 不行
 * （它要求自己的 stdin 是 tty），`expect` 自己开 pty，且「等标记出现再发下一段」是它的原语。
 *
 * ## 为什么不接 runRepl
 *
 * 这一层问的是 node 的 stdin/readline 语义，不是我们的循环。它要是不成立，接不接循环都白搭；
 * 它成立之后「`InputQueue` 里那条排队的行怎么办」才是循环那一层的题，另开探针。
 * 场景 B 的 800ms 忙等就是在**不引入循环**的前提下造出「回合进行中」那个窗口。
 *
 * ## 答案（2026-08-20 实测，pty）
 *
 * **能做，但「看着最省事」的那个交接是错的。**
 *
 * | | ① 收到方向键 | ② 之后 readline 还活着 | ③ 排队那一行 | ④ 键漏给 readline |
 * | --- | --- | --- | --- | --- |
 * | `rl.pause()` | 是 | **否** | 原样取出 | **⚠️ 漏 1 次** |
 * | `rl.close()` + 重建 | 是 | 是 | 原样取出 | 没有 |
 *
 * **`rl.pause()` 停的是流，不是 readline 的消费。** 选单里按的那个 Enter 被两边各收一份，
 * readline 那份变成一条**空行**塞进队列（`[[LEFTOVER]] ["STRAY",""]`）。这不是脏一点而已：
 * `readDecision` 专门为「空行不是一个决定」写过一整段（`repl.ts:543`，那曾是一个出货 bug——
 * 一个不耐烦的回车批准了没人看过的 Bash 命令）。选单每关一次就往队列里塞一个空行，
 * 等于把那个 bug 的弹药自动补上。
 *
 * `picker.ts:14` 那条「两个 line 事件消费者会变成时序竞争」的判断，到这里从论证变成了实测。
 * 它没有否掉选单，它否掉的是 `pause` 那种交接。
 *
 * **`close` 是干净的**：四项全过，包括最要紧的③——回合进行中敲的那一行留在队列里，
 * 选单不碰它，关掉之后原样取出。
 *
 * ⚠️ **两条实现上的硬边，都是这个探针撞出来的：**
 *
 * 1. `pause()`/`close()` 之后必须自己 `process.stdin.resume()`，否则挂上去的 keypress
 *    监听器一个键都收不到（探针第一版卡在这，选单像死了一样）。
 * 2. **`rl.close()` 会触发 `repl.ts:249` 的 `rl.on("close")`，那里面是 `ended = true`**
 *    ——照搬这个交接会顺手把 REPL 关掉。真接进去的时候得先把那个处理器摘掉再关，
 *    或者用一个「正在交接」的标志让它别当成 EOF。
 *
 * ⚠️ 重建 readline 会丢掉 `historySize: 200` 攒下的历史。这个探针没量它值多少，
 * 只记下代价存在——`rl.history` 是可读的，真在意的话可以搬过去。
 *
 * ⚠️ 探针自己造过两次假信号，都留在注释里当反面教材：用 `rl.question()`（一次性监听）
 * 会把忙窗口里那一行报成「丢了」；阶段 D 只 take 一次会把「还活着吗」报成「否」。
 * **观测面写错了，量出来的是观测面。**
 */
import { createInterface } from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";

/** 选单开着的时候，readline 怎么让位。 */
type Handoff = "pause" | "close";
const HANDOFFS: Handoff[] = ["pause", "close"];

// ---------------------------------------------------------------- 孩子那一侧

async function runChild(mode: Handoff): Promise<void> {
  const isTTY = process.stdin.isTTY === true;
  const open = (): ReturnType<typeof createInterface> =>
    createInterface({
      input: process.stdin,
      output: process.stdout,
      // repl.ts:107 的同一行判断，照抄。
      terminal: isTTY,
      historySize: 200,
    });
  let rl = open();

  const say = (text: string): void => {
    process.stdout.write(`${text}\n`);
  };

  // ⚠️ 常驻监听 + 队列，**不是 `rl.question()`**。这不是风格问题：`rl.question` 是
  // 一次性监听，没有 pending question 的时候到达的行直接没人接——探针第一版就是这么写的，
  // 于是忙窗口里那一行「丢了」，而那是探针自己造的假信号，跟 raw mode 一点关系没有。
  // `repl.ts` 走的是 `rl.on("line")` 喂 `InputQueue`（`queue.ts` 整个文件在讲为什么），
  // 要问「排队的那一行会不会被选单吃掉」，就必须先真的有那个队列。
  const queued: string[] = [];
  let wake: (() => void) | null = null;
  const listen = (): void => {
    rl.on("line", (raw: string) => {
      queued.push(raw.trim());
      say(`[[QUEUED]] ${raw.trim()}`);
      wake?.();
    });
  };
  listen();
  const take = async (): Promise<string> => {
    for (;;) {
      const next = queued.shift();
      if (next !== undefined) return next;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  };

  say(`[[TTY]] ${String(isTTY)}`);

  // ——— A：正常读一行 ———
  say("[[READY]] type a line");
  say(`[[LINE]] ${await take()}`);

  // ——— B：忙 800ms。这段时间敲进去的行，readline 会缓冲，之后重放（repro/15 证过）———
  say("[[BUSY]] busy for 800ms — type something now");
  await new Promise((resolve) => setTimeout(resolve, 800));

  // ——— C：开选单：把 stdin 从 readline 手里接过来 ———
  // 两种交接，量的就是它们的差别。
  //   pause —— 看着最省事：暂停 readline，自己挂 keypress。
  //   close —— 真的把 readline 从流上摘下来，选单结束后重建一个。
  if (mode === "pause") rl.pause();
  else rl.close();
  emitKeypressEvents(process.stdin);
  if (isTTY) process.stdin.setRawMode(true);
  // ⚠️ 第一版漏了这一句，选单一个键都收不到。`pause()`/`close()` 停的是**流本身**，
  // 不只是 readline 的消费——不自己 resume，挂上去的 keypress 监听器永远不会响。
  process.stdin.resume();

  const keys: string[] = [];
  await new Promise<void>((resolve) => {
    const onKey = (chunk: string, key: { name?: string; sequence?: string }): void => {
      const name = key.name ?? JSON.stringify(chunk);
      say(`[[KEY]] ${name}`);
      keys.push(name);
      if (key.name === "return" || key.name === "enter") {
        process.stdin.off("keypress", onKey);
        resolve();
      }
    };
    process.stdin.on("keypress", onKey);
    say("[[TUI-OPEN]] arrow keys, then Enter");
  });

  // ——— 还回去 ———
  if (isTTY) process.stdin.setRawMode(false);
  if (mode === "pause") {
    rl.resume();
  } else {
    rl = open();
    listen();
  }
  say(`[[TUI-CLOSE]] keys=${JSON.stringify(keys)}`);

  // ——— D：readline 还活着吗，队列里还剩什么 ———
  say(`[[LEFTOVER]] ${JSON.stringify(queued)}`);
  // 两次：先把排队的 STRAY 取出来，再等新敲的 two。第一版只取一次，于是「还活着吗」
  // 读到的是 STRAY，判成了「否」——又一个探针自己造的假信号。
  say(`[[LINE]] ${await take()}`);
  say(`[[LINE]] ${await take()}`);

  rl.close();
  say("[[DONE]]");
}

// ---------------------------------------------------------------- 父进程

/** `\033[B` 是下方向键。expect 里方括号要转义，否则会被当成命令替换。 */
async function runOnPty(mode: Handoff): Promise<string> {
  const proc = Bun.spawn({
    cmd: [
      "expect",
      "-c",
      "set timeout 20",
      "-c",
      `spawn bun ${import.meta.path} --child ${mode}`,
      "-c",
      "expect -ex {[[READY]]}",
      "-c",
      'send "one\r"',
      // 忙窗口一出现就敲——这一行是「选单打开之前排队的那一行」。
      "-c",
      "expect -ex {[[BUSY]]}",
      "-c",
      'send "STRAY\r"',
      "-c",
      "expect -ex {[[TUI-OPEN]]}",
      // JS 产出真的 ESC（\u001b），方括号留一个反斜杠给 Tcl——`[` 在 Tcl 里是命令替换，
      // 直接写会得到 `missing close-bracket`（第一版就栽在这）。
      "-c",
      'send "\u001b\\[B"',
      "-c",
      'send "\u001b\\[B"',
      "-c",
      'send "\r"',
      "-c",
      "expect -ex {[[TUI-CLOSE]]}",
      "-c",
      'send "two\r"',
      "-c",
      "expect -ex {[[DONE]]}",
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

if (process.argv.includes("--child")) {
  await runChild((process.argv[process.argv.indexOf("--child") + 1] as Handoff) ?? "pause");
} else {
  for (const mode of HANDOFFS) {
    const output = await runOnPty(mode);

    // TTY 那一侧行尾是 CRLF，所以按「非换行符」收，别用 `.`（repro/15 的同一个坑）。
    const grab = (tag: string): string[] =>
      [...output.matchAll(new RegExp(`\\[\\[${tag}\\]\\] ?([^\r\n]*)`, "g"))].map(
        (match) => match[1] ?? "",
      );

    const lines = grab("LINE");
    const keys = grab("KEY");
    const seen = grab("QUEUED");

    process.stdout.write(`\n════════ ${mode} ════════\n`);
    process.stdout.write(output.replace(/\r/g, "").replace(/^spawn .*\n/, ""));

    process.stdout.write("\n  ── 判读 ──\n");
    process.stdout.write(`  readline 收到的行: ${JSON.stringify(seen)}\n`);
    process.stdout.write(`  选单收到的键:     ${JSON.stringify(keys)}\n`);
    // 选单开着时 readline 不该收到任何东西。空串就是那个 Enter 漏过去了。
    const leaked = seen.filter((line) => line === "").length;
    process.stdout.write(
      `  ① 选单收到方向键:        ${keys.includes("down") ? "是" : "否"}\n` +
        `  ② 关掉后 readline 还活着: ${lines.includes("two") ? "是（读到 two）" : "否"}\n` +
        `  ③ 排队那一行:            ${
          seen.includes("STRAY") && lines.includes("STRAY")
            ? "留在队列里，之后原样取出（安全）"
            : "没能原样回来"
        }\n` +
        `  ④ 选单的键漏给 readline: ${leaked > 0 ? `⚠️ 漏了 ${String(leaked)} 次（双消费）` : "没有"}\n`,
    );
  }
  process.stdout.write("\n");
}
