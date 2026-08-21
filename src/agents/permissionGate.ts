import { ToolMessage } from "@langchain/core/messages";
import { createMiddleware, type AnyAgentMiddleware } from "langchain";

import { decide, toolCallOf, type RuleSet } from "../tools/permission";

/**
 * The deny effector of the permission gate.
 *
 * Runs in `wrapToolCall`, before the tool executes, and refuses any call the
 * rule engine decides to deny — returning a `ToolMessage` the model reads,
 * instead of running the tool (and instead of a throw that the tool node would
 * wrap in "Error: … Please fix your mistakes"). The hard floor is always in
 * force; the configurable rules ride along in `rules`.
 *
 * Shared with subagents on purpose, unlike the confirmation gate. A subagent
 * cannot `interrupt()` to ask (docs/adr/0003), but it *can* be denied —
 * `wrapToolCall` needs no checkpointer. If this were main-agent-only, an
 * Explore's `Read` would lose the hard floor, reopening the same exfiltration
 * channel the tool-body `resolveInside` used to close.
 */
export function permissionGate(rules?: RuleSet): AnyAgentMiddleware {
  return createMiddleware({
    name: "PermissionGate",
    wrapToolCall: async (request, handler) => {
      const verdict = decide(toolCallOf(request.toolCall), rules);
      if (verdict.decision === "deny") {
        return new ToolMessage({
          tool_call_id: request.toolCall.id ?? "",
          name: request.toolCall.name,
          content: verdict.reason ?? "permission denied",
          status: "error",
        });
      }
      return handler(request);
    },
  }) as AnyAgentMiddleware;
}
