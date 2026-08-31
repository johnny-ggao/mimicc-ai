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

// 🔴 This used to grep `createUniversalAgent` and assert on `src/agents/loop.ts`.
// That symbol has more matches than MAX_GREP_HITS, so whether `src/` lands
// inside the first 100 depends on directory-enumeration order — APFS happened
// to put it early, ext4 on CI walked README → repro/ → docs/ → bench/ → tests/
// and truncated before ever reaching `src/`. Green locally, red on every CI
// run. The needle below is unique, so the limit never engages.
test("defaults the grep glob to the whole tree", async () => {
  const DEEP = "test-default-glob-tmp";
  mkdirSync(`${DEEP}/nested/deeper`, { recursive: true });
  writeFileSync(`${DEEP}/nested/deeper/needle.txt`, "zz_default_glob_needle\n");
  try {
    const hits = await grepTool.invoke({ pattern: "zz_default_glob_needle" });

    // A path in a *nested* directory, because the claim is that the default
    // glob recurses from the root — this fails if the default were `src/*`,
    // `tests/**`, or `**/*.ts`.
    expect(hits).toContain(`${DEEP}/nested/deeper/needle.txt:`);
  } finally {
    rmSync(DEEP, { recursive: true, force: true });
  }
});

// The system prompt names each of these and describes what it does, so the
// registry and `src/agents/prompt.ts` are one specification in two places. A tool
// the prompt promises but the registry lacks costs a whole lap of the loop:
// ToolNode turns "not found" into a tool message and the model tries again.
test("registers the unconditional tools the prompt advertises, in order", () => {
  expect(TOOLS.map((tool) => tool.name)).toEqual([
    "Read",
    "Write",
    "Edit",
    "Bash",
    "Glob",
    "Grep",
    // Appended 2026-08-31 (web-tools ticket 02) — appended, not inserted, so
    // the cached prefix over the first six survived the addition.
    "WebFetch",
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

/* ---------- what a scan left out has to be in what it returns ---------- */

// 🔴 **Not under `.test-tmp/`**, and the reason is itself one of the findings:
// `Glob`/`Grep` cannot see anything inside a hidden directory, so fixtures there
// are invisible to the very tools under test. That hole is still open (ticket 07
// item 4); this name works around it rather than hiding it.
const SCAN = "test-scan-tmp";
afterAll(() => {
  rmSync(SCAN, { recursive: true, force: true });
});

// 🔴 All four of these came back as `no files match` / `no matches` before —
// a *positive claim of absence* about files that were never opened. That is the
// one shape a search must never have, because a plain "no" is the answer a model
// has no reason to question.
test("Glob says when it stopped at its limit", async () => {
  mkdirSync(`${SCAN}/many`, { recursive: true });
  for (let i = 0; i < 250; i += 1) {
    writeFileSync(`${SCAN}/many/f${String(i)}.txt`, "needle\n");
  }

  const out = String(await globTool.invoke({ pattern: `${SCAN}/many/*.txt` }));

  expect(out.split("\n")).toHaveLength(201); // 200 hits + the note
  expect(out).toContain("stopped at the 200-result limit");
  rmSync(SCAN, { recursive: true, force: true });
});

test("Grep says when it stopped at its limit", async () => {
  mkdirSync(`${SCAN}/many`, { recursive: true });
  for (let i = 0; i < 150; i += 1) {
    writeFileSync(`${SCAN}/many/f${String(i)}.txt`, "needle\n");
  }

  const out = String(
    await grepTool.invoke({ pattern: "needle", glob: `${SCAN}/many/*.txt` }),
  );

  expect(out).toContain("stopped at the 100-match limit");
  rmSync(SCAN, { recursive: true, force: true });
});

test("Grep says which files it passed over instead of calling them absent", async () => {
  mkdirSync(SCAN, { recursive: true });
  writeFileSync(`${SCAN}/big.txt`, `needle\n${"x".repeat(70_000)}`);
  writeFileSync(`${SCAN}/bin.dat`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));

  const big = String(
    await grepTool.invoke({ pattern: "needle", glob: `${SCAN}/big.txt` }),
  );
  expect(big).toContain("no matches");
  expect(big).toContain("too large to search");

  // And a binary file is skipped rather than searched: returning the matched
  // "line" is how mojibake used to reach the model.
  const bin = String(
    await grepTool.invoke({ pattern: "PNG", glob: `${SCAN}/bin.dat` }),
  );
  expect(bin).toContain("skipped 1 file: binary");
  expect(bin).not.toContain("PNG\u0000");
  rmSync(SCAN, { recursive: true, force: true });
});

// The control. Without it, a version that appends a note every time passes all
// three tests above and makes every ordinary result noisier.
test("a scan that left nothing out says nothing extra", async () => {
  mkdirSync(SCAN, { recursive: true });
  writeFileSync(`${SCAN}/one.txt`, "needle\n");

  expect(String(await globTool.invoke({ pattern: `${SCAN}/*.txt` }))).toBe(
    `${SCAN}/one.txt`,
  );
  expect(
    String(await grepTool.invoke({ pattern: "needle", glob: `${SCAN}/*.txt` })),
  ).toBe(`${SCAN}/one.txt:1:needle`);
  rmSync(SCAN, { recursive: true, force: true });
});

/* ---------- hidden files are files ---------- */

// 🔴 Before this, `.github/`, `.env.example` and everything under `.claude/`
// did not exist as far as these two tools were concerned — and the answer they
// gave was `no files match`, about a place they never looked. The tests for the
// change above had to be moved out of `.test-tmp/` for exactly this reason.
test("Glob and Grep see inside hidden directories", async () => {
  mkdirSync(`${SCAN}/.github/workflows`, { recursive: true });
  writeFileSync(`${SCAN}/.github/workflows/ci.yml`, "needle: yes\n");
  writeFileSync(`${SCAN}/.env.example`, "needle=1\n");

  const globbed = String(await globTool.invoke({ pattern: `${SCAN}/**/*.yml` }));
  expect(globbed).toContain(".github/workflows/ci.yml");

  const grepped = String(
    await grepTool.invoke({ pattern: "needle", glob: `${SCAN}/**` }),
  );
  expect(grepped).toContain(".github/workflows/ci.yml");
  // `.env.example` is credential-shaped, so Grep passes it over — but *says so*
  // rather than folding it into "no matches".
  expect(grepped).toContain("may hold credentials");
  rmSync(SCAN, { recursive: true, force: true });
});

// The ignore list is the one exclusion that stays, so it has to hold at depth —
// it was written `node_modules/**`, which never matched a nested one.
test("the ignored trees are ignored at any depth", async () => {
  mkdirSync(`${SCAN}/packages/a/node_modules`, { recursive: true });
  writeFileSync(`${SCAN}/packages/a/node_modules/dep.js`, "needle\n");
  writeFileSync(`${SCAN}/packages/a/own.js`, "needle\n");

  const out = String(await globTool.invoke({ pattern: `${SCAN}/**/*.js` }));

  expect(out).toContain("packages/a/own.js");
  expect(out).not.toContain("node_modules");
  rmSync(SCAN, { recursive: true, force: true });
});
