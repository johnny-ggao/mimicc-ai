import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { createMiddleware, type AnyAgentMiddleware } from "langchain";

import { clamp, WRAP_UP_ROOM_MS } from "../deadline";

import { hintInjector } from "./hint";
import type { TurnCapReason } from "./loopguard";

/**
 * The work budget on the token/time axis.
 *
 * ## Why this exists instead of a step budget
 *
 * The step axis is gone, deliberately (turn-budget ticket 01, and the survey in
 * external-bench ticket 03): the peers do not budget steps. pi's drive loop is
 * `while (true)` — the model decides how long a turn is; deepseek-harness runs
 * `while (await this.turn())` until the model completes or hits max-tokens;
 * deer-flow keeps one recursion ceiling as a crash net, not a work budget. A
 * step budget misclassifies a healthy-busy turn as broken — csv-to-parquet
 * burned 17, then 25 honest tool-call laps on a hard task and got cut mid-fix
 * three times (48 → 102 → 150 nodes). No step number settles that: the model's
 * work simply takes as many laps as it takes.
 *
 * What bounds a turn instead is **cost**: every lap re-reads the view, so a
 * turn's cumulative input tokens are its true price, and wall-clock is the
 * backstop for the pathological case that spins without spending tokens. The
 * budget here is per **turn** — reset in `beforeAgent` — and the default
 * (window × 4) is derived rather than guessed, so it scales with the context
 * window instead of being re-tuned per task.
 *
 * ## Exhaustion is a warning, then a stop — not a kill
 *
 * Same two-phase shape as loopGuard: crossing the budget queues a one-shot
 * note for the next model call ("hand in your answer, no more tools"); the
 * model gets that one chance, DSH-style, to end the turn naturally. Only if it
 * keeps calling tools is the message stripped and a canned final answer forced
 * (`onCap("budget_exhausted")`) — recorded as a structured observable rather
 * than thrown, so `classify` keeps treating it like loopGuard's loop_capped.
 */

export const BUDGET_WARNING =
  "[budget warning] This turn's token/time budget is exhausted. " +
  "Do not call more tools — produce your final answer with what you have.";

export const BUDGET_FORCED_STOP =
  "[FORCED STOP] Turn budget exhausted. Producing final answer with results collected so far.";

export interface TurnBudgetOptions {
  /** Cumulative input tokens allowed per turn. Includes cache reads (usage.ts semantics). */
  tokenBudget: number;
  /** Wall-clock budget per turn, in milliseconds. */
  timeBudgetMs: number;
  /** Injectable clock. Tests only. */
  now?: () => number;
  /** Reports the cap, same channel as loopGuard's loop_capped. */
  onCap?: (reason: TurnCapReason) => void;
}

/** How many input tokens one model call consumed, or 0 when the reply carries none. */
function inputTokensOf(message: BaseMessage): number {
  const usage = (message as { usage_metadata?: { input_tokens?: number } })
    .usage_metadata;
  return usage?.input_tokens ?? 0;
}

export function turnBudget(options: TurnBudgetOptions): AnyAgentMiddleware {
  const now = options.now ?? Date.now;
  let tokens = 0;
  let started = 0;
  let timeBudgetMs = options.timeBudgetMs;
  let flagged = false;
  const inject = hintInjector();

  return createMiddleware({
    name: "TurnBudget",
    beforeAgent: () => {
      tokens = 0;
      started = now();
      // 🔑 **这个预算也是内层的钟**（ADR 0010）。有总闸的时候（`--print`），配置里那个
      // 十分钟可能比整次调用剩下的时间还长——那样它就永远轮不到响，而**轮不到响的预算
      // 意味着交不出答案**：总闸到点是硬停，按定义没有最终答案。夹到「剩余 − 收尾余地」
      // 之后，两段式还来得及走完，模型交得出手里已有的东西。
      // ⚠️ 每回合重算，不是构造时算一次：剩余时间每一回合都在变。
      timeBudgetMs = clamp(options.timeBudgetMs, WRAP_UP_ROOM_MS, now()).ms ?? 0;
      flagged = false;
      inject.reset();
    },
    // Accumulate first, deliver hints second: the hint must ride the *next*
    // call, while the tokens spent on this one must already count when
    // afterModel checks the budget.
    wrapModelCall: (request, handler) =>
      inject.wrapModelCall(request, async (innerRequest) => {
        const result = await handler(innerRequest);
        tokens += inputTokensOf(result);
        return result;
      }),
    afterModel: (state: { messages?: BaseMessage[] }) => {
      const last = state.messages?.[state.messages.length - 1];
      if (last === undefined || !AIMessage.isInstance(last)) return;

      const hasCalls = (last.tool_calls ?? []).length > 0;
      const over = tokens > options.tokenBudget || now() - started > timeBudgetMs;

      if (flagged && hasCalls) {
        options.onCap?.("budget_exhausted");
        const content =
          (typeof last.content === "string" ? last.content : "") +
          "\n\n" +
          BUDGET_FORCED_STOP;
        const additional_kwargs = Object.fromEntries(
          Object.entries(last.additional_kwargs ?? {}).filter(
            ([key]) => key !== "tool_calls" && key !== "function_call",
          ),
        );
        return {
          messages: [
            new AIMessage({
              ...(last.id !== undefined ? { id: last.id } : {}),
              content,
              additional_kwargs,
            }),
          ],
        };
      }

      if (over && hasCalls) {
        flagged = true;
        inject.queue(BUDGET_WARNING);
      }
      return;
    },
  }) as AnyAgentMiddleware;
}
