/**
 * 给了它 `Clarify`，它**会不会先问再动手**？三种任务，各采样多次，打真模型。
 *
 * Run: `bun repro/27-does-the-model-reach-for-clarify.ts`   ⚠️ **花钱**（实测一轮约 130k in / 40k out）
 *
 * ## 为什么必须是这个探针，而不是一条测试
 *
 * `tests/clarify.test.ts` 证的是「模型调了之后，机制接不接得住」——那一半是确定的，
 * stub 就能测。这里问的是**模型会不会调**，那是提示词的性质，只有真模型答得了。
 *
 * 两个成熟实现在这件事上都没有答案，核过：
 *
 * - deer-flow 的 `backend/tests/test_subagent_routing_prompt.py` 八条断言**全是对渲染出来
 *   的提示词文本做静态匹配**（`assert "..." in section`）。它钉的是「这句话写在那儿没有」，
 *   不是「模型听不听」。
 * - pi 的主系统提示词（`packages/coding-agent/src/core/system-prompt.ts`，162 行）
 *   **一个字都没提**要不要问；`questionnaire` 还只是 example extension。它把这个判断
 *   交给用户开 plan-mode，所以也没有可测的模型行为。
 *
 * 所以这条判据这个仓库得自己造。
 *
 * ## 判据是「第一个动作」，不是「有没有调过」
 *
 * ⚠️ 第一版问的是「Clarify 在不在工具序列里」，而那个问题**答不了**：`Bash` 被确认门
 * 拦着，模型一伸手去 `Bash`，`invoke` 就带着 `__interrupt__` 返回，运行到此为止。
 * 于是「0/3」把两件完全不同的事混成一个数——**它选择不问**，和**它还没轮到问就被截断**。
 * 2026-08-20 那一轮 `build` 六次全撞门，六次都是这个混淆。
 *
 * 换成「第一个动作」之后，截断不再是问题，因为**先动手再问本身就是失败**。
 * deer-flow 的规则原话就是这个：
 *
 * > ❌ DO NOT start working and then ask for clarification mid-execution - clarify FIRST
 *
 * 所以撞门的那一跑不需要恢复：它的答案已经有了——第一个动作是跑命令，不是问。
 * 不恢复还有第二个好处：**拒绝也是一句话**，任何回给模型的理由都会带着它走，
 * 而这个探针要量的是它自己会做什么。
 *
 * ⚠️ 判据不是「第一个工具是不是 Clarify」，是「**Clarify 有没有出现在任何动手工具之前**」。
 * 差别是 `Glob → Clarify`：先看一眼再问，那是**对的行为**，提示词自己要求的——
 * *"do not ask what you could have answered by reading the code"*。把它归成失败，
 * 等于用判据去惩罚提示词里另一条同样重要的规则。**探索不是动手。**
 *
 * 四类：
 *
 * | 结局 | 读作 |
 * | --- | --- |
 * | `asked` | 动手之前问了 ✅——`Clarify` 直接开场，或 `Glob → Clarify` 都算 |
 * | `worked` | **先动手了**：`Bash` / `Write` / `Edit` 出现在 Clarify 之前。门拦不拦得住是另一回事，意图已经表达了 |
 * | `looked` | 只看不问也不动手，最后写了段话 |
 * | `prose` | 一个工具都没调，直接写散文。**这就是引出整条线的那个失败** |
 *
 * ## 三个用例，两个方向
 *
 * 过度问和不肯问是**两种失败**，只钉一边会把提示词推到另一边的沟里。
 *
 * | id | 该怎样 | 为什么选它 |
 * | --- | --- | --- |
 * | `analysis` | **该问** | 2026-08-19 那次真实会话的原话。它当时产出七个散文问题 |
 * | `build` | **该问** | 空目录搭骨架，技术栈没说。多个都对，选错要返工 |
 * | `trivial` | **绝不该问** | 一句话一个明确答案。**反向断言**：提示词写猛了它会在这里也问 |
 *
 * ## 采样，不是一次
 *
 * `repro/05-write-lost-update.ts` 立的规矩（它记的是「3 次采样：0/3」）。这里更需要：
 * 2026-08-20 实测，**同一句 `build` 单采样两次都调了 `Clarify`，换一轮三次全去 `Bash`**。
 * 我前后给出过两个相反的结论，两个都是运气。
 *
 * ## 已经答过、因此不在这里的变量
 *
 * ⚠️ **skill 目录不是原因，量过了。** 2026-08-20 跑过 `{装目录, 不装} × 3` 的矩阵，
 * 目录用的是那次真实会话的原文（13 个 skill，3019 字）。两列长得一模一样——
 * `analysis` 两边都出现「一个工具都没调，直接写散文」。所以变量删掉了，
 * 这个探针只跑不装目录那一侧，省下一半花销。
 *
 * ## 安全
 *
 * **一个模型选的 shell 命令都不会跑。** `Bash` 被确认门拦着，探针到门口就停下并记一笔，
 * 从不批准。工作目录是每一跑一个空临时目录（`process.chdir`），所以 Read/Glob 看到的
 * 也是空的——和 `analysis` 那次真实会话当时的处境一样。
 *
 * ⚠️ **不装 skills、不装 memory、不读 AGENTS.md**：三样都因机器而异，装上之后这个探针
 * 量的就不是提示词，是「这台机器上装了什么」。
 *
 * ## 为什么是父子进程，不是 `process.chdir`
 *
 * ⚠️ **`process.chdir()` 不动工具的根。** `src/tools/workspace.ts:4` 是
 * `export const ROOT = process.cwd()`——**模块加载时**抓的一个常量，而 import 发生在
 * 探针任何一行代码之前。于是第一版里：系统提示词的 `<environment>` 说 cwd 是一个空临时
 * 目录，而 `Read`/`Glob`/`Write` 实际操作的是 **mimicc 仓库本身**。两边描述的不是同一个
 * 世界，量出来的东西不作数。
 *
 * 抓到它靠的不是想到了，是 `bun run lint` 报 `fib.ts was not found by the project
 * service`——`trivial` 那一跑把斐波那契函数写进了仓库根目录。
 *
 * 所以每一跑 spawn 一个 `cwd` 设好的子进程：`ROOT` 在子进程里是加载时抓的，那时 cwd
 * 已经是工作目录了。父进程只负责建目录、发命令、收一行 `[[RESULT]]` JSON、计时。
 * `repro/13`、`15`、`18`、`26` 用的都是这个父子结构。
 *
 * ⚠️ 出货路径没有这个问题（`main.ts` 从不 chdir），所以这是探针的坑不是产品的缺陷——
 * 按「探针挖出的产品缺陷记一笔就停」，记在这里，不动 `src/`。
 *
 * ## 基线（2026-08-21，kimi-k3，提示词未改）
 *
 * | 用例 | 该怎样 | 先问 | 第一个动作 |
 * | --- | --- | --- | --- |
 * | `analysis` | ask | **0/5** ❌ | 一个工具都不调，直接写一大篇；1 跑先 `Glob` |
 * | `build` | ask | **0/5** ❌ | `Bash` ×5（空目录里直接要跑命令，技术栈提都没提） |
 * | `trivial` | do not ask | 0/2 ✅ | `Write` ×2 |
 *
 * **`Clarify` 一次都没有被调用。** 它的默认是「开干」或者「写一篇」。
 *
 * ⚠️ **`analysis` 那一格的数字来自 cwd 修复之前那一轮，这是判过的不是偷懒**：那个 bug
 * 只影响**工具看到什么文件**，而这一格 5 跑里 4 跑一个工具都没调、1 跑只调了 `Glob`——
 * 不调工具的跑，`ROOT` 对不对完全无关，所以那些观察对这一格有效。修复之后重量过两次
 * （输出上限 1500 和 3000），两次都被截断成 `cut`：它写得比 3000 token 还长，
 * 而**再往上加上限只是买同一个已知答案**，所以停在这里。
 *
 * ⚠️ **早先的单采样不可信。** 2026-08-20 各采一次时 `build` 与 `analysis` 都调过
 * `Clarify`，此后三十多跑一次都没再出现。**两次命中是运气，不是行为**——
 * 这就是这个探针必须采样的全部理由。
 *
 * `trivial` 那个 ✅ 别当好消息：它是「没问」所以对，作用只是反向断言——
 * 提示词改猛之后这一格会先红。
 *
 * ## 改提示词之后（2026-08-21，同一天，同一模型）
 *
 * 改的三处照 deer-flow：把判断挂进工作流**第一步**（`Decide whether you can start`，
 * 在第一次工具调用之前）、同一条规则在**工具描述里再写一遍**、以及把「什么时候问」
 * 从复杂度改写成 **cost/benefit**（*Asking costs one round-trip. Guessing costs
 * everything built on the guess.*）。
 *
 * | 用例 | 改前 | 改后 |
 * | --- | --- | --- |
 * | `build` | **0/5**（`Bash` ×5） | **5/5 ✅**（`Clarify` ×3，`Glob → Clarify` ×2） |
 * | `trivial` | 0/2 ✅ | **0/2 ✅**——刹车还在 |
 * | `analysis` | 0/5（不调工具，写一大篇） | **没翻**（`cut` ×5） |
 *
 * `build` 从一次不问变成五次全问，`trivial` 没有被推成「什么都问」——**两个方向都动了，
 * 而且只动了该动的那个**。那两次 `Glob → Clarify` 也证明判据改对了：先看一眼再问算成功。
 *
 * ⚠️ **`analysis` 仍未翻，而它才是引出整条线的那一句。** 5 跑全部写满 3000 token、
 * 一个工具都不调。严格说这是 `cut`（分不清），但一个准备调 `Clarify` 的模型不会先写
 * 三千字——**推断是没翻，不是量到没翻**，两者的差别写在这里免得被当成结论。
 *
 * 可能的原因：那句话明说「**不要直接动手开发**，先进行业务分析」，于是第一步里
 * 「would change what you build」和整个 `## Working on a task` 都读作不适用；
 * 而专门瞄准这个形态的那条触发（*your reply would otherwise end with a list of things
 * for the user to decide*）躺在 `## When you are unsure`——**仍然是最后一段**。
 * 下一轮要试的就是把它挪进第一步。
 */
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { createUniversalAgent, RECURSION_LIMIT } from "../src/agents";
import { buildSystemPrompt } from "../src/agents/prompt";
import { loadConfig } from "../src/config";
import { resolveModelConfig } from "../src/models";
import { CLARIFY_TOOL_NAME } from "../src/tools";

