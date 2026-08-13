import { ContextOverflowError } from "@langchain/core/errors";
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  getBufferString,
  type BaseMessage,
} from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { Command } from "@langchain/langgraph";
import { createMiddleware, type AnyAgentMiddleware } from "langchain";
import { z } from "zod";

import { PROJECT_INSTRUCTIONS_ID } from "./instructions";

/**
 * The context window, computed rather than carved out of the history.
 *
 * ## The distinction this file exists to hold
 *
 * **Conversation history** is the original: every message of this thread, kept
 * whole, in the checkpointer. **The context window** is what the model sees on
 * one request — a view derived from that history. They are two things, and both
 * stock mechanisms for staying under a token limit confuse them: one edits the
 * message array in place, the other returns "delete everything, here is a
 * summary". Both destroy the original to shrink the view.
 *
 * This one stores two private facts — where the cut is, and the summary that
 * stands in for what precedes it — and rebuilds the view on every model call.
 * `state.messages` is never shortened. Once the original is safe, summarising
 * stops being a lossy operation on the record and becomes what it should have
 * been: a projection.
 *
 * ## Why it hangs off wrapModelCall, and what actually makes it reversible
 *
 * Being on `wrapModelCall` is not what makes this safe — `contextEditingMiddleware`
 * is on the same hook and is permanent. The difference is one line: it does
 * `messages[i] = …`, and `request.messages` *is* `state.messages`, the same array
 * (nodes/AgentNode.js:331). This one builds a new array and passes that along, so
 * state is untouched. **In-place versus a new array is the whole of it; the hook
 * is not.**
 *
 * ## The numbers, and why they are what they are
 *
 * The window is 1,048,576 tokens — measured, from the provider's own refusal,
 * not the "1M" the pricing table rounds to. Summarising starts at 80% of it. The
 * missing 20% is not waste: it is margin against our own arithmetic, and the
 * margin has to be generous because characters-per-token is not a constant.
 * Measured across two kinds of filler it ranged from 5.84 to 1.64 — a factor of
 * 3.6 — while the estimator everything uses assumes a flat 4.
 *
 * Which is also why the token count here is a hybrid: the last real
 * `input_tokens` the provider reported, plus an estimate of only what has been
 * added since. Anchoring on a true number shrinks the error from "3.6x on
 * everything" to "3.6x on the last message or two".
 */

/** Measured, from the provider's refusal string. Not the rounded figure. */
export const WINDOW_LIMIT = 1_048_576;

/** Fraction of the window at which summarising starts. */
export const TRIGGER_FRACTION = 0.8;

/** Fraction of the window kept as recent context after a summary. */
export const KEEP_FRACTION = 0.3;

/**
 * Ceiling on how much history is fed to the summarising call.
 *
 * Without it, one summary of a nearly-full window would itself be a
 * near-full-window request. What falls outside the ceiling is dropped from the
 * summary — and is still in the thread file, which is the whole reason that file
 * exists. Recency is what a summary is for, so the ceiling keeps the tail.
 */
export const SUMMARY_INPUT_TOKENS = 100_000;

const SUMMARY_PROMPT = `You are compacting a coding session so it can continue in a smaller context.

Write a summary of the conversation below. Include, in this order:

1. What the user is trying to achieve, in their own terms.
2. Decisions already made, and the reason for each.
3. Files inspected or changed, with paths, and what changed in them.
4. What was in progress when the conversation was cut, and the immediate next step.

Be specific. Paths, identifiers and exact values are worth more than description.
Do not include pleasantries, and do not address the user. Write only the summary.

<conversation>
{conversation}
</conversation>`;

/** Marks the message that stands in for everything before the cut. */
export const SUMMARY_SOURCE = "context-window";

export interface ContextWindowOptions {
  /**
   * The model that writes summaries. The same one the agent runs on: this is a
   * single-model program, and a summary decides what every later turn can see,
   * which is a poor place to economise.
   */
  model: BaseChatModel;
  /** Overridable so a test can trigger a summary without producing 800k tokens. */
  limit?: number;
  triggerFraction?: number;
  keepFraction?: number;
  summaryInputTokens?: number;
  /** Told about every summary, and every failure to produce one. */
  onEvent?: (event: WindowEvent) => void;
}

