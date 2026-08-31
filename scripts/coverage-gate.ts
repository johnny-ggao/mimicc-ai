#!/usr/bin/env bun
/**
 * 覆盖率门禁：总体 ≥ 80%，算在 `coverage/lcov.info` 上。
 *
 * Run: `bun run test:coverage`（先 `bun test --coverage` 生成 lcov，再跑这里）
 *
 * ## 为什么门槛不在 bunfig.toml
 *
 * `coverageThreshold` 在 Bun 1.3.14 上是**按文件逐个判**的，不是按总体：
 * 仓库外最小复现（2026-08-31）——总体 50%、门槛 0.4、树里有一个 0% 的文件，退 1。
 * 而表里 `All files` 那行印的又是**按文件平均**。于是同一个 0.8 有三种读法：
 * 注释写的意图（总体）、bun 判的（逐文件）、表上印的（文件均值），互相都对不上。
 * `src/console/repl.ts`（交互 REPL，单测够不着的那部分）行覆盖 ~11%，逐文件语义下
 * **任何**门槛值都过不去——CI 从 2026-08-14 起每一跑都红在这一步，一红十七天，
 * 因为 bun 挂的时候**一个字都不印**。上游 oven-sh/bun#17028 是同一个形状。
 *
 * ## 判什么
 *
 * 行与函数两个维度的**加权总体**（Σ命中/Σ总数）：大文件按大小说话，
 * 一个一千行的低覆盖模块不会被七十个小文件的 100% 平均掉——文件均值会。
 * lcov 里只有测试真加载过的文件（`coverageSkipTestFiles` 排除测试自身），
 * 所以这和 bunfig 注释说的一样，是「已测代码的质量」指标，不是「测了多少」。
 *
 * 判据落在退出码上：缺 lcov、空 lcov、任一维度不达标，都退非零——
 * 只印红字不退非零的守卫等于没有（repro/51 用血换来的那条）。
 */
import { readFileSync } from "node:fs";

const LCOV = "coverage/lcov.info";
const THRESHOLD = 0.8;

interface FileCoverage {
  path: string;
  linesFound: number;
  linesHit: number;
  functionsFound: number;
  functionsHit: number;
}

let text: string;
try {
  text = readFileSync(LCOV, "utf8");
} catch {
  process.stdout.write(
    `🔴 读不到 ${LCOV}——门禁没东西可判，按不过算。\n` +
      "   先跑 `bun test --coverage`（报表配置在 bunfig.toml 的 [test] 里）。\n",
  );
  process.exit(1);
}

const files: FileCoverage[] = [];
let current: FileCoverage | null = null;
for (const raw of text.split("\n")) {
  const line = raw.trim();
  if (line.startsWith("SF:")) {
    current = {
      path: line.slice(3),
      linesFound: 0,
      linesHit: 0,
      functionsFound: 0,
      functionsHit: 0,
    };
    files.push(current);
  } else if (current !== null) {
    if (line.startsWith("LF:")) current.linesFound = Number(line.slice(3));
    else if (line.startsWith("LH:")) current.linesHit = Number(line.slice(3));
    else if (line.startsWith("FNF:")) current.functionsFound = Number(line.slice(4));
    else if (line.startsWith("FNH:")) current.functionsHit = Number(line.slice(4));
  }
}

if (files.length === 0) {
  process.stdout.write(`🔴 ${LCOV} 里一个 SF 记录都没有——空报表不是绿，按不过算。\n`);
  process.exit(1);
}

/** 一个维度的判决。NaN 与 0/0 都落在「不过」那边——守卫失明时要红，不要绿。 */
function judge(name: string, hit: number, found: number): boolean {
  const ratio = found > 0 ? hit / found : 0;
  const ok = ratio >= THRESHOLD;
  process.stdout.write(
    `  ${ok ? "✅" : "🔴"} ${name}  ${String(hit)}/${String(found)} = ${(ratio * 100).toFixed(1)}%（门槛 ${String(THRESHOLD * 100)}%）\n`,
  );
  return ok;
}

process.stdout.write(
  `覆盖率门禁（${LCOV}，${String(files.length)} 个文件，加权总体——上面表里 All files 是文件均值，另一套算法）\n`,
);
const linesOk = judge(
  "行  ",
  files.reduce((sum, file) => sum + file.linesHit, 0),
  files.reduce((sum, file) => sum + file.linesFound, 0),
);
const functionsOk = judge(
  "函数",
  files.reduce((sum, file) => sum + file.functionsHit, 0),
  files.reduce((sum, file) => sum + file.functionsFound, 0),
);

if (!linesOk || !functionsOk) {
  const worst = [...files]
    .sort((a, b) => b.linesFound - b.linesHit - (a.linesFound - a.linesHit))
    .slice(0, 5);
  process.stdout.write("\n未覆盖行数最多的五个（拖秤的在这里找）：\n");
  for (const file of worst) {
    process.stdout.write(
      `  ${String(file.linesFound - file.linesHit).padStart(5)} 行未覆盖  ${file.path}（${file.linesHit === 0 ? "0" : String(file.linesHit)}/${String(file.linesFound)}）\n`,
    );
  }
  process.exit(1);
}
