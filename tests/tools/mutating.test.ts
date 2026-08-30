import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { setProcessDeadline } from "@/deadline";
import { bashTool, editTool, writeTool } from "@/tools";
import {
  killRunningCommands,
  runCommand,
  setCommandCeiling,
  UNATTENDED_COMMAND_CEILING_MS,
} from "@/tools/mutating";

/**
 * Everything resolves against process.cwd(), so the fixtures have to live inside
 * the repository. `.test-tmp/` is gitignored and removed below.
 */
const DIR = ".test-tmp";
const file = (name: string) => `${DIR}/${name}`;

afterAll(() => rm(DIR, { recursive: true, force: true }));

/** Captures a rejection so assertions can read the message directly. */
function rejection(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => "(resolved unexpectedly)",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
}

/* ---------- Write ---------- */

test("Write creates intermediate directories", async () => {
  const result = await writeTool.invoke({
    path: file("nested/deep/x.txt"),
    content: "hello",
  });

  expect(result).toContain("created");
  expect(await Bun.file(file("nested/deep/x.txt")).text()).toBe("hello");
});

// A full-file write is the only way this agent can silently lose work someone
// else did between a Read and the write. Edit cannot: if the target moved or
// became ambiguous it refuses, and a change elsewhere in the file survives,
// because an Edit rewrites only the span it matched. Removing the capability is
// what closes that, and it is cheaper than tracking what was read.
test("Write refuses to overwrite an existing file", async () => {
  await writeTool.invoke({ path: file("clobber.txt"), content: "0123456789" });

  const message = await rejection(
    writeTool.invoke({ path: file("clobber.txt"), content: "new" }),
  );

  expect(message).toContain("already exists");
  expect(message).toContain("Use Edit");
  // And the original is untouched — a refusal that half-wrote would be worse
  // than the overwrite it replaced.
  expect(await Bun.file(file("clobber.txt")).text()).toBe("0123456789");
});

// The escape hatch the refusal points at has to actually work, or "use Edit to
// replace it in full" is advice the model cannot follow.
test("a full replacement is an Edit whose oldString is the whole file", async () => {
  await writeTool.invoke({ path: file("replace.txt"), content: "old\nbody\n" });

  await editTool.invoke({
    path: file("replace.txt"),
    oldString: "old\nbody\n",
    newString: "new\nbody\n",
  });

  expect(await Bun.file(file("replace.txt")).text()).toBe("new\nbody\n");
});

/* ---------- Edit ---------- */

const SAMPLE = "const a = 1;\nconst b = 2;\nconst c = 1;\n";

test("Edit replaces a unique target and reports the line", async () => {
  await writeTool.invoke({ path: file("edit.ts"), content: SAMPLE });

  expect(
    await editTool.invoke({
      path: file("edit.ts"),
      oldString: "const b = 2;",
      newString: "const b = 3;",
    }),
  ).toBe(`edited ${file("edit.ts")} at line 2`);
  expect(await Bun.file(file("edit.ts")).text()).toContain("const b = 3;");
});

// The contract, and the reason Edit exists rather than Write-with-extra-steps.
// Replacing the first of several matches edits a line the model never looked at,
// and nothing in the result would say so.
test("Edit refuses an ambiguous target instead of taking the first match", async () => {
  await writeTool.invoke({ path: file("ambiguous.ts"), content: SAMPLE });

  const message = await rejection(
    editTool.invoke({
      path: file("ambiguous.ts"),
      oldString: "= 1;",
      newString: "= 9;",
    }),
  );

  expect(message).toContain("matches 2 places");
  // Untouched: a refusal has to be a refusal, not a partial edit.
  expect(await Bun.file(file("ambiguous.ts")).text()).toBe(SAMPLE);
});

test("Edit refuses a target that is not there", async () => {
  await writeTool.invoke({ path: file("missing.ts"), content: SAMPLE });

  expect(
    await rejection(
      editTool.invoke({ path: file("missing.ts"), oldString: "nope", newString: "x" }),
    ),
  ).toContain("not found");
});

test("Edit refuses an empty target", async () => {
  await writeTool.invoke({ path: file("empty.ts"), content: SAMPLE });

  expect(
    await rejection(
      editTool.invoke({ path: file("empty.ts"), oldString: "", newString: "x" }),
    ),
  ).toContain("nothing to locate");
});

