import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

import { HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";

import { READ_MARK_KEY, staleReads } from "@/agents";
import { resolvePath } from "@/tools/permission";

/**
 * Driven through the two hooks, not through an agent run.
 *
 * `wrapToolCall` decides whether a notice is queued; `wrapModelCall` decides
 * where it goes. Both are asserted, because the second one is the whole reason
 * this leaves no trace in the history — a notice queued and then written to the
 * graph state would be a different mechanism with the same behaviour.
 */

const DIR = ".test-tmp/stale-reads";
const FILE = `${DIR}/target.md`;
const OTHER = `${DIR}/other.md`;

const sensor = staleReads();

/** The text of a message, when it is a string — which is all this program sends. */
function textOf(message: BaseMessage | undefined): string {
  return typeof message?.content === "string" ? message.content : "";
}

/** A `Read` result carrying a mark for `path` at its current bytes. */
function markFor(path: string, hash: string): BaseMessage {
  const message = new ToolMessage({ tool_call_id: "r1", name: "Read", content: "..." });
  message.additional_kwargs[READ_MARK_KEY] = { path: resolvePath(path), hash };
  return message;
}

/** The hash the gate would have stamped, taken the same way it takes it. */
async function currentHash(path: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  const { readFileSync } = await import("node:fs");
  return createHash("sha256")
    .update(readFileSync(resolvePath(path)))
    .digest("hex");
}

/** Runs one Bash call through the sensor, with `during` standing in for the command. */
async function runBash(
  messages: BaseMessage[],
  during?: () => void,
  command = "echo hi",
): Promise<void> {
  const handler = (): Promise<ToolMessage> => {
    if (during) during();
    return Promise.resolve(
      new ToolMessage({ tool_call_id: "b1", name: "Bash", content: "done" }),
    );
  };
  await sensor.wrapToolCall?.(
    {
      toolCall: { name: "Bash", args: { command }, id: "b1", type: "tool_call" },
      tool: undefined,
      state: { messages },
      runtime: {},
    } as never,
    handler as never,
  );
}

/** The messages the next model call would actually be sent. */
async function nextRequestMessages(base: BaseMessage[]): Promise<BaseMessage[]> {
  let seen: BaseMessage[] = [];
  await sensor.wrapModelCall?.(
    { messages: base } as never,
    ((request: { messages: BaseMessage[] }) => {
      seen = request.messages;
      return { result: [] };
    }) as never,
  );
  return seen;
}

beforeEach(async () => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, "original\n");
  writeFileSync(OTHER, "untouched\n");
  // Clear anything a previous test queued — the same reset the turn boundary does.
  // `beforeAgent` is either the handler or `{ hook }`; take whichever this is.
  const before = sensor.beforeAgent;
  const hook = typeof before === "function" ? before : before?.hook;
  await hook?.({ messages: [] }, {} as never);
});

afterEach(() => {
  rmSync(DIR, { recursive: true, force: true });
});

test("a command that changes a file the model read queues a notice naming it", async () => {
  const marks = [markFor(FILE, await currentHash(FILE))];

  await runBash(marks, () => writeFileSync(FILE, "changed by the command\n"));

  const sent = await nextRequestMessages([new HumanMessage("go")]);
  const last = textOf(sent[sent.length - 1]);
  expect(last).toContain("[STALE READ]");
  expect(last).toContain(resolvePath(FILE));
});

test("a command that changes nothing says nothing", async () => {
  const marks = [markFor(FILE, await currentHash(FILE))];

  await runBash(marks);

  const sent = await nextRequestMessages([new HumanMessage("go")]);
  expect(sent).toHaveLength(1);
});

test("only the file that changed is named", async () => {
  const marks = [
    markFor(FILE, await currentHash(FILE)),
    markFor(OTHER, await currentHash(OTHER)),
  ];

  await runBash(marks, () => writeFileSync(FILE, "changed\n"));

  const sent = await nextRequestMessages([new HumanMessage("go")]);
  const text = textOf(sent[sent.length - 1]);
  expect(text).toContain(resolvePath(FILE));
  expect(text).not.toContain(resolvePath(OTHER));
});

test("a mark that was already stale before the command is not reported", async () => {
  // The model read it, then edited it a lap ago: the mark is stale and the model
  // knows. Reporting that is the noise this sensor must not make.
  const marks = [markFor(FILE, "0".repeat(64))];

  await runBash(marks);

  const sent = await nextRequestMessages([new HumanMessage("go")]);
  expect(sent).toHaveLength(1);
});

test("a tool that is not Bash is not observed", async () => {
  const marks = [markFor(FILE, await currentHash(FILE))];

  const handler = (): Promise<ToolMessage> => {
    writeFileSync(FILE, "changed by something else\n");
    return Promise.resolve(
      new ToolMessage({ tool_call_id: "e1", name: "Edit", content: "ok" }),
    );
  };
  await sensor.wrapToolCall?.(
    {
      toolCall: { name: "Edit", args: { path: FILE }, id: "e1", type: "tool_call" },
      tool: undefined,
      state: { messages: marks },
      runtime: {},
    } as never,
    handler as never,
  );

  // An Edit changing the file is the model's own doing, and the gate covers the
  // consequence. Saying so here would be telling it what it just did.
  const sent = await nextRequestMessages([new HumanMessage("go")]);
  expect(sent).toHaveLength(1);
});

test("the notice never reaches the history — it rides on the request alone", async () => {
  const marks = [markFor(FILE, await currentHash(FILE))];
  const history = [new HumanMessage("go")];

  await runBash(marks, () => writeFileSync(FILE, "changed\n"));
  const sent = await nextRequestMessages(history);

  // The wire carries it; the caller's array does not.
  expect(sent).toHaveLength(2);
  expect(history).toHaveLength(1);
});

test("the notice is delivered once, not on every lap", async () => {
  const marks = [markFor(FILE, await currentHash(FILE))];

  await runBash(marks, () => writeFileSync(FILE, "changed\n"));

  expect(await nextRequestMessages([new HumanMessage("go")])).toHaveLength(2);
  expect(await nextRequestMessages([new HumanMessage("go")])).toHaveLength(1);
});
