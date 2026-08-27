import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { createMiddleware, type AnyAgentMiddleware } from "langchain";

import { hintInjector } from "./hint";

/**
 * Detects a model going in circles and force-stops it, instead of leaving it to
 * burn tokens until the turn budget (turnBudget) or the wall clock lands —
 * the pathology guards exist so the budget does not have to be the first line.
 *
 * The model repeats the same tool-call set: the set is hashed and counted per
 * turn. At the warn threshold a warning is injected on the next model call; at
 * the hard limit the tool_calls are stripped and a canned final answer is
 * forced. The hard stop does not throw — the turn completes as capped, not
 * clean — which is reported through onCap so the caller can record it as a
 * structured observable (deer-flow's stop_reason=loop_capped, see research/15).
 *
 * Hash layer only. The frequency layer — the same tool type called too many
 * times even with changing arguments — is a separate refinement, not here yet.
 */

const WARN_THRESHOLD = 3;
const HARD_LIMIT = 5;

const HARD_STOP_MSG =
  "[FORCED STOP] Repeated tool calls exceeded the safety limit. Producing final answer with results collected so far.";

/** The reasons a turn can end capped rather than clean. */
export type TurnCapReason = "loop_capped" | "budget_exhausted";

function warningText(streak: number): string {
  return (
    "[loop warning] You have made the same tool call " +
    String(streak) +
    " times in a row. " +
    "Stop repeating it — change approach, or produce a final answer with what you have."
  );
}

/** A stable key for the tool-call set, or null when the message has no tool calls. */
function toolCallKey(message: AIMessage): string | null {
  const calls = message.tool_calls ?? [];
  if (calls.length === 0) return null;
  return JSON.stringify(calls.map((call) => [call.name ?? "", call.args ?? {}]).sort());
}

export function loopGuard(options: {
  onCap?: (reason: TurnCapReason) => void;
}): AnyAgentMiddleware {
  let streak = 0;
  let lastKey: string | null = null;
  const inject = hintInjector();

  return createMiddleware({
    name: "LoopGuard",
    beforeAgent: () => {
      streak = 0;
      lastKey = null;
      inject.reset();
    },
    afterModel: (state: { messages?: BaseMessage[] }) => {
      const last = state.messages?.[state.messages.length - 1];
      if (last === undefined || !AIMessage.isInstance(last)) return;

      const key = toolCallKey(last);
      if (key === null) {
        streak = 0;
        lastKey = null;
        return;
      }
      streak = key === lastKey ? streak + 1 : 1;
      lastKey = key;

      if (streak >= HARD_LIMIT) {
        options.onCap?.("loop_capped");
        const content =
          (typeof last.content === "string" ? last.content : "") +
          "\n\n" +
          HARD_STOP_MSG;
        const additional_kwargs = Object.fromEntries(
          Object.entries(last.additional_kwargs ?? {}).filter(
            ([key]) => key !== "tool_calls" && key !== "function_call",
          ),
        );
        return {
          messages: [
            new AIMessage({
              ...(last.id !== undefined ? { id: last.id } : {}),
              content,
              additional_kwargs,
            }),
          ],
        };
      }
      if (streak >= WARN_THRESHOLD) {
        inject.queue(warningText(streak));
      }
      return;
    },
    wrapModelCall: inject.wrapModelCall,
  }) as AnyAgentMiddleware;
}
