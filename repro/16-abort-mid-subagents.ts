/**
 * 三个并行 Explore 被 Ctrl+C（abort）打断后：各自什么状态、写了一半的报告去了哪里、
 * 父回合最终什么状态 —— 票 05 第三处「③」的探针。
 *
 * Run: `bun repro/16-abort-mid-subagents.ts`   （不花钱，打本地 stub，连模型都没有）
 *
 * 票里写「三个 Explore 并行时，Ctrl+C 之后各自处在什么状态、报告写了一半的那个怎么办，
 * 没有测试也没有结论」。代码推断：inFlight.abort() → graph.stream({signal}) → 信号经
 * ToolNode 的 mergeAbortSignals 传进 Task 的 runtime → 每个 Explore 的
 * graph.invoke({signal}) 收到同一信号 → 三个一起 abort → task.ts:225-231 在
 * runtime.signal?.aborted 时 rethrow → ToolNode rethrow → 父 graph 抛 →
 * repl runTurn catch → "^C interrupted"。
 *
 * 这个脚本把三条量出来，不照抄推断：
 *
 * ① 三个并行 abort 时，三个是不是【都】abort，还是有的能跑完？
 *    判据不是「报告没进父状态」（那也可能是跑完了但被丢），而是 usageMeter 的
 *    `onUsage`：它只在模型这一跳**成功返回**后才 fire（src/usage.ts:89-108），
 *    被 abort 的模型调用会在 `handler` 抛掉、走不到 report。所以 explore 的
 *    onUsage 条数 = 几个跑完了；0 = 三个全 abort。
 *
 * ② 父 thread（真 JsonlSaver，临时目录）最终什么形状？应是 human + ai(3 个 Task
 *    tool_calls)、没有 tool 结果、没有最终回答 —— 「未回答」。
 *
 * ③ 写了一半 / 已写完的 Explore 报告，有没有漏进父状态？
 *    实测分两种：**写了一半**的（模型这一跳被 abort、报告没产出）不会漏，因为它压根
 *    不存在；**已写完**的（fast Explore 先跑完、报告已返回）会漏 —— 它的 ToolMessage
 *    走 putWrites 落进父的 pendingWrites，abort 只抛掉了那两个还在跑的，没抛掉这个已
 *    落盘的。这一点**推翻**「报告随整个回合被丢弃」：丢弃的是写了一半的，已写完的
 *    会漏进父状态、恢复时生效。
 *
 * ## 同步点不靠 sleep 猜时序
 *
 * abort 发生在「Explore 还在跑」是被证过的：stub 里每个 Explore 请求到达时记一条
 * `arrived`，父侧等「三个都 arrived」才 abort（all-slow）；one-fast 则等「fast 的
 * ToolMessage 已 putWrites + 两个 slow 已 arrived」才 abort —— 后一个时点由一个
 * JsonlSaver 子类在 `putWrites` 里看到 REPORT-FAST 时报出来，不是 sleep 猜的。
 * abort 那一瞬间会把每个 Explore 的 arrived/completed 快照打出来。
 *
 * ## 每个关键断言都有对照组（不 abort）
 *
 * 同一条 stub、同一批 dispatch，不 abort 跑完：对照组里 explore 的 onUsage=3、
 * 父 thread 有 3 条 tool 结果 + 最终回答、三份报告都在。所以上面「写了一半没有 / ①是 0」
 * 是因为 abort，「已写完会漏」也确实是 abort 场景才有的行为——都不是 stub 不回报告、
 * 也不是 JsonlSaver 压根不写。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { createUniversalAgent, DURABILITY, RECURSION_LIMIT } from "../src/agents";
import { JsonlSaver } from "../src/checkpoint";
import type { ModelUsage } from "../src/usage";

const SLOW_MS = 1500;
const FAST = "probe-fast";
const SLOWS = ["probe-slow-a", "probe-slow-b", "probe-slow-c"];
const REPORTS: Record<string, string> = {
  [FAST]: "REPORT-FAST",
  "probe-slow-a": "REPORT-SLOW-A",
  "probe-slow-b": "REPORT-SLOW-B",
  "probe-slow-c": "REPORT-SLOW-C",
};
const FINAL_ANSWER = "PARENT-FINAL-ANSWER";

const completion = (id: string, message: Record<string, unknown>, finish: string) => ({
  id,
  object: "chat.completion",
  created: 0,
  model: "stub",
  choices: [{ index: 0, message, finish_reason: finish }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

function isExploreBody(body: { messages: { role: string; content?: string }[] }): boolean {
  const system = body.messages.find((message) => message.role === "system");
  return (system?.content ?? "").includes("Explore agent");
}

/** The Explore agent sees only the objective as its human message, so it is findable verbatim. */
function objectiveOf(messages: unknown): string | null {
  const text = JSON.stringify(messages);
  for (const objective of Object.keys(REPORTS)) if (text.includes(objective)) return objective;
  return null;
}

