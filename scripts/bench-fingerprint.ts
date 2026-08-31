#!/usr/bin/env bun
/**
 * bench/ 冻结面的指纹对账。
 *
 * Run: `bun run bench:fingerprint`（校验）／`bun scripts/bench-fingerprint.ts --write`（重打指纹）
 *
 * ## 它在挡什么
 *
 * `bench/README.md` 的头号规矩：**改 `measure.ts` 的三个问题、或改 `fixture*` 下任何一个
 * 字节 = 作废全部历史基线。** 但在 2026-08-31 之前这条规矩只写在文档里——bench/ 同时被排除出
 * lint、typecheck 和探针冒烟（各有各的理由，README 里都写着），于是手改 fixture、改题面、
 * 让工具链重排，三条路都无声通过所有关卡。守卫哑着，规矩就只是劝诫（审查判它 admonition_only，
 * 依据是 `docs/harness-principles.md` 原则 2）。
 *
 * ## 它不挡什么
 *
 * **这不是禁止改，是禁止无声改。** 有意作废基线时：跑 `--write` 重打指纹，把新指纹和改动
 * 一起提交，并在提交信息里写明「作废基线」——记账落在 git diff 里，正是 `fingerprint.json`
 * 存在的意义（同一手法见 `scripts/probe-smoke.ts` 的退役对账：登记表自身也要防腐烂）。
 *
 * 点文件（`.DS_Store` 这类）不进指纹：它们不进 git，本机有、CI 没有，收进来指纹就在
 * 两边对不上了——指纹要量的是**基线依赖的字节**，不是目录的杂音。
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const BENCH = join(ROOT, "bench");
const MANIFEST = join(BENCH, "fingerprint.json");

/** 冻结的脚本：README 点名 `measure.ts`；另两个各自背着票 04/05 的历史读数。 */
const FROZEN_FILES = ["measure.ts", "measure-agents-md.ts", "measure-reread.ts"];
/** 冻结的 fixture：README 写明「三份都是冻结的」。 */
const FROZEN_DIRS = ["fixture", "fixture-agents-md", "fixture-edit"];

interface Manifest {
  why: string;
  files: Record<string, string>;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** 目录下所有非点文件的相对路径，递归、排序——顺序稳定，diff 才可读。 */
function walk(dir: string, prefix: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const rel = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...walk(join(dir, entry.name), rel));
    else found.push(rel);
  }
  return found.sort();
}

function current(): Record<string, string> {
  const paths = [
    ...FROZEN_FILES,
    ...FROZEN_DIRS.flatMap((dir) => walk(join(BENCH, dir), dir)),
  ].sort();
  return Object.fromEntries(paths.map((path) => [path, sha256(join(BENCH, path))]));
}

const files = current();

if (process.argv.includes("--write")) {
  const manifest: Manifest = {
    why:
      "bench 冻结面的指纹。改动这里列的任何文件 = 作废全部历史基线（bench/README.md）。" +
      "有意作废时：bun scripts/bench-fingerprint.ts --write，新指纹与改动一起提交，" +
      "提交信息写明「作废基线」。",
    files,
  };
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(
    `✅ 指纹已重打：${String(Object.keys(files).length)} 个文件进 bench/fingerprint.json\n` +
      "   ⚠️ 这一步的意思是「历史基线从此作废」——提交信息里要写明。\n",
  );
  process.exit(0);
}

let recorded: Manifest;
try {
  recorded = JSON.parse(readFileSync(MANIFEST, "utf8")) as Manifest;
} catch {
  process.stdout.write(
    "🔴 bench/fingerprint.json 读不了。指纹清单自己丢了或坏了——它是账本，先把它修回来，\n" +
      "   或用 `bun scripts/bench-fingerprint.ts --write` 重建（那等于宣布历史基线作废）。\n",
  );
  process.exit(1);
}

const changed = Object.keys(files).filter(
  (path) => path in recorded.files && recorded.files[path] !== files[path],
);
const added = Object.keys(files).filter((path) => !(path in recorded.files));
const missing = Object.keys(recorded.files).filter((path) => !(path in files));

if (changed.length + added.length + missing.length === 0) {
  process.stdout.write(
    `✅ bench 冻结面未动（${String(Object.keys(files).length)} 个文件对上指纹）\n`,
  );
  process.exit(0);
}

for (const path of changed) process.stdout.write(`🔴 改动了：bench/${path}\n`);
for (const path of added) process.stdout.write(`🔴 新增了：bench/${path}\n`);
for (const path of missing) process.stdout.write(`🔴 少掉了：bench/${path}\n`);
process.stdout.write(
  "\nbench 冻结面动了 = 历史基线作废（bench/README.md 的头号规矩）。\n" +
    "无意的：把上面的文件改回去。\n" +
    "有意的：`bun scripts/bench-fingerprint.ts --write`，新指纹与改动一起提交，\n" +
    "提交信息写明「作废基线」——**这守卫挡的是无声改，不是改。**\n",
);
process.exit(1);
