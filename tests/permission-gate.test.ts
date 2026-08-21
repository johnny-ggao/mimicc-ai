import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";

import {
  HumanMessage,
  type BaseMessage,
  type ToolMessage,
} from "@langchain/core/messages";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import type { AnyAgentMiddleware } from "langchain";

import { agentStack, createUniversalAgent } from "@/agents";
import { parseRule, type RuleSet } from "@/tools/permission";

/**
 * A stubbed model endpoint that asks for one Read on the first lap and answers on
 * the second — one full lap, enough to see whether the read was denied.
 */
let server: ReturnType<typeof Bun.serve>;
let requests: { messages: Record<string, unknown>[] }[] = [];
/** The tool call the stub asks for; each test sets these before invoking. */
let toolName = "Read";
let toolArgs: Record<string, unknown> = { path: ".env" };

const completion = (id: string, message: Record<string, unknown>, finish: string) => ({
  id,
  object: "chat.completion",
  created: 0,
  model: "stub",
  choices: [{ index: 0, message, finish_reason: finish }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push((await request.json()) as (typeof requests)[number]);
      return Response.json(
        requests.length === 1
          ? completion(
              `chatcmpl-${String(requests.length)}`,
              {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: {
                      name: toolName,
                      arguments: JSON.stringify(toolArgs),
                    },
                  },
                ],
              },
              "tool_calls",
            )
          : completion(
              `chatcmpl-${String(requests.length)}`,
              { role: "assistant", content: "it would not let me" },
              "stop",
            ),
      );
    },
  });
});

afterAll(() => void server.stop(true));

function graph(rules?: RuleSet, auto = false) {
  requests = [];
  return createUniversalAgent({
    baseURL: `http://localhost:${String(server.port)}`,
    apiKey: "test-key",
    model: "stub",
    maxTokens: 64,
    ...(rules !== undefined ? { rules } : {}),
    auto,
  });
}

function toolMessages(messages: BaseMessage[]): ToolMessage[] {
  return messages.filter(
    (message): message is ToolMessage => message.getType() === "tool",
  );
}

/** The single tool message a one-lap turn should produce. */
function onlyTool(messages: BaseMessage[]): ToolMessage {
  const tools = toolMessages(messages);
  if (tools.length !== 1)
    throw new Error(`expected 1 tool message, got ${tools.length}`);
  const first = tools[0];
  if (first === undefined) throw new Error("expected a tool message");
  return first;
}

/** MessageContent is a string or an array of blocks; narrow before comparing. */
function contentOf(tool: ToolMessage): string {
  const content = tool.content;
  return typeof content === "string" ? content : JSON.stringify(content);
}

test("denies a secret read with a message the model reads, not a throw", async () => {
  toolName = "Read";
  toolArgs = { path: ".env" };
  const out = await graph().invoke(
    { messages: [new HumanMessage("read the env file")] },
    { configurable: { thread_id: "test-thread" } },
  );

  const tool = onlyTool(out.messages);
  const content = contentOf(tool);
  expect(content).toContain("may hold credentials");
  // A deliberate denial, not a throw the tool node wrapped in "Error: … Please
  // fix your mistakes." The prefix is how the old tool-body throw surfaced.
  expect(content).not.toContain("Please fix your mistakes");
  expect(tool.status).toBe("error");
});

test("denies a read that escapes the working directory", async () => {
  toolName = "Read";
  toolArgs = { path: "../escaped.txt" };
  const out = await graph().invoke(
    { messages: [new HumanMessage("read a file outside")] },
    { configurable: { thread_id: "test-thread" } },
  );

  const tool = onlyTool(out.messages);
  const content = contentOf(tool);
  expect(content).toContain("escapes the working directory");
  expect(content).not.toContain("Please fix your mistakes");
});

test("denies a mutating tool on a secret path without asking first", async () => {
  toolName = "Write";
  toolArgs = { path: ".env", content: "x" };
  const out = await graph().invoke(
    { messages: [new HumanMessage("write the env file")] },
    { configurable: { thread_id: "test-thread" } },
  );

  // One tool message = the call was denied, not interrupted for a human. An
  // interrupt would have paused the graph with no ToolMessage at all.
  const tool = onlyTool(out.messages);
  const content = contentOf(tool);
  expect(content).toContain("may hold credentials");
  expect(content).not.toContain("Please fix your mistakes");
  expect(tool.status).toBe("error");
});

test("a Bash deny rule fires end to end", async () => {
  toolName = "Bash";
  toolArgs = { command: "rm -rf /" };
  const out = await graph([parseRule("Bash(rm -rf:*)", "deny")]).invoke(
    { messages: [new HumanMessage("clean up")] },
    { configurable: { thread_id: "test-thread" } },
  );

  // Denied by the rule — one tool message — not parked at the gate, which is
  // what the old wiring did (it never passed `command`, so the rule never fired).
  const tool = onlyTool(out.messages);
  expect(contentOf(tool)).toContain("denied by rule: Bash(rm -rf:*)");
});

test("an allow rule lets a mutating tool run without asking", async () => {
  const target = ".mimicc-outputs/rule-allow.txt";
  rmSync(target, { force: true });

  toolName = "Write";
  toolArgs = { path: target, content: "hello" };
  const out = await graph([parseRule("Write(.mimicc-outputs/**)", "allow")]).invoke(
    { messages: [new HumanMessage("write it")] },
    { configurable: { thread_id: "test-thread" } },
  );

  // The tool ran — one tool message, the Write result — rather than parking at
  // the gate. A parked turn would have produced no ToolMessage at all.
  const tool = onlyTool(out.messages);
  expect(contentOf(tool)).toContain("created");

  rmSync(target, { force: true });
});

test("auto mode lets a mutating tool run without asking", async () => {
  const target = ".mimicc-outputs/auto-write.txt";
  rmSync(target, { force: true });

  toolName = "Write";
  toolArgs = { path: target, content: "hello" };
  const out = await graph(undefined, true).invoke(
    { messages: [new HumanMessage("write it")] },
    { configurable: { thread_id: "test-thread" } },
  );

  const tool = onlyTool(out.messages);
  expect(contentOf(tool)).toContain("created");

  rmSync(target, { force: true });
});

/** The deny effector is shared with subagents, not main-agent-only. */
function hasPermissionGate(stack: AnyAgentMiddleware[]): boolean {
  return stack.some((middleware) => middleware.name === "PermissionGate");
}

test("the deny effector is part of every kind's stack, subagents included", () => {
  const env = { model: new FakeListChatModel({ responses: ["unused"] }) };
  expect(hasPermissionGate(agentStack("main", env))).toBe(true);
  expect(hasPermissionGate(agentStack("explore", env))).toBe(true);
});
