/**
 * read-before-write 那道闸，装在出货的循环上还成立吗？—— 票 05（`.scratch/deterministic-gate/`）
 *
 * 运行：`bun repro/41-does-the-gate-hold-in-the-loop.ts`
 * ⚠️ **这个探针花钱**：真模型、真工具、真闸、真循环，三格各一次。
 *
 * ## 为什么单测不够
 *
 * `tests/read-before-write.test.ts` 直接调那个钩子——**它证明的是判据对**。
 * 它证明不了的有两样：
 *
 * 1. 闸真的**在装配好的栈里**（`kinds.test.ts` 断言了名字在数组里，但那也只是数组）；
 * 2. 拦下之后**模型接得住**——一条 `status="error"` 的 ToolMessage 回去，
 *    它是去重读、还是原地重试、还是当场放弃。**这一条只有真模型能答。**
 *
 * ## 🔑 为什么可以直接命令模型「不要先读」
 *
 * 票 04 定了：**我们自己从不触发这个失效模式**（`.mimicc` 五条 session 里 `Write`/`Edit` 是 0），
 * 所以判据必须是**探针驱动**的。这个探针不测「模型多常忘记读」——那是频次问题、
 * 也不是闸的判据；它测的是**到了那个状态，闸拦不拦、拦完循环还转不转**。
 * 刻意把它推到那个状态，与 `repro/38` 刻意造一个凑不出两个亮点的输入是同一个手法。
 *
 * ## 三格
 *
 *   ① 没读就改已存在的文件   -> 应被拦，且文件内容不变
 *   ② 读了再改               -> 应通过，文件内容变了
 *   ③ 读一次，改两次         -> 第二次应被拦（写永不刷新标记）
 *
 * ## 观测面：只看行为
 *
 * 工具调用序列、拦截消息出现没有、**以及盘上的文件到底变没变**。
 * ⚠️ 不问模型「你读了吗」——`repro/37:38` 那条先例（取回 != 遵循）同样适用。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PROBE_DIR = join(import.meta.dir, "..", ".mimicc", "probe-41");
const TARGET = "notes.md";
const ORIGINAL = "# Notes\n\n- first line\n";

const OPEN = "<<<PROBE41";
const CLOSE = "PROBE41>>>";

const CELLS = {
  // 🔴 第一次跑（2026-08-25）这一格**没测到闸**：模型走了 `Bash`，文件照改。
  // D1 那条「已知缺口」不是理论上的——真模型第一次尝试就走了它。这一格保留原样，
  // 因为它的结果比一个绿勾有价值：**它测的是缺口，不是闸。**
  "①a-没读就改·不指定工具": {
    id: "unread-free",
    prompt: `Overwrite the file ${TARGET} so that it contains exactly the text "REPLACED". Do not read the file first — just write it.`,
    expect: "🔴 已知会从 Bash 绕过去",
  },
  // 指定工具，才真的走到闸跟前。
  "①b-没读就改·指定 Write": {
    id: "unread-write",
    prompt: `Use the Write tool to overwrite ${TARGET} so it contains exactly the text "REPLACED". Do not read the file first, and do not use Bash — use the Write tool.`,
    expect: "拦下，文件不变",
  },
  "②-读了再改": {
    id: "read-then-write",
    prompt: `Read ${TARGET}, then rewrite it with one extra line "- second line" appended at the end.`,
    expect: "通过，文件变了",
  },
  "③-改两次": {
    id: "twice",
    prompt: `Read ${TARGET}. Then make two separate modifications to it: first append a line "- alpha", then append another line "- beta". Use two separate tool calls.`,
    expect: "第二次被拦",
  },
} as const;

type CellName = keyof typeof CELLS;

interface Payload {
  calls: string[];
  blocked: number;
  toolErrors: string[];
  finalText: string;
  input: number;
  output: number;
  error?: string;
}

// ------------------------------------------------------------------ 子进程侧

async function runChild(): Promise<void> {
  // cwd 已经是 PROBE_DIR —— `src/tools/workspace.ts:2` 的 ROOT 在 import 时固化。
  const { HumanMessage, ToolMessage } = await import("@langchain/core/messages");
  const { buildSystemPrompt, createUniversalAgent, RECURSION_LIMIT } = await import(
    "../src/agents"
  );
  const { JsonlSaver } = await import("../src/checkpoint");
  const { loadConfig } = await import("../src/config");
  const { OUTPUT_BUDGET, resolveModelConfig } = await import("../src/models");

  const cell = (process.env["CELL"] ?? "①b-没读就改·指定 Write") as CellName;
  const model = resolveModelConfig(loadConfig());
  const stateDir = join(process.cwd(), ".state");

  const payload: Payload = {
    calls: [],
    blocked: 0,
    toolErrors: [],
    finalText: "",
    input: 0,
    output: 0,
  };

  try {
    const agent = createUniversalAgent({
      baseURL: model.baseURL,
      apiKey: model.apiKey,
      model: model.model,
      ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
      outputBudget: model.maxTokens ?? OUTPUT_BUDGET,
      window: { limit: model.windowLimit },
      systemPrompt: buildSystemPrompt({ cwd: process.cwd(), date: "2026-08-25" }),
      checkpointer: new JsonlSaver(stateDir),
      stateDir,
      // 门翻成 allow：这一票测的不是权限，是版本闸。
      auto: true,
    });

    const result = await agent.invoke(
      { messages: [new HumanMessage(CELLS[cell].prompt)] },
      {
        recursionLimit: RECURSION_LIMIT,
        configurable: { thread_id: `probe-41-${CELLS[cell].id}` },
      },
    );

    type AiLike = {
      getType(): string;
      content: unknown;
      tool_calls?: { name: string }[];
      usage_metadata?: { input_tokens?: number; output_tokens?: number };
    };
    for (const message of result.messages as (AiLike & { status?: string })[]) {
      if (ToolMessage.isInstance(message)) {
        const text = typeof message.content === "string" ? message.content : "";
        if (text.includes("you have not read its current version")) payload.blocked += 1;
        else if (message.status === "error") payload.toolErrors.push(text.slice(0, 120));
        continue;
      }
      if (message.getType() !== "ai") continue;
      for (const call of message.tool_calls ?? []) payload.calls.push(call.name);
      if (typeof message.content === "string" && message.content.trim() !== "") {
        payload.finalText = message.content;
      }
      payload.input += message.usage_metadata?.input_tokens ?? 0;
      payload.output += message.usage_metadata?.output_tokens ?? 0;
    }
  } catch (error) {
    payload.error = String(error).slice(0, 300);
  }

  process.stdout.write(`${OPEN}${JSON.stringify(payload)}${CLOSE}`);
}

// ------------------------------------------------------------------ 编排者侧

interface Outcome extends Payload {
  cell: CellName;
  before: string;
  after: string;
}

async function one(cell: CellName): Promise<Outcome> {
  rmSync(PROBE_DIR, { recursive: true, force: true });
  mkdirSync(PROBE_DIR, { recursive: true });
  writeFileSync(join(PROBE_DIR, TARGET), ORIGINAL);

  const proc = Bun.spawn({
    cmd: ["bun", import.meta.path],
    cwd: PROBE_DIR,
    env: { ...process.env, PROBE_ROLE: "child", CELL: cell },
    stdout: "pipe",
    stderr: "inherit",
  });
  const raw = await new Response(proc.stdout).text();
  await proc.exited;

  const start = raw.indexOf(OPEN);
  const end = raw.indexOf(CLOSE);
  const payload: Payload =
    start >= 0 && end > start
      ? (JSON.parse(raw.slice(start + OPEN.length, end)) as Payload)
      : {
          calls: [],
          blocked: 0,
          toolErrors: [],
          finalText: "",
          input: 0,
          output: 0,
          error: "子进程没交回东西",
        };

  return {
    ...payload,
    cell,
    before: ORIGINAL,
    after: readFileSync(join(PROBE_DIR, TARGET), "utf8"),
  };
}

async function main(): Promise<void> {
  const all: Outcome[] = [];

  for (const cell of Object.keys(CELLS) as CellName[]) {
    process.stdout.write(`\n==== ${cell} · 预期：${CELLS[cell].expect} ====\n`);
    const outcome = await one(cell);
    all.push(outcome);

    if (outcome.error !== undefined) {
      process.stdout.write(`  抛了：${outcome.error}\n`);
      continue;
    }

    const changed = outcome.after !== outcome.before;
    process.stdout.write(
      `  工具：${outcome.calls.join(" -> ") || "(无)"}\n` +
        `  被闸拦下：${String(outcome.blocked)} 次` +
        `  文件：${changed ? "变了" : "没变"}\n`,
    );
    if (outcome.toolErrors.length > 0) {
      process.stdout.write(`  其它工具错误：${outcome.toolErrors.join(" | ")}\n`);
    }
    process.stdout.write(
      `  盘上现在是：\n${outcome.after
        .split("\n")
        .map((line) => `    | ${line}`)
        .join("\n")}\n`,
    );
    process.stdout.write(
      `  最终回复：${outcome.finalText.replace(/\s+/g, " ").slice(0, 220)}\n`,
    );
  }

  process.stdout.write("\n==== 汇总 ====\n\n");
  process.stdout.write("  格                        拦下  文件  判\n");
  for (const o of all) {
    const changed = o.after !== o.before;
    const want =
      o.cell === "①a-没读就改·不指定工具"
        ? true // 这一格没有「预期」——它记录缺口，见上面的注释
        : o.cell === "①b-没读就改·指定 Write"
          ? o.blocked >= 1 && !changed
          : o.cell === "②-读了再改"
            ? o.blocked === 0 && changed
            : o.blocked >= 1;
    process.stdout.write(
      `  ${o.cell.padEnd(24)}  ${String(o.blocked).padStart(3)}  ${(changed ? "变了" : "没变").padStart(4)}  ${want ? "✅" : "🔴 不符预期"}\n`,
    );
  }

  const inTotal = all.reduce((sum, o) => sum + o.input, 0);
  const outTotal = all.reduce((sum, o) => sum + o.output, 0);
  process.stdout.write(
    `\n  实际用量：input ${inTotal.toLocaleString()} · output ${outTotal.toLocaleString()}\n` +
      "\n  ⚠️ 三格全 ✅ 只说明闸在循环里成立；**它不说明模型多常忘记读**——\n" +
      "     那是频次问题，而我们的使用历史里 Write/Edit 是 0（票 04 F2）。\n",
  );
}

if (process.env["PROBE_ROLE"] === "child") await runChild();
else await main();
