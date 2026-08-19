import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";

/**
 * The projection: conversation history in, context window out.
 *
 * ## The two words, and why they are two
 *
 * **The view** (`CONTEXT.md`: 上下文窗口) is the noun — the `BaseMessage[]` the
 * model actually receives on one request. **The projection** is the verb: the
 * function that computes it. Two inputs, one output, no side effects and no
 * framework — a third, which messages must survive, now rides on the messages
 * themselves rather than being handed in:
 *
 * ```
 * (history, cut) ──project──▶ view
 *    ↑ the original, never discarded      ↑ recomputed every call, never stored
 * ```
 *
 * Keeping them separate is what makes the central claim of this repository
 * expressible at all. Only two facts are persisted — where the cut is, and the
 * one message standing in for what precedes it — and the view is rebuilt from
 * them on every model call. Compare the two stock mechanisms:
 * `contextEditingMiddleware` does `messages[i] = …` and
 * `summarizationMiddleware` returns "delete everything, here is a summary".
 * **Both destroy the original to shrink the view.** This one does not, and three
 * properties follow, each with a test that would fail without it: a summarised
 * session still reads back whole from disk; a second summary recomputes the cut
 * over the same history rather than summarising a summary; and a pinned message
 * that has fallen behind the cut can be fetched back.
 *
 * ## Why this is a module and not six private functions
 *
 * Because "what does the model see this time" is a question worth being able to
 * ask, and until this file existed the only way to ask it was to start an agent
 * and a stub server. That is not merely inconvenient. An inconsistency lived in
 * here for the whole life of the code and was found by a probe against the real
 * provider rather than by a test — see {@link requestTokens}, which measures
 * something subtly different from what {@link planCut} measures. Nobody put the
 * two side by side, because there was no side to put them on.
 *
 * ## What is deliberately elsewhere
 *
 * Deciding *when* to cut, calling the model to write a summary, updating state,
 * absorbing an overflow: all of that is `compaction.ts`. This file computes; it
 * never acts. The split is not free, and the counter-argument was recorded
 * rather than waved away — see `docs/adr/0004`.
 */

/**
 * Where the history is cut, and what stands in for the part before it.
 *
 * A value rather than two loose parameters because they are only ever meaningful
 * together: an index with no summary is a silent deletion, and a summary with no
 * index has nothing to replace. `at: 0` with no summary is the untouched state.
 *
 * Note that this is *not* the persisted shape — the graph state still holds
 * `_windowCutoff` and `_windowSummary` as two keys, and it has to, because
 * session files written before this refactor contain them. The adapter builds a
 * `Cut` at the boundary. A value object here and two keys on disk is the right
 * way round: the interface can be designed, the file format is already spent.
 */
export interface Cut {
  /** Index into the history. Everything before it is represented by `summary`. */
  at: number;
  /** Stands in for what precedes `at`. Absent means nothing has been cut yet. */
  summary?: BaseMessage | undefined;
}

/** The `additional_kwargs` key that marks a message as pinned. */
export const PINNED_KEY = "mimicc_pinned";

/**
 * Spread into a message's `additional_kwargs` to pin it at construction.
 *
 * ```ts
 * new HumanMessage({ content, additional_kwargs: { ...PINNED } })
 * ```
 */
export const PINNED: Readonly<Record<string, true>> = { [PINNED_KEY]: true };

/** Whether this message must survive a cut that has passed it. */
export function isPinned(message: BaseMessage): boolean {
  return message.additional_kwargs[PINNED_KEY] === true;
}

/**
 * Pins a message that somebody else built.
 *
 * ⚠️ **The exception, and it is meant to stay one.** The rule is that whoever
 * produces a message pins it, because they are the one who knows it has to be —
 * see {@link project}. This exists for the messages we do not produce: the
 * confirmation gate's rejection carries the user's own words back as a tool
 * result, and that `ToolMessage` is built inside langchain's
 * `humanInTheLoopMiddleware` (`agents/middleware/hitl.js:399`), where we have no
 * constructor to reach.
 *
 * Mutating rather than rebuilding: the message has not been committed to state
 * yet, and rebuilding a `ToolMessage` means knowing every field langchain chose
 * to put on it. **Do not reach for this to avoid pinning at the source.** Every
 * use is a place where the rule does not apply, and there should be one.
 */
