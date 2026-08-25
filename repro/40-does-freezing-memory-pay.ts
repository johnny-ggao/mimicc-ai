/**
 * 探针 40：冻结记忆块，真实缓存命中率差多少？——票 04（`.scratch/stable-head/`）
 *
 * 运行：`bun repro/40-does-freezing-memory-pay.ts <label>`（label 进结果文件名）
 * 🔴 **这个探针花钱**，估约 17 万 input token/次。跑完最后印实际用量。
 *
 * ## 为什么不是复跑 `repro/31`
 *
 * 🔴 `repro/31` 用 `model.invoke([...])` **手搓消息直接打 provider**（`repro/31:139`），
 * **从不经过 `injectMemory`、agent 或任何中间件**。复跑它只会得到 2026-08-24 那组数，
 * 对 `a27f93f` 那次改动一无所知。而且它跑的是 **deepseek-v4-flash**，今天配的是 **v4-pro**
 * ——拿它当「前」是型号和路径两处一起变，读不出是哪个的功劳。
 *
 * **所以这里走真 agent**：`createUniversalAgent` + 真中间件栈 + 真 provider。
 *
 * ## 三个臂
 *
 *   QUIET  记忆在，五轮一个字不改        ← 对照：块本来就不变，应当接近满命中
 *   CHURN  记忆每轮加一条                ← 被测的那个：改了记忆还要不要钱
 *   NONE   完全没有记忆                  ← 第二对照：隔离「记忆块自己」的贡献
 *
 * **要答的是 CHURN 相对 QUIET 掉多少。** 冻结之前它应当塌掉（块一变，它之后全废）；
 * 冻结之后它应当≈QUIET，只多付尾部那条 `<memory-update>` 自己的 token。
 *
 * 🔑 **两个对照都是必须的。** `../view-layout/` 票 02 栽过一次：**对照组只验了一半，
 * 而坏的正是没验那一面。** QUIET 说「测量有效」，NONE 说「差异确实来自记忆块」。
 *
 * ## `repro/31` 的三个坑，逐条防住
 *
 * 1. **定长 seed** —— 否则各臂请求大小不同，位置就不是唯一变量。
 * 2. **相位/复本/臂/轮次都进 seed** —— 否则量到的是上一遍留下的热缓存。
 * 3. 🔴 **复本必须换 seed** —— 重放同一条轨迹会让每一发命中自己的双胞胎，
 *    连塌掉的臂都会满命中，那就什么也没测到。
 * 另加轮间 8 秒：这个 provider 的前缀缓存不是同步落的，v1 里对照组出现过中途归零。
 *
 * ## 污染检测
 *
 * 真 agent 带着 Bash/Write/Task/Memory* 工具。模型一旦真去调，这一轮就不是一次干净的
 * 单发请求，而且 `MemoryAdd` 会当场改掉本臂的 store，把设计搅烂。
 * 两道防线：**系统提示词明令只回一个词**，**四个可规则化的工具 deny 掉**；
 * 再加一道观测——**一轮超过一次模型调用就判这个复本作废并印出来**，不静默。
 */
import { HumanMessage } from "@langchain/core/messages";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUniversalAgent, DURABILITY, RECURSION_LIMIT } from "../src/agents";
import { loadConfig } from "../src/config";
import { MemoryStore, type MemoryDirs } from "../src/memory";
import { resolveModelConfig } from "../src/models";
import { parseRule, type RuleSet } from "../src/tools/permission";
import { type ModelUsage } from "../src/usage";

const LABEL = process.argv[2] ?? "run";
const resolved = resolveModelConfig(loadConfig());

const TURNS = 5;
const REPLICATES = 2;
/**
 * 轮间等待。这个 provider 的前缀缓存不是同步落的（`repro/31` 的坑 3：对照组出现过
 * 中途归零，而字节相同的重放稳定拿 ~97%），所以真跑必须留 8 秒。
 * ⚠️ **只有拿本地 stub 空跑时才设 `PROBE_GAP_MS=0`** —— 真跑设它等于自毁测量。
 */
const TURN_GAP_MS = Number(process.env.PROBE_GAP_MS ?? 8_000);
/** ≈900 token 的填充，让历史逐轮长起来。定长。 */
const PAD_UNITS = 190;
const BASE_MEMORIES = 3;

/** 臂名定长，五个字符——请求大小不能因为名字长短而不同。 */
type Arm = "QUIET" | "CHURN" | "NONE_";
const ARMS: Arm[] = ["QUIET", "CHURN", "NONE_"];

/** 模型一旦真调工具，这四个先被拒；剩下的靠污染检测兜。 */
const DENY: RuleSet = [
  parseRule("Read(**)", "deny"),
  parseRule("Write(**)", "deny"),
  parseRule("Edit(**)", "deny"),
  parseRule("Bash(*)", "deny"),
];

const SYSTEM = [
  "You are a benchmark stub. Your only job is to reply with the single word ACK.",
  "Never call a tool. Never explain. Never add punctuation. Reply: ACK",
  // 撑到接近真实系统提示词的量级（生产上约 2400 token），否则固定前缀太短、
  // 命中率会被一个不真实的分母抬高。
  `pad ${"s".repeat(9_000)}`,
].join("\n");

/** 定长 seed：标签 + 相位 + 复本 + 臂 + 轮次，全部零填充到固定宽度。 */
function seed(replicate: number, arm: Arm, turn: number): string {
  const w = (n: number, width: number) => String(n).padStart(width, "0");
  return `${LABEL.slice(0, 4).padEnd(4, "_")}-r${w(replicate, 2)}-${arm}-t${w(turn, 2)}`;
}

