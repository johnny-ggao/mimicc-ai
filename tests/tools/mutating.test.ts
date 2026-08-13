import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { bashTool, editTool, writeTool } from "@/tools";

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

/* ---------- 安全护栏：写入侧和只读侧共用同一份实现 ---------- */

// Write and Edit run without a confirmation gate, which is only defensible while
// resolveInside actually holds. These two tests are what makes that true.
test("Write refuses to leave the working directory", async () => {
  expect(
    await rejection(writeTool.invoke({ path: "../escaped.txt", content: "x" })),
  ).toContain("escapes the working directory");
});

test("Write refuses the files whose whole point is to hold secrets", async () => {
  for (const path of [".env", ".env.local", "keys/deploy.pem"]) {
    expect(await rejection(writeTool.invoke({ path, content: "x" }))).toContain(
      "may hold credentials",
    );
  }
});

test("Edit refuses to leave the working directory", async () => {
  expect(
    await rejection(
      editTool.invoke({ path: "../escaped.txt", oldString: "a", newString: "b" }),
    ),
  ).toContain("escapes the working directory");
});

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

// Tool output goes straight to the model. A command that can read the key out of
// its own environment makes every other guard in this file decorative.
test("Bash does not hand the API key to the commands it runs", async () => {
  const result = await bashTool.invoke({
    command: 'echo "key=[${LLM_API_KEY:-unset}]"',
  });

  expect(result).toContain("key=[unset]");
});