export function markPinned<T extends BaseMessage>(message: T): T {
  message.additional_kwargs[PINNED_KEY] = true;
  return message;
}

/**
 * What the model is sent: the pinned messages, the summary, then everything
 * after the cut.
 *
 * **Pinning is a mark the message carries, not a list this function is handed.**
 * It used to be the latter — `pins: readonly string[]`, supplied by whoever
 * assembled the middleware — and the reasoning was sound as far as it went: the
 * projection has no business knowing that a thing called "project instructions"
 * exists. What that shape could not express is anything decided *at runtime*.
 * The list was built once, at construction, from ids known then; a message the
 * user types, or one the confirmation gate produces when they reject a command,
 * has an id that did not exist yet and could never join it.
 *
 * So the coupling moved down rather than away. This function still does not know
 * about any particular feature — it knows that a message can be marked, which is
 * a domain concept in its own right (`CONTEXT.md`: 钉住). Whoever produces a
 * message that must survive is still the one who says so; they now say it on the
 * message instead of in a list.
 *
 * Why pinning is needed at all, which is easy to get wrong: a resident message
 * is injected under a fixed id, and `messagesStateReducer` merges by id —
 * replacing **in place**, keeping position. So it never moves from its original
 * index near the front, which means it sits before every cut that will ever be
 * made and would silently drop out of the view. Re-injecting each turn does not
 * help; only rebuilding the view can.
 */
export function project(history: BaseMessage[], cut: Cut): BaseMessage[] {
  const view =
    cut.at <= 0 || cut.summary === undefined
      ? history
      : [
          ...history.filter((message, index) => index < cut.at && isPinned(message)),
          cut.summary,
          ...history.slice(cut.at),
        ];
  // Last, and it has to be last: it inserts messages, which would move `cut.at`
  // out from under the arithmetic above if it ran first.
  return closeDangling(view);
}

/**
 * What a tool call is told when nobody is going to answer it any more.
 *
 * Deliberately does **not** say why the run stopped, because the view cannot
 * tell: a Ctrl+C and a crash leave the identical shape behind — one assistant
 * message with `tool_calls` and no results — and only the console knows which
 * happened. Naming one would be a guess printed as a fact, and the model reads
 * this as a fact.
 *
 * What it does say is the part that changes the next move: **the call is kept
 * and its result is given up** (the decided semantics, 2026-08-19), so repeating
 * it is a decision rather than a formality — and if a person stopped it,
 * repeating it is probably the opposite of what they wanted.
 */
export function abandonedText(tool: string): string {
  return [
    `[abandoned: this ${tool} call was issued, and no result was ever recorded]`,
    "The run stopped between the two — a Ctrl+C, or the process dying. It may",
    "have taken effect, may have taken effect partly, or may never have started.",
    "It was not run again and it will not be: the call is kept in the history,",
    "its result is given up. If a person stopped it, do not simply repeat it.",
    "Check the current state before doing anything that assumes either outcome.",
  ].join("\n");
}

