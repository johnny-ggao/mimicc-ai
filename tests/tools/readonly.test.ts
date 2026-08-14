import { expect, test } from "bun:test";

import { AIMessage, type ToolMessage } from "@langchain/core/messages";
import { ToolNode } from "@langchain/langgraph/prebuilt";

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

/* ---------- 安全护栏（这部分是我们的责任，不是框架的）---------- */

// Read-only is not risk-free: tool output is sent to the model, so an
// unconstrained path is an exfiltration channel rather than merely a read.
test("refuses to read outside the working directory", async () => {
  expect(await rejection(read("../../../etc/hosts"))).toContain(
    "escapes the working directory",
  );
});

test("refuses files whose whole point is to hold secrets", async () => {
  for (const path of [".env", ".env.local", "keys/deploy.pem", "certs/server.key"]) {
    expect(await rejection(read(path))).toContain("may hold credentials");
  }
});

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

/* ---------- 与 ToolNode 的接缝 ---------- */

// The property the hand-written dispatch used to guarantee, now the framework's
// job — but the seam is ours: a guard that throws has to come back as a tool
// message, or the provider rejects a history with an unanswered tool_call.
test("a guard rejection comes back as a tool message, not an exception", async () => {
  const node = new ToolNode(TOOLS);
  const call = new AIMessage({
    content: "",
    tool_calls: [{ id: "call_1", name: "Read", args: { path: ".env" } }],
  });

  const out = (await node.invoke({ messages: [call] })) as { messages: ToolMessage[] };

  expect(out.messages).toHaveLength(1);
  expect(out.messages[0]?.tool_call_id).toBe("call_1");
  const body = out.messages[0]?.content;
  expect(typeof body === "string" ? body : JSON.stringify(body)).toContain(
    "may hold credentials",
  );
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