export type WindowEvent =
  | {
      type: "summarized";
      reason: "threshold" | "overflow";
      before: number;
      kept: number;
    }
  | { type: "summary_failed"; reason: "threshold" | "overflow"; error: string };

/** Private state. The leading underscore keeps it out of the agent's input and output. */
const stateSchema = z.object({
  _windowCutoff: z.number().optional(),
  _windowSummary: z.custom<BaseMessage>().optional(),
});

interface WindowState {
  _windowCutoff?: number | undefined;
  _windowSummary?: BaseMessage | undefined;
  messages: BaseMessage[];
}

export function contextWindow(options: ContextWindowOptions): AnyAgentMiddleware {
  const limit = options.limit ?? WINDOW_LIMIT;
  const trigger = Math.floor(limit * (options.triggerFraction ?? TRIGGER_FRACTION));
  const keep = Math.floor(limit * (options.keepFraction ?? KEEP_FRACTION));
  const summaryInput = options.summaryInputTokens ?? SUMMARY_INPUT_TOKENS;
  const report = options.onEvent ?? (() => {});

  async function summarize(
    history: BaseMessage[],
    reason: "threshold" | "overflow",
  ): Promise<BaseMessage | undefined> {
    const trimmed = tailWithin(history, summaryInput);
    const prompt = SUMMARY_PROMPT.replace("{conversation}", getBufferString(trimmed));
    try {
      const reply = await options.model.invoke([new HumanMessage(prompt)]);
      return new HumanMessage({
        content: `Summary of the earlier part of this conversation:\n\n${reply.text}`,
        additional_kwargs: { lc_source: SUMMARY_SOURCE },
      });
    } catch (error) {
      // Not fatal on the normal path: the threshold leaves 20% of the window
      // spare, so this request still fits and the next lap tries again. The
      // alternative — dropping the oldest messages without summarising — would
      // lose context silently, which this program does not do anywhere.
      report({ type: "summary_failed", reason, error: String(error) });
      return undefined;
    }
  }

  return createMiddleware({
    name: "ContextWindow",
    stateSchema,
    wrapModelCall: async (request, handler) => {
      const state = request.state as WindowState;
      const history = request.messages ?? [];
      let cutoff = state._windowCutoff ?? 0;
      let summary = state._windowSummary;
      let changed = false;

      if (used(history, cutoff, summary) >= trigger) {
        const next = chooseCutoff(history, cutoff, keep);
        if (next > cutoff) {
          const fresh = await summarize(history.slice(0, next), "threshold");
          if (fresh !== undefined) {
            report({
              type: "summarized",
              reason: "threshold",
              before: history.length,
              kept: history.length - next,
            });
            cutoff = next;
            summary = fresh;
            changed = true;
          }
        }
      }

      try {
        const response = await handler({
          ...request,
          messages: view(history, cutoff, summary),
        });
        return changed ? update(response, cutoff, summary) : response;
      } catch (error) {
        // The threshold is defended by an estimate, and the estimate can be
        // several times wrong — so the line does get crossed. Catching it turns
        // a hard failure into a slow turn. Once, though: a second failure means
        // summarising did not help, and pretending otherwise burns money on a
        // request that cannot succeed.
        if (!isOverflow(error)) throw error;

        // Cut harder than the threshold would. Reaching here means the estimate
        // was wrong, possibly by several times — so re-applying the same
        // retention budget trusts the number that just failed, and on a turn
        // that already summarised it computes the identical cut and makes no
        // progress at all. When even a quarter of the budget cannot move the
        // cut, there is nothing left to summarise and the failure is honest.
        const next = chooseCutoff(history, cutoff, Math.max(1, Math.floor(keep / 4)));
        const fresh =
          next > cutoff
            ? await summarize(history.slice(0, next), "overflow")
            : undefined;
        if (fresh === undefined) throw error;

        report({
          type: "summarized",
          reason: "overflow",
          before: history.length,
          kept: history.length - next,
        });
        const response = await handler({
          ...request,
          messages: view(history, next, fresh),
        });
        return update(response, next, fresh);
      }
    },
  }) as AnyAgentMiddleware;
}

/**
 * What the model is sent: the repository's instructions, the summary, then
 * everything after the cut.
 *
 * The instructions have to be pinned here, and the reason is easy to get wrong.
 * They are injected under a fixed id, and `messagesStateReducer` merges by id —
 * replacing **in place**, keeping position. So the message never moves from its
 * original index near the front, which means it sits before every cut that will
 * ever be made and would silently drop out of the view. Re-injecting each turn
 * does not help; only rebuilding the view can.
 */
