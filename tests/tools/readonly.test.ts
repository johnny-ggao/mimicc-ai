import { expect, test } from "bun:test";

import { globTool, grepTool, readTool, TOOLS } from "@/tools";

const read = (path: string) => readTool.invoke({ path });

/**
 * Captures a rejection so assertions can read the message directly.
 * bun:test's `.rejects` matcher is not typed as awaitable, and awaiting it trips
 * `@typescript-eslint/await-thenable` even though it works at runtime.
 */
function rejection(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => "(resolved unexpectedly)",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
}

// Grep still filters secrets out of search results; the hard-floor *deny* for
// Read/Write/Edit moved into the permission gate (tests/permission-gate.test.ts).
test("keeps secrets out of grep results too", async () => {
  // The guard has to cover content search as well, or the same bytes leak by
  // another route.
  const hits = await grepTool.invoke({ pattern: "LLM_API_KEY", glob: "**/*" });

  expect(hits).not.toContain(".env:");
});

/* ---------- 工具行为 ---------- */

test("reads a file with 1-based line numbers", async () => {
  expect(await read("package.json")).toStartWith("1\t{");
});

test("reports a missing file as a thrown error the model can read", async () => {
  expect(await rejection(read("src/nope.ts"))).toContain("no such file");
});

test("globs files and skips the ignored directories", async () => {
  const hits = await globTool.invoke({ pattern: "**/*.json" });

  expect(hits).toContain("package.json");
  expect(hits).not.toContain("node_modules/");
});

test("says so plainly when a glob matches nothing", async () => {
  expect(await globTool.invoke({ pattern: "**/*.nope" })).toContain("no files match");
});

test("greps content and reports path:line:text", async () => {
  const hits = await grepTool.invoke({ pattern: "loadConfig", glob: "src/**/*.ts" });

  expect(hits).toMatch(/src\/config\.ts:\d+:/);
});

test("says so plainly when a grep matches nothing", async () => {
  const hits = await grepTool.invoke({
    pattern: "zzz_no_such_symbol",
    glob: "src/**/*.ts",
  });

  expect(hits).toContain("no matches");
});

test("reports a malformed regular expression", async () => {
  expect(await rejection(grepTool.invoke({ pattern: "([unclosed" }))).toContain(
    "bad regular expression",
  );
});

test("defaults the grep glob to the whole tree", async () => {
  const hits = await grepTool.invoke({ pattern: "createUniversalAgent" });

  // A real path in a subdirectory, because the claim is that the default glob
  // recurses — an assertion against a file in `src/` alone would still pass if
  // the default were `src/*`.
  expect(hits).toContain("src/agents/loop.ts:");
});

// The system prompt names all six by name and describes what each one does, so
// the registry and `src/agents/prompt.ts` are one specification in two places. A tool
// the prompt promises but the registry lacks costs a whole lap of the loop:
// ToolNode turns "not found" into a tool message and the model tries again.
test("registers the six tools the prompt advertises, in order", () => {
  expect(TOOLS.map((tool) => tool.name)).toEqual([
    "Read",
    "Write",
    "Edit",
    "Bash",
    "Glob",
    "Grep",
  ]);
});
