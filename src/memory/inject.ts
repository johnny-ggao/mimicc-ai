import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { createMiddleware, type AnyAgentMiddleware } from "langchain";

import { PINNED, type WindowEvent } from "../context";

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
 * The `additional_kwargs` key carrying which memories the frozen block contains.
 *
 * Ids rather than text, because that is all an update needs: what to add comes
 * from the live store, and what to retract needs only its id — the text is still
 * visible in the block above it.
 *
 * On `additional_kwargs` rather than parsed back out of the rendered text, and
 * that is a decision with a reason. Memory content is free text the *model*
 * wrote, so a regex for `[0-9a-f]{12}` in brackets can match a memory that
 * happens to contain one — a silent misread, which is the exact failure class
 * this marker exists to prevent. It is also not a new seam: {@link PINNED} lives
 * in `additional_kwargs` already and the projection reads it there.
 *
 * ⚠️ **The checkpointer's round trip is measured, not assumed** — see
 * `tests/memory-inject.test.ts`. `checkpoint/messages.ts` lists the fields whose
 * fidelity it has checked and `additional_kwargs` was not among them, so this
 * key comes with its own test rather than riding on somebody else's.
 *
 * Travelling *on the message* is what makes recovery self-healing: if the block
 * is gone the marker is gone with it, and the absence is read as "nothing was
 * ever frozen". A separate state channel would outlive the block it describes
 * and start disagreeing with the view — silently.
 */
export const SNAPSHOT_KEY = "mimicc_memory_snapshot";

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
 * ## Why the block is frozen, and where the corrections go instead
 *
 * It used to be rebuilt every turn. That was decided against my recommendation
 * (2026-08-17) and the argument was sound at the time: freezing was defended on
 * "the model already knows what it just wrote", which only holds while the
 * `MemoryAdd` call is still in the context window, and **compaction takes it
 * out**. In a long session the model genuinely does forget what it remembered.
 *
 * What that argument did not have is a second place to put the correction. Now
 * it does. The block is built once and its bytes never change again; anything
 * that changed since rides out as a separate `<memory-update>` appended to the
 * *request* — see {@link renderUpdate}. So the freezing objection is answered
 * rather than overruled: the model still learns what it remembered mid-session,
 * it just learns it from the update instead of from a rewritten block.
 *
 * The price of rebuilding was never the bytes of the block, it was **where** it
 * sits. The block is injected early and stays at that index forever
 * (`messagesStateReducer` merges by id, in place), so every rewrite invalidated
 * the provider's cached prefix from there to the end of the request — measured
 * at 4.0% cache hit against 39.3% for the same content at the tail
 * (`repro/31-the-cache-bill.ts`). Frozen, it invalidates nothing, ever.
 *
 * ## Why the update is appended to the request and not to the state
 *
 * Because a message in the state cannot be left unpinned: `pinTurnTask` pins
 * every unpinned `HumanMessage` it finds, so an update written back would join
 * the pinned set and outlive its own usefulness. Appending inside
 * `wrapModelCall` hands the handler a new array and never touches state, which
 * is the same move `hintInjector` makes and the reason `CONTEXT.md` has a word
 * for that slot (附言).
 *
 * It also means the update is recomputed on **every model call**, not every
 * turn, so a memory written on tool lap two is visible on lap three. The
 * rebuilt-block design could not do that — it ran once per turn, outside the
 * loop.
 *
 * ## Why pinned
 *
 * Same reason the instructions are: it sits before every cut that will ever be
 * made, so without a pin the projection would eventually drop it and the model
 * would lose its memory partway through a long session — silently, since nothing
 * downstream knows the difference between "no memories" and "the memories were
 * trimmed away".
 */
