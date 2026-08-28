import { expect, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";

import { classify, failureMarker, failureText } from "@/agents";
import { DeadlineExceeded } from "@/deadline";

/**
 * The unified "how did a turn end" classifier - the error-axis half that
 * replaces the duplicated abort / recursion predicates (ticket 01, landed here).
 *
 * Expected values are literals copied from what the code did before the
 * refactor: failure.ts isAbort, repl.ts describe, task.ts explain. The point
 * is that the predicates live here exactly once and still agree with the old
 * behaviour - the refactor must not change a classification.
 */

test("abort is the exact name, or any name containing Abort", () => {
  expect(classify({ name: "AbortError" })).toEqual({ kind: "abort" });
  expect(classify({ name: "SomeAbort" })).toEqual({ kind: "abort" });
});

test("a name that is not Abort is not abort", () => {
  expect(classify({ name: "TimeoutError" }).kind).toBe("failure");
  expect(classify({ name: 123 }).kind).toBe("failure");
  expect(classify({ name: undefined }).kind).toBe("failure");
});

test("abort is checked before status", () => {
  expect(classify({ name: "AbortError", status: 500 }).kind).toBe("abort");
});

test("recursion is a failure whose reason is recursion", () => {
  const outcome = classify({ name: "GraphRecursionError" });
  expect(outcome.kind).toBe("failure");
  if (outcome.kind === "failure") expect(outcome.reason).toBe("recursion");
});

test("recursion is checked before status", () => {
  const outcome = classify({ name: "GraphRecursionError", status: 500 });
  expect(outcome.kind).toBe("failure");
  if (outcome.kind === "failure") expect(outcome.reason).toBe("recursion");
});

test("an llm status is a failure carrying that status", () => {
  const outcome = classify({ status: 429 });
  expect(outcome.kind).toBe("failure");
  if (outcome.kind === "failure") {
    expect(outcome.reason).toBe("llm_status");
    expect(outcome.status).toBe(429);
  }
});

test("status 0 is a status, not absent", () => {
  const outcome = classify({ status: 0 });
  expect(outcome.kind).toBe("failure");
  if (outcome.kind === "failure") expect(outcome.reason).toBe("llm_status");
});

test("non-objects and unmarked objects are ordinary failures", () => {
  for (const error of [
    new Error("boom"),
    "a string",
    42,
    null,
    undefined,
    { message: "no status" },
  ]) {
    const outcome = classify(error);
    expect(outcome.kind).toBe("failure");
    if (outcome.kind === "failure") expect(outcome.reason).toBe("other");
  }
});

test("failureText is the old message extraction", () => {
  expect(failureText(new Error("boom"))).toBe("boom");
  expect(failureText("literal")).toBe("literal");
});

test("failureMarker keeps the exact old wording", () => {
  const marker = failureMarker(new Error("boom"));
  expect(marker).toBeInstanceOf(AIMessage);
  expect(marker.content).toBe("[previous turn failed: boom]");
});

// 期限也是靠 abort 落地的（`console/once.ts` 到点按下那把中断），所以这两格证的是
// 同一件事的两面：形状一样、含义相反，判据必须先看期限（ADR 0010）。
test("超期是失败，不是中止 —— 它写 marker，中止不写", () => {
  const outcome = classify(new DeadlineExceeded(30_000, "run"));
  expect(outcome.kind).toBe("failure");
  expect(outcome.kind === "failure" && outcome.reason).toBe("deadline");
});

test("即使壳上带着 Abort 的名字，期限的标记也先赢", () => {
  const disguised = Object.assign(new DeadlineExceeded(1_000, "run"), {
    name: "AbortError",
  });
  expect(classify(disguised).kind).toBe("failure");
});

test("超期的那句话说得出是哪只钟、过了多久", () => {
  expect(failureText(new DeadlineExceeded(30_400, "run"))).toContain("run deadline");
  expect(failureText(new DeadlineExceeded(30_400, "run"))).toContain("30s");
});
