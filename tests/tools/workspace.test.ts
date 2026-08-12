import { expect, test } from "bun:test";

import { withPathLock } from "@/tools/workspace";

/** Records entry and exit so interleaving is visible in the assertion. */
function tracked(log: string[], id: string, ms: number) {
  return async (): Promise<string> => {
    log.push(`${id}+`);
    await Bun.sleep(ms);
    log.push(`${id}-`);
    return id;
  };
}

// The engine runs a batch concurrently and should. What it cannot know is that
// two calls touch one file: that is a fact about the tool, not about the task.
test("serialises work on the same path", async () => {
  const log: string[] = [];

  await Promise.all([
    withPathLock("/a", tracked(log, "one", 20)),
    withPathLock("/a", tracked(log, "two", 1)),
  ]);

  expect(log).toEqual(["one+", "one-", "two+", "two-"]);
});

// The whole reason for keying on the path rather than taking one global write
// lock: a global lock would answer the model's independence claim with "assume
// nothing is independent".
test("leaves different paths concurrent", async () => {
  const log: string[] = [];

  await Promise.all([
    withPathLock("/a", tracked(log, "one", 20)),
    withPathLock("/b", tracked(log, "two", 1)),
  ]);

  expect(log).toEqual(["one+", "two+", "two-", "one-"]);
});

// A tool that throws is ordinary here — Edit refuses ambiguous targets by
// throwing. If that wedged the queue, one bad edit would hang every later call
// on that file for the rest of the session.
test("a rejecting holder still releases the path", async () => {
  // bun:test's `.rejects` matcher is not typed as awaitable, so the rejection is
  // captured by hand — same reason as the helper in readonly.test.ts.
  const message = await withPathLock("/c", () =>
    Promise.reject(new Error("boom")),
  ).then(
    () => "(resolved unexpectedly)",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

  expect(message).toBe("boom");
  expect(await withPathLock("/c", () => Promise.resolve("after"))).toBe("after");
});

test("passes the result of the work back to its own caller", async () => {
  expect(await withPathLock("/d", () => Promise.resolve(42))).toBe(42);
});