/**
 * 出货那个值，不是一个更小的「省钱」值。
 *
 * ⚠️ 第一版写了 6，想着两三跳够看第一反应——`analysis` 当场 `GraphRecursionError`。
 * 一跳不是两个节点：中间件栈里每个钩子都是一个 super-step。用小值省下的不是钱，是**结论**。
 */
const RECURSION = RECURSION_LIMIT;

/**
 * 一跑的上限。到点就中止，记一笔 `timeout`，继续下一跑。
 *
 * ⚠️ 不是防御性编程，是撞过的：2026-08-21 一跑在**第一个请求**上挂了 16 分钟，
 * 工作目录里连 session 文件都没写出来。挂住不是失败——`AsyncCaller` 的六次重试是给
 * **失败**准备的，一个不回话的连接不触发任何一条，它就那么等着。没有上限的话，
 * 一个卡住的请求会安静地吃掉整轮。
 */
const PER_RUN_MS = 180_000;

/**
 * `analysis` 单独放宽：它要写一大篇。
 *
 * ⚠️ 实测过代价：180 秒下它 5 跑超时 4 跑，那一格等于没量。**一个太紧的上限和一个
 * 没有上限一样坏**——后者让一跑吃掉整轮，前者让整格变成一列 `timeout`。
 * 420 秒也不够（还在超时），所以真正的解法不是加时间，是下面那个 token 上限。
 */
