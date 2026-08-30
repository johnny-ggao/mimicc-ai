#!/usr/bin/env bun
/**
 * 冒烟：`repro/` 里的探针还跑不跑得起来。
 *
 * Run: `bun run probes:smoke`
 *
 * ## 它在挡什么
 *
 * **改接口会无声打死探针。** 2026-08-19 实测过一次：给 `AgentGraph` 加一个方法、给
 * `ReplOptions` 加两个字段，`repro/15` 当场抛，而 `bun run check` 全绿——`repro/` 在
 * tsconfig 之外，是 `repro/README.md` 里一条明写的决定。
 *
 * ## 为什么是「跑」而不是「查类型」
 *
 * 把 `repro/` 纳入 typecheck 量过了：**32 个错、9 个文件**，其中绝大多数是 strict 噪音
 * （探针本来就写得松），而最像「真错」的那一条是**假信号**——`profile-probe.ts` 的
 * `getProfileLimits` 运行时确实导出（`langchain/dist/.../summarization.js:573`），
 * 只是 `.d.ts` 不声明它，探针注释里写着这是**故意穿过 dist 拿的**。
 * 反过来，真正烂掉的那一个（`05-write-lost-update.ts` 读弃用的 `LLM_API_KEY`，
 * 今天的 `.env` 不再定义它，死在客户端构造上）**typecheck 一个字都不会说**。
 * 所以判据是「起不起得来」，不是「类型对不对」。2026-08-20 判。
 *
 * ## 花钱的那几个也有护栏，而且不花钱
 *
 * 它们不能真跑，但可以把 `LLM_BASE_URL` 指到**本地一个只回 200 + 空 `choices` 的 stub**：
 * 活着的探针走得到发请求那一步，烂掉的探针死在那之前（模块加载、客户端构造、接口不匹配）。
 * `05-write-lost-update.ts` 就是这么被抓到的——它读弃用的 `LLM_API_KEY`，死在客户端构造上。
 *
 * ⚠️ **不用死端口，试过了。** 连接被拒是一种失败，`AsyncCaller` 会重试 6 次并退避
 * （`repro/README.md` 顶上那条警告），实测 30 秒内 stderr 上一个字都没有——判据反而读不到。
 * 200 + 空 `choices` 正是那条警告自己给的解法：**它不触发重试。**
 *
 * 判据也因此不是退出码、不是错误字样，而是 **stub 收到过请求没有**——最硬的那个观测面。
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const REPRO = join(ROOT, "repro");

/** 打真 provider 的探针，和它们为什么。数字取自 `repro/README.md`。 */
const PAID: Record<string, string> = {
  "05-write-lost-update.ts": "3 次采样，小额",
  "08-overflow.ts": "一次约 1.1M token 的未命中输入，实测 $0.09",
  "19-orphan-tool-call.ts": "三次小请求，合计 < $0.001",
  "27-does-the-model-reach-for-clarify.ts":
    "12 次采样打真模型，一轮约 60k in / 20k out",
  "29-what-reasoning-really-costs.ts":
    "3 个回合，约 50k in / 15k out，maxTokens 压到 2048",
  // ⚠️ 32 **不花 token**——它每一发都是 400，计费为零。它在这张表里只为借用
  // 「重定向到本地 stub」这个机制：否则冒烟会去打真 provider，需要网络和一把有效的 key。
  "31-the-cache-bill.ts": "约 20 万 in（三个臂 × 复本 + 相位 2），out 可忽略",
  "40-does-freezing-memory-pay.ts":
    "约 26 万 in（三臂 × 二复本 × 五轮，走真 agent），跑两版共约 53 万",
  "32-what-the-provider-allows.ts": "不花 token（每发都是 400），列在这里只为不打网络",
  "33-does-output-share-the-window.ts": "两发各约 86 万未命中输入，实测 $0.1 量级",
  "35-how-wrong-is-our-estimate.ts": "六发各约 6k，合计约 3 万 in，$0.01 量级",
  "37-does-position-change-adherence.ts":
    "三臂 × 两档 × 5 采样 × 2 面，深档每臂约 31.7 万 in",
  "38-does-the-written-check-run.ts":
    "两臂 × 3 次，走真 agent，约 10.8 万 in / 1.7 万 out",
  "39-does-the-check-slot-matter.ts":
    "两臂 × 3 次，走真 agent，约 13 万 in / 2.3 万 out",
  "41-does-the-gate-hold-in-the-loop.ts":
    "四格各 1 次，走真 agent 与真闸，约 5.6 万 in",
  "43-does-a-real-task-reach-for-write.ts":
    "三格各 1 次真写码任务，走真 agent 与真闸，实测 6.8 万 in / 1.6k out",
  "44-was-it-the-wording.ts":
    "两臂 × 5 次，走真 agent 与真闸，实测 11.1 万 in / 3.5k out",
};