/**
 * Gives every unanswered tool call a result, **in the view only**.
 *
 * ## Why this has to exist
 *
 * A provider rejects an assistant message whose `tool_calls` are not answered —
 * measured against the real one (`repro/19-orphan-tool-call.ts`): HTTP 400,
 * *an assistant message with 'tool_calls' must be followed by tool messages
 * responding to each 'tool_call_id'*. And the shape is reachable from the
 * shipping path (`repro/20-abort-mid-tool-then-type.ts`): Ctrl+C a turn while a
 * tool is running, then type an ordinary sentence — langgraph opens a **new run
 * from START** instead of finishing the batch, so the results never arrive.
 * History only grows, so that is not one failed turn: **every later request
 * carries it and the session is finished**, `/clear` being the only way out.
 *
 * ## Why here rather than in the history
 *
 * Two facts decided it, and both were measured rather than argued.
 *
 * The check is **positional**: a fourth case in `repro/19` sent the same call
 * with its result appended *after* the following user message — the same 400.
 * So the repair has to control *where* the result goes, and a `beforeAgent` hook
 * cannot: state updates append, and by then the user's new message is already in
 * state. Repairing the history would mean rewriting the message list to insert
 * in the middle — a store that only ever appends, rewritten to reorder.
 *
 * The view, meanwhile, already differs from the history by design — that is what
 * a cut is — and {@link pairSafe} is here for exactly the same reason: **the
 * projection is not allowed to emit an illegal shape**. This is that rule, one
 * case wider.
 *
 * ⚠️ The consequence is deliberate: the history keeps the unanswered call
 * forever, because that is what happened. The model is simply never shown a
 * request that cannot be sent.
 */
export function closeDangling(messages: BaseMessage[]): BaseMessage[] {
  const answered = new Set(
    messages.flatMap((message) =>
      ToolMessage.isInstance(message) ? [message.tool_call_id] : [],
    ),
  );

  const repaired: BaseMessage[] = [];
  let inserted = false;
  for (const message of messages) {
    repaired.push(message);
    if (!AIMessage.isInstance(message)) continue;
    for (const call of message.tool_calls ?? []) {
      if (call.id === undefined || answered.has(call.id)) continue;
      inserted = true;
      repaired.push(
        new ToolMessage({
          tool_call_id: call.id,
          name: call.name,
          content: abandonedText(call.name),
          status: "error",
        }),
      );
    }
  }

  // The common case by far, and worth keeping cheap: an untouched view is the
  // same array, not a copy of it.
  return inserted ? repaired : messages;
}

/**
 * How large the next request will be, in tokens — **the request, not the view**.
 *
 * The distinction is the one this module exists to make askable, and it is not a
 * quibble. A request is the *resident segment* (system prompt plus tool
 * schemas, `CONTEXT.md`: 常驻段) plus the view. This function anchors on the
 * last `input_tokens` the provider reported, and that number includes the
 * resident segment; {@link planCut} walks the message array and does not.
 *
 * So the two are not two rulers disagreeing — they measure two different
 * things, and the gap between them is a constant nobody had named. Measured
 * against the real provider: with a 4,000-token limit this returned 4,483 while
 * `planCut` refused to cut, because roughly 2,400 of that was resident and the
 * messages alone had not reached the retention budget. In production the
 * resident segment is 0.2% of the window and the gap is invisible.
 *
 * **Left as it is on purpose.** Making the resident segment an explicit
 * parameter is the correct end state and would change *when* summaries fire —
 * that is a production behaviour change, and this repository decides those from
 * observations rather than from arguments. `docs/adr/0004` records it as a debt
 * with a trigger. `pi` has already arrived at the split, for reference:
 * `shouldCompact(contextTokens, contextWindow, settings)` takes both numbers as
 * parameters, and `getLastAssistantUsage` / `estimateContextTokens` are two
 * separately exported functions.
 *
 * Anchoring on a real number is itself the point: characters-per-token is not a
 * constant (measured between 5.84 and 1.64 across two kinds of filler, while the
 * estimator assumes a flat 4), so counting from the last true figure shrinks the
 * error from "wrong about everything" to "wrong about the last message or two".
 */
export function requestTokens(history: BaseMessage[], cut: Cut): number {
  const visible = project(history, cut);
  for (let index = visible.length - 1; index >= 0; index -= 1) {
    const message = visible[index];
    if (!AIMessage.isInstance(message)) continue;
    // A quarantined cast, one of three of the same defect: `usage_metadata` is
    // declared through the generic message-structure machinery and collapses to
    // `undefined` when the structure parameter is left at its default, so the
    // compiler believes the field can never hold a value. It does. See the same
    // note in usage.ts and agents/loop.ts, and retry all three on the next
    // @langchain/core bump; verified needed against 1.2.5.
    const usage = message.usage_metadata as { input_tokens?: number } | undefined;
    if (typeof usage?.input_tokens === "number") {
      return usage.input_tokens + estimate(visible.slice(index));
    }
  }
  return estimate(visible);
}

