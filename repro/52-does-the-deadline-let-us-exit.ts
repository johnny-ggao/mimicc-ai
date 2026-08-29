/**
 * 总闸响了，**进程退得掉吗**？—— 答案：退得掉，105 毫秒。
 *
 * 运行：`bun repro/52-does-the-deadline-let-us-exit.ts`（约 1 分钟）
 * **不花钱**：本地 stub 模型服务，跑的是真的 `--print` 入口（子进程）。
 *
 * ## 读数
 *
 * ```
 * 甲 对照        172ms  退了=是  期限语=无  码=0
 * 乙 挂住的流  61105ms  退了=是  期限语=有  码=1     ← 总闸配的是 61s
 * ```
 *
 * **总闸响后 105 毫秒进程就没了。** 生产里那三题「打了期限语却仍被记 `agent_timeout`」
 * 的 47 秒差，**不在进程退出这一段**。
 *
 * ## 起点与它推翻了什么
 *
 * 批 1 重跑（`.scratch/external-bench/issues/06-...`）里三题读数一模一样：终端印了
 * `run deadline reached after 340s`，tb 却照常在 360 秒记 `agent_timeout`，
 * agent 时长精确到 390.5s = 题面 360 + 适配器的 `+30` 封顶。
 *
 * 我的假设是「进程没在适配器留的 20 秒里退干净」，嫌疑放在 `runCommand`：
 * **超时那条路进了赛跑（`expired`），中止这条路只 kill 然后继续 `await finished`**。
 * 🔴 **这个探针把它推翻了。** 那条不对称仍然在（值得看），但它不是这个症状的原因。
 *
 * 一并排除掉的还有两条，都是量过的：
 * - **不是我们杀了自己的 shell**：`detached: true` 确实让孩子自成一组（`pgid == pid`），
 *   `killTree` 的 `-pid` 打不到我们所在的组。
 * - **不是 tb 发错了键**：`run.log` 逐字
 *   `['mimicc --auto --timeout 340 --print …', '; tmux wait -S done', 'Enter']`，
 *   `max_timeout_sec: 390.0`，用 `;` 连接，退出码是几都轮得到它。
 *
 * **剩下没解释的**：mimicc 在容器内约 340.1 秒就没了，而 tb 的阻塞读直到 390.5 秒才放手
 * ——那个 `tmux wait -S done` 的信号没送到。**要查它得在容器里下探针，不是本地能做的。**
 *
 * ## 两格
 *
 *   甲 对照：stub 正常发完流并关掉 → 回合自己走完，进程立刻退。
 *   乙 挂住的流：发完响应头和一片字节就闭嘴、不关流 → 只有总闸能停它（`repro/50` 的形状）。
 *
 * ⚠️ **仪器踩过的两个坑，都写在代码注释里**：stub 必须会说 SSE（`--print` 走 `graph.stream`，
 * 只回 JSON 会让子进程抛 `Received empty response from chat model call.`）；
 * 以及**总闸小于 60 秒时回合预算会被夹成 0**（`WRAP_UP_ROOM_MS`），回合当场
 * `budget_exhausted` 收掉，根本轮不到期限——所以这里的总闸取 61 秒。
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 总闸，秒。给得小，探针才便宜。 */
const TIMEOUT_SEC = 61;
/** 探针自己的忍耐：超过它就认定「退不掉」。 */
const PATIENCE_MS = 150_000;

/**
 * 模型只回一件事：跑这条命令。永远不给最终答复。
 *
 * ⚠️ **必须支持流式。** `--print` 走 `graph.stream`（`src/console/once.ts`），
 * 模型那一跳是 `stream: true`；只回 JSON 的 stub 会让子进程当场抛
 * `Received empty response from chat model call.` ——探针第一版就栽在这里，
 * 而它当时**静默**地把两格都判成「总闸没响」。
 */
