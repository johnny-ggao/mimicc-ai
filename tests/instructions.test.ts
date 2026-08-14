import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

import { HumanMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";

import { createUniversalAgent } from "@/agents";
import {
  MAX_INSTRUCTION_BYTES,
  PROJECT_INSTRUCTIONS_ID,
  readProjectInstructions,
} from "@/context";
import type { Logger } from "@/logger";

/**
 * Everything here resolves against paths handed in explicitly, but the fixtures
 * still live inside the repository — same reason as tests/tools: nothing should
 * write outside it. `.test-tmp/` is gitignored.
 */
const DIR = ".test-tmp/instructions";

/** Records what the reader reported, since two failure modes are log-only. */
function recorder(): { lines: string[]; log: Logger } {
  const lines: string[] = [];
  const note =
    (level: string) =>
    (message: string, meta?: Record<string, unknown>): void => {
      lines.push(`${level} ${message} ${JSON.stringify(meta ?? {})}`);
    };
  return {
    lines,
    log: {
      debug: note("debug"),
      info: note("info"),
      warn: note("warn"),
      error: note("error"),
    },
  };
}

function fixture(files: Record<string, string>): string {
  const dir = `${DIR}/${String(Object.keys(files).length)}-${String(Math.random()).slice(2)}`;
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(`${dir}/${name}`, content);
  }
  return dir;
}

afterAll(() => rmSync(DIR, { recursive: true, force: true }));

/* ---------- 读取与四类失败模式 ---------- */

// The common case, and the one that has to be free. No file, no message, no
// tokens — the system prompt tells the model that a missing tag means a missing
// file, so there is nothing to say.
test("costs nothing when the repository has no instructions", () => {
  const { lines, log } = recorder();
  mkdirSync(DIR, { recursive: true });

  expect(readProjectInstructions(fixture({}), log)).toBeUndefined();
  expect(lines).toEqual([]);
});

test("wraps the file in a tag naming where it came from", () => {
  const { log } = recorder();
  const dir = fixture({ "AGENTS.md": "Use tabs.\n" });

  expect(readProjectInstructions(dir, log)).toBe(
    '<project-instructions path="AGENTS.md">\nUse tabs.\n</project-instructions>',
  );
});

// Both, not one of them. Picking a winner needs a precedence rule, and a
// precedence rule drops half the guidance silently when the two disagree.
test("injects both files, AGENTS.md first", () => {
  const { log } = recorder();
  const dir = fixture({ "AGENTS.md": "first", "CLAUDE.md": "second" });
  const out = readProjectInstructions(dir, log) ?? "";

  expect(out.indexOf('path="AGENTS.md"')).toBeLessThan(out.indexOf('path="CLAUDE.md"'));
  expect(out).toContain("</project-instructions>\n\n<project-instructions");
});

// Present but unreadable is the mode that must not be swallowed: the model can
// adjust for "there are conventions I cannot see" only if it is told.
test("tells the model when a file is there but cannot be read", () => {
  const { lines, log } = recorder();
  const dir = fixture({});
  mkdirSync(`${dir}/AGENTS.md`, { recursive: true });

  const out = readProjectInstructions(dir, log) ?? "";
  expect(out).toContain('status="unreadable"');
  expect(out).toContain("not a regular file");
  expect(lines[0]).toStartWith("warn project_instructions_unreadable");
});

// Clipping rather than refusing: a refusal is silent, and a 100KB AGENTS.md
// would simply stop applying with nobody the wiser.
test("clips an oversized file and says so in the text and the log", () => {
  const { lines, log } = recorder();
  const size = MAX_INSTRUCTION_BYTES + 500;
  const dir = fixture({ "AGENTS.md": "x".repeat(size) });

  const out = readProjectInstructions(dir, log) ?? "";
  expect(out).toContain(
    `[clipped at ${String(MAX_INSTRUCTION_BYTES)} bytes of ${String(size)}]`,
  );
  expect(out.length).toBeLessThan(size);
  expect(lines[0]).toStartWith("warn project_instructions_clipped");
});

/* ---------- 注入：位置与幂等 ---------- */

let server: ReturnType<typeof Bun.serve>;
let requests: { messages: Record<string, unknown>[] }[] = [];

