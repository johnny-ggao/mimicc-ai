import { ContextOverflowError } from "@langchain/core/errors";
import {
  HumanMessage,
  getBufferString,
  type BaseMessage,
} from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { Command } from "@langchain/langgraph";
import { createMiddleware, type AnyAgentMiddleware } from "langchain";
import { z } from "zod";

import { downgrade } from "./downgrade";
import {
  planCut,
  project,
  requestTokens,
  SUMMARY_SOURCE,
  tailWithin,
  type Cut,
} from "./projection";
import { cacheReadOf, usageOf, type ModelUsage } from "../usage";

/**
 * Keeping the context window under the limit, and everything that requires
 * touching the outside world.
 *
 * ## What this file is, now that it is not the projection
 *
 * `projection.ts` answers "what does the model see", as arithmetic over a list.
 * This file is the adapter around it: it watches the size, decides when to act,
 * calls the model to write a summary, reports what happened, writes the two
 * facts back to graph state, and catches the overflow the estimate failed to
 * predict. Everything here either performs I/O, touches langchain, or is a
 * decision about *when* — and none of it is a decision about *what*.
 *
 * ## Why it hangs off wrapModelCall, and what actually makes it reversible
 *
 * Being on `wrapModelCall` is not what makes this safe — `contextEditingMiddleware`
 * is on the same hook and is permanent. The difference is one line: it does
 * `messages[i] = …`, and `request.messages` *is* `state.messages`, the same array
 * (nodes/AgentNode.js:331). This one hands `project()`'s new array to the handler,
 * so state is untouched. **In-place versus a new array is the whole of it; the
 * hook is not.**
 *
 * ## The numbers, and why they are what they are
 *
 * The window is 1,048,576 tokens — measured, from the provider's own refusal,
 * not the "1M" the pricing table rounds to. Summarising starts at 80% of it. The
 * missing 20% is not waste: it is margin against our own arithmetic, and the
 * margin has to be generous because characters-per-token is not a constant
 * (measured between 5.84 and 1.64 while the estimator assumes a flat 4).
 *
 * ## The tests here stay slow on purpose
 *
 * Extracting the projection made half of this feature's tests cheap, and the
 * temptation that follows is to make the other half cheap too. Do not. Both bugs
 * this feature has actually shipped were in an adapter, not in arithmetic — a
 * subagent inheriting its parent's checkpointer, and the scale installed on the
 * wrong side of this middleware — and neither would have been caught by a pure
 * test, because in both cases the pure functions were correct. The tests below
 * go through a stub server because that is where the failures are.
 * `docs/adr/0004` records this as a consequence, not a preference.
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
 * summary — and is still in the session file, which is the whole reason that file
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

export interface ContextWindowOptions {
  /**
   * The model that writes summaries. The same one the agent runs on: this is a
   * single-model program, and a summary decides what every later turn can see,
   * which is a poor place to economise.
   */
  model: BaseChatModel;
  /**
   * Whose window this is — the same identity its meter is labelled with.
   *
   * Required, and that is the point. Every kind of agent installs this
   * middleware and each one summarises on its own account, so two things have
   * to carry a name: the summarising call, billed as `` `${agent} summary` ``,
   * and every event reported below. It used to be an optional `usageAgent`
   * defaulting to `"summary"`, and that default was the bug waiting to happen —
   * a second kind that forgot to pass it would have spent under the first one's
   * name, silently, with the log still looking well-formed.
   *
   * One field rather than two because an agent has one identity. Letting a
   * caller label its billing and its events differently is a way to lie that
   * nobody needs.
   */
  agent: string;
  /**
   * Message ids that must survive a cut, supplied by whoever installs this.
   *
   * The projection used to name one id itself — the only edge in the module
   * graph that reached from this feature into another. It is here now because
   * the place that *injects* a resident message is the place that knows it has
   * to be pinned, and that place is `agentStack`: it installs
   * `projectInstructions` and passes that message's id in the same breath. A
   * second kind of resident content costs an entry in a list rather than an edit
   * to the arithmetic.
   */
  /** Overridable so a test can trigger a summary without producing 800k tokens. */
  limit?: number;
  triggerFraction?: number;
  keepFraction?: number;
  summaryInputTokens?: number;
  /** Told about every summary, and every failure to produce one. */
  onEvent?: (event: WindowEvent) => void;
  /**
   * The working directory a downgraded result's pointer must be readable from.
   *
   * Defaults to the process's, which is what `tools/workspace.ts` resolves reads
   * against. Reachable only so a test can point it at a temp directory.
   */
  root?: string;
  /**
   * Told what the summarising call itself cost.
   *
   * Optional in the same way `onEvent` is, and wired up for the same reason: the
   * one request in this program that no middleware can see should not also be
   * the one nobody is told about.
   */
  onUsage?: (usage: ModelUsage) => void;
}

