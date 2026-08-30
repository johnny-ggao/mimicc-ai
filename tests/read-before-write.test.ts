import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

import { ToolMessage, type BaseMessage } from "@langchain/core/messages";

import { isPinned } from "@/context";
import { READ_MARK_KEY, readBeforeWrite } from "@/agents";
import { resolvePath } from "@/tools/permission";

/**
 * The gate is exercised through its hook rather than through a whole agent run.
 *
 * The hook *is* the unit: it takes a tool call and the messages, and returns
 * either the handler's result or a refusal. Driving a model to produce the same
 * two calls would test the stub. One end-to-end case at the bottom covers the
 * thing this cannot — that the middleware is actually in the stack.
 */

const DIR = ".test-tmp/read-before-write";
const FILE = `${DIR}/target.md`;

const gate = readBeforeWrite();

/** Calls the hook with one tool call, recording whether the tool would have run. */
async function callGate(
  name: string,
  args: Record<string, unknown>,
  messages: BaseMessage[],
  onRun?: () => void | Promise<void>,
): Promise<{ result: ToolMessage; ran: boolean }> {
  let ran = false;
  const handler = async (): Promise<ToolMessage> => {
    ran = true;
    if (onRun) await onRun();
    return new ToolMessage({ tool_call_id: "call_1", name, content: "ok" });
  };
  const request = {
    toolCall: { name, args, id: "call_1", type: "tool_call" },
    tool: undefined,
    state: { messages },
    runtime: {},
  };
  // The hook's own types are the agent's; the request above is the shape it reads.
  const result = (await gate.wrapToolCall?.(
    request as never,
    handler as never,
  )) as ToolMessage;
  return { result, ran };
}

/** A `Read` result carrying a mark, as the gate itself would have stamped it. */
async function readMarkFor(path: string): Promise<BaseMessage> {
  const { result } = await callGate("Read", { path }, []);
  return result;
}

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, "original\n");
});

afterEach(() => {
  rmSync(DIR, { recursive: true, force: true });
});

test("a Read stamps a mark naming the file and its bytes", async () => {
  const marked = await readMarkFor(FILE);
  const mark = marked.additional_kwargs[READ_MARK_KEY] as {
    path: string;
    hash: string;
  };

  expect(mark.path).toBe(resolvePath(FILE));
  expect(mark.hash).toMatch(/^[0-9a-f]{64}$/);
});

test("editing a file that exists without reading it is refused", async () => {
  const { result, ran } = await callGate(
    "Edit",
    { path: FILE, oldString: "a", newString: "b" },
    [],
  );

  expect(ran).toBe(false);
  expect(result.status).toBe("error");
  expect(result.content).toContain("you have not read its current version");
});

test("the refusal is pinned, because a forgotten refusal is a retried edit", async () => {
  const { result } = await callGate(
    "Edit",
    { path: FILE, oldString: "a", newString: "b" },
    [],
  );

  expect(isPinned(result)).toBe(true);
});

test("reading first lets the edit through", async () => {
  const marked = await readMarkFor(FILE);
  const { ran } = await callGate(
    "Edit",
    { path: FILE, oldString: "a", newString: "b" },
    [marked],
  );

  expect(ran).toBe(true);
});

test("a mark for a different file does not open this one", async () => {
  const other = `${DIR}/other.md`;
  writeFileSync(other, "unrelated\n");
  const marked = await readMarkFor(other);

  const { ran } = await callGate(
    "Edit",
    { path: FILE, oldString: "a", newString: "b" },
    [marked],
  );

  expect(ran).toBe(false);
});

test("an edit never refreshes the mark: the second modification is refused", async () => {
  const marked = await readMarkFor(FILE);
  const first = await callGate(
    "Edit",
    { path: FILE, oldString: "a", newString: "b" },
    [marked],
    () => {
      // What the real tool does, and what invalidates every earlier read.
      writeFileSync(FILE, "changed\n");
    },
  );
  expect(first.ran).toBe(true);

  const second = await callGate(
    "Edit",
    { path: FILE, oldString: "c", newString: "d" },
    [marked],
  );
  expect(second.ran).toBe(false);
});

test("a file that does not exist is not gated — there is no earlier version", async () => {
  const fresh = `${DIR}/new.md`;
  const { ran } = await callGate(
    "Edit",
    { path: fresh, oldString: "a", newString: "b" },
    [],
  );

  expect(ran).toBe(true);
});

test("Bash is not gated — the admitted gap, asserted so it stays deliberate", async () => {
  const { ran } = await callGate("Bash", { command: `echo x >> ${FILE}` }, []);

  expect(ran).toBe(true);
});

test("an unhashable target fails open rather than blocking", async () => {
  // A directory: it exists, and it cannot be hashed as a file.
  const { ran } = await callGate(
    "Edit",
    { path: DIR, oldString: "a", newString: "b" },
    [],
  );

  expect(ran).toBe(true);
});

test("two edits in one batch: the second does not clear the gate on the same mark", async () => {
  const marked = await readMarkFor(FILE);
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  // The engine runs a batch concurrently. The first call is still in flight when
  // the second is checked — the window the hash comparison alone cannot close.
  const first = callGate(
    "Edit",
    { path: FILE, oldString: "a", newString: "b" },
    [marked],
    () => held,
  );
  const second = await callGate(
    "Edit",
    { path: FILE, oldString: "c", newString: "d" },
    [marked],
  );

  expect(second.ran).toBe(false);

  release();
  expect((await first).ran).toBe(true);
});