/** 单个探针的上限。13 / 15 / 23 靠 sleep 制造时序，慢是设计不是卡住。 */
const TIMEOUT_MS = 180_000;

/**
 * 花钱那几个的上限，短得多。**它是护栏，不是正常收尾**——2026-08-21 实测五个全都自己跑完：
 * `05` / `08` / `19` / `29` 各 50~135ms，`27` 十二次采样合计约 1.6s，一个都没被杀。
 *
 * ⚠️ 快是 stub 的功劳，不是探针的：200 + 空 `choices` **不是失败**，客户端解 `choices[0]`
 * 时当场抛，`AsyncCaller` 的六次重试一条都不触发（实测 `27` 十二次采样正好十二个请求）。
 * 换成死端口就是另一回事——连接被拒是失败，会重试 6 次并退避（`repro/README.md` 顶上那条
 * 警告，实测一次 400 打了服务器 7 遍），`repro/19` 那样能跑 5 分钟以上。**这是上面选 stub
 * 而不选死端口的第二个理由，第一个理由是判据本身读不到。**
 *
 * 上限留着是防没量过的探针在某条路径上干等。真被杀掉也不算失败：判据是 stub 收到过请求
 * 没有——**它活到了发请求那一步**，后面那些不再回答任何问题。
 */
const PAID_TIMEOUT_MS = 30_000;

/**
 * 退役的探针：**它的问题答完了，而被它量的那样东西已经不在了。**
 *
 * ## 为什么需要这个机制，而不是删掉文件
 *
 * 这个脚本自己的失败提示一直写着「修它，或者退役——**别把它从这个列表里划掉**」，
 * 但在 2026-08-28 之前**没有「退役」这回事**：这里是 `readdirSync` 全扫，
 * 唯一能让一个探针不报红的办法就是删掉它。于是那句话是空的，而空的规矩会以两种方式塌——
 * 要么留着一个永远红的条目（红久了没人再看红字），要么真把文件删了
 * （**证据不能只存在于一台机器上**，那是 `repro/README.md` 顶上写死的理由）。
 *
 * 所以退役的定义是**只列不跑**：文件留在 git 里、名字留在这份输出里、旁边写着为什么。
 * 🔑 **看得见才叫退役，看不见就叫划掉。**
 *
 * ## 什么时候可以退役（两条都要成立）
 *
 * 1. 它的结论**已经落进 `docs/adr/` 或 `CONTEXT.md`**——探针是证据，不是结论的家；
 * 2. 它量的那样东西**没了**，所以它不可能再答一次自己的问题。
 *
 * ⚠️ **「它现在跑不起来」不是理由，那是腐烂**，腐烂要修（这个脚本存在的全部意义）。
 * 分辨的方法是问：把接口改回去它就能答了吗？能，就是腐烂；不能，才是退役。
 */
const RETIRED: Record<string, string> = {
  "45-how-many-laps-fit-in-the-limit.ts":
    "2026-08-28 退役。题面过期：它量的是「`RECURSION_LIMIT = 48` 等于几圈」，" +
    "而 ADR 0009（`5fea7ee`）把步数预算整个删了，那个常数今天是 `1_000_000` 的格式占位。" +
    "**两个观测面都死了**：`getGraph()` 今天拿不到（节点表 0 个，被它自己的 try/catch " +
    "静默吞掉），上限也撞不到。**而它照样印结论**——「每圈约 200000.0 个节点」是 " +
    "1000000÷5 的算术垃圾，「真实任务能用的往返次数 = 5」更是错的（5 是 loopGuard 对" +
    "重复调用的阈值）。结论早已落进 ADR 0009 与 CONTEXT.md「回合预算」；" +
    "「什么能停下一个老实的循环」这一问由 `repro/51` 接走。" +
    "⚠️ 退役前先修了它的腐烂（stub 的 id 恒定），修完 0.15 秒跑完——" +
    "**所以这次退役与「它跑不动」无关**。",
};

interface Result {
  file: string;
  ok: boolean;
  ms: number;
  note: string;
}

