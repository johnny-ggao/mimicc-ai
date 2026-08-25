/**
 * 给 mimicc 一个**真实的写码任务**，它会不会自己伸手拿 `Write` / `Edit`？
 *
 * 运行：`bun repro/43-does-a-real-task-reach-for-write.ts`
 * ⚠️ **这个探针花钱**：真模型、真工具、真闸、真循环，三格各一次。
 *
 * ## 它要推翻（或坐实）的是哪一句
 *
 * 票 04 从 `.mimicc` 五条 session 数出 `Write`/`Edit` **0 次**，由此写进 ADR 0008 的是：
 * *「我们没有这个失效模式的实证，而且**不会等出来**——这个仓库自己从不触发它。」*
 *
 * 🔴 **那句话把「这五条 session 的用法」说成了「这个工具的性质」。** 重核（2026-08-26）：
 *
 * - `Write`/`Edit` 是 `633ea63`（2026-08-12）进的仓库，**早于全部五条 session**
 *   （08-14 ×3、08-18、08-19）——不是「当时没这个工具」；
 * - 那五条里 `Read` 2063 / `Grep` 608 / `Bash` 235 / `Glob` 185，**全是只读任务**
 *   （跑探针、检索、读源码）。session 里出现 23 次 `Write never overwrites`，
 *   看清了是 agent **读 `mutating.ts` 源码**读到的（带 Read 的行号前缀），不是真报错。
 *
 * **所以 0 次是「样本里没有写码任务」，不是「模型不用写工具」。** 这个探针给它真的写码任务。
 *
 * ## 🔑 与 `repro/41` 的唯一区别：不指定工具
 *
 * 41 逐字命令模型 *use the Write tool* / *do not use Bash*——那是**刻意把它推到闸跟前**，
 * 问的是「到了那个状态闸拦不拦」。这里**一个工具名都不提**，问的是
 * **「一个正常的写码任务，它自己会走到那条路上吗」**。
 * ⚠️ 提示里不提工具，也就意味着 `Bash` 那条逃生口一直开着——这是观测的一部分，不是缺陷。
 *
 * ## 三格（都是不带工具名的普通任务）
 *
 *   ① 新建一个模块        -> 若出现 `Write`，0 次那句就已经不成立
 *   ② 改一个已存在的文件  -> 期待 `Read -> Edit`；顺带看闸在真任务上误报没有
 *   ③ 既改又建            -> 一个任务里两种写
 *
 * ## 观测面：只看行为
 *
 * 工具调用序列 + 盘上的文件到底变没变/建没建。**不问模型「你用了什么」**
 * （`repro/37` 那条先例：取回 != 遵循）。
 *
 * ⚠️ `auto: true`，同 `repro/41`：不开自动模式，`Bash` 会停下来问人，无人值守跑不完。
 * 代价是 `Bash` 在这里没有摩擦，比真实交互式使用更容易被选中。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PROBE_DIR = join(import.meta.dir, "..", ".mimicc", "probe-43");

const OPEN = "<<<PROBE43";
const CLOSE = "PROBE43>>>";

/** 一个小而真的工作区：有源码、有测试、有 README，任务才像任务。 */
const SEED: Record<string, string> = {
  "src/greet.ts": `export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}
`,
  "src/greet.test.ts": `import { expect, test } from "bun:test";
import { greet } from "./greet";

test("greet", () => {
  expect(greet("world")).toBe("Hello, world!");
});
`,
  "README.md": `# tiny

A tiny module. \`bun test\` runs the tests.
`,
};

