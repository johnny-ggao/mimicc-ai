import { ToolMessage } from "@langchain/core/messages";
import { tool, type ToolRuntime } from "@langchain/core/tools";
import { createMiddleware, type AnyAgentMiddleware } from "langchain";
import { z } from "zod";

import { markPinned } from "../context";
import { SAFE_TO_REPLAY } from "../tools/replay";

import { wrapSkill, type SkillRegistry } from "./registry";

/** The name the model types and the confirmation policy keys on. */
export const SKILL_TOOL_NAME = "Skill";

/**
 * Builds the `Skill` tool: name a skill, get its full instructions back.
 *
 * ## Why a factory
 *
 * The tool needs the registry, and the registry is read off disk at startup by
 * `main.ts` — the same reason `Task` is a factory handed the model: a ready-made
 * tool in `TOOLS` would have to reach the filesystem to get one.
 *
 * ## The gate, and why it is not a separate rule
 *
 * A `disable-model-invocation` skill is refused here with "user-invoked only":
 * the whole point of that flag is that the model is not the index, and a tool
 * that loaded it anyway would silently erase the flag. The slash command is the
 * one entry that passes; this is the one that does not.
 *
 * ## Deduplication is per-thread, not per-process
 *
 * Loading the same skill twice buys a second pinned copy of the same body. The
 * set is keyed by `thread_id`, so `/clear` (a new thread) starts empty and a
 * crash-resume — a fresh process, hence a fresh set — re-runs the call with the
 * body genuinely absent from the thread. Scanning the history would be the
 * alternative, and it is rejected: the tool has the thread id, not the messages.
 */
export function createSkillTool(registry: SkillRegistry) {
  const loaded = new Map<string, Set<string>>();

  return tool(
    (
      input: { name: string; file?: string | undefined },
      runtime: ToolRuntime,
    ): string => {
      const { name, file } = input;
      const skill = registry.get(name);
      if (skill === undefined) {
        throw new Error(notFound(name, registry));
      }
      if (!skill.modelInvokable) {
        throw new Error(
          `skill ${name} is user-invoked only; it cannot be loaded by the model — the user types /${name}`,
        );
      }

      if (file !== undefined) return registry.readFile(name, file);

      const threadId =
        typeof runtime.configurable?.thread_id === "string"
          ? runtime.configurable.thread_id
          : undefined;
      if (threadId !== undefined) {
        const seen = loaded.get(threadId) ?? new Set<string>();
        if (seen.has(name)) {
          return `skill ${name} is already loaded — see the earlier <skill name="${name}"> block`;
        }
        seen.add(name);
        loaded.set(threadId, seen);
      }

      return wrapSkill(skill);
    },
    {
      name: SKILL_TOOL_NAME,
      // Reading the same skill twice leaves the world exactly as it was.
      metadata: { ...SAFE_TO_REPLAY },
      description:
        "Load the full instructions of a task-specific skill. The skills available to you are listed in the <skill-catalog> block in this conversation. Pass file to read one of a skill's auxiliary files instead.",
      schema: z.object({
        name: z.string().describe("The skill name, from the <skill-catalog> list"),
        file: z
          .string()
          .optional()
          .describe(
            "Optional: read an auxiliary file belonging to the skill, by filename",
          ),
      }),
    },
  );
}

/** The refusal the model reads and can act on, naming the alternatives. */
function notFound(name: string, registry: SkillRegistry): string {
  const available = registry
    .modelInvokable()
    .map((skill) => `\`${skill.name}\``)
    .join(", ");
  return `no skill named ${name}; the model-invoked skills are ${available || "none installed"}`;
}

/**
 * Pins a `Skill` tool's result after the fact.
 *
 * The tool returns a string; langchain builds the `ToolMessage`, so there is no
 * constructor to reach from inside the tool. This is the *second* legitimate use
 * of `markPinned` — the first is the confirmation gate's rejection — and the
 * justification is the same: the message is built by the framework, and the
 * content is exactly the kind that must survive a summary. A skill body eaten
 * part-way through its task is an instruction the model stops following.
 *
 * Errors are left alone: "no skill named X" must not be pinned into the thread.
 */
export function pinSkillLoads(): AnyAgentMiddleware {
  return createMiddleware({
    name: "PinSkillLoads",
    wrapToolCall: async (request, handler) => {
      const result = await handler(request);
      if (
        request.toolCall.name === SKILL_TOOL_NAME &&
        ToolMessage.isInstance(result) &&
        result.status !== "error"
      ) {
        markPinned(result);
      }
      return result;
    },
  }) as AnyAgentMiddleware;
}