/**
 * Where to cut so the tail is about `keepTokens`, or `null` when cutting would
 * not help.
 *
 * **`null` is the point of this signature.** The same state used to be an
 * anonymous `if (next > cutoff)` at two call sites, and "over the threshold but
 * nothing can be cut" was a branch with no name and no test — while being a
 * state the program reaches in real life: measured against the provider on a
 * small window, where the resident segment pushed {@link requestTokens} past the
 * trigger while the messages themselves still fitted the retention budget. A
 * named return makes the adapter say what it does about it.
 *
 * The returned index never moves backwards past `cut.at`: a cut only ever
 * advances, so a recomputation cannot un-summarise something.
 */
export function planCut(
  history: BaseMessage[],
  cut: Cut,
  keepTokens: number,
): number | null {
  let total = 0;
  let raw = history.length;
  for (let index = history.length - 1; index >= cut.at; index -= 1) {
    const message = history[index];
    if (message === undefined) continue;
    total += estimate([message]);
    if (total > keepTokens) break;
    raw = index;
  }

  const safe = pairSafe(history, raw, cut.at);
  return safe > cut.at ? safe : null;
}

/**
 * Moves a cut so it does not land between a tool call and its results.
 *
 * The constraint is the provider's, not a preference: an assistant message with
 * `tool_calls` must be followed by a result for each one, and a result with no
 * call ahead of it is rejected outright. Cutting inside a batch of results
 * strands them, so the cut moves back to the message that issued them and the
 * whole exchange goes into the summarised side.
 */
function pairSafe(history: BaseMessage[], raw: number, floor: number): number {
  const at = history[raw];
  if (at === undefined || !ToolMessage.isInstance(at)) return raw;

  const orphaned = new Set<string>();
  for (let index = raw; index < history.length; index += 1) {
    const message = history[index];
    if (message === undefined || !ToolMessage.isInstance(message)) break;
    orphaned.add(message.tool_call_id);
  }

  for (let index = raw - 1; index >= floor; index -= 1) {
    const message = history[index];
    if (!AIMessage.isInstance(message)) continue;
    if (
      message.tool_calls?.some((call) => call.id !== undefined && orphaned.has(call.id))
    ) {
      return index;
    }
  }

  // No issuing message in range — the results are already orphans, so keeping
  // them changes nothing. Move past them instead of cutting into the batch.
  let index = raw;
  while (index < history.length && ToolMessage.isInstance(history[index])) index += 1;
  return index;
}

/**
 * The longest tail of `messages` that fits in `budget` estimated tokens.
 *
 * The second projection in this file, and it belongs here for the same reason
 * the first does: summarising is a model call, so "what does *it* see" is the
 * same question under a different rule — the tail within a budget, with no cut
 * and no pins. Leaving it in the adapter would have left the adapter holding
 * half a projection.
 */
export function tailWithin(messages: BaseMessage[], budget: number): BaseMessage[] {
  let total = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) continue;
    total += estimate([message]);
    if (total > budget) return messages.slice(index + 1);
  }
  return messages;
}

/**
 * Four characters to the token, the same rule the framework's own estimator
 * uses — and wrong by up to 3.6x either way depending on what the text is. It is
 * only ever applied to the newest messages, and the 20% margin below the window
 * limit exists because of it.
 */
export function estimate(messages: BaseMessage[]): number {
  let characters = 0;
  for (const message of messages) {
    characters +=
      typeof message.content === "string"
        ? message.content.length
        : JSON.stringify(message.content).length;
    if (AIMessage.isInstance(message) && message.tool_calls?.length) {
      characters += JSON.stringify(message.tool_calls).length;
    }
  }
  return Math.ceil(characters / 4);
}