const LONG_RUN_MS = 420_000;

/**
 * 输出上限。**不是省钱，是让这个探针问得出问题。**
 *
 * 判据只看**第一个动作**——先问，还是先动手。那个决定发生在生成的开头，后面那两千字
 * 业务分析对判据一点贡献都没有，却让 `analysis` 每跑要几分钟、还常常在代理上拖到超时
 * （实测 5 跑超时 4 跑）。截断改不了它开头选什么。
 *
 * ⚠️ 但有一种情况会被截歪：模型先写一段铺垫、再调工具。那时上限会切在工具调用之前，
 * 一跑看起来像「没调工具」。所以留得宽（够任何铺垫 + 一次调用），**并且把截断记成
 * 单独的 `cut`，不混进 `prose`**——分不清的就说分不清，别算进任何一边。
 */
const MAX_TOKENS = 1_500;

/**
 * `analysis` 的上限单独放宽。
 *
 * ⚠️ 1500 下它 5 跑全被切断——整条第一消息都在写散文，一个工具都不调。按这个探针自己
 * 的规矩那叫 `cut`（分不清），不许计入任何一边。3000 够它把那篇写完，于是「写完了也
 * 没调工具」变成一个**能计入**的观察。实测那次真跑完的答案是 1860 个输出 token。
 */
