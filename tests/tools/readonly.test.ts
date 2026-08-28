import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

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

/* ---------- Read refuses what it cannot honestly return ---------- */

const BIN = ".test-tmp/readonly-binary";
afterAll(() => {
  rmSync(BIN, { recursive: true, force: true });
});

function fixture(name: string, bytes: number[]): string {
  mkdirSync(BIN, { recursive: true });
  writeFileSync(`${BIN}/${name}`, Buffer.from(bytes));
  return `${BIN}/${name}`;
}

// 🔴 The case this exists for. `chess-best-move` read a board image, got the
// bytes decoded as UTF-8 with line numbers and `status: success`, and spent 660
// seconds building a pixel classifier to see a picture nothing here could ever
// show it. The refusal has to say that last part, because the limit is this
// program's — no tool builds image content — not the model's.
test("Read refuses an image and says nothing here can show it", async () => {
  const message = await rejection(
    read(fixture("board.png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2])),
  );

  expect(message).toContain("PNG image");
  expect(message).toContain("no images");
  // And it must not hand back a workaround: reaching for Bash is exactly what
  // the model did on its own, for eleven minutes.
  expect(message).not.toContain("Bash");
});

test("Read refuses other binary but points at a way through", async () => {
  const message = await rejection(read(fixture("blob.bin", [1, 2, 0, 3, 4])));

  expect(message).toContain("NUL");
  expect(message).toContain("Bash");
});

test("Read names the format when it can", async () => {
  expect(
    await rejection(read(fixture("a.zip", [0x50, 0x4b, 0x03, 0x04, 0, 1]))),
  ).toContain("ZIP archive");
});

// The control: a NUL-free file still reads, or the check would cost more than
// the mojibake it prevents.
test("Read still reads ordinary text", async () => {
  mkdirSync(BIN, { recursive: true });
  writeFileSync(`${BIN}/plain.txt`, "hello\nworld\n");
  expect(await read(`${BIN}/plain.txt`)).toContain("1\thello");
});

// "no such file" about something that is right there sends the model looking
// for a path problem it does not have.
test("Read says a directory is a directory", async () => {
  mkdirSync(`${BIN}/adir`, { recursive: true });
  const message = await rejection(read(`${BIN}/adir`));

  expect(message).toContain("is a directory");
  expect(message).not.toContain("no such file");
});