test("Edit refuses a no-op", async () => {
  await writeTool.invoke({ path: file("noop.ts"), content: SAMPLE });

  expect(
    await rejection(
      editTool.invoke({ path: file("noop.ts"), oldString: "a", newString: "a" }),
    ),
  ).toContain("identical");
});

/* ---------- 并发：引擎无脑并行，工具自己负责互斥 ---------- */

// The measured case, verbatim: asked to change two fields of one config file,
// the model emitted both Edits in a single turn — correctly, since neither
// depends on the other's result — and before the path lock existed both
// reported success while only the first change reached the file.
test("two concurrent edits to one file both land", async () => {
  const source =
    'export const config = {\n  host: "localhost",\n  port: 3000,\n  retries: 3,\n};\n';
  await writeTool.invoke({ path: file("concurrent.ts"), content: source });

  const reports = await Promise.all([
    editTool.invoke({
      path: file("concurrent.ts"),
      oldString: "  port: 3000,",
      newString: "  port: 8080,",
    }),
    editTool.invoke({
      path: file("concurrent.ts"),
      oldString: "  retries: 3,",
      newString: "  retries: 5,",
    }),
  ]);

  const after = await Bun.file(file("concurrent.ts")).text();
  expect(reports).toHaveLength(2);
  expect(after).toContain("port: 8080");
  expect(after).toContain("retries: 5");
});

// Reporting success for an edit that was then overwritten is the worst shape
// this failure takes: the prompt tells the model not to re-read after a
// successful Edit, so nothing downstream would ever notice.
test("a concurrent write does not make an edit report a change it lost", async () => {
  await writeTool.invoke({ path: file("clobber2.ts"), content: "a\nb\n" });

  await Promise.all([
    editTool.invoke({ path: file("clobber2.ts"), oldString: "a", newString: "A" }),
    editTool.invoke({ path: file("clobber2.ts"), oldString: "b", newString: "B" }),
  ]);

  expect(await Bun.file(file("clobber2.ts")).text()).toBe("A\nB\n");
});

/* ---------- Bash ---------- */

test("Bash returns combined output", async () => {
  expect(await bashTool.invoke({ command: "echo out; echo err 1>&2" })).toContain(
    "out",
  );
  expect(await bashTool.invoke({ command: "echo out; echo err 1>&2" })).toContain(
    "err",
  );
});

// The distinction the model depends on: a failing test suite is a *result* it
// has to read, not a tool that broke. Throwing here would hand it an error
// message instead of the failure output.
test("Bash reports a non-zero exit as a result, not a failure", async () => {
  const result = await bashTool.invoke({ command: "echo nope 1>&2; exit 3" });

  expect(result).toContain("nope");
  expect(result).toContain("[exit 3]");
});

test("Bash says something when a command prints nothing", async () => {
  expect(await bashTool.invoke({ command: "true" })).toBe("[no output]");
});

// Tool output goes straight to the model. A command that can read a key out of
// its own environment makes every other guard in this file decorative. All three
// names — the three per-provider keys and the legacy alias — must be stripped.
test("Bash does not hand the API keys to the commands it runs", async () => {
  const result = await bashTool.invoke({
    command:
      'echo "a=[${LLM_API_KEY:-unset}] b=[${LLM_DEEPSEEK_API_KEY:-unset}] ' +
      'c=[${LLM_MOONSHOT_CN_API_KEY:-unset}] d=[${LLM_ZHIPU_CN_API_KEY:-unset}]"',
  });

  expect(result).toContain("a=[unset] b=[unset] c=[unset] d=[unset]");
});

/* ---------- Bash: the deadline ---------- */

/**
 * The deadline is tested through `runCommand` rather than the tool because the
 * tool's own is 120 seconds. What is under test is not the number.
 *
 * Every case here uses the same shape, and it is the shape that broke in the
 * field: **a grandchild that outlives the shell**. `sh -c` spawns it, the shell
 * waits for it, and it holds the write end of our stdout pipe. Signalling the
 * shell alone left it running — so the read never saw EOF, and the deadline that
 * had already fired could not end the call it fired for.
 */
const grandchild = (marker: string, sleepSec: number) =>
  `(sleep ${String(sleepSec)}; echo alive > ${marker}) & echo started; wait`;

test("a command that outlives its shell is still cut off at the deadline", async () => {
  const started = Date.now();
  const outcome = await runCommand(grandchild(file("never-1"), 5), 300);

  expect(outcome.timedOut).toBe(true);
  expect(outcome.code).toBe(null);
  // Whatever it printed before the deadline is still reported — the model is
  // told the command was cut off, not handed nothing.
  expect(outcome.body).toContain("started");
  // The point of the whole change: back before the deadline, not after the
  // grandchild's 5s. Generous enough not to flake on a loaded machine.
  expect(Date.now() - started).toBeLessThan(3000);
});