function view(
  history: BaseMessage[],
  cutoff: number,
  summary: BaseMessage | undefined,
): BaseMessage[] {
  if (cutoff <= 0 || summary === undefined) return history;

  const pinned = history.find(
    (message, index) => index < cutoff && message.id === PROJECT_INSTRUCTIONS_ID,
  );
  return [...(pinned ? [pinned] : []), summary, ...history.slice(cutoff)];
}

function update(
  response: unknown,
  cutoff: number,
  summary: BaseMessage | undefined,
): Command {
  // A Command rather than the response itself, because the state update is the
  // point. The reply is not lost: AgentNode keeps the model's message separately
  // and appends it whatever this hook returns (nodes/AgentNode.js:94-105).
  void response;
  return new Command({ update: { _windowCutoff: cutoff, _windowSummary: summary } });
}

/**
 * Tokens in the request we are about to make.
 *
 * The anchor is the last `input_tokens` the provider actually reported, which is
 * sitting on the most recent AI message — it is the only number here that is not
 * a guess. Everything after that message is estimated. When there is no anchor
 * yet (the first call of a thread) the whole view is estimated.
 */
function used(
  history: BaseMessage[],
  cutoff: number,
  summary: BaseMessage | undefined,
): number {
  const visible = view(history, cutoff, summary);
  for (let index = visible.length - 1; index >= 0; index -= 1) {
    const message = visible[index];
    if (!AIMessage.isInstance(message)) continue;
    // The third quarantined cast of the same defect: `usage_metadata` is
    // declared through the generic message-structure machinery and collapses to
    // `undefined` when the structure parameter is left at its default, so the
    // compiler believes the field can never hold a value. It does. See the same
    // note in usage.ts and agent.ts, and retry all three on the next
    // @langchain/core bump; verified needed against 1.2.5.
    const usage = message.usage_metadata as { input_tokens?: number } | undefined;
    if (typeof usage?.input_tokens === "number") {
      return usage.input_tokens + estimate(visible.slice(index));
    }
  }
  return estimate(visible);
}

/**
 * Four characters to the token, the same rule the framework's own estimator
 * uses — and wrong by up to 3.6x either way depending on what the text is. It is
 * only ever applied to the newest messages, and the 20% margin exists because of
 * it.
 */
function estimate(messages: BaseMessage[]): number {
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

/** The longest tail of `messages` that fits in `budget` estimated tokens. */
function tailWithin(messages: BaseMessage[], budget: number): BaseMessage[] {
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
 * Where to cut so that the tail is about `keep` tokens — moved, if necessary, so
 * it does not land between a tool call and its result.
 *
 * That constraint is the provider's, not a preference: an assistant message with
 * `tool_calls` must be followed by a result for each one, and a result with no
 * call ahead of it is rejected outright. Cutting inside a batch of results
 * strands them, so the cut moves back to the message that issued them and the
 * whole exchange goes into the summarised side.
 */
function chooseCutoff(history: BaseMessage[], current: number, keep: number): number {
  let total = 0;
  let raw = history.length;
  for (let index = history.length - 1; index >= current; index -= 1) {
    const message = history[index];
    if (message === undefined) continue;
    total += estimate([message]);
    if (total > keep) break;
    raw = index;
  }
  return safeCutoff(history, raw, current);
}

function safeCutoff(history: BaseMessage[], raw: number, floor: number): number {
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
 * Whether this failure is the window being exceeded.
 *
 * The provider says so in prose, and the framework recognises it by matching
 * four hard-coded phrases written for a different vendor. That this repository's
 * provider happens to hit one of them (`maximum context length`) was verified
 * rather than assumed — the same shortcut has cost this project four times
 * elsewhere. The cause chain is walked because middleware wraps errors on the
 * way out.
 */
function isOverflow(error: unknown): boolean {
  let current: unknown = error;
  for (
    let depth = 0;
    depth < 10 && current !== undefined && current !== null;
    depth += 1
  ) {
    if (ContextOverflowError.isInstance(current)) return true;
    current =
      typeof current === "object" && "cause" in current ? current.cause : undefined;
  }
  return false;
}