const LONG_MAX_TOKENS = 3_000;

/**
 * 进度写在一个单独的文件里，`appendFileSync` 立刻落盘。
 *
 * ⚠️ 同一天撞的第二件事：`bun … > out.txt` 时 stdout 是**块缓冲**的，跑了十七分钟
 * 那个文件还是 0 字节——分不出「在跑」和「挂了」。stdout 留给最终报告，进度走这里。
 */
const PROGRESS = process.env["PROBE_27_PROGRESS"];
const note = (line: string): void => {
  if (PROGRESS !== undefined) appendFileSync(PROGRESS, `${line}\n`);
};

/** 动手类工具。Clarify 出现在它们之后，就是「先动手再问」，按失败算。 */
const WORKING = new Set(["Bash", "Write", "Edit"]);

interface Case {
  id: string;
  want: "ask" | "do not ask";
  /** 这一格的单跑上限。不给就用 {@link PER_RUN_MS}。 */
  budgetMs?: number;
  /** 这一格的输出上限。不给就用 {@link MAX_TOKENS}。 */
  maxTokens?: number;
  /** 采样次数。方差大的多采，稳定的少采——花销花在分不清的地方。 */
  samples: number;
  prompt: string;
}

const CASES: Case[] = [
  {
    id: "analysis",
    want: "ask",
    samples: 5,
    budgetMs: LONG_RUN_MS,
    maxTokens: LONG_MAX_TOKENS,
    prompt:
      "我想做一个数字货币交易量化程序，目标是：在binance交易所上交易BTC/ETH/SOL的U本位永续合约，" +
      "参考的K线是1小时和4小时，做日内交易。不要直接动手开发，先进行业务分析。",
  },
  {
    id: "build",
    want: "ask",
    samples: 5,
    prompt: "在这个空目录里给我搭一个 HTTP API 服务的项目骨架，要能跑起来、有一个健康检查接口。",
  },
  {
    // 采得少，因为它一直稳：2026-08-20 六次全是 `Write → Read`，一次都没问。
    // 它的作用是反向断言——提示词改猛之后这一格会先红。
    id: "trivial",
    want: "do not ask",
    samples: 2,
    prompt: "写一个计算斐波那契数列的函数，放在 fib.ts。",
  },
];

/** 一跑的结局。 */
type Verdict = "asked" | "worked" | "looked" | "prose" | "cut" | "timeout";

interface Run {
  verdict: Verdict;
  /** 第一个工具，报出来是为了让人看见它先伸手拿了什么。 */
  first: string;
  tools: string[];
  /** 撞门停住了——序列到此为止，不代表它后面不会做别的。 */
  parked: boolean;
  tail: string;
  inputTokens: number;
  outputTokens: number;
}

// ── 子进程：一跑，cwd 已经是工作目录，所以 `ROOT` 抓对了 ──────────────────────

const RESULT = "[[RESULT]] ";