test("the deadline kills what the command started, not just the shell", async () => {
  const marker = file("never-2");
  await runCommand(grandchild(marker, 1), 200);

  // Past the grandchild's own sleep: if it survived the kill, the marker lands.
  await Bun.sleep(1800);
  expect(await Bun.file(marker).exists()).toBe(false);
});

// An interrupted turn used to be cleaned up by the terminal signalling the whole
// foreground process group. `detached` took the command out of that group, so
// the abort has to carry the kill itself — or Ctrl-C would leave the work running.
test("an aborted turn kills what the command started", async () => {
  const marker = file("never-3");
  const controller = new AbortController();
  const running = runCommand(grandchild(marker, 1), 10_000, controller.signal);

  await Bun.sleep(200);
  controller.abort();
  await running;

  await Bun.sleep(1800);
  expect(await Bun.file(marker).exists()).toBe(false);
});

test("a command that finishes on its own is untouched by any of this", async () => {
  const outcome = await runCommand("echo out; echo err 1>&2; exit 3", 10_000);

  expect(outcome.timedOut).toBe(false);
  expect(outcome.code).toBe(3);
  expect(outcome.body).toContain("out");
  expect(outcome.body).toContain("err");
});

// The deadline kills and an abort kills — but a clean exit killed nothing, and a
// detached child survives its parent by design. Terminal-Bench measured the
// cost: an orphaned `apt-get` still holding the dpkg lock while the *grading*
// phase ran. `src/main.ts` calls this from the process's exit paths.
test("leaving takes every still-running command with it", async () => {
  const marker = file("never-4");
  const running = runCommand(grandchild(marker, 1), 10_000);

  await Bun.sleep(200);
  killRunningCommands();
  await running;

  await Bun.sleep(1800);
  expect(await Bun.file(marker).exists()).toBe(false);
});

// The other half of the same fact: a command that already finished must not be
// in the registry, or a later sweep would be signalling recycled pids.
test("a finished command is not swept later", async () => {
  await runCommand("true", 10_000);
  // Nothing to kill, and nothing throws: the registry emptied itself.
  expect(() => {
    killRunningCommands();
  }).not.toThrow();
});

// The console half of this is `repro/49` on a real pty; this is the half that
// produces the ticks. A timer, not the output: a hung command produces nothing,
// and "still running, 0 bytes" is exactly what has to reach the screen.
test("a running command says so about once a second", async () => {
  const ticks: { elapsedMs: number; bytes: number }[] = [];
  await runCommand("sleep 2.2; echo done", 10_000, undefined, (tick) =>
    ticks.push(tick),
  );

  expect(ticks.length).toBeGreaterThanOrEqual(2);
  expect(ticks[0]?.elapsedMs).toBeGreaterThan(0);
  expect(ticks.at(-1)?.elapsedMs).toBeGreaterThan(ticks[0]?.elapsedMs ?? 0);
  // Silence is the point: nothing was printed until the very end, and the ticks
  // still arrived.
  expect(ticks[0]?.bytes).toBe(0);
});

test("a command nobody is watching pays for no ticks", async () => {
  // No callback, no timer. The courtesy is opt-in.
  const outcome = await runCommand("echo quiet", 10_000);
  expect(outcome.body).toContain("quiet");
});

/* ---------- who owns the deadline ---------- */

// pi lets the model ask for the time a command needs, and defaults to none —
// which it can afford because a human is watching and can interrupt. We take the
// parameter; the default is the half that depends on somebody being there.
test("a command may ask for the time it needs", async () => {
  const marker = file("never-5");
  const started = Date.now();
  // Two seconds of grandchild, and a call that asks for less than that.
  const outcome = await runCommand(grandchild(marker, 5), 400);

  expect(outcome.timedOut).toBe(true);
  expect(Date.now() - started).toBeLessThan(3000);
});

test("no deadline means no deadline — the command decides when it is done", async () => {
  const started = Date.now();
  const outcome = await runCommand("sleep 0.4; echo done", undefined);

  expect(outcome.timedOut).toBe(false);
  expect(outcome.body).toContain("done");
  expect(Date.now() - started).toBeGreaterThanOrEqual(350);
});