/** Resolves if the client aborts this request before it completes. Bun-only. */
function clientGone(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

interface ExploreRecord {
  objective: string;
  arrived: boolean;
  /** The stub returned a report for this Explore. */
  completed: boolean;
  /** The client (the Explore's model fetch) disconnected before the report returned. */
  clientAborted: boolean;
}

type Mode = "control" | "all-slow" | "one-fast";

// ---- shared, reset per scenario -------------------------------------------------
let server: ReturnType<typeof Bun.serve>;
let mode: Mode = "control";
let exploreRecords: ExploreRecord[] = [];
let usageRecords: ModelUsage[] = [];
let parentLaps = 0;
let fireAbort: (() => void) | null = null;
let atAbort: ExploreRecord[] = [];
/** Set by {@link FastReportSaver} once the fast Explore's ToolMessage has been putWrites'd. */
let fastReportWritten = false;

/**
 * A JsonlSaver that fires when the fast Explore's tool result is written as a pending
 * write. That is the exact moment after which an abort can no longer discard the report —
 * and it is how this probe pins the "已写完" leak down instead of racing it.
 */
class FastReportSaver extends JsonlSaver {
  onFastReportWrite: (() => void) | null = null;

  override async putWrites(
    config: Parameters<JsonlSaver["putWrites"]>[0],
    writes: Parameters<JsonlSaver["putWrites"]>[1],
    taskId: Parameters<JsonlSaver["putWrites"]>[2],
  ): Promise<void> {
    await super.putWrites(config, writes, taskId);
    if (writes.some(([, value]) => JSON.stringify(value).includes(REPORTS[FAST] ?? ""))) {
      this.onFastReportWrite?.();
    }
  }
}

/** Called whenever new evidence might have satisfied the abort condition. */
function maybeAbort(): void {
  if (fireAbort === null) return;
  if (mode === "all-slow") {
    if (exploreRecords.filter((record) => record.arrived).length >= 3) {
      atAbort = exploreRecords.map((record) => ({ ...record }));
      fireAbort();
      fireAbort = null;
    }
  } else if (mode === "one-fast") {
    const slowArrived = exploreRecords.filter(
      (record) => record.objective !== FAST && record.arrived,
    ).length;
    if (fastReportWritten && slowArrived >= 2) {
      atAbort = exploreRecords.map((record) => ({ ...record }));
      fireAbort();
      fireAbort = null;
    }
  }
}

function startServer(): void {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { messages: { role: string; content?: string }[] };

      if (!isExploreBody(body)) {
        parentLaps += 1;
        const dispatched = exploreRecords.length > 0;
        if (dispatched) {
          return Response.json(
            completion(`parent-${String(parentLaps)}`, { role: "assistant", content: FINAL_ANSWER }, "stop"),
          );
        }
        const objectives = mode === "one-fast" ? [FAST, "probe-slow-a", "probe-slow-b"] : SLOWS;
        return Response.json(
          completion(
            `parent-${String(parentLaps)}`,
            {
              role: "assistant",
              content: "",
              tool_calls: objectives.map((objective) => ({
                id: `call_${objective}`,
                type: "function",
                function: {
                  name: "Task",
                  arguments: JSON.stringify({ description: objective, subagent_type: "explore" }),
                },
              })),
            },
            "tool_calls",
          ),
        );
      }

      const objective = objectiveOf(body.messages) ?? "unknown";
      const record: ExploreRecord = { objective, arrived: true, completed: false, clientAborted: false };
      exploreRecords.push(record);
      maybeAbort();

      if (objective === FAST) {
        record.completed = true;
        return Response.json(
          completion(`explore-${objective}`, { role: "assistant", content: REPORTS[objective] ?? "" }, "stop"),
        );
      }

      const raced = await Promise.race([
        Bun.sleep(SLOW_MS).then(() => "slept" as const),
        clientGone(request.signal).then(() => "aborted" as const),
      ]);
      if (raced === "aborted") {
        record.clientAborted = true;
        return new Response(null, { status: 499 });
      }
      record.completed = true;
      return Response.json(
        completion(`explore-${objective}`, { role: "assistant", content: REPORTS[objective] ?? "" }, "stop"),
      );
    },
  });
}

// ---- the parent turn -------------------------------------------------------------