function stubFor(
  command: string,
  /** 挂住：发完响应头和一片字节就闭嘴，也不关流。生产里那三题就是这个形状。 */
  stall = false,
): ReturnType<typeof Bun.serve> {
  let calls = 0;
  const encoder = new TextEncoder();
  return Bun.serve({
    port: 0,
    // 不让 Bun 替我们掐连接：那会把「对面先走了」伪装成我们的超时（`repro/50` 吃过）。
    idleTimeout: 0,
    async fetch(request) {
      calls += 1;
      const body = (await request.json()) as { stream?: boolean };
      // 每次唯一：`add_messages` 按 id upsert，同 id 会让整段历史只剩一条 ai，
      // 所有读「最后一条消息」的判据都假性哑掉（`repro/51` 的教训）。
      const id = `stub-${String(calls)}`;
      const callId = `call-${String(calls)}`;
      const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
      const toolCall = {
        id: callId,
        type: "function" as const,
        function: { name: "Bash", arguments: JSON.stringify({ command }) },
      };

      if (body.stream !== true) {
        return Response.json({
          id,
          object: "chat.completion",
          created: 0,
          model: "stub",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "", tool_calls: [toolCall] },
              finish_reason: "tool_calls",
            },
          ],
          usage,
        });
      }

      const chunk = (delta: unknown, finish: string | null = null): string =>
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created: 0,
          model: "stub",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(chunk({ role: "assistant", content: "" })));
          if (stall) return; // 头发了、字发了，然后什么都不再发生。
          controller.enqueue(
            encoder.encode(chunk({ tool_calls: [{ index: 0, ...toolCall }] })),
          );
          controller.enqueue(encoder.encode(chunk({}, "tool_calls")));
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: "stub", choices: [], usage })}\n\n`,
            ),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    },
  });
}

interface Reading {
  ms: number;
  exited: boolean;
  deadlineSaid: boolean;
  code: number | null;
}

async function arm(label: string, command: string, stall = false): Promise<Reading> {
  const server = stubFor(command, stall);
  const dir = mkdtempSync(join(tmpdir(), "probe-52-"));
  writeFileSync(join(dir, "seed.txt"), "seed\n");

  const child = Bun.spawn(
    [
      "bun",
      join(import.meta.dir, "..", "src", "main.ts"),
      "--auto",
      "--timeout",
      String(TIMEOUT_SEC),
      "--print",
      "run the command",
    ],
    {
      cwd: dir,
      env: {
        ...process.env,
        LLM_BASE_URL: `http://127.0.0.1:${String(server.port)}`,
        LLM_DEEPSEEK_API_KEY: "sk-stub",
        LLM_MODEL: "deepseek-v4-flash",
        MIMICC_STATE_DIR: join(dir, "state"),
        LOG_LEVEL: "error",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const started = Bun.nanoseconds();
  const patience = new Promise<"PATIENCE">((resolve) =>
    setTimeout(() => {
      resolve("PATIENCE");
    }, PATIENCE_MS),
  );
  const settled = await Promise.race([child.exited, patience]);
  const ms = Math.round((Bun.nanoseconds() - started) / 1e6);
  const exited = settled !== "PATIENCE";

  // 读得到多少读多少：还没退的那一格，管道里已经有的东西照样是证据。
  if (!exited) child.kill();
  const err = await new Response(child.stderr).text().catch(() => "");
  const out = await new Response(child.stdout).text().catch(() => "");
  await server.stop(true);

  const deadlineSaid = `${out}${err}`.includes("run deadline reached");
  // ⚠️ **仪器不许静默失败。** 子进程没印期限语时，把它到底说了什么摊出来——
  // 这条线已经两次被「stub 说了谎」骗过（`repro/50` 的 idleTimeout、`repro/51` 的 id）。
  if (!deadlineSaid) {
    console.log(`     ↳ 子进程 stderr: ${err.trim().split("\n").slice(-3).join(" ⏎ ").slice(0, 300)}`);
    console.log(`     ↳ 子进程 stdout: ${out.trim().split("\n").slice(-2).join(" ⏎ ").slice(0, 200)}`);
  }
  console.log(
    `${label}  ${String(ms).padStart(6)}ms  退了=${exited ? "是" : "**否**"}  ` +
      `期限语=${deadlineSaid ? "有" : "无"}  码=${exited ? String(settled) : "-"}`,
  );
  return { ms, exited, deadlineSaid, code: exited ? (settled as number) : null };
}

console.log(`总闸 ${String(TIMEOUT_SEC)}s ｜ 探针忍耐 ${String(PATIENCE_MS / 1000)}s\n`);

const clean = await arm("甲 对照  ", "echo hi");
const stalled = await arm("乙 挂住的流", "echo hi", true);

console.log("\n—— 判读 ——");
const budget = TIMEOUT_SEC * 1000;
if (!stalled.deadlineSaid) {
  console.log("🔴 乙格没印出期限语，总闸没响，读数不作数——先看上面那两行 stderr。");
} else if (stalled.ms > budget + 10_000) {
  console.log(
    `🔴 成立：总闸在 ${String(TIMEOUT_SEC)}s 响了，进程却到 ${String(stalled.ms)}ms 才退` +
      `（拖了约 ${String(Math.round((stalled.ms - budget) / 1000))} 秒）。\n` +
      "   生产里那三题就是这个形状：tb 在题面预算处照常记 `agent_timeout`，\n" +
      "   适配器留的 20 秒自停余量因此白留。",
  );
} else {
  console.log(
    `✅ 推翻：总闸 ${String(TIMEOUT_SEC)}s，进程 ${String(stalled.ms)}ms 就退了。\n` +
      "   生产里那 47 秒（343.6 → 390.5）另有解释，**不在进程退出这一段**——\n" +
      "   下一个该查的是 tmux 那个 `done` 信号有没有真的发出去。",
  );
}
