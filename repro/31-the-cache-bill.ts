/**
 * 探针 31：每轮都变的那一块，放头和放尾，缓存差多少？——票 01（`.scratch/view-layout/`）
 *
 * 运行：`bun repro/31-the-cache-bill.ts`
 * 🔴 **这个探针花钱**，约 20 万 input token。跑完最后一行会印实际数字。
 *
 * ## 要答的
 *
 * **同一个每轮都变的块，放在 messages 开头 vs 放在末尾，前缀缓存差多少？**
 *
 * 背景是课程 05 留言区在 deepseek-v4-flash 上量到的 95% → 40%（未命中价是命中价 50 倍）。
 * 这个探针不复现那个数——**本仓库今天跑的是 moonshot-cn / kimi-k3，不是 DeepSeek**——
 * 它答的是结构问题，而结构问题的答案对两家都用得上。
 *
 * ## 三个臂，只差位置
 *
 *   HEAD    [system][每轮变的块][history …]     ← 今天 `injectMemory` 的位置
 *   TAIL    [system][history …][每轮变的块]     ← 投影期追加会落在这里
 *   FRZN    [system][永不变的块][history …]     ← 对照组：应当接近满命中
 *
 * FRZN 是**测量有效性的标尺**（`learn/learning-records/0005-*.md` 的教训：
 * 没有对照组，「没差异」读不出来是真没差异还是测量失效）。
 *
 * ## 预测（写在前面，免得看到数字再编故事）
 *
 *   FRZN   命中随轮次单调涨——前缀只增不改
 *   HEAD   命中 ≈ 0 —— 块一变，它后面的整片前缀全作废
 *   TAIL   命中 ≈ FRZN，只是每轮多付一个「块」的未命中
 *
 * 相位 2 直接验最后那条恒等式：**miss(TAIL) − miss(FRZN) ≈ 块 × (轮数 − 1)**。
 *
 * ## v1 踩到的三个坑（2026-08-24，全部已修）
 *
 * 1. **臂名长度不等** → 三个臂的请求大小不一样（FRZN 的 system 比 HEAD 长），
 *    位置就不是唯一变量了。现在所有 seed 都是**定长**的。
 * 2. **相位 2 的第一个点和相位 1 的 TAIL 臂字节完全相同** → 它量到的是相位 1 留下的
 *    热缓存（97.4%），不是一条新轨迹。现在 seed 里带相位号。
 * 3. 🔴 **这个 provider 的前缀缓存不是同步落的。** v1 里对照组出现
 *    「命中 → 0 → 0 → 命中」这种中途归零，而**字节完全相同的重放能稳定拿到 ~97%**。
 *    也就是说零不是「前缀变了」，是**首次填充没赶上**。两个应对：轮间等 8 秒，
 *    以及**跑多个复本取合计**。⚠️ **复本必须换 seed**——重放同一条轨迹会让每一发都命中
 *    自己的上一遍双胞胎，连 HEAD 都会变成满命中，那就什么也没测到。
 */
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";

import { loadConfig } from "../src/config";
import { resolveModelConfig } from "../src/models";

const resolved = resolveModelConfig(loadConfig());
const run = String(Date.now()).slice(-6);

const model = new ChatOpenAI({
  model: resolved.model,
  apiKey: resolved.apiKey,
  configuration: { baseURL: resolved.baseURL },
  maxTokens: 32,
});

const TURNS = 5;
const REPLICATES = 2;
const BLOCK_UNITS = 45; // ≈ 200 token
const CHUNK_UNITS = 260; // ≈ 1200 token 的「工具返回」
const TURN_GAP_MS = 8_000;

type Arm = "HEAD" | "TAIL" | "FRZN";
const ARMS: Arm[] = ["HEAD", "TAIL", "FRZN"];

/**
 * 定长 seed：相位 + 复本 + 臂序号。
 *
 * ⚠️ **定长是判据的一部分**，不是洁癖：seed 进 filler 的每一个单元，长度差一个字符
 * 就会让某个臂的请求整体变大，位置就不再是唯一变量（v1 的坑 ①）。
 */
function seed(phase: number, replicate: number, arm: Arm): string {
  return `${run}p${String(phase)}r${String(replicate)}a${String(ARMS.indexOf(arm))}`;
}

function filler(tag: string, units: number): string {
  const parts: string[] = [];
  for (let i = 0; i < units; i++) parts.push(`${tag}-${String(i)}`);
  return parts.join(" ");
}

function systemFor(s: string): string {
  return [
    `You are probe-${s}, a measurement fixture.`,
    filler(`sys${s}`, 60),
    "Answer every question with the single word: ok.",
  ].join("\n");
}