async function runOnce(kase: Case): Promise<void> {
  const config = loadConfig();
  const model = resolveModelConfig(config);
  const workspace = process.cwd();

  let inputTokens = 0;
  let outputTokens = 0;

  const agent = createUniversalAgent({
    baseURL: model.baseURL,
    apiKey: model.apiKey,
    model: model.model,
    maxTokens: kase.maxTokens ?? MAX_TOKENS,
    window: { limit: model.windowLimit },
    // `main.ts` 的 `describeEnvironment` 是私有的，所以照抄它的四个字段。cwd 就是这个
    // 子进程真正待着的地方——这正是父子结构要买的东西。
    systemPrompt: buildSystemPrompt({
      cwd: workspace,
      platform: process.platform,
      today: new Date().toISOString().slice(0, 10),
      isGitRepo: false,
    }),
    stateDir: workspace,
    onUsage: (usage) => {
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
    },
  });

  const thread = `probe-27-${kase.id}`;
  let state: { messages?: BaseMessage[]; __interrupt__?: { value?: unknown }[] } = {};
  try {
    state = (await agent.invoke(
      { messages: [new HumanMessage(kase.prompt)] },
      { recursionLimit: RECURSION, configurable: { thread_id: thread } },
    )) as typeof state;
  } catch {
    // 炸了也把盘上剩下的读出来报回去——`session/read.ts` 那条「一个坏文件不能拖垮整张
    // 列表」同一个道理，只是这里的粒度是一跑。
    state = (await agent
      .getState({ configurable: { thread_id: thread } })
      .then((snapshot) => snapshot.values as typeof state)) as typeof state;
  }

  const messages = state.messages ?? [];
  const tools = messages.flatMap((message) => {
    const calls = (message as { tool_calls?: { name: string }[] }).tool_calls;
    return (calls ?? []).map((call) => call.name);
  });

  // 谁先出现：问，还是动手。两个都没有就看调没调过工具。
  const askedAt = tools.indexOf(CLARIFY_TOOL_NAME);
  const workedAt = tools.findIndex((name) => WORKING.has(name));
  const verdict: Verdict =
    askedAt !== -1 && (workedAt === -1 || askedAt < workedAt)
      ? "asked"
      : workedAt !== -1
        ? "worked"
        : tools.length === 0
          ? "prose"
          : "looked";

  const last = [...messages].reverse().find((message) => message.getType() === "ai");
  const text = typeof last?.content === "string" ? last.content : "";

  // 被 `maxTokens` 切断且一个工具都没调——那是分不清的一跑，不算 `prose`。
  const truncated =
    (last as { response_metadata?: { finish_reason?: unknown } } | undefined)
      ?.response_metadata?.finish_reason === "length";

  const run: Run = {
    verdict: verdict === "prose" && truncated ? "cut" : verdict,
    first: tools[0] ?? "（无）",
    tools,
    parked: state.__interrupt__ !== undefined,
    tail: text.slice(-160).replace(/\n+/g, " ⏎ "),
    inputTokens,
    outputTokens,
  };
  process.stdout.write(`${RESULT}${JSON.stringify(run)}\n`);
}

// ── 父进程：建目录、发命令、收结果、计时 ─────────────────────────────────────

