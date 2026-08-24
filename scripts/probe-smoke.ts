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
  "32-what-the-provider-allows.ts": "不花 token（每发都是 400），列在这里只为不打网络",
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

process.stdout.write(
  `冒烟 ${String(files.length)} 个探针（花钱的 ${String(Object.keys(PAID).length)} 个跑在本地 stub 上）\n\n`,
);

const results: Result[] = [];
for (const file of files) {
  const paid = file in PAID;
  const result = await run(file, paid);
  results.push(result);
  process.stdout.write(
    `  ${result.ok ? "✅" : "🔴"} ${String(result.ms).padStart(6)}ms  ${file}` +
      `${paid ? "  [花钱：本地 stub]" : ""}${result.note === "" ? "" : `  — ${result.note}`}\n`,
  );
}

const failed = results.filter((result) => !result.ok);
process.stdout.write(
  `\n${failed.length === 0 ? "✅ 全部起得来" : `🔴 ${String(failed.length)} 个起不来`}\n`,
);
if (failed.length > 0) {
  process.stdout.write(
    "\n探针腐烂通常不是探针的错：改了接口而它还照着旧的写。修它，或者在 `repro/README.md`\n" +
      "里把它退役——**别把它从这个列表里划掉**，那等于把「没人知道它死了多久」再来一次。\n",
  );
  process.exit(1);
}
