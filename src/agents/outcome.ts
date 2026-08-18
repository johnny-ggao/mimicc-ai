import { AIMessage } from "@langchain/core/messages";

/**
 * How a thrown error ends a turn — in one place, so the classification is
 * written once and the four call sites only consume it (ticket 01).
 *
 * A turn can end three ways; only two of them are *errors*:
 *
 * - **abort** — the user pressing Ctrl+C, orthogonal control (CONTEXT.md「中止」).
 *   Not a failure: no marker is written, nothing is rescued.
 * - **failure** — the turn genuinely did not run (model 500, request over
 *   limit, retries exhausted, or the loop hit the recursion ceiling). Rescuable
 *   (CONTEXT.md「失败」); a marker is written for the next turn to read.
 * - **capped** — the loop guard force-stopped it and still produced a final
 *   answer. Deliberately absent here: it is reported through `onCap`, not
 *   thrown as an error, so `classify` cannot see it. It stays `TurnCapReason`
 *   in `loopguard.ts` (ticket 01, Q3).
 *
 * `reason` distinguishes what kind of failure, because each caller renders a
 * different shape for a different audience: the console turns `recursion` into
 * "stopped after N steps", `task.ts` turns it into "narrow the objective", and
 * the marker turns every failure into one bracket line. The predicates that
 * decide the reason live here, exactly once; before this module the abort
 * predicate was written in both `failure.ts` and `repl.ts`, and the recursion
 * predicate in both `repl.ts` and `task.ts`.
 */

/** The prefix that marks a message as the record the harness writes of a failed turn. */
export const FAILURE_PREFIX = "[previous turn failed: ";

/** Why a turn ended, for a thrown error. See the module comment. */
export type TurnOutcome =
  | { kind: "abort" }
  | {
      kind: "failure";
      reason: "recursion" | "llm_status" | "other";
      error: unknown;
      /** Present only when `reason` is `"llm_status"`. */
      status?: number;
    };

/**
 * Classifies a thrown error into how the turn ended.
 *
 * The order is load-bearing and matches the old `repl.ts` describe: abort is
 * checked first (an AbortError that also carries a status is still an abort),
 * then recursion, then the provider status. Anything that is not an object, or
 * has none of these marks, is an ordinary failure.
 */
export function classify(error: unknown): TurnOutcome {
  if (typeof error !== "object" || error === null) {
    return { kind: "failure", reason: "other", error };
  }
  const { name, status } = error as { name?: unknown; status?: number };
  if (name === "AbortError" || (typeof name === "string" && name.includes("Abort"))) {
    return { kind: "abort" };
  }
  if (name === "GraphRecursionError") {
    return { kind: "failure", reason: "recursion", error };
  }
  if (status !== undefined) {
    return { kind: "failure", reason: "llm_status", error, status };
  }
  return { kind: "failure", reason: "other", error };
}

/** One deterministic line describing why the turn failed. */
export function failureText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * The marker message written into state when a turn fails.
 *
 * An {@link AIMessage} on purpose, and the reasons are each a trap the other
 * message types fall into (ticket 14):
 *
 * - **Not a HumanMessage.** `pinTurnTask` pins every unpinned human message,
 *   treating it as a task the user typed. A failure note is not a task.
 * - **Not a SystemMessage.** The system role is the operator channel
 *   (CONTEXT.md「操作方通道」) — the one place only we write. A transient
 *   status note does not belong there.
 *
 * An AIMessage is ordinary: not pinned, not the operator channel, and the
 * projection summarises it like any other content.
 */
export function failureMarker(error: unknown): AIMessage {
  return new AIMessage(`${FAILURE_PREFIX}${failureText(error)}]`);
}
