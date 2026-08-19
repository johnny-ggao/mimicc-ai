import { expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { ToolJournal } from "@/checkpoint";

/**
 * The sidecar, on its own.
 *
 * Nothing here starts a graph: the whole point of splitting this out of
 * `08-wrap-tool-call` is that "what does the file say about this call" is
 * answerable without one.
 */

function journal(thread = "t1") {
  return new ToolJournal(mkdtempSync(join(tmpdir(), "mimicc-journal-")), thread);
}

const intent = (id: string, replay: "safe" | "never" = "never") => ({
  toolCallId: id,
  tool: "Bash",
  args: { command: "rm -rf build" },
  replay,
});

test("a call nobody wrote about is unrecorded", async () => {
  expect((await journal().lookup("c1")).kind).toBe("unrecorded");
});

/**
 * The state the mechanism exists for: durable intent, absent settlement. Nothing
 * on disk can say whether the effect happened, half happened, or never started —
 * and the declaration captured here is what decides what to do about it.
 */
test("an intent with no settlement reads as interrupted, declaration and all", async () => {
  const log = journal();
  await log.recordIntent(intent("c1", "never"));

  const state = await log.lookup("c1");
  expect(state.kind).toBe("interrupted");
  if (state.kind !== "interrupted") throw new Error("unreachable");
  expect(state.intent.replay).toBe("never");
  expect(state.intent.args).toEqual({ command: "rm -rf build" });
});

test("a settlement carries the result back", async () => {
  const log = journal();
  await log.recordIntent(intent("c1"));
  await log.recordSettlement({ toolCallId: "c1", content: "gone", isError: false });

  const state = await log.lookup("c1");
  expect(state.kind).toBe("settled");
  if (state.kind !== "settled") throw new Error("unreachable");
  expect(state.settlement.content).toBe("gone");
});

/**
 * The replay case, spelled out because it is the one that decides the design.
 *
 * A crash and a resume put the same call through again, so the same intent is
 * written twice. The declaration that matters is the one captured **before** the
 * effect — if the second write won, the record would say what the code believes
 * now, which is precisely the thing `bothSafe` exists to distrust.
 */
test("writing the same intent twice keeps the first declaration", async () => {
  const log = journal();
  await log.recordIntent(intent("c1", "never"));
  await log.recordIntent(intent("c1", "safe"));

  const state = await log.lookup("c1");
  if (state.kind !== "interrupted") throw new Error("expected it to still be in doubt");
  expect(state.intent.replay).toBe("never");
  // …and it did not grow a second line either.
  expect(readFileSync(log.path, "utf8").trimEnd().split("\n")).toHaveLength(1);
});

/**
 * A half-written last line is the ordinary shape of a file whose writer was
 * killed — which is the whole situation this file is about, so it cannot be an
 * error case.
 */
test("a torn last line does not hide the intact ones before it", async () => {
  const log = journal();
  await log.recordIntent(intent("c1"));
  appendFileSync(log.path, '{"kind":"intent","toolCallId":"c2","to');

  expect((await log.lookup("c1")).kind).toBe("interrupted");
  expect((await log.lookup("c2")).kind).toBe("unrecorded");
});

test("pruning drops what settled and keeps what is still in doubt", async () => {
  const log = journal();
  await log.recordIntent(intent("done"));
  await log.recordSettlement({ toolCallId: "done", content: "ok", isError: false });
  await log.recordIntent(intent("pending"));

  await log.prune();

  expect((await log.lookup("done")).kind).toBe("unrecorded");
  expect((await log.lookup("pending")).kind).toBe("interrupted");
});

/**
 * The rewrite is published atomically — temp file, then rename — and this is the
 * only observable half of that: no debris left beside the journal.
 *
 * It matters more here than it looks. This file exists because the process can
 * die at any moment, so a rewrite that could be caught half-done would be a
 * crash-recovery file that is not itself crash-safe, and what a torn rewrite
 * loses is exactly the records with an intent and no settlement — the only thing
 * recovery has to go on.
 */
test("pruning leaves nothing behind beside the journal", async () => {
  const log = journal();
  await log.recordIntent(intent("done"));
  await log.recordSettlement({ toolCallId: "done", content: "ok", isError: false });
  await log.recordIntent(intent("pending"));

  await log.prune();

  const directory = dirname(log.path);
  expect(readdirSync(directory)).toEqual([basename(log.path)]);
});

test("pruning the last settled call takes the file with it", async () => {
  const log = journal();
  await log.recordIntent(intent("c1"));
  await log.recordSettlement({ toolCallId: "c1", content: "ok", isError: false });

  await log.prune();

  expect(existsSync(log.path)).toBe(false);
});

/**
 * The pairing is by name, so whoever deletes a thread can find both files.
 *
 * ⚠️ Nothing deletes threads today — `JsonlSaver.deleteThread` has no callers —
 * so this is a convention waiting for its first user rather than a wired-up path.
 * Asserting the name is what makes it findable when that user shows up.
 */
test("the journal is named after its thread and sits beside it", async () => {
  const log = journal("abc-123");
  expect(basename(log.path)).toBe("abc-123.tools.jsonl");

  await log.recordIntent(intent("c1"));
  expect(existsSync(log.path)).toBe(true);
  await log.remove();
  expect(existsSync(log.path)).toBe(false);
});
