import { ToolMessage } from "@langchain/core/messages";
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