/**
 * Which tool the stub asks for on its first call. Read is auto-approved, so the
 * turn runs to completion; Bash is the one the confirmation gate stops, which is
 * what makes the interrupt-and-resume path reachable without a network.
 */
let stubTool: "Read" | "Bash" = "Read";

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push((await request.json()) as (typeof requests)[number]);
      const first = requests.length === 1;

      return Response.json({
        id: `chatcmpl-${String(requests.length)}`,
        object: "chat.completion",
        created: 0,
        model: "stub",
        choices: [
          {
            index: 0,
            message: first
              ? {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: {
                        name: stubTool,
                        arguments:
                          stubTool === "Bash"
                            ? '{"command":"ls"}'
                            : '{"path":"package.json"}',
                      },
                    },
                  ],
                }
              : { role: "assistant", content: "done" },
            finish_reason: first ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
});

afterAll(() => void server.stop(true));

const INSTRUCTIONS =
  '<project-instructions path="AGENTS.md">Use tabs.</project-instructions>';

function agent(tool: "Read" | "Bash" = "Read") {
  requests = [];
  stubTool = tool;
  return createUniversalAgent({
    baseURL: `http://localhost:${String(server.port)}`,
    apiKey: "test-key",
    model: "stub",
    maxTokens: 64,
    projectInstructions: INSTRUCTIONS,
  });
}

const CONFIG = { configurable: { thread_id: "instructions-thread" } };

function injected(messages: { id?: string }[]): number[] {
  return messages.flatMap((message, index) =>
    message.id === PROJECT_INSTRUCTIONS_ID ? [index] : [],
  );
}

// The shape the whole design rests on: one copy, at a position fixed from the
// first turn. `beforeAgent` returns the message on every turn and does not check
// whether it is already there — `messagesStateReducer` merges by id and replaces
// in place, which is what makes the unconditional return idempotent.
test("injects one copy and keeps it in the same place across turns", async () => {
  const graph = agent();

  await graph.invoke({ messages: [new HumanMessage("one")] }, CONFIG);
  const out = await graph.invoke({ messages: [new HumanMessage("two")] }, CONFIG);

  // After the user's first message, because the graph merges the invocation
  // input into state before beforeAgent runs.
  expect(injected(out.messages)).toEqual([1]);
  expect(out.messages.map((message) => message.getType())).toEqual([
    "human",
    "human",
    "ai",
    "tool",
    "ai",
    "human",
    "ai",
  ]);
});

test("puts the instructions on the wire as user content", async () => {
  const graph = agent();

  await graph.invoke({ messages: [new HumanMessage("one")] }, CONFIG);

  for (const request of requests) {
    const carrying = request.messages.filter((message) =>
      JSON.stringify(message.content).includes("<project-instructions"),
    );
    expect(carrying).toHaveLength(1);
    expect(carrying[0]?.role).toBe("user");
  }
});

/**
 * Interrupting mid-turn and resuming does not add a second copy.
 *
 * Whether `beforeAgent` runs again on resume is the question this started as,
 * and the answer stopped mattering: with a fixed id the reducer collapses a
 * second return onto the first, so the invariant holds either way. That is the
 * point of testing the invariant rather than the hook.
 */
test("survives an interrupt and resume without a second copy", async () => {
  const graph = agent("Bash");

  const paused = await graph.invoke({ messages: [new HumanMessage("one")] }, CONFIG);
  expect(injected(paused.messages)).toEqual([1]);

  const out = await graph.invoke(
    new Command({ resume: { decisions: [{ type: "reject", message: "not now" }] } }),
    CONFIG,
  );

  expect(injected(out.messages)).toEqual([1]);
});

// Absent option, absent message. The middleware is only installed when there is
// something to inject, so a repository without instructions pays nothing.
test("adds nothing when there are no instructions to inject", async () => {
  requests = [];
  const graph = createUniversalAgent({
    baseURL: `http://localhost:${String(server.port)}`,
    apiKey: "test-key",
    model: "stub",
    maxTokens: 64,
  });

  const out = await graph.invoke({ messages: [new HumanMessage("one")] }, CONFIG);

  expect(injected(out.messages)).toEqual([]);
});
