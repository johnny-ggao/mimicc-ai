/**
 * mimicc 退出之后，它启的命令还活着吗？
 *
 * 运行：`bun repro/48-do-commands-outlive-us.ts`
 * **不花钱**：只起 `/bin/sh`，一个字节都不出网。
 *
 * ## 为什么问这一问
 *
 * `repro/46` 之后 `Bash` 是 `detached: true` 起的——这正是超时能杀掉整条管道的原因
 * （`killTree` 用负号 pid 打整个进程组）。**但 detached 的另一半是：它默认活得比父进程久。**
 *
 * 超时会杀、中断会杀，**而「正常退出」什么都没杀**。Terminal-Bench 量过这半边的代价：
 * `download-youtube` 的评分阶段逐字报 `dpkg lock ... held by process 252 (apt-get)`
 * ——agent 早被杀了，它启的 `apt-get` 还在，**把下一阶段的评分也搞挂了**。
 *
 * pi 有同一个登记表并在每个入口的退出路径上清扫
 * （`utils/shell.ts:179-194`、`modes/print-mode.ts:58`）——**这个形状不是我们发明的。**
 *
 * ## 观测面
 *
 * 两臂都起一个**子进程**（真正的 `bun` 进程，不是同进程内的调用），让它：
 * 起一条带孙子的命令 → 不等它结束 → **命令还在跑的时候就 `process.exit`**。
 * 然后回到本进程，等过孙子自己的 sleep，看那个标记文件在不在。
 *
 * - **A 臂**：子进程不装清扫（改之前的行为）
 * - **B 臂**：子进程照 `src/main.ts` 的写法装 `process.on("exit", killRunningCommands)`
 *
 * ⚠️ 量的是「进程退出之后孙子还在不在」，不是超时——**超时那条已经由 `repro/46` 管了。**
 *
 * ⚠️ **子进程必须在命令还没跑完时就 `process.exit`。** 让它自然 drain 是不行的——
 * 那要等命令结束，孙子早把标记写完了，两臂都会「活过」，什么都证明不了。
 * **第一版就这么错过一次。** 真实场景本来也是这个：`--print` 的错误路径
 * `process.exit(1)`，以及 tb 把进程杀掉。
 *
 * ## 结果（2026-08-28）
 *
 * ```
 * A（不清扫）  子进程退出码 0   孙子活过父进程：是
 * B（清扫）    子进程退出码 0   孙子活过父进程：否
 * ```
 */
import { rm } from "node:fs/promises";

const DIR = ".repro-tmp-48";
const GRANDCHILD_SEC = 3;

/** 子进程要跑的脚本：起一条带孙子的命令，不等它，命令还在跑时就退出。 */
function childScript(marker: string, sweep: boolean): string {
  return `
import { runCommand${sweep ? ", killRunningCommands" : ""} } from "../src/tools/mutating";
${sweep ? 'process.on("exit", killRunningCommands);' : ""}
// 起了就不管。
void runCommand('(sleep ${String(GRANDCHILD_SEC)}; echo alive > ${marker}) & echo started; wait', 60_000);
await Bun.sleep(300);
// 🔑 命令还在跑的时候就走人。**自然 drain 不算**——那要等命令自己结束，
// 孙子早写完标记了，两臂都会「活过」，什么也证明不了（第一版就这么错过一次）。
// 真实场景就是这个：--print 的错误路径 process.exit(1)，以及 tb 把进程杀掉。
process.exit(0);
`;
}

async function arm(name: string, sweep: boolean): Promise<void> {
  const marker = `${DIR}/${sweep ? "swept" : "orphan"}`;
  const script = `${DIR}/child-${sweep ? "b" : "a"}.ts`;
  await Bun.write(script, childScript(marker, sweep));

  const child = Bun.spawn(["bun", script], { stdout: "pipe", stderr: "pipe" });
  const code = await child.exited;

  // 等过孙子自己的 sleep：它要是活过了父进程，标记就会落地。
  await Bun.sleep(GRANDCHILD_SEC * 1000 + 800);
  const survived = await Bun.file(marker).exists();

  console.log(
    `${name}  子进程退出码 ${String(code)}   孙子活过父进程：${survived ? "是" : "否"}`,
  );
}

await rm(DIR, { recursive: true, force: true });
await Bun.write(`${DIR}/.keep`, "");
await arm("A（不清扫）", false);
await arm("B（清扫）  ", true);
await rm(DIR, { recursive: true, force: true });
