/**
 * 选项 C 要每条 `Bash` 之后重 hash 所有带标记的文件——那要多少钱？
 * —— 票 07（`.scratch/deterministic-gate/`）
 *
 * 运行：`bun repro/42-what-post-hoc-hashing-costs.ts`
 * ✅ **不花钱**：没有模型，没有网络。纯本地测量。
 *
 * ## 为什么这一问值得单独量
 *
 * 用户驳回了「测模型多常用 `Bash`」那个探针，理由逐字：*模型的输出带有不小的不确定性，
 * 去撞 bash 本质上不能得到确定性的结论*。**这个探针是那条原则的正面例子**：
 * 它量的是一个确定性系统的确定性代价，跑一百次得一百次同样的结论。
 *
 * ## 三个数
 *
 *   N        真实会话里同时活着的标记有多少（从 `.mimicc/*.jsonl` 数出来）
 *   每次代价  stat + 读 + sha256 那 N 个文件要多久
 *   占比      相对一次真实 `Bash` 调用的耗时
 *
 * ⚠️ **上限用的是全文，不是 `MAX_FILE_BYTES`**：标记哈希的是整个文件
 * （`src/agents/readBeforeWrite.ts` 的 `hashOf`），而 `Read` 只把前 64KB 给模型看。
 * 所以拿仓库里的**真实文件**来量，不用合成数据。
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** 真实会话里每条 session 读过多少个不同文件——标记数的上界。 */
function marksInRealSessions(): number[] {
  const dir = join(ROOT, ".mimicc");
  const counts: number[] = [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl") && !f.includes(".tools."));
  } catch {
    return counts;
  }
  for (const file of files) {
    const text = readFileSync(join(dir, file), "utf8");
    const paths = new Set<string>();
    for (const match of text.matchAll(/"name":"Read","args":\{"path":"([^"]*)"/g)) {
      paths.add(match[1] ?? "");
    }
    if (paths.size > 0) counts.push(paths.size);
  }
  return counts.sort((a, b) => a - b);
}

/** The repository's own source files, biggest first — what a real mark set looks like. */
function realFiles(limit: number): string[] {
  const out: { path: string; size: number }[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (/\.(ts|md|json)$/.test(entry.name)) {
        try {
          out.push({ path: full, size: statSync(full).size });
        } catch {
          /* unreadable, skip */
        }
      }
    }
  };
  walk(join(ROOT, "src"), 0);
  walk(join(ROOT, "tests"), 0);
  walk(join(ROOT, "repro"), 0);
  out.sort((a, b) => b.size - a.size);
  return out.slice(0, limit).map((f) => f.path);
}

/** Exactly what the gate's `hashOf` does, N times. */
function hashAll(paths: string[]): number {
  let bytes = 0;
  for (const path of paths) {
    try {
      if (!statSync(path, { throwIfNoEntry: false })?.isFile()) continue;
      const buffer = readFileSync(path);
      bytes += buffer.length;
      createHash("sha256").update(buffer).digest("hex");
    } catch {
      /* fail-open, same as the gate */
    }
  }
  return bytes;
}

function timed(work: () => number): { ms: number; bytes: number } {
  const started = performance.now();
  const bytes = work();
  return { ms: performance.now() - started, bytes };
}

/** A real Bash call, to have something to compare the overhead against. */
async function bashMs(command: string): Promise<number> {
  const started = performance.now();
  const proc = Bun.spawn(["/bin/sh", "-c", command], { stdout: "pipe", stderr: "pipe" });
  await new Response(proc.stdout).text();
  await proc.exited;
  return performance.now() - started;
}

const REPEATS = 5;

async function main(): Promise<void> {
  process.stdout.write("\n==== N：真实会话里活着的标记数 ====\n\n");
  const counts = marksInRealSessions();
  if (counts.length === 0) {
    process.stdout.write("  (.mimicc 里没有会话，跳过)\n");
  } else {
    process.stdout.write(
      `  每条 session 读过的不同文件：${counts.join(" / ")}\n` +
        `  最大 ${String(counts[counts.length - 1])}\n`,
    );
  }
  process.stdout.write(
    "\n  ⚠️ 这是**上界**：标记活在消息里，摘要吃掉读结果标记就没了，\n" +
      "     所以同时活着的只会更少（`readBeforeWrite` 的 D3）。\n",
  );

  process.stdout.write("\n==== 每次 Bash 之后重 hash 的代价 ====\n\n");
  process.stdout.write("     N   总字节   最好(ms)   中位(ms)   最差(ms)\n");
  const rows: { n: number; median: number }[] = [];
  for (const n of [1, 5, 19, 50, 200]) {
    const paths = realFiles(n);
    if (paths.length === 0) continue;
    const runs: number[] = [];
    let bytes = 0;
    for (let i = 0; i < REPEATS; i += 1) {
      const r = timed(() => hashAll(paths));
      runs.push(r.ms);
      bytes = r.bytes;
    }
    runs.sort((a, b) => a - b);
    const median = runs[Math.floor(runs.length / 2)] ?? 0;
    rows.push({ n: paths.length, median });
    process.stdout.write(
      `  ${String(paths.length).padStart(4)}   ${(bytes / 1024).toFixed(0).padStart(5)}K   ` +
        `${(runs[0] ?? 0).toFixed(2).padStart(7)}   ${median.toFixed(2).padStart(7)}   ` +
        `${(runs[runs.length - 1] ?? 0).toFixed(2).padStart(7)}\n`,
    );
  }
  process.stdout.write("\n  ⚠️ 取仓库里**最大的** N 个文件，所以这是悲观值。\n");

  process.stdout.write("\n==== 对照：一次真实 Bash 调用要多久 ====\n\n");
  const commands = ["ls", "git status", "grep -r 'export' src --include=*.ts -l"];
  const baselines: { command: string; ms: number }[] = [];
  for (const command of commands) {
    const runs: number[] = [];
    for (let i = 0; i < REPEATS; i += 1) runs.push(await bashMs(command));
    runs.sort((a, b) => a - b);
    const median = runs[Math.floor(runs.length / 2)] ?? 0;
    baselines.push({ command, ms: median });
    process.stdout.write(`  ${median.toFixed(1).padStart(7)}ms   ${command}\n`);
  }

  process.stdout.write("\n==== 占比 ====\n\n");
  const cheapest = baselines.reduce((a, b) => (a.ms < b.ms ? a : b));
  process.stdout.write(`  拿最便宜的那条命令作分母：\`${cheapest.command}\` ${cheapest.ms.toFixed(1)}ms\n\n`);
  for (const row of rows) {
    const pct = (row.median / cheapest.ms) * 100;
    process.stdout.write(
      `  N=${String(row.n).padStart(3)}  →  +${row.median.toFixed(2)}ms  (${pct.toFixed(1)}% of \`${cheapest.command}\`)\n`,
    );
  }
  process.stdout.write(
    "\n  怎么读：**这是延迟，不是 token**。选项 C 不往上下文里加任何东西，\n" +
      "  除非真的检测到变化——所以它的常态成本只有这里这个数。\n",
  );
}

await main();