const CELLS = {
  "①-新建一个模块": {
    id: "new-module",
    prompt:
      "Add a new module src/farewell.ts that exports a farewell(name) function returning " +
      '"Bye, <name>!", matching the style of the existing greet module. Add a test for it too.',
    watch: ["src/farewell.ts"],
    expect: "期待出现 Write",
  },
  "②-改一个已存在的文件": {
    id: "edit-existing",
    prompt:
      "greet() should return \"Hello, stranger!\" when it is given an empty name. " +
      "Make that change and update the tests.",
    watch: ["src/greet.ts", "src/greet.test.ts"],
    expect: "期待 Read -> Edit；闸不该误报",
  },
  "③-既改又建": {
    id: "both",
    prompt:
      "Add a shout(text) helper that upper-cases its argument. Put it in a new file " +
      "src/shout.ts, and re-export it from src/greet.ts so callers can import both from there.",
    watch: ["src/shout.ts", "src/greet.ts"],
    expect: "一个任务里两种写",
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
  // cwd 已经是 PROBE_DIR —— `src/tools/workspace.ts` 的 ROOT 在 import 时固化。
  const { HumanMessage, ToolMessage } = await import("@langchain/core/messages");
  const { buildSystemPrompt, createUniversalAgent, RECURSION_LIMIT } = await import(
    "../src/agents"
  );
  const { JsonlSaver } = await import("../src/checkpoint");
  const { loadConfig } = await import("../src/config");
  const { OUTPUT_BUDGET, resolveModelConfig } = await import("../src/models");

  const cell = (process.env["CELL"] ?? "①-新建一个模块") as CellName;
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
      systemPrompt: buildSystemPrompt({ cwd: process.cwd(), date: "2026-08-26" }),
      checkpointer: new JsonlSaver(stateDir),
      stateDir,
      auto: true,
    });

    const result = await agent.invoke(
      { messages: [new HumanMessage(CELLS[cell].prompt)] },
      {
        recursionLimit: RECURSION_LIMIT,
        configurable: { thread_id: `probe-43-${CELLS[cell].id}` },
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
  seedChanged: string[];
  created: string[];
}

function seed(): void {
  rmSync(PROBE_DIR, { recursive: true, force: true });
  mkdirSync(join(PROBE_DIR, "src"), { recursive: true });
  for (const [path, body] of Object.entries(SEED)) {
    writeFileSync(join(PROBE_DIR, path), body);
  }
}

async function one(cell: CellName): Promise<Outcome> {
  seed();

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

  // 盘上的事实：种子文件变没变、被盯的新文件建没建。
  const seedChanged = Object.keys(SEED).filter((path) => {
    const full = join(PROBE_DIR, path);
    return existsSync(full) && readFileSync(full, "utf8") !== SEED[path];
  });
  const created = CELLS[cell].watch.filter(
    (path) => !(path in SEED) && existsSync(join(PROBE_DIR, path)),
  );

  return { ...payload, cell, seedChanged, created };
}

async function main(): Promise<void> {
  const all: Outcome[] = [];

  for (const cell of Object.keys(CELLS) as CellName[]) {
    process.stdout.write(`\n==== ${cell} · ${CELLS[cell].expect} ====\n`);
    process.stdout.write(`  任务：${CELLS[cell].prompt}\n`);
    const outcome = await one(cell);
    all.push(outcome);

    if (outcome.error !== undefined) {
      process.stdout.write(`  抛了：${outcome.error}\n`);
      continue;
    }

    const writes = outcome.calls.filter((n) => n === "Write" || n === "Edit").length;
    process.stdout.write(
      `  工具：${outcome.calls.join(" -> ") || "(无)"}\n` +
        `  Write/Edit 次数：${String(writes)}\n` +
        `  被闸拦下：${String(outcome.blocked)} 次\n` +
        `  种子文件被改：${outcome.seedChanged.join(", ") || "(无)"}\n` +
        `  新建：${outcome.created.join(", ") || "(无)"}\n`,
    );
    if (outcome.toolErrors.length > 0) {
      process.stdout.write(`  其它工具错误：${outcome.toolErrors.join(" | ")}\n`);
    }
  }

  const total = all.reduce(
    (acc, o) => ({ input: acc.input + o.input, output: acc.output + o.output }),
    { input: 0, output: 0 },
  );
  const writeCells = all.filter((o) =>
    o.calls.some((n) => n === "Write" || n === "Edit"),
  ).length;
  const bashCells = all.filter((o) => o.calls.includes("Bash")).length;

  process.stdout.write(
    `\n==== 汇总 ====\n` +
      `  出现过 Write/Edit 的格：${String(writeCells)} / ${String(all.length)}\n` +
      `  用过 Bash 的格：${String(bashCells)} / ${String(all.length)}\n` +
      `  闸拦下合计：${String(all.reduce((n, o) => n + o.blocked, 0))} 次\n` +
      `  用量：input ${String(total.input)} · output ${String(total.output)}\n`,
  );
}

if (process.env["PROBE_ROLE"] === "child") await runChild();
else await main();
