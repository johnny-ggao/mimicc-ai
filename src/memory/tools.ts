import { tool, type ToolRuntime } from "@langchain/core/tools";
import { z } from "zod";

import type { ClientTool } from "@langchain/core/tools";

import { NEVER_REPLAY, SAFE_TO_REPLAY } from "../tools";

import {
  CATEGORIES,
  MemoryRefused,
  type MemoryStore,
  type WriteContext,
} from "./store";

/** How many memories a single search may return. */
const SEARCH_LIMIT = 20;

export interface MemoryToolOptions {
  store: MemoryStore;
}

/**
 * Reads the provenance the model is not allowed to supply.
 *
 * `ToolRuntime` extends `RunnableConfig`, so the thread id is in `configurable`
 * where langgraph put it and the call id is the one `ToolNode` assigned. Neither
 * is a tool argument, and that is the point: a `source` the model passed in
 * would be a claim it is making, while the only value of this field is that it
 * can be trusted when a memory turns out to be wrong.
 */
function provenance(runtime: ToolRuntime): WriteContext {
  const configurable = runtime.configurable as { thread_id?: unknown } | undefined;
  const threadId =
    typeof configurable?.thread_id === "string" ? configurable.thread_id : "unknown";
  return { threadId, callId: runtime.toolCallId ?? "unknown" };
}

/**
 * The four memory tools.
 *
 * A factory, not a constant, for the reason `createTaskTool` is one: these need
 * a resolved directory, and where things live is settled in `main.ts` so the
 * agent builder never touches the filesystem.
 *
 * ## Why tools rather than automatic extraction
 *
 * The alternative — a hook that runs an LLM over each finished turn and writes
 * whatever it decides is worth keeping — was rejected (2026-08-17) on three
 * counts. A tool call appears in the transcript, so what was remembered and why
 * is visible; a hook is not. A hook costs one extra model request *per turn*,
 * forever, and this repository weighs every mechanism on that scale. And the
 * tool layer already exists, so this adds almost no new machinery.
 *
 * The known weakness is that a tool only fires if the model thinks to call it.
 * That is accepted, because the failure is legible: memory stays empty and
 * anyone can see it. The hook's failure mode — quietly accumulating things
 * nobody looked at — is not.
 *
 * ## Why no confirmation gate
 *
 * `Bash` stops and asks. Memory writes deliberately do not, and the reason is
 * not that they are safe: it is that they are frequent. A gate that fires
 * constantly stops being read, and the gate that stops being read is the same
 * one guarding `Bash`. Observability here is the transcript and the files, not
 * a prompt.
 */
export function createMemoryTools({ store }: MemoryToolOptions): ClientTool[] {
  const search = tool(
    ({ query, category, limit }, _runtime: ToolRuntime): string => {
      const results = store.search(query, {
        ...(category !== undefined ? { category } : {}),
        limit: Math.min(limit ?? SEARCH_LIMIT, SEARCH_LIMIT),
      });

      if (results.length === 0) return "no memories match";

      return results
        .map((memory) => `[${memory.id}] (${memory.category}) ${memory.content}`)
        .join("\n\n");
    },
    {
      name: "MemorySearch",
      // Searching twice leaves the world as it was.
      metadata: { ...SAFE_TO_REPLAY },
      description:
        "Search what you already remember about this user and this project. " +
        "An empty query returns everything, newest first. " +
        "Do this before assuming you do not know something, and before adding a " +
        "memory that may already be there.",
      schema: z.object({
        query: z
          .string()
          .describe("Words to look for in the memory text. Empty returns everything."),
        category: z.enum(CATEGORIES).optional().describe("Only return this category."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`At most ${String(SEARCH_LIMIT)}.`),
      }),
    },
  );

  const add = tool(
    ({ content, category }, runtime: ToolRuntime): string => {
      try {
        const memory = store.add(content, category, provenance(runtime));
        return `remembered [${memory.id}] as ${memory.category}`;
      } catch (error) {
        // A refusal is a message to the model, not a crash: it says which gate
        // stopped the write and what to do instead, and the model can act on it.
        if (error instanceof MemoryRefused) return `not remembered: ${error.message}`;
        throw error;
      }
    },
    {
      name: "MemoryAdd",
      // Writing the same content twice is refused by the dedupe gate, so a
      // replay is not destructive — but it is also not free, and the crash-replay
      // rule is about effects that already happened. Left to never.
      metadata: { ...NEVER_REPLAY },
      description:
        "Remember one fact across sessions. Use it for things that will still be " +
        "true next time: how this person works, corrections they have given you, " +
        "this project's goals and constraints, where its external resources are. " +
        "Not for anything specific to the task at hand — that is what the " +
        "conversation is for. State it as one self-contained fact.",
      schema: z.object({
        content: z.string().describe("The fact, stated so it stands on its own."),
        category: z
          .enum(CATEGORIES)
          .describe(
            "user: how this person works, anywhere. " +
              "feedback: a correction they gave you, and why. " +
              "project: this repository's goals or constraints. " +
              "reference: where an external resource lives.",
          ),
      }),
    },
  );

  const remove = tool(
    ({ id }, _runtime: ToolRuntime): string =>
      store.remove(id) ? `forgotten [${id}]` : `no memory with id ${id}`,
    {
      name: "MemoryDelete",
      metadata: { ...NEVER_REPLAY },
      description:
        "Forget one memory, by the id MemorySearch returned. Use it when a " +
        "memory has stopped being true — a stale memory is worse than a missing " +
        "one, because you will act on it.",
      schema: z.object({ id: z.string().describe("Id from MemorySearch.") }),
    },
  );

  const update = tool(
    ({ id, content, category }, runtime: ToolRuntime): string => {
      const existing = store.find(id);
      if (existing === undefined) return `no memory with id ${id}`;

      try {
        // Written before the old one is removed. If the new text is refused —
        // too long, a duplicate of some *other* memory — the original must
        // survive; the opposite order loses a good memory to a failed edit.
        const replacement = store.add(
          content ?? existing.content,
          category ?? existing.category,
          provenance(runtime),
        );
        if (replacement.id !== id) store.remove(id);
        return `updated [${id}] -> [${replacement.id}]`;
      } catch (error) {
        if (error instanceof MemoryRefused) return `not updated: ${error.message}`;
        throw error;
      }
    },
    {
      name: "MemoryUpdate",
      metadata: { ...NEVER_REPLAY },
      description:
        "Correct one memory in place. The id changes, because a fact whose text " +
        "changed is a different fact — the returned id is the one to use from " +
        "now on. Omitted fields keep their current value.",
      schema: z.object({
        id: z.string().describe("Id from MemorySearch."),
        content: z.string().optional().describe("Replacement text."),
        category: z.enum(CATEGORIES).optional().describe("Replacement category."),
      }),
    },
  );

  return [search, add, update, remove];
}