/** 每轮都变的块。轮次号在最前面——`format_state(run)` 的轮次计数就是这么变的。 */
function varyingBlock(s: string, turn: number, units: number): string {
  return [`[STATE] turn=${String(turn).padStart(3, "0")}`, filler(`st${s}`, units)].join("\n");
}

/** 永不变的块。同样大小、同样位置，只有内容不随轮次动。 */
function frozenBlock(s: string, units: number): string {
  return [`[STATE] turn=fix`, filler(`st${s}`, units)].join("\n");
}

function historyChunk(s: string, turn: number): string {
  return `[tool result ${s}/${String(turn)}]\n${filler(`h${s}t${String(turn)}`, CHUNK_UNITS)}`;
}

interface Reading {
  turn: number;
  input: number;
  cached: number;
}

/**
 * 退避重试。
 *
 * ⚠️ **不是可选的**：2026-08-24 跑的时候引擎持续报
 * `429 engine_overloaded_error`（capacity 类，不是配额类）。这个探针要连发几十个大请求，
 * 撞上是常态，而中途死掉会浪费前面已经花掉的 token。只重试 429 / 5xx——
 * 重试一个 400 只是把同一个错误再买五遍。
 */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  const delays = [2_000, 4_000, 8_000, 16_000, 32_000, 64_000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const status = (error as { status?: number }).status;
      const retryable = status === 429 || (status !== undefined && status >= 500);
      if (!retryable || attempt >= delays.length) throw error;
      const wait = delays[attempt] ?? 64_000;
      process.stdout.write(`    ↻ ${String(status)}，${String(wait / 1000)}s 后重试\n`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

async function ask(system: string, body: string[]): Promise<Omit<Reading, "turn">> {
  const response = await withRetry(() =>
    model.invoke([new SystemMessage(system), ...body.map((text) => new HumanMessage(text))]),
  );
  const usage = response.usage_metadata as
    | { input_tokens?: number; input_token_details?: { cache_read?: number } }
    | undefined;
  const raw = (response as { response_metadata?: { usage?: { cached_tokens?: number } } })
    .response_metadata?.usage;
  return {
    input: usage?.input_tokens ?? 0,
    cached: usage?.input_token_details?.cache_read ?? raw?.cached_tokens ?? 0,
  };
}

async function runArm(
  phase: number,
  replicate: number,
  arm: Arm,
  turns: number,
  blockUnits: number,
): Promise<Reading[]> {
  const s = seed(phase, replicate, arm);
  const system = systemFor(s);
  const history: string[] = [];
  const readings: Reading[] = [];

  for (let turn = 1; turn <= turns; turn++) {
    history.push(historyChunk(s, turn));
    const block =
      arm === "FRZN" ? frozenBlock(s, blockUnits) : varyingBlock(s, turn, blockUnits);
    const body = arm === "TAIL" ? [...history, block] : [block, ...history];
    readings.push({ turn, ...(await ask(system, body)) });
    // 给缓存填充留时间——v1 的坑 ③。
    if (turn < turns) await new Promise((resolve) => setTimeout(resolve, TURN_GAP_MS));
  }
  return readings;
}

function totals(readings: Reading[]): { input: number; cached: number; miss: number } {
  const input = readings.reduce((sum, r) => sum + r.input, 0);
  const cached = readings.reduce((sum, r) => sum + r.cached, 0);
  return { input, cached, miss: input - cached };
}

function report(label: string, readings: Reading[]): void {
  process.stdout.write(`\n${label}\n  轮次     input    cached   命中率\n`);
  for (const r of readings) {
    const rate = r.input === 0 ? 0 : (r.cached / r.input) * 100;
    process.stdout.write(
      `  ${String(r.turn).padStart(4)}${String(r.input).padStart(10)}${String(r.cached).padStart(10)}${`${rate.toFixed(1)}%`.padStart(9)}\n`,
    );
  }
  const t = totals(readings);
  process.stdout.write(
    `  合计${String(t.input).padStart(10)}${String(t.cached).padStart(10)}${`${((t.cached / t.input) * 100).toFixed(1)}%`.padStart(9)}\n`,
  );
}

process.stdout.write(`provider ${resolved.provider} / model ${resolved.model}\n`);
process.stdout.write(`baseURL  ${resolved.baseURL}\nrun      ${run}\n`);

// ── 相位 0：这个 provider 到底报不报 cached_tokens？ ────────────────────────
const calSeed = seed(0, 0, "HEAD");
const calBody = [historyChunk(calSeed, 1), historyChunk(calSeed, 2)];
const cold = await ask(systemFor(calSeed), calBody);
const warm = await ask(systemFor(calSeed), calBody);
process.stdout.write(
  `\n相位 0 · 标定（同一个请求发两遍）\n  冷 input=${String(cold.input)} cached=${String(cold.cached)}\n  热 input=${String(warm.input)} cached=${String(warm.cached)}（${((warm.cached / warm.input) * 100).toFixed(1)}%）\n`,
);
if (warm.cached === 0) {
  process.stdout.write("\n🔴 热的那发仍是 0——观测面不存在，后面不用跑了。\n");
  process.exit(1);
}

// ── 相位 1：三个臂 × 复本 ───────────────────────────────────────────────────
process.stdout.write("\n══ 相位 1：同一个每轮变的块，放头 vs 放尾 ══\n");
const pooled: Record<Arm, Reading[]> = { HEAD: [], TAIL: [], FRZN: [] };
for (let replicate = 0; replicate < REPLICATES; replicate++) {
  for (const arm of ARMS) {
    const readings = await runArm(1, replicate, arm, TURNS, BLOCK_UNITS);
    report(`复本 ${String(replicate + 1)} · ${arm}`, readings);
    pooled[arm].push(...readings);
  }
}

const H = totals(pooled.HEAD);
const T = totals(pooled.TAIL);
const F = totals(pooled.FRZN);
const rate = (x: { input: number; cached: number }): string =>
  `${((x.cached / x.input) * 100).toFixed(1)}%`;

process.stdout.write(
  `\n合并 ${String(REPLICATES)} 个复本\n` +
    `  HEAD  input ${String(H.input).padStart(7)}  未命中 ${String(H.miss).padStart(7)}  命中率 ${rate(H)}\n` +
    `  TAIL  input ${String(T.input).padStart(7)}  未命中 ${String(T.miss).padStart(7)}  命中率 ${rate(T)}\n` +
    `  FRZN  input ${String(F.input).padStart(7)}  未命中 ${String(F.miss).padStart(7)}  命中率 ${rate(F)}  ← 对照组\n`,
);
process.stdout.write(
  `\n判读\n  ${F.cached / F.input > 0.6 ? "✅ 对照组命中良好，测量有效" : "🔴 对照组自己就命中不了——下面两行不可用作结论"}\n` +
    `  TAIL 比 HEAD 少付 ${String(H.miss - T.miss)} 个未命中 token（${(((H.miss - T.miss) / H.miss) * 100).toFixed(1)}%）\n` +
    `  TAIL 比 FRZN 多付 ${String(T.miss - F.miss)} 个\n`,
);

// ── 相位 2：尾部块的代价，验恒等式 ──────────────────────────────────────────
// 只跑 TAIL 和 FRZN：问题是「加这一块要花多少」，位置那一问相位 1 已经答了。
const BIG = BLOCK_UNITS * 4;
process.stdout.write(`\n══ 相位 2：块放大到 ${String(BIG)} 单位，验 miss(TAIL) − miss(FRZN) ≈ 块 × (轮数−1) ══\n`);
const bigTail = await runArm(2, 0, "TAIL", TURNS, BIG);
const bigFrzn = await runArm(2, 0, "FRZN", TURNS, BIG);
report(`大块 · TAIL`, bigTail);
report(`大块 · FRZN`, bigFrzn);

// 块自己有多大：小块与大块每轮的 input 差 = 两者体积差；块大小按单位数按比例反推。
// ⚠️ v2 第一版把这个差**当成了块本身**印出来（"大块 ≈ 1485"），差了一个 BLOCK_UNITS。
const delta = (totals(bigTail).input - T.input / REPLICATES) / TURNS;
const smallBlockTokens = delta / (BIG / BLOCK_UNITS - 1);
const bigBlockTokens = smallBlockTokens + delta;
const predicted = bigBlockTokens * (TURNS - 1);
const observed = totals(bigTail).miss - totals(bigFrzn).miss;
process.stdout.write(
  `\n  小块 ≈ ${smallBlockTokens.toFixed(0)} token，大块 ≈ ${bigBlockTokens.toFixed(0)} token（由每轮 input 差反推）\n` +
    `  实测差 miss(TAIL) − miss(FRZN) = ${String(observed)}\n` +
    `  预测   大块 × (轮数−1)          = ${predicted.toFixed(0)}\n` +
    `  ${observed > predicted * 1.5 ? `🔴 **实测是预测的 ${(observed / predicted).toFixed(1)} 倍——「尾部块只花它自己那点」这条恒等式证伪**` : "✅ 恒等式成立"}\n`,
);

const grand =
  cold.input + warm.input + H.input + T.input + F.input +
  totals(bigTail).input + totals(bigFrzn).input;
process.stdout.write(`\n本次共发 input ${String(grand)} token\n`);