interface ThreadShape {
  types: string[];
  contents: string[];
  pendingWrites: string[];
  /** For each report/answer string, which raw-line kinds contain it (message/writes/checkpoint). */
  rawReportWhere: Record<string, string[]>;
  rawLines: number;
}

async function inspectThread(dir: string, thread: string): Promise<ThreadShape> {
  const saver = new JsonlSaver(dir);
  const tuple = await saver.getTuple({ configurable: { thread_id: thread } });
  const messages = (tuple?.checkpoint.channel_values["messages"] ?? []) as BaseMessage[];
  const pendingWrites = (tuple?.pendingWrites ?? []) as [string, string, unknown][];

  const path = join(dir, `${thread}.jsonl`);
  const raw = existsSync(path) ? readFileSync(path, "utf8") : "";
  const rawLines = raw.split("\n").filter(Boolean);

  const rawReportWhere: Record<string, string[]> = {};
  for (const needle of [...Object.values(REPORTS), FINAL_ANSWER]) {
    rawReportWhere[needle] = rawLines
      .filter((line) => line.includes(needle))
      .map((line) => {
        try {
          return String((JSON.parse(line) as { kind?: string }).kind ?? "?");
        } catch {
          return "?";
        }
      });
  }

  return {
    types: messages.map((message) => message.getType()),
    contents: messages.map((message) =>
      typeof message.content === "string" ? message.content : JSON.stringify(message.content),
    ),
    pendingWrites: pendingWrites.map(([, , value]) => JSON.stringify(value)),
    rawReportWhere,
    rawLines: rawLines.length,
  };
}

interface ScenarioEvidence {
  mode: Mode;
  aborted: boolean;
  parentError: string;
  parentErrorIsAbort: boolean;
  exploreRecords: ExploreRecord[];
  atAbort: ExploreRecord[];
  usageAgents: string[];
  thread: ThreadShape;
  dir: string;
}

async function runScenario(scenarioMode: Mode, doAbort: boolean): Promise<ScenarioEvidence> {
  mode = scenarioMode;
  exploreRecords = [];
  usageRecords = [];
  parentLaps = 0;
  atAbort = [];
  fireAbort = null;
  fastReportWritten = false;

  const directory = mkdtempSync(join(tmpdir(), "mimicc-abort-"));
  const thread = `probe-16-${scenarioMode}`;

  const saver = new FastReportSaver(directory);
  saver.onFastReportWrite = () => {
    fastReportWritten = true;
    maybeAbort();
  };

  const graph = createUniversalAgent({
    baseURL: `http://localhost:${String(server.port)}/v1`,
    apiKey: "stub",
    model: "stub",
    systemPrompt: "you are the parent agent",
    checkpointer: saver,
    onUsage: (usage) => {
      usageRecords.push(usage);
      maybeAbort();
    },
  });

  const controller = new AbortController();
  // `graph.invoke` rather than `graph.stream`: the abort signal path is the same
  // (both merge the signal into the runnable config, which is what ToolNode reads at
  // mergeAbortSignals), and tests/task.test.ts + tests/recovery.test.ts measure abort
  // through invoke. The Explore agents already run on invoke (task.ts:214), so the
  // signal reaches them identically either way.
  const invoking = graph
    .invoke(
      { messages: [new HumanMessage("go")] },
      {
        recursionLimit: RECURSION_LIMIT,
        durability: DURABILITY,
        signal: controller.signal,
        configurable: { thread_id: thread },
      },
    )
    .then(
      () => ({ error: null as unknown }),
      (caught: unknown) => ({ error: caught }),
    );

  if (doAbort) {
    // Wait for the stub to prove the Explores are in flight, then abort. Never sleep-guessed:
    // `fireAbort` is called from the stub's own arrival/completion records.
    await Promise.race([
      new Promise<void>((resolve) => {
        fireAbort = resolve;
        maybeAbort(); // in case the condition was already met before this promise existed
      }),
      Bun.sleep(10_000).then(() => {
        throw new Error(`abort trigger never fired in ${scenarioMode}`);
      }),
    ]);
    controller.abort();
  }
  const error = (await invoking).error;

  const named = error as { name?: string; message?: string } | null;
  const parentErrorText =
    error === null ? "(none — turn completed)" : `${named?.name ?? "?"}: ${named?.message ?? String(error)}`;

  return {
    mode: scenarioMode,
    aborted: doAbort,
    parentError: parentErrorText,
    parentErrorIsAbort:
      error !== null && ((named?.name ?? "").includes("Abort") || (named?.message ?? "").toLowerCase().includes("abort")),
    exploreRecords,
    atAbort,
    usageAgents: usageRecords.map((usage) => usage.agent),
    thread: await inspectThread(directory, thread),
    dir: directory,
  };
}

