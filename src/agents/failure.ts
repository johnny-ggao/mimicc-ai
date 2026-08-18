import { AIMessage } from "@langchain/core/messages";

/**
 * The harness's record that a turn failed, and how to tell failure from abort.
 *
 * This is the B′+A half of R6, decided in ticket 05: a turn that fails (model
 * 500 / request over limit / retries exhausted) must leave a durable marker in
 * the checkpoint, so the next turn can rescue it. A turn that is *aborted* must
 * not — abort is orthogonal control, not a failure (see CONTEXT.md「中止」).
 *
 * The marker is an {@link AIMessage} on purpose, and the reasons are each a trap
 * the other message types fall into:
 *
 * - **Not a HumanMessage.** `pinTurnTask` pins every unpinned human message,
 *   treating it as a task the user typed. A failure note is not a task, and
 *   pinning it would make failed turns accumulate pinned messages forever.
 * - **Not a SystemMessage.** The system role is the operator channel
 *   (`CONTEXT.md`「操作方通道」) — the one place only we write, with operator
 *   authority. A transient status note does not belong there.
 *
 * An AIMessage is ordinary: it is not pinned, it is not the operator channel,
 * and the projection summarises it like any other content. Its one oddity — the
 * assistant role — cannot be mistaken for model output, because a failed turn
 * produced no assistant message at all, and the bracket convention below says it
 * is the harness speaking.
 */

/** The prefix that marks a message as the harness's record of a failed turn. */
export const FAILURE_PREFIX = "[previous turn failed: ";

/** Whether an error is the user asking to stop, rather than a turn failing. */
export function isAbort(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === "AbortError" || (typeof name === "string" && name.includes("Abort"));
}

/** One deterministic line describing why the turn failed. */
export function failureText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** The marker message written into state when a turn fails. */
export function failureMarker(error: unknown): AIMessage {
  return new AIMessage(`${FAILURE_PREFIX}${failureText(error)}]`);
}