function padding(tag: string): string {
  return `${tag} ${Array.from({ length: PAD_UNITS }, (_, i) => `w${String(i).padStart(4, "0")}`).join(" ")}`;
}

/** 定长记忆正文，免得各臂 store 体积不可比。 */
function memoryText(tag: string, n: number): string {
  return `fact ${tag}-${String(n).padStart(3, "0")} ${"m".repeat(120)}`;
}

interface ArmResult {
  arm: Arm;
  replicate: number;
  input: number;
  cached: number;
  output: number;
  calls: number;
  contaminated: boolean;
}

async function runArm(arm: Arm, replicate: number): Promise<ArmResult> {
  const root = mkdtempSync(join(tmpdir(), `probe40-${arm}-`));
  const dirs: MemoryDirs = { global: join(root, "global"), project: join(root, "project") };
  const usages: ModelUsage[] = [];
  let contaminated = false;

  const store = new MemoryStore(dirs);
  if (arm !== "NONE_") {
    for (let i = 0; i < BASE_MEMORIES; i += 1) {
      store.add(memoryText(seed(replicate, arm, 0), i), "user", {
        threadId: "probe",
        callId: `seed-${String(i)}`,
      });
    }
  }

  const graph = createUniversalAgent({
    baseURL: resolved.baseURL,
    apiKey: resolved.apiKey,
    model: resolved.model,
    systemPrompt: SYSTEM,
    rules: DENY,
    outputBudget: 32,
    ...(arm === "NONE_" ? {} : { memory: dirs }),
    onUsage: (usage) => usages.push(usage),
  });

  const thread = `probe40-${LABEL}-${arm}-${String(replicate)}`;
  for (let turn = 1; turn <= TURNS; turn += 1) {
    // CHURN 在**这一轮开始之前**改 store，所以第一轮的块和 QUIET 同形，
    // 差异从第二轮起才出现——那正是「改了记忆要不要钱」的问题。
    if (arm === "CHURN" && turn > 1) {
      store.add(memoryText(seed(replicate, arm, turn), 900 + turn), "project", {
        threadId: "probe",
        callId: `churn-${String(turn)}`,
      });
    }

    const before = usages.length;
    await graph.invoke(
      { messages: [new HumanMessage(`${padding(seed(replicate, arm, turn))}\nReply: ACK`)] },
      {
        recursionLimit: RECURSION_LIMIT,
        durability: DURABILITY,
        configurable: { thread_id: thread },
      },
    );
    const laps = usages.length - before;
    if (laps !== 1) {
      contaminated = true;
      console.log(`  ⚠️ ${arm} r${String(replicate)} t${String(turn)}: ${String(laps)} 次模型调用（应为 1）——这个复本作废`);
    }
    if (turn < TURNS) await Bun.sleep(TURN_GAP_MS);
  }

  rmSync(root, { recursive: true, force: true });

  const sum = (pick: (u: ModelUsage) => number) => usages.reduce((a, u) => a + pick(u), 0);
  return {
    arm,
    replicate,
    input: sum((u) => u.inputTokens),
    cached: sum((u) => u.cacheRead ?? 0),
    output: sum((u) => u.outputTokens),
    calls: usages.length,
    contaminated,
  };
}

console.log(`探针 40 · label=${LABEL} · ${resolved.model} @ ${resolved.baseURL}`);
console.log(`${String(ARMS.length)} 臂 × ${String(REPLICATES)} 复本 × ${String(TURNS)} 轮，轮间 ${String(TURN_GAP_MS / 1000)} 秒\n`);

const results: ArmResult[] = [];
for (let replicate = 1; replicate <= REPLICATES; replicate += 1) {
  for (const arm of ARMS) {
    const result = await runArm(arm, replicate);
    const rate = result.input === 0 ? 0 : (result.cached / result.input) * 100;
    console.log(
      `  ${arm} r${String(replicate)}  input ${String(result.input).padStart(7)}  cached ${String(result.cached).padStart(7)}  命中 ${rate.toFixed(1)}%${result.contaminated ? "  ⚠️作废" : ""}`,
    );
    results.push(result);
  }
}

console.log("\n合计（只算未污染的复本）：");
const byArm = ARMS.map((arm) => {
  const rows = results.filter((r) => r.arm === arm && !r.contaminated);
  const input = rows.reduce((a, r) => a + r.input, 0);
  const cached = rows.reduce((a, r) => a + r.cached, 0);
  return { arm, input, cached, rate: input === 0 ? 0 : (cached / input) * 100, replicates: rows.length };
});
for (const row of byArm) {
  console.log(`  ${row.arm}  ${row.rate.toFixed(1)}%  (input ${String(row.input)}, cached ${String(row.cached)}, 有效复本 ${String(row.replicates)})`);
}

const totalIn = results.reduce((a, r) => a + r.input, 0);
const totalOut = results.reduce((a, r) => a + r.output, 0);
console.log(`\n实际用量：input ${String(totalIn)} · output ${String(totalOut)}`);

const out = join(process.cwd(), `.probe40-${LABEL}.json`);
writeFileSync(out, JSON.stringify({ label: LABEL, model: resolved.model, byArm, results, totalIn, totalOut }, null, 2));
console.log(`结果写到 ${out}`);
