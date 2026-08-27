/**
 * Bash 的 120s 超时到底管不管用？
 *
 * 运行：`bun repro/46-does-the-bash-deadline-bite.ts`
 * **不花钱**：只起 `/bin/sh`，一个字节都不出网。
 *
 * ## 为什么问这一问
 *
 * 2026-08-27 全量跑 Terminal-Bench，`play-zork` 的第三条命令
 * `cd /app/frotz && echo "" | ./frotz zork1.z5 2>&1 | head -50`
 * **在会话记录里没有对应的工具结果**——它一直没返回，直到 tb 在 420s 把整个
 * agent 杀掉。一条命令吃掉 370 秒。
 *
 * 读码找到两处叠在一起（改之前的 `src/tools/mutating.ts`）：
 *
 * ```ts
 * const timer = setTimeout(() => void child.kill(), MAX_COMMAND_MS);
 * [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), …]);
 * ```
 *
 * ① `child` 是 `/bin/sh -c <command>`，`child.kill()` 只给 **sh** 发信号，
 *    管道里的孙子进程照活；
 * ② 读的是 `new Response(child.stdout).text()`——**读到 EOF 才返回**，
 *    而孙子还握着写端，EOF 就不来。**杀了 sh 也解不开这次读。**
 *
 * 旁证：`download-youtube` 的评分阶段逐字报
 * `dpkg lock ... held by process 252 (apt-get)`——agent 早被杀了，孤儿还在，
 * **把下一阶段的测试也搞挂了**。
 *
 * ## 观测面
 *
 * 两臂只差实现，命令与上限逐字相同：
 *
 * - **A 臂**＝改之前的形状（这个文件里原样重写一遍，好让它在修完之后还能跑）。
 * - **B 臂**＝改之后的 `runCommand`（直接 import 真代码，不是复制品）。
 *
 * 每臂量两个数：
 * ① **从发起到返回花了多久**——对比 500ms 的上限；
 * ② **孙子活没活过这次 kill**——它在 sleep 3 秒后写一个标记文件，
 *    返回之后再等到 4 秒去看那个文件在不在。
 *
 * ⚠️ 不看命令输出对不对——这里量的是「上限咬不咬得住」，不是 shell 行为。
 *
 * ## 结果（2026-08-27，macOS / bun 1.3.14）
 *
 * ```
 * A（改之前）  返回耗时 3008ms（上限 500ms）  孙子活过 kill：是
 * B（改之后）  返回耗时  505ms（上限 500ms）  孙子活过 kill：否
 * ```
 *
 * **A 臂的 3009ms 就是那 370 秒的小号**：上限根本没咬住，返回时间是被
 * 孙子的生命周期决定的。B 臂两条都对上了。
 */
import { rm } from "node:fs/promises";

import { runCommand } from "@/tools/mutating";

const DIR = ".repro-tmp-46";
const LIMIT_MS = 500;
const GRANDCHILD_SEC = 3;

/** 一个活过 sh 的孙子：sh 等着它，它握着 stdout 的写端。 */
const command = (marker: string) =>
  `(sleep ${String(GRANDCHILD_SEC)}; echo alive > ${marker}) & echo started; wait`;

/** A 臂：改之前的实现，原样。 */
async function before(cmd: string): Promise<void> {
  const child = Bun.spawn(["/bin/sh", "-c", cmd], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => void child.kill(), LIMIT_MS);
  try {
    await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    await child.exited;
  } finally {
    clearTimeout(timer);
  }
}

/** B 臂：改之后的实现。 */
async function after(cmd: string): Promise<void> {
  await runCommand(cmd, LIMIT_MS);
}

async function arm(name: string, run: (cmd: string) => Promise<void>): Promise<void> {
  const marker = `${DIR}/${name}`;
  const started = Date.now();
  await run(command(marker));
  const elapsed = Date.now() - started;

  // 等过孙子自己的 sleep：它要是活过了 kill，标记就会落地。
  await Bun.sleep(GRANDCHILD_SEC * 1000 + 1000 - elapsed);
  const survived = await Bun.file(marker).exists();

  console.log(
    `${name}  返回耗时 ${String(elapsed).padStart(4)}ms（上限 ${String(LIMIT_MS)}ms）  ` +
      `孙子活过 kill：${survived ? "是" : "否"}`,
  );
}

await rm(DIR, { recursive: true, force: true });
await Bun.write(`${DIR}/.keep`, "");
await arm("A（改之前）", before);
await arm("B（改之后）", after);
await rm(DIR, { recursive: true, force: true });
