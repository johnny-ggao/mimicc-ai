import {
  AIMessage,
  HumanMessage,
  RemoveMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { createMiddleware, type AnyAgentMiddleware } from "langchain";

import { readAnswerCut, type AnswerCut } from "../context";

import { hintInjector } from "./hint";

/**
 * Ensures a turn ends with a visible assistant response.
 *
 * Two different things end a turn blank, and they need opposite treatment.
 *
 * **The model returned nothing.** It ran tools and then produced an empty final
 * answer — no exception, just nothing. Retry once: remove the empty message,
 * jump back to the model with a reminder. If the retry is empty too, persist a
 * canned fallback so the turn is visibly complete rather than blank.
 *
 * **The output ceiling ate the answer.** On a reasoning model the reasoning is
 * billed as output, so a whole ceiling can go into thinking with not one
 * character of answer written. That reply is empty in exactly the same way, and
 * the reminder above is the wrong thing to send: the model did not forget to
 * answer, it never got there — and the retry re-asks at the same ceiling, so it
 * ends the same way. Say what happened instead, and do not retry.
 *
 * Measured, Terminal-Bench run `2026-08-27__22-37-36`
 * (`.scratch/external-bench/issues/05-failure-triage.md`, C1/C2):
 * `grid-pattern-transform` spent 133s on one call that returned
 * `completion_tokens == reasoning_tokens == 32768` and nothing else — and
 * because no tool had run yet, the check below never looked at it and the turn
 * ended silent. `write-compressor` did it twice for 325s and reported the
 * fallback's wrong cause.
 *
 * ⚠️ **Only `bound: "ceiling"` short-circuits.** A `"provider"` ending is the
 * recoverable one — pi makes exactly one bounded retry for it
 * (`packages/ai/src/utils/overflow.ts:171`) — so it falls through to the retry
 * that is already here.
 */

const REMINDER =
  "[system_reminder] Your previous response after the tool execution was empty. " +
  "Review the tool results already in the conversation and provide a concise, " +
  "user-visible final response. Do not call another tool unless it is strictly necessary.";

const FALLBACK =
  "The model completed the tool run but returned no final response, including after one automatic retry. Please try again.";

/** Says which limit ended the turn, because "no response" would name the wrong cause. */
function ceilingText(cut: AnswerCut): string {
  return (
    `This turn produced no answer: the reply reached its output limit ` +
    `(${String(cut.output)} of ${String(cut.ceiling)} tokens) before writing any of it — ` +
    `on a reasoning model the thinking is billed as output and can consume the whole limit. ` +
    `Retrying at the same limit would end the same way, so nothing was retried. ` +
    `Ask for less in one turn, or raise the output budget.`
  );
}

function hasVisibleContent(message: AIMessage): boolean {
  // This program's single model returns string content. A non-string content
  // block is treated as empty rather than inspected block by block.
  const content = message.content;
  return typeof content === "string" && content.trim().length > 0;
}

/** Whether a tool ran after the most recent user message (this turn). */
function toolResultSinceLastUser(messages: BaseMessage[]): boolean {
  let lastUser = -1;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message !== undefined && HumanMessage.isInstance(message)) lastUser = index;
  }
  if (lastUser === -1) return false;
  for (let index = lastUser + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (message !== undefined && ToolMessage.isInstance(message)) return true;
  }
  return false;
}

/**
 * Swaps an empty answer for a written one: remove, then append.
 *
 * 🔴 **Not a same-id replacement**, and the difference is the whole point. Reusing
 * the id is langgraph's own idiom and works in memory — but the saver keys
 * messages by id and keeps the first write, so the substituted text never comes
 * back out of the checkpointer. `mimicc --print` reads exactly that: it asks the
 * checkpointer for the finished thread and walks back to the last assistant
 * message (`src/console/once.ts:165`).
 *
 * Measured, Terminal-Bench run `2026-08-28__02-59-09`: `write-compressor` fired
 * `answer_cut` and correctly skipped the retry, and `--print` still printed
 * **nothing**. A test on `invoke`'s return value cannot see this — that value is
 * the in-memory state, where the same-id write did land.
 */
function replace(empty: AIMessage, content: string): BaseMessage[] {
  return [
    ...(empty.id !== undefined ? [new RemoveMessage({ id: empty.id })] : []),
    new AIMessage({ content }),
  ];
}

export function emptyReplyGuard(): AnyAgentMiddleware {
  let retried = false;
  const inject = hintInjector();

  return createMiddleware({
    name: "EmptyReplyGuard",
    beforeAgent: () => {
      retried = false;
      inject.reset();
    },
    afterModel: {
      canJumpTo: ["model"],
      hook: (state: { messages?: BaseMessage[] }) => {
        const messages = state.messages ?? [];
        const last = messages[messages.length - 1];
        if (last === undefined || !AIMessage.isInstance(last)) return;
        if (hasVisibleContent(last)) return;
        if ((last.tool_calls ?? []).length > 0) return;

        // Before the tool-result check, not after: the ceiling can eat the very
        // first reply of a turn, and that turn has no tool result to find.
        const cut = readAnswerCut(last);
        if (cut?.bound === "ceiling") {
          return { messages: replace(last, ceilingText(cut)) };
        }

        if (!toolResultSinceLastUser(messages)) return;

        if (!retried) {
          retried = true;
          inject.queue(REMINDER);
          return {
            messages: last.id !== undefined ? [new RemoveMessage({ id: last.id })] : [],
            jumpTo: "model" as const,
          };
        }
        return { messages: replace(last, FALLBACK) };
      },
    },
    wrapModelCall: inject.wrapModelCall,
  }) as AnyAgentMiddleware;
}