// ---- printing --------------------------------------------------------------------

function banner(text: string): void {
  process.stdout.write(`\n=== ${text} ===\n`);
}

function printExplore(records: ExploreRecord[], label: string): void {
  process.stdout.write(`  ${label}:\n`);
  for (const record of records) {
    process.stdout.write(
      `    ${record.objective.padEnd(14)} arrived=${String(record.arrived)} ` +
        `completed=${String(record.completed)} clientAborted=${String(record.clientAborted)}\n`,
    );
  }
}

function printEvidence(evidence: ScenarioEvidence): void {
  banner(
    `${evidence.mode}（${evidence.aborted ? "abort" : "不 abort，对照组"}）· 目录 ${evidence.dir}`,
  );
  process.stdout.write(`  父回合: ${evidence.parentError}\n`);
  process.stdout.write(`  父回合是 abort 吗: ${evidence.parentErrorIsAbort ? "是" : "否"}\n`);
  printExplore(evidence.exploreRecords, "Explore 全程记录（stub 观测）");
  if (evidence.aborted) printExplore(evidence.atAbort, "abort 那一瞬间的 Explore 快照");
  process.stdout.write(`  usage agents（按 fire 顺序）: [${evidence.usageAgents.join(", ")}]\n`);
  process.stdout.write(`  父 thread 消息类型: [${evidence.thread.types.join(", ")}]\n`);
  process.stdout.write(`  父 thread 消息内容:\n`);
  for (const content of evidence.thread.contents) {
    process.stdout.write(`    ${content.slice(0, 120)}\n`);
  }
  process.stdout.write(`  父 thread pendingWrites 条数: ${String(evidence.thread.pendingWrites.length)}\n`);
  for (const write of evidence.thread.pendingWrites) {
    process.stdout.write(`    ${write.slice(0, 120)}\n`);
  }
  process.stdout.write(
    `  原始文件里各字符串落在哪些行 kind: ${Object.entries(evidence.thread.rawReportWhere)
      .map(([needle, kinds]) => `${needle}=[${kinds.join(",") || "无"}]`)
      .join("  ")}\n`,
  );
  process.stdout.write(`  原始文件行数: ${String(evidence.thread.rawLines)}\n`);
}