export function injectMemory(
  store: MemoryStore,
  agent: string,
  onEvent?: (event: WindowEvent) => void,
): AnyAgentMiddleware {
  return createMiddleware({
    name: "Memory",
    beforeAgent: (state: { messages?: BaseMessage[] }) => {
      const existing = frozenBlock(state.messages);
      // Already frozen and readable: the whole point is that this returns
      // nothing, so the reducer has nothing to merge and the bytes stand.
      if (snapshotIds(existing) !== undefined) return;

      const kept = select(store.all(), MAX_INJECTED_BYTES);
      const text = render(kept);
      // Nothing remembered yet is not an empty section, it is no section. An
      // empty tag would spend tokens telling the model something the absence of
      // the tag already says, on every request, forever.
      if (text === undefined) return;

      // A block that is present but carries no readable id set is a session
      // written before this design, or one whose marker did not survive. Both
      // take the same road — re-freeze — because "never marked" and "marker
      // lost" are the same situation from here, and a second branch would only
      // be a second thing to get wrong.
      //
      // Reported, because this is the one moment the block's bytes change: it
      // costs one turn's prefix and is otherwise invisible. Nothing downstream
      // can tell a session that re-froze from one that simply ran cold.
      if (existing !== undefined) {
        onEvent?.({ type: "memory_refroze", agent, memories: kept.length });
      }

      return {
        messages: [
          new HumanMessage({
            id: MEMORY_ID,
            content: text,
            additional_kwargs: {
              ...PINNED,
              [SNAPSHOT_KEY]: kept.map((memory) => memory.id),
            },
          }),
        ],
      };
    },
    wrapModelCall: async (request, handler) => {
      const ids = snapshotIds(frozenBlock(request.messages));
      // No block, or one this design cannot read: `beforeAgent` will have
      // re-frozen it, and until it has there is nothing to diff against.
      if (ids === undefined) return handler(request);

      const update = renderUpdate(select(store.all(), MAX_INJECTED_BYTES), ids);
      if (update === undefined) return handler(request);

      return handler({
        ...request,
        messages: [...(request.messages ?? []), new HumanMessage(update)],
      });
    },
  }) as AnyAgentMiddleware;
}

/** The frozen block in a message list, or undefined when there is not one. */
function frozenBlock(messages: BaseMessage[] | undefined): BaseMessage | undefined {
  return messages?.find((message) => message.id === MEMORY_ID);
}

/**
 * The ids a frozen block was built from, or undefined when it cannot say.
 *
 * Undefined covers three cases on purpose — no block, no marker, a marker of the
 * wrong shape — because every one of them means the same thing to the caller:
 * there is no snapshot to diff against, so freeze one.
 */
function snapshotIds(message: BaseMessage | undefined): string[] | undefined {
  const value = message?.additional_kwargs[SNAPSHOT_KEY];
  if (!Array.isArray(value)) return undefined;
  if (!value.every((id) => typeof id === "string")) return undefined;
  return value;
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
    // Says outright that it is a snapshot, for the reason `downgrade.ts` gives
    // about its synopsis: text that reads like the live thing gets used like the
    // live thing. This block is frozen for the session, so a reader who takes it
    // for current is reading a claim nobody is making.
    "A snapshot of what you remembered, taken when this block was written — not a live view.",
    "Anything that changed since appears in a later <memory-update>; that one wins.",
    "Use MemorySearch for the rest; MemoryUpdate or MemoryDelete by id when one has",
    "stopped being true.",
    ...sections,
    "</memory>",
  ].join("\n");
}

/**
 * What changed between a frozen block and what would be injected now.
 *
 * Both sides are the *selected* set rather than the whole store, and that is
 * load-bearing: `select` caps the block at {@link MAX_INJECTED_BYTES}, so
 * diffing against `store.all()` would report every memory the budget left out as
 * an addition, on every request, and hand back the bytes the cap just saved.
 *
 * `-` means "no longer listed", which is deliberately weaker than "deleted": a
 * memory can leave the selection by being deleted *or* by being crowded out
 * when a newer one arrives. The block never claimed to be the whole store —
 * `MemorySearch` is what settles which of the two happened — so the update does
 * not claim it either.
 *
 * Undefined when nothing changed, which is the common case and has to cost
 * nothing: the update is recomputed on every model call, so an empty one would
 * be a tag repeated for the life of the thread saying only that it is empty.
 */
export function renderUpdate(
  current: Memory[],
  snapshot: string[],
): string | undefined {
  const frozen = new Set(snapshot);
  const live = new Set(current.map((memory) => memory.id));

  const added = current.filter((memory) => !frozen.has(memory.id));
  const dropped = snapshot.filter((id) => !live.has(id));
  if (added.length === 0 && dropped.length === 0) return undefined;

  return [
    "<memory-update>",
    "Changes since the <memory> snapshot above. Where they disagree, this wins.",
    "`+` is new since the snapshot. `-` is no longer listed — deleted, or crowded",
    "out by a newer memory; MemorySearch settles which.",
    ...added.map((memory) => `+ [${memory.id}] ${memory.content}`),
    ...dropped.map((id) => `- [${id}]`),
    "</memory-update>",
  ].join("\n");
}