async function run(file: string, paid: boolean): Promise<Result> {
  const started = Bun.nanoseconds();

  // 花钱的那几个跑在本地 stub 上：请求到得了，但没有一个 token 被真的买过。
  let hits = 0;
  const stub = paid
    ? Bun.serve({
        port: 0,
        fetch() {
          hits += 1;
          return Response.json({
            id: "smoke",
            object: "chat.completion",
            created: 0,
            model: "smoke",
            choices: [],
          });
        },
      })
    : null;

  const proc = Bun.spawn({
    cmd: ["bun", join(REPRO, file)],
    cwd: ROOT,
    env:
      stub === null
        ? process.env
        : { ...process.env, LLM_BASE_URL: `http://localhost:${String(stub.port)}` },
    stdout: "pipe",
    stderr: "pipe",
  });

  const timer = setTimeout(
    () => {
      proc.kill();
    },
    paid ? PAID_TIMEOUT_MS : TIMEOUT_MS,
  );
  const [, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  const ms = Math.round((Bun.nanoseconds() - started) / 1e6);

  if (stub !== null) {
    await stub.stop(true);
    // 判据不是退出码——空 `choices` 之后它注定非零。问的是它有没有活到发请求那一步。
    return {
      file,
      ok: hits > 0,
      ms,
      note:
        hits > 0
          ? `活着（打到本地 stub ${String(hits)} 次，没花钱）`
          : `一个请求都没发出去：${lastError(err)}`,
    };
  }
  return {
    file,
    ok: code === 0,
    ms,
    note: code === 0 ? "" : `退出码 ${String(code)}：${lastError(err)}`,
  };
}

function lastError(stderr: string): string {
  const line = stderr
    .split("\n")
    .reverse()
    .find((text) => /error|throw|Error:/i.test(text));
  return (line ?? stderr.split("\n").at(-2) ?? "(无输出)").trim().slice(0, 140);
}

const files = readdirSync(REPRO)
  .filter((name) => name.endsWith(".ts"))
  .sort();

// 一份指着不存在的文件的退役名单，本身就是腐烂——而且是**看不见**的那种：
// 它会安静地什么都不做。所以先对账，再开跑。
const orphaned = Object.keys(RETIRED).filter((name) => !files.includes(name));
if (orphaned.length > 0) {
  process.stdout.write(
    `🔴 退役名单里有 ${String(orphaned.length)} 个文件不存在：${orphaned.join("、")}\n` +
      "   退役是「只列不跑」，不是删掉。把文件找回来，或者把这条名单删掉。\n",
  );
  process.exit(1);
}

const live = files.filter((name) => !(name in RETIRED));
process.stdout.write(
  `冒烟 ${String(live.length)} 个探针（花钱的 ${String(Object.keys(PAID).length)} 个跑在本地 stub 上` +
    `${files.length === live.length ? "" : `；另有 ${String(files.length - live.length)} 个已退役，只列不跑`}）\n\n`,
);

const results: Result[] = [];
for (const file of files) {
  // 退役的照样占一行。名字看得见、理由看得见，才不是「划掉」。
  const why = RETIRED[file];
  if (why !== undefined) {
    process.stdout.write(`  ⏸️  已退役  ${file}\n        ${why}\n`);
    continue;
  }
  const paid = file in PAID;
  const result = await run(file, paid);
  results.push(result);
  process.stdout.write(
    `  ${result.ok ? "✅" : "🔴"} ${String(result.ms).padStart(6)}ms  ${file}` +
      `${paid ? "  [花钱：本地 stub]" : ""}${result.note === "" ? "" : `  — ${result.note}`}\n`,
  );
}

const failed = results.filter((result) => !result.ok);
const retiredNote =
  files.length === live.length
    ? ""
    : `（另有 ${String(files.length - live.length)} 个已退役）`;
process.stdout.write(
  `\n${failed.length === 0 ? `✅ 全部起得来${retiredNote}` : `🔴 ${String(failed.length)} 个起不来${retiredNote}`}\n`,
);
if (failed.length > 0) {
  process.stdout.write(
    "\n探针腐烂通常不是探针的错：改了接口而它还照着旧的写。**先修它。**\n" +
      "只有当它量的那样东西已经不存在、而结论已经进了 `docs/adr/` 或 `CONTEXT.md` 时，\n" +
      "才把它登记进这个脚本的 `RETIRED`（并在 `repro/README.md` 的表里标上）——\n" +
      "**退役是只列不跑，不是从列表里划掉**，那等于把「没人知道它死了多久」再来一次。\n",
  );
  process.exit(1);
}
