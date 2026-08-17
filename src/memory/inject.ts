import { HumanMessage } from "@langchain/core/messages";
import { createMiddleware, type AnyAgentMiddleware } from "langchain";

import { PINNED } from "../context";

import { CATEGORIES, type Category, type Memory, type MemoryStore } from "./store";

/**
 * The message id, and — exactly as with the project instructions — the entire
 * deduplication strategy.
 *
 * `messagesStateReducer` merges by id, replacing in place and keeping position,
 * so `beforeAgent` can return this on every turn and the reducer makes it
 * idempotent. No guard, no scan, no second source of truth about whether the
 * injection already happened.
 */
export const MEMORY_ID = "memory";

/**
 * How many bytes of memory ride along on every request.
 *
 * Deliberately the same order as `MAX_INSTRUCTION_BYTES` and for the identical
 * reason: this text is paid for on every model call for the life of the thread,
 * not once like a `Read`.
 *
 * ⚠️ This bound is what closes the context bill, which is why the store's own
 * cap can afford to be a runaway detector rather than a budget (2026-08-17).
 * Loosening this without revisiting that decision would leave neither of them
 * doing the job.
 */
export const MAX_INJECTED_BYTES = 4_000;

/**
 * Which memories get the room, when there is not room for all of them.
 *
 * Ordered by what is worst to be missing rather than by anything the model
 * scores. A correction you fail to apply is the most expensive kind of mistake
 * — you already made it once. How the person works comes next; the project's
 * constraints after that; and references last, because "where does X live" is
 * the query `MemorySearch` answers best and the one you know to ask.
 *
 * Ties break on recency. Both keys are computed from what is on disk, which is
 * the point: the alternative was a confidence score the model assigns itself,
 * and that was rejected for being uncheckable (see `store.ts`).
 */
const PRIORITY: Record<Category, number> = {
  feedback: 0,
  user: 1,
  project: 2,
  reference: 3,
};

/**
 * Memory in the context window.
 *
 * ## Why a HumanMessage and not a system message
 *
 * The same decision as the project instructions, arrived at from a different
 * direction. Instructions are excluded from `system` because whoever can commit
 * to the repository writes them. Memory is excluded because **the model wrote
 * it**: every line here was distilled from a conversation and stored by a tool
 * call, so putting it in `system` would let the agent grant its own output the
 * authority of its own safety rules. deer-flow reaches the same conclusion and
 * names it (`dynamic_context_middleware.py:220-224`, "memory stays at role:user",
 * citing OWASP LLM01).
 *
 * ## Why the message is built per turn, unlike the instructions
 *
 * `projectInstructions` builds its message once at construction because its
 * bytes must never change. This one must be allowed to change, and that was
 * decided against my recommendation (2026-08-17): the argument for freezing it
 * was that the model already knows what it just wrote, and that argument only
 * holds while the `MemoryAdd` call is still in the context window. **Compaction
 * takes it out.** In a long session the model genuinely does forget what it
 * remembered, and only re-injection brings it back.
 *
 * The cost is real and bounded to where it belongs: the reducer compares the
 * merged message, so a turn that wrote nothing produces byte-identical content
 * and the cached prefix survives. Only a turn that actually changed memory pays,
 * and `tests/memory-inject.test.ts` pins that split.
 *
 * ## Why pinned
 *
 * Same reason the instructions are: it sits before every cut that will ever be
 * made, so without a pin the projection would eventually drop it and the model
 * would lose its memory partway through a long session — silently, since nothing
 * downstream knows the difference between "no memories" and "the memories were
 * trimmed away".
 */
export function injectMemory(store: MemoryStore): AnyAgentMiddleware {
  return createMiddleware({
    name: "Memory",
    beforeAgent: () => {
      const text = render(select(store.all(), MAX_INJECTED_BYTES));
      // Nothing remembered yet is not an empty section, it is no section. An
      // empty tag would spend tokens telling the model something the absence of
      // the tag already says, on every request, forever.
      if (text === undefined) return;

      return {
        messages: [
          new HumanMessage({
            id: MEMORY_ID,
            content: text,
            additional_kwargs: { ...PINNED },
          }),
        ],
      };
    },
  });
}

/**
 * Fills the budget by priority, then recency.
 *
 * Whole memories only. A memory cut in half is worse than a memory left out: the
 * model cannot tell that it is reading a fragment, and half of "never run this
 * against production" is an instruction to run it.
 */
export function select(memories: Memory[], budget: number): Memory[] {
  const ordered = [...memories].sort((a, b) => {
    const byPriority = PRIORITY[a.category] - PRIORITY[b.category];
    return byPriority !== 0 ? byPriority : b.created.localeCompare(a.created);
  });

  const kept: Memory[] = [];
  let spent = 0;
  for (const memory of ordered) {
    const cost = Buffer.byteLength(memory.content, "utf8") + 8;
    // `break`, not `continue`: skipping ahead to a shorter memory would make
    // what is injected depend on the sizes of what came before it, so adding one
    // long memory could silently swap out an unrelated short one.
    if (spent + cost > budget) break;
    kept.push(memory);
    spent += cost;
  }
  return kept;
}

/**
 * The injected text, or undefined when there is nothing to inject.
 *
 * Grouped by category with the id shown, because the id is what `MemoryUpdate`
 * and `MemoryDelete` take: a model that notices a memory has gone stale can act
 * on it without searching first.
 */
export function render(memories: Memory[]): string | undefined {
  if (memories.length === 0) return undefined;

  const sections = CATEGORIES.flatMap((category) => {
    const group = memories.filter((memory) => memory.category === category);
    if (group.length === 0) return [];
    return [
      `<${category}>`,
      ...group.map((memory) => `[${memory.id}] ${memory.content}`),
      `</${category}>`,
    ];
  });

  return [
    "<memory>",
    "What you have remembered from earlier sessions. Use MemorySearch for the rest;",
    "MemoryUpdate or MemoryDelete by id when one of these has stopped being true.",
    ...sections,
    "</memory>",
  ].join("\n");
}