/**
 * The part of the options a caller is allowed to tune.
 *
 * Everything else — which model, whose window, where the events and the numbers
 * go — is decided by whoever assembles the stack, not by whoever configures it.
 * Named here rather than spelled out at each call site so the two kinds cannot
 * drift into permitting different things, which they had: the agent's version
 * of this Omit left `usageAgent` reachable and the subagents' did not.
 */
export type WindowTuning = Omit<
  ContextWindowOptions,
  "model" | "agent" | "onEvent" | "onUsage"
>;

/**
 * Every event carries `agent` for the same reason every usage record does
 * (`ModelUsage.agent`): more than one kind of agent reports into one log, and an
 * event you cannot attribute is an event you cannot act on.
 */
export type WindowEvent =
  | {
      type: "summarized";
      agent: string;
      reason: "threshold" | "overflow";
      before: number;
      kept: number;
    }
  | {
      type: "downgraded";
      agent: string;
      reason: "threshold" | "overflow";
      /** How many tool results were replaced. */
      results: number;
      /** Characters before and after, across those results alone. */
      before: number;
      after: number;
    }
  | {
      type: "summary_failed";
      agent: string;
      reason: "threshold" | "overflow";
      error: string;
    };

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
  const meter = options.onUsage ?? (() => {});
  // Derived here rather than handed in, because the summarising call happens in
  // this file (`options.model.invoke` below) and "my summary is billed under my
  // own name plus a word" is this middleware's own business. The stack passes
  // one identity down; nobody downstream gets to pick a second name.
  const meterAs = `${options.agent} summary`;
  const root = options.root ?? process.cwd();

  async function summarize(
    history: BaseMessage[],
    reason: "threshold" | "overflow",
  ): Promise<BaseMessage | undefined> {
    const trimmed = tailWithin(history, summaryInput);
    const prompt = SUMMARY_PROMPT.replace("{conversation}", getBufferString(trimmed));
    const startedAt = Date.now();
    try {
      const reply = await options.model.invoke([new HumanMessage(prompt)]);
      // Reported by hand because this call does not go through the agent: it is
      // `model.invoke` on the raw instance, so no middleware wraps it and the
      // meter never sees it. Left unreported it was the largest single request
      // the program can make — up to SUMMARY_INPUT_TOKENS — and the only one
      // absent from the log.
      meter({
        agent: meterAs,
        messages: 1,
        inputTokens: usageOf(reply)?.input_tokens ?? 0,
        outputTokens: usageOf(reply)?.output_tokens ?? 0,
        cacheRead: cacheReadOf(reply),
        reasoningTokens: usageOf(reply)?.output_token_details?.reasoning,
        elapsedMs: Date.now() - startedAt,
      });
      return new HumanMessage({
        content: `Summary of the earlier part of this conversation:\n\n${reply.text}`,
        additional_kwargs: { lc_source: SUMMARY_SOURCE },
      });
    } catch (error) {
      // Not fatal on the normal path: the threshold leaves 20% of the window
      // spare, so this request still fits and the next lap tries again. The
      // alternative — dropping the oldest messages without summarising — would
      // lose context silently, which this program does not do anywhere.
      report({
        type: "summary_failed",
        agent: options.agent,
        reason,
        error: String(error),
      });
      return undefined;
    }
  }

  /**
   * One attempt to move the cut forward, or nothing.
   *
   * `planCut` returning `null` is a real state and not an error: over the
   * trigger, yet no cut would make progress. It happens — measured against the
   * provider on a small window, where the resident segment counted by
   * `requestTokens` pushed the total past the line while the messages alone
   * still fitted the retention budget. The turn simply proceeds at its current
   * size, and no `summarized` event is reported, because none happened.
   */
  async function advance(
    history: BaseMessage[],
    cut: Cut,
    budget: number,
    reason: "threshold" | "overflow",
  ): Promise<Cut | undefined> {
    const at = planCut(history, cut, budget);
    if (at === null) return undefined;

    const summary = await summarize(history.slice(0, at), reason);
    if (summary === undefined) return undefined;

    report({
      type: "summarized",
      agent: options.agent,
      reason,
      before: history.length,
      kept: history.length - at,
    });
    return { at, summary };
  }

  /**
   * One pass of downgrading, reported if it did anything.
   *
   * Returns the same array when nothing was over the limit, so the common case
   * costs a walk and no allocation.
   */
  function shrink(
    history: BaseMessage[],
    reason: "threshold" | "overflow",
  ): BaseMessage[] {
    const { messages, downgraded } = downgrade(history, { root });
    if (downgraded.length === 0) return history;

    report({
      type: "downgraded",
      agent: options.agent,
      reason,
      results: downgraded.length,
      before: downgraded.reduce((sum, one) => sum + one.from, 0),
      after: downgraded.reduce((sum, one) => sum + one.to, 0),
    });
    return messages;
  }

  return createMiddleware({
    name: "ContextWindow",
    stateSchema,
    wrapModelCall: async (request, handler) => {
      const state = request.state as WindowState;
      let history = request.messages ?? [];
      // The persisted shape is two keys and has to stay that way — session files
      // written before the projection existed contain them. `Cut` is built at
      // this boundary and never leaves it.
      let cut: Cut = { at: state._windowCutoff ?? 0, summary: state._windowSummary };
      let changed = false;

      if (requestTokens(history, cut) >= trigger) {
        // Cheapest thing that shrinks a request, so it goes first: replacing a
        // 60KB file listing with a synopsis and a path costs one hash and no
        // model call. Only if that is still not enough is a summary worth
        // paying for.
        history = shrink(history, "threshold");

        if (requestTokens(history, cut) >= trigger) {
          const next = await advance(history, cut, keep, "threshold");
          if (next !== undefined) {
            cut = next;
            changed = true;
          }
        }
      }

      try {
        const response = await handler({
          ...request,
          messages: project(history, cut),
        });
        return changed ? update(response, cut) : response;
      } catch (error) {
        // The threshold is defended by an estimate, and the estimate can be
        // several times wrong — so the line does get crossed. Catching it turns
        // a hard failure into a slow turn. Once, though: a second failure means
        // summarising did not help, and pretending otherwise burns money on a
        // request that cannot succeed.
        if (!isOverflow(error)) throw error;

        // Maximum pressure, so take the free reduction here too — the estimate
        // that let this request out was wrong, and a synopsis is the one lever
        // that does not depend on it being right the second time.
        history = shrink(history, "overflow");

        // Cut harder than the threshold would. Reaching here means the estimate
        // was wrong, possibly by several times — so re-applying the same
        // retention budget trusts the number that just failed, and on a turn
        // that already summarised it computes the identical cut and makes no
        // progress at all. When even a quarter of the budget cannot move the
        // cut, there is nothing left to summarise and the failure is honest.
        const next = await advance(
          history,
          cut,
          Math.max(1, Math.floor(keep / 4)),
          "overflow",
        );
        if (next === undefined) throw error;

        const response = await handler({
          ...request,
          messages: project(history, next),
        });
        return update(response, next);
      }
    },
  }) as AnyAgentMiddleware;
}

/**
 * The state write, and why it is a Command.
 *
 * The reply is not lost: AgentNode keeps the model's message separately and
 * appends it whatever this hook returns (nodes/AgentNode.js:94-105). The two
 * keys are written separately rather than as one `Cut`, because session files
 * predating the projection contain them under these names.
 */
function update(response: unknown, cut: Cut): Command {
  void response;
  return new Command({
    update: { _windowCutoff: cut.at, _windowSummary: cut.summary },
  });
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
