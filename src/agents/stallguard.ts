import { ToolMessage } from "@langchain/core/messages";
import { isGraphBubbleUp } from "@langchain/langgraph";
import { createMiddleware, type AnyAgentMiddleware } from "langchain";

import { hintInjector } from "./hint";

/**
 * Detects a run of failing tool calls and prompts the model to change approach.
 *
 * The thin version of deer-flow's tool_progress middleware: only an error
 * result counts as a problem call, and a run of three queues one progress hint.
 * A single clean result resets the run.
 *
 * A tool that *throws* is a problem call too. With a wrapToolCall middleware
 * present, ToolNode hands the raw throw to the middleware and lets it decide;
 * re-throwing would be fatal, so the throw is converted to the same error
 * ToolMessage ToolNode would have produced on its own (see nodes/ToolNode.js).
 *
 * ⚠️ **Unless the throw is not a failure.** LangGraph implements `interrupt()`
 * as a throw — `GraphInterrupt extends GraphBubbleUp` (`langgraph/errors.js`) —
 * and its other control-flow signals travel the same way: a cooperative drain,
 * a subgraph's `Command` on its way up to the parent. Turning one of those into
 * an error ToolMessage does not report a failure, it *cancels a question the
 * human was supposed to answer*: measured in `repro/25`, a tool body that
 * called `interrupt()` never stopped the graph, and the model read back
 * `"GraphInterrupt: […] Please fix your mistakes."` — the payload of the
 * question, addressed to the wrong reader, with an apology attached.
 *
 * So a bubble-up is re-thrown and does not count against the streak. This is
 * what langchain's own error middleware does with the same class of throw
 * (`agents/middleware/toolError.js:51`), and the predicate is theirs too, so
 * a signal added in a later release is covered without this file being told.
 */

const BAD_STREAK_LIMIT = 3;

const HINT_TEXT =
  "[PROGRESS HINT] Several tool calls in a row failed. Read each error and change approach instead of retrying the same thing.";

export function stallGuard(): AnyAgentMiddleware {
  let badStreak = 0;
  const inject = hintInjector();

  const record = (bad: boolean): void => {
    badStreak = bad ? badStreak + 1 : 0;
    if (badStreak >= BAD_STREAK_LIMIT) {
      inject.queue(HINT_TEXT);
      badStreak = 0;
    }
  };

  return createMiddleware({
    name: "StallGuard",
    beforeAgent: () => {
      badStreak = 0;
      inject.reset();
    },
    wrapToolCall: async (request, handler) => {
      try {
        const result = await handler(request);
        record(ToolMessage.isInstance(result) && result.status === "error");
        return result;
      } catch (error) {
        // Before `record`, not after: a paused call has not failed, and letting
        // it move the streak would mean three questions in a row nag the model
        // to change approach.
        if (isGraphBubbleUp(error)) throw error;
        record(true);
        return new ToolMessage({
          tool_call_id: request.toolCall.id ?? "",
          name: request.toolCall.name ?? "",
          content: `${String(error)}\n Please fix your mistakes.`,
          // A throw is a failure, not a crash — mark it so the journal records an
          // error settlement rather than a success (ticket 10).
          status: "error",
        });
      }
    },
    wrapModelCall: inject.wrapModelCall,
  }) as AnyAgentMiddleware;
}
