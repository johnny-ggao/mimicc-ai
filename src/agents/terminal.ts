import {
  AIMessage,
  HumanMessage,
  RemoveMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { createMiddleware, type AnyAgentMiddleware } from "langchain";

/**
 * Ensures a tool-using turn ends with a visible assistant response.
 *
 * The model can run tools and then produce an empty final answer — a turn that
 * ends with nothing, and no exception. Retry once: remove the empty message,
 * jump back to the model with a reminder. If the retry is empty again, persist
 * a canned fallback so the turn is visibly complete rather than blank.
 */

const REMINDER =
  "[system_reminder] Your previous response after the tool execution was empty. " +
  "Review the tool results already in the conversation and provide a concise, " +
  "user-visible final response. Do not call another tool unless it is strictly necessary.";

const FALLBACK =
  "The model completed the tool run but returned no final response, including after one automatic retry. Please try again.";

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

export function emptyReplyGuard(): AnyAgentMiddleware {
  let retried = false;
  let pendingReminder: string | null = null;

  return createMiddleware({
    name: "EmptyReplyGuard",
    beforeAgent: () => {
      retried = false;
      pendingReminder = null;
    },
    afterModel: {
      canJumpTo: ["model"],
      hook: (state: { messages?: BaseMessage[] }) => {
        const messages = state.messages ?? [];
        const last = messages[messages.length - 1];
        if (last === undefined || !AIMessage.isInstance(last)) return;
        if (hasVisibleContent(last)) return;
        if ((last.tool_calls ?? []).length > 0) return;
        if (!toolResultSinceLastUser(messages)) return;

        if (!retried) {
          retried = true;
          pendingReminder = REMINDER;
          return {
            messages: last.id !== undefined ? [new RemoveMessage({ id: last.id })] : [],
            jumpTo: "model" as const,
          };
        }
        return {
          messages: [
            new AIMessage({
              ...(last.id !== undefined ? { id: last.id } : {}),
              content: FALLBACK,
            }),
          ],
        };
      },
    },
    wrapModelCall: async (request, handler) => {
      if (pendingReminder === null) return handler(request);
      const reminder = pendingReminder;
      pendingReminder = null;
      return handler({
        ...request,
        messages: [...(request.messages ?? []), new HumanMessage(reminder)],
      });
    },
  }) as AnyAgentMiddleware;
}