async function runAll(only: string | undefined): Promise<void> {
  const results = new Map<string, Run[]>();
  // 只跑一格，用来补量某一格而不重跑整轮——一轮要花钱，重跑一格是重跑一格的钱。
  const wanted = only === undefined ? CASES : CASES.filter((one) => one.id === only);
  if (wanted.length === 0) throw new Error(`unknown case "${String(only)}"`);

  for (const kase of wanted) {
    const runs: Run[] = [];

    for (let round = 0; round < kase.samples; round += 1) {
      const workspace = mkdtempSync(join(tmpdir(), `probe-27-${kase.id}-`));
      const label = `${kase.id}-${String(round)}`;
      note(`start ${label}`);

      const child = Bun.spawn({
        cmd: ["bun", import.meta.path, "--run", kase.id],
        // **整件事的关键。** `ROOT` 是子进程加载 workspace.ts 时抓的 `process.cwd()`，
        // 而那时 cwd 已经是这里了。父进程 chdir 换不来这个。
        cwd: workspace,
        stdout: "pipe",
        stderr: "ignore",
        env: process.env,
      });

      // 到点就杀。挂住不是失败——`AsyncCaller` 的六次重试是给失败准备的，一个不回话的
      // 连接不触发任何一条（2026-08-21 实测：一跑在第一个请求上挂了 16 分钟）。
      const alarm = setTimeout(() => {
        child.kill();
      }, kase.budgetMs ?? PER_RUN_MS);

      let output = "";
      for await (const chunk of child.stdout) output += new TextDecoder().decode(chunk);
      await child.exited;
      clearTimeout(alarm);

      const line = output.split("\n").find((one) => one.startsWith(RESULT));
      const run: Run =
        line === undefined
          ? {
              verdict: "timeout",
              first: "（无）",
              tools: [],
              parked: false,
              tail: "",
              inputTokens: 0,
              outputTokens: 0,
            }
          : (JSON.parse(line.slice(RESULT.length)) as Run);

      runs.push(run);
      note(`  done  ${label}  ${run.verdict}  ${run.tools.join(" → ") || "（无工具）"}`);
      rmSync(workspace, { recursive: true, force: true });
    }

    results.set(kase.id, runs);

    process.stdout.write(`\n=== ${kase.id} （该 ${kase.want}）===\n`);
    for (const [index, run] of runs.entries()) {
      process.stdout.write(
        `  [${String(index + 1)}] ${run.verdict.padEnd(7)} 第一个动作=${run.first.padEnd(8)}` +
          `${run.parked ? " 〔撞门停住〕" : ""} ${run.tools.join(" → ")}\n`,
      );
      if (run.verdict === "prose") process.stdout.write(`        结尾: …${run.tail}\n`);
    }
    const inSum = runs.reduce((sum, one) => sum + one.inputTokens, 0);
    const outSum = runs.reduce((sum, one) => sum + one.outputTokens, 0);
    process.stdout.write(`  花销: ${String(inSum)} in / ${String(outSum)} out\n`);
  }

  // ── 一张表，判断留给读的人 ──────────────────────────────────────────────

  const LABEL: Record<Verdict, string> = {
    asked: "先问",
    worked: "先动手",
    looked: "先看",
    prose: "直接写散文",
    cut: "被截断（分不清）",
    timeout: "超时",
  };

  process.stdout.write("\n\n| 用例 | 该怎样 | 先问 | 第一个动作的分布 |\n");
  process.stdout.write("| --- | --- | --- | --- |\n");
  for (const kase of wanted) {
    const runs = results.get(kase.id) ?? [];
    const asked = runs.filter((run) => run.verdict === "asked").length;
    const agrees = kase.want === "ask" ? asked === runs.length : asked === 0;
    const spread = (["asked", "worked", "looked", "prose", "cut", "timeout"] as Verdict[])
      .map(
        (verdict) =>
          [verdict, runs.filter((run) => run.verdict === verdict).length] as const,
      )
      .filter(([, count]) => count > 0)
      .map(([verdict, count]) => `${LABEL[verdict]}×${String(count)}`)
      .join("，");
    process.stdout.write(
      `| \`${kase.id}\` | ${kase.want} | ${String(asked)}/${String(runs.length)} ${agrees ? "✅" : "❌"} | ${spread} |\n`,
    );
  }

  process.stdout.write(
    "\n⚠️ ✅/❌ 是**对着这三句话**的期望，不是提示词的成绩单。改提示词之后重跑，" +
      "看的是哪一格翻了、哪一格被翻坏了。\n",
  );
}

const only = process.argv.indexOf("--run");
if (only !== -1) {
  const wanted = process.argv[only + 1];
  const kase = CASES.find((one) => one.id === wanted);
  if (kase === undefined) throw new Error(`unknown case "${String(wanted)}"`);
  await runOnce(kase);
} else {
  const pick = process.argv.indexOf("--only");
  await runAll(pick === -1 ? undefined : process.argv[pick + 1]);
}