test("Write is not gated — a stricter rule already covers it, and two rules read worse than one", async () => {
  // `writeTool` throws `already exists and Write never overwrites` on its own
  // (src/tools/mutating.ts:48-54). Gating it here replaced that accurate message
  // with "read it first" — advice that does not help, because Write refuses
  // either way. `repro/41` caught the model repeating the wrong reason back.
  const { ran } = await callGate("Write", { path: FILE, content: "x" }, []);

  expect(ran).toBe(true);
});

test("a Write stamps a mark naming the file it just created", async () => {
  const fresh = `${DIR}/written.md`;
  const { result, ran } = await callGate(
    "Write",
    { path: fresh, content: "brand new\n" },
    [],
    () => writeFileSync(fresh, "brand new\n"),
  );

  expect(ran).toBe(true);
  const mark = result.additional_kwargs[READ_MARK_KEY] as {
    path: string;
    hash: string;
  };
  expect(mark.path).toBe(resolvePath(fresh));
  expect(mark.hash).toMatch(/^[0-9a-f]{64}$/);
});

test("editing right after your own Write needs no re-read", async () => {
  const fresh = `${DIR}/written.md`;
  const { result } = await callGate(
    "Write",
    { path: fresh, content: "brand new\n" },
    [],
    () => writeFileSync(fresh, "brand new\n"),
  );

  const { ran } = await callGate(
    "Edit",
    { path: fresh, oldString: "brand", newString: "fresh" },
    [result],
  );
  expect(ran).toBe(true);
});

// Terminal-Bench, run `2026-08-27__22-37-36`: `Write → Edit → Edit` was refused
// on the second Edit in three separate tasks (`blind-maze-explorer-algorithm`,
// `pytorch-model-cli`, `.hard`), each costing a re-read of a file the model had
// just written itself. The Write reason applies unchanged: the tool computed the
// bytes, so "knows the current version" is a fact.
test("an Edit stamps a mark naming the file it just changed", async () => {
  const marked = await readMarkFor(FILE);
  const { result, ran } = await callGate(
    "Edit",
    { path: FILE, oldString: "original", newString: "changed" },
    [marked],
    () => writeFileSync(FILE, "changed\n"),
  );

  expect(ran).toBe(true);
  const mark = result.additional_kwargs[READ_MARK_KEY] as {
    path: string;
    hash: string;
  };
  expect(mark.path).toBe(resolvePath(FILE));
  // The bytes *after* the edit, not the ones the read saw.
  expect(mark.hash).not.toBe(
    (marked.additional_kwargs[READ_MARK_KEY] as { hash: string }).hash,
  );
});

test("editing twice in a row needs no re-read in between", async () => {
  const marked = await readMarkFor(FILE);
  const { result } = await callGate(
    "Edit",
    { path: FILE, oldString: "original", newString: "changed" },
    [marked],
    () => writeFileSync(FILE, "changed\n"),
  );

  const { ran } = await callGate(
    "Edit",
    { path: FILE, oldString: "changed", newString: "changed twice" },
    [marked, result],
  );
  expect(ran).toBe(true);
});

test("an external change after your Edit is still refused", async () => {
  const marked = await readMarkFor(FILE);
  const { result } = await callGate(
    "Edit",
    { path: FILE, oldString: "original", newString: "changed" },
    [marked],
    () => writeFileSync(FILE, "changed\n"),
  );

  // Somebody else — Bash, the user — moves the file out from under the mark.
  writeFileSync(FILE, "changed by someone else\n");

  const { ran } = await callGate(
    "Edit",
    { path: FILE, oldString: "changed", newString: "changed twice" },
    [marked, result],
  );
  expect(ran).toBe(false);
});

test("an external change after your Write is still refused", async () => {
  const fresh = `${DIR}/written.md`;
  const { result } = await callGate(
    "Write",
    { path: fresh, content: "brand new\n" },
    [],
    () => writeFileSync(fresh, "brand new\n"),
  );
  // Someone else (or Bash) touches it after the Write.
  writeFileSync(fresh, "changed from outside\n");

  const { ran, result: refusal } = await callGate(
    "Edit",
    { path: fresh, oldString: "a", newString: "b" },
    [result],
  );
  expect(ran).toBe(false);
  expect(refusal.content).toContain("you have not read its current version");
});

test("a Write that fails to land stamps nothing", async () => {
  // Write onto an existing file throws in the tool; the engine turns the throw
  // into an error ToolMessage. That error must not carry a mark, or a later
  // Edit would hold a fake stamp for bytes that were never written.
  const handler = (): Promise<ToolMessage> =>
    Promise.resolve(
      new ToolMessage({
        tool_call_id: "call_1",
        name: "Write",
        content: "Error: already exists and Write never overwrites",
        status: "error",
      }),
    );
  const request = {
    toolCall: {
      name: "Write",
      args: { path: FILE, content: "x" },
      id: "call_1",
      type: "tool_call",
    },
    tool: undefined,
    state: { messages: [] as BaseMessage[] },
    runtime: {},
  };
  const result = (await gate.wrapToolCall?.(
    request as never,
    handler as never,
  )) as ToolMessage;

  expect(result.status).toBe("error");
  expect(result.additional_kwargs[READ_MARK_KEY]).toBeUndefined();
});