// The tool's own default comes from whoever set the ceiling — `src/main.ts` sets
// one only for `--print`, where nobody can press anything.
test("the ceiling is what a call with no timeout of its own gets", async () => {
  const marker = file("never-6");
  setCommandCeiling(400);
  try {
    const result = String(await bashTool.invoke({ command: grandchild(marker, 5) }));
    expect(result).toContain("timed out after 0.4s");
    expect(result).toContain("Pass a larger timeout");
  } finally {
    setCommandCeiling(undefined);
  }
});

test("a call may override the ceiling upwards", async () => {
  setCommandCeiling(200);
  try {
    // The ceiling would have cut this at 200ms; the call asks for more and gets it.
    const result = String(
      await bashTool.invoke({ command: "sleep 0.5; echo through", timeout: 5 }),
    );
    expect(result).toContain("through");
    expect(result).not.toContain("timed out");
  } finally {
    setCommandCeiling(undefined);
  }
});

// A model that asked for a deadline and silently got a different one would be
// told nothing — the exact defect this area is being cleaned of.
test("a nonsense timeout is refused rather than quietly replaced", async () => {
  expect(await rejection(bashTool.invoke({ command: "true", timeout: 0 }))).toContain(
    "invalid timeout",
  );
  expect(await rejection(bashTool.invoke({ command: "true", timeout: -3 }))).toContain(
    "invalid timeout",
  );
  expect(
    await rejection(bashTool.invoke({ command: "true", timeout: 9_999_999_999 })),
  ).toContain("a timer can hold");
});

test("the unattended ceiling is the number `--print` installs", () => {
  expect(UNATTENDED_COMMAND_CEILING_MS).toBe(120_000);
});

/**
 * 内层的钟必须严格小于外层的钟（ADR 0010）。
 *
 * 在这之前 `timeout` 唯一的上界是 `setTimeout` 自己能装下的 24.8 天：模型在一次只剩
 * 200 秒的调用里给一条命令要 3600 秒，会**原样拿到**。
 */
test("这次调用剩下多少，一条命令最多就拿多少 —— 而且夹了要说", async () => {
  // 余量 2 秒，所以 2.4 秒的总闸留给命令 0.4 秒。
  setProcessDeadline(Date.now() + 2_400);
  try {
    const result = String(
      await bashTool.invoke({
        command: grandchild(file("clamped-1"), 5),
        timeout: 3_600,
      }),
    );
    // 钉「不到半秒就被掐了」，不钉具体毫秒：夹出来的数随 `Date.now()` 抖
    // （实测 0.399 与 0.4 都出现过），钉它就是钉噪音。
    expect(result).toMatch(/timed out after 0\.\d+s/);
    // 说出它要过什么、以及再要也没用——不说的话，模型会把「才跑几百毫秒就被杀」
    // 读成命令自己的毛病。
    expect(result).toContain("you asked for 3600s");
    expect(result).toContain("a larger timeout would not have helped");
  } finally {
    setProcessDeadline(undefined);
  }
});

test("没给 timeout 的那一格，话要换一种说法 —— 它没要过 120 秒", async () => {
  setProcessDeadline(Date.now() + 2_400);
  setCommandCeiling(UNATTENDED_COMMAND_CEILING_MS);
  try {
    const result = String(
      await bashTool.invoke({ command: grandchild(file("clamped-2"), 5) }),
    );
    expect(result).toMatch(/timed out after 0\.\d+s/);
    expect(result).not.toContain("you asked for");
    expect(result).toContain("that is all this run had left");
  } finally {
    setCommandCeiling(undefined);
    setProcessDeadline(undefined);
  }
});

// 一条注定在起跑线上被杀的命令只会留下副作用和一段没人读得完的输出。
test("余地不够就根本不开跑，并说出是这次调用没时间了", async () => {
  setProcessDeadline(Date.now() + 500);
  try {
    const result = String(await bashTool.invoke({ command: "echo ran", timeout: 5 }));
    expect(result).toContain("not started");
    expect(result).not.toContain("ran");
  } finally {
    setProcessDeadline(undefined);
  }
});

// 有人挂着的时候没有总闸，所以什么都不夹——人就是那把钟。
test("没有总闸时，要多久就是多久", async () => {
  const result = String(
    await bashTool.invoke({ command: "sleep 0.2; echo through", timeout: 3_600 }),
  );
  expect(result).toContain("through");
  expect(result).not.toContain("timed out");
});
