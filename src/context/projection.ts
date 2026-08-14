import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";

/**
 * The projection: conversation history in, context window out.
 *
 * ## The two words, and why they are two
 *
 * **The view** (`CONTEXT.md`: 上下文窗口) is the noun — the `BaseMessage[]` the
 * model actually receives on one request. **The projection** is the verb: the
 * function that computes it. Four inputs, one output, no side effects and no
 * framework:
 *
 * ```
 * (history, cut, pins) ──project──▶ view
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
 * thread still reads back whole from disk; a second summary recomputes the cut
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
 * thread files written before this refactor contain them. The adapter builds a
 * `Cut` at the boundary. A value object here and two keys on disk is the right
 * way round: the interface can be designed, the file format is already spent.
 */
export interface Cut {
  /** Index into the history. Everything before it is represented by `summary`. */
  at: number;
  /** Stands in for what precedes `at`. Absent means nothing has been cut yet. */
  summary?: BaseMessage | undefined;
}

/**
 * What the model is sent: the pinned messages, the summary, then everything
 * after the cut.
 *
 * `pins` is a list of message ids and comes from the caller — it used to be one
 * hard-coded id in here, which was the only edge in the module graph that
 * crossed from this feature into another. The projection has no business knowing
 * that a thing called "project instructions" exists; it only needs to know which
 * ids must survive a cut. Whoever injects a resident message is the one who
 * knows it has to be pinned, and now says so.
 *
 * Why pinning is needed at all, which is easy to get wrong: a resident message
 * is injected under a fixed id, and `messagesStateReducer` merges by id —
 * replacing **in place**, keeping position. So it never moves from its original
 * index near the front, which means it sits before every cut that will ever be
 * made and would silently drop out of the view. Re-injecting each turn does not
 * help; only rebuilding the view can.
 */
export function project(
  history: BaseMessage[],
  cut: Cut,
  pins: readonly string[],
): BaseMessage[] {
  if (cut.at <= 0 || cut.summary === undefined) return history;

  const pinned = history.filter(
    (message, index) =>
      index < cut.at && message.id !== undefined && pins.includes(message.id),
  );
  return [...pinned, cut.summary, ...history.slice(cut.at)];
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
export function requestTokens(
  history: BaseMessage[],
  cut: Cut,
  pins: readonly string[],
): number {
  const visible = project(history, cut, pins);
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