async function main(): Promise<void> {
  let failures = 0;
  const check = (name: string, ok: boolean, detail: string): void => {
    if (!ok) failures += 1;
    process.stdout.write(`${ok ? "✅" : "❌"} ${name}\n   ${detail}\n\n`);
  };

  startServer();

  const control = await runScenario("control", false);
  const allSlow = await runScenario("all-slow", true);
  const oneFast = await runScenario("one-fast", true);

  for (const evidence of [control, allSlow, oneFast]) printEvidence(evidence);

  banner("判据");

  const exploreUsage = (evidence: ScenarioEvidence) =>
    evidence.usageAgents.filter((agent) => agent === "explore").length;

  // 对照组自己先要诚实：不 abort 时三个 Explore 全跑完、报告全进父状态、父给出了最终回答。
  const controlExplore = exploreUsage(control);
  const controlToolResults = control.thread.types.filter((type) => type === "tool").length;
  const controlAnswered = control.thread.contents.some((content) => content.includes(FINAL_ANSWER));
  check(
    "对照组：不 abort 时三个 Explore 全跑完（onUsage explore=3）",
    controlExplore === 3,
    `onUsage explore=${String(controlExplore)} —— 这条不成立，后面「=0 是因为 abort」就无从谈起。`,
  );
  check(
    "对照组：父 thread 有 3 条 tool 结果 + 最终回答",
    controlToolResults === 3 && controlAnswered,
    `tool 结果 ${String(controlToolResults)} 条 / 最终回答 ${controlAnswered ? "有" : "无"}`,
  );

  // ① 三个并行 abort：三个是不是都 abort（没有一个跑完）。
  const allSlowExplore = exploreUsage(allSlow);
  const allSlowAbortedClients = allSlow.exploreRecords.filter((record) => record.clientAborted).length;
  check(
    "① 三个并行 abort 时，三个【都】abort（onUsage explore=0，没有一个跑完）",
    allSlowExplore === 0 && allSlow.exploreRecords.length === 3,
    `onUsage explore=${String(allSlowExplore)} / 到达的 Explore=${String(allSlow.exploreRecords.length)} / ` +
      `clientAborted=${String(allSlowAbortedClients)}/3 —— ` +
      (allSlow.parentErrorIsAbort ? "父回合确实以 abort 抛掉。" : "⚠️ 父回合没抛 abort，先看父回合那行。"),
  );

  // ② 父 thread 形状：human + ai(3 个 Task tool_calls)，无 tool 结果、无最终回答。
  const noToolResults = !allSlow.thread.types.includes("tool");
  const noFinalAnswer = !allSlow.thread.contents.some((content) => content.includes(FINAL_ANSWER));
  check(
    "② 父 thread = human + ai，无 tool 结果、无最终回答（「未回答」）",
    noToolResults && noFinalAnswer,
    `类型 [${allSlow.thread.types.join(", ")}] —— ` +
      `tool 结果 ${noToolResults ? "无" : "有"} / 最终回答 ${noFinalAnswer ? "无" : "有"}`,
  );

  // ③ 报告有没有漏进父状态：写了一半（all-slow）没有；已写完（one-fast 的 fast）漏进 pendingWrites。
  const anyReportInState = (evidence: ScenarioEvidence): string[] =>
    Object.keys(REPORTS).filter(
      (objective) =>
        evidence.thread.contents.some((content) => content.includes(REPORTS[objective] ?? "")) ||
        evidence.thread.pendingWrites.some((write) => write.includes(REPORTS[objective] ?? "")),
    );
  const leakedAllSlow = anyReportInState(allSlow);
  const leakedOneFast = anyReportInState(oneFast);
  const fastCompleted = oneFast.usageAgents.filter((agent) => agent === "explore").length >= 1;
  check(
    "③ 写了一半的报告：没有一条漏进父状态",
    leakedAllSlow.length === 0,
    `漏进状态的报告 = [${leakedAllSlow.join(", ") || "无"}] —— 三个都还在跑时被 abort，报告压根没产出。`,
  );
  // 已写完的：不是「也漏不进来」，而是恰恰漏进来了。fast 的 ToolMessage 在 abort 之前已经
  // putWrites，躺在父的 pendingWrites 里，getTuple（恢复要读的那份状态）能读到它。这推翻
  // 票里的推断「报告随整个回合被丢弃」——被丢弃的只有写了一半的；已写完的漏进父状态。
  check(
    "③ 已写完的报告：漏进了父状态（pendingWrites），推翻「随回合丢弃」",
    leakedOneFast.length === 1 && leakedOneFast[0] === FAST && fastCompleted,
    `fast 已产出报告 ${fastCompleted ? "是" : "否"} / 漏进状态的报告 = [${leakedOneFast.join(", ") || "无"}] —— ` +
      `fast 的 ToolMessage 已 putWrites，abort 抛掉了两个还在跑的 slow，但没抛掉这个已落盘的。`,
  );

  // 对照组配平：不 abort 时三份报告都进父状态（成为 tool 结果）。它同时给③的两个方向做对照：
  // 写了一半的「没有」不是 stub 不回报告；已写完的「有」不是 stub 只对 fast 特殊对待。
  check(
    "对照组配平：不 abort 时三份报告都进父状态（tool 结果）",
    anyReportInState(control).length === 3,
    `父状态里的报告 = [${anyReportInState(control).join(", ")}]`,
  );

  // 把「已写完漏进 pendingWrites」讲直白：报告在文件的 kind:"writes" 行里，且 getTuple 的
  // pendingWrites 真能读到它（不是没人引用的孤儿字节）——恢复时它会被当成 tool 结果应用。
  const fastWhere = oneFast.thread.rawReportWhere[REPORTS[FAST] ?? ""] ?? [];
  process.stdout.write(
    `📌 已写完的 REPORT-FAST 落在原始文件的 [${fastWhere.join(",") || "无"}] 行，` +
      `getTuple 读到的 pendingWrites=${String(oneFast.thread.pendingWrites.length)} 条（含它）—— ` +
      `恢复时它会被当 tool 结果应用，报告就这样漏进了父状态。\n\n`,
  );

  process.stdout.write(
    failures === 0 ? "全部符合预期\n" : `${String(failures)} 条不符\n`,
  );

  for (const evidence of [control, allSlow, oneFast]) rmSync(evidence.dir, { recursive: true, force: true });
  try {
    server.stop(true);
  } catch {
    // The aborted fetches can leave Bun's server in a state where stop() throws; the
    // process is done either way.
  }
  // Bun can keep the event loop alive on aborted fetch connections even after the turn
  // settled; the probe is a script, so exit explicitly once the verdicts are printed.
  process.exit(failures === 0 ? 0 : 1);
}

await main();
