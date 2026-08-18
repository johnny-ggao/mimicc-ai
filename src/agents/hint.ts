import { HumanMessage } from "@langchain/core/messages";
import type { AnyAgentMiddleware } from "langchain";

/**
 * The one-shot hint delivery every guard shares.
 *
 * loopGuard, stallGuard and emptyReplyGuard each detect a different bad pattern
 * (a repeated tool-call set, a run of failed calls, an empty final reply), but
 * they all deliver the warning the same way: queue it once, inject it as a
 * HumanMessage on the next model call, then forget it. The one-shot shape is
 * the invariant worth owning — a hint injected every lap would nag, and one
 * never cleared would leak into the next turn (ticket 04).
 *
 * Only the delivery half. Each guard keeps its own detection predicate (a
 * hash, a failure count, an empty-reply check); those do not share an
 * interface, which is why this is not a guard factory.
 */
export interface HintInjector {
  /** Queue a hint to be injected on the next model call. Last write wins. */
  queue(text: string): void;
  /** Clear the pending hint. Called from each guard's beforeAgent. */
  reset(): void;
  /** The wrapModelCall hook: inject the pending hint, once, then clear it. */
  wrapModelCall: NonNullable<AnyAgentMiddleware["wrapModelCall"]>;
}

export function hintInjector(): HintInjector {
  let pending: string | null = null;
  return {
    queue(text) {
      pending = text;
    },
    reset() {
      pending = null;
    },
    async wrapModelCall(request, handler) {
      if (pending === null) return handler(request);
      const text = pending;
      pending = null;
      return handler({
        ...request,
        messages: [...(request.messages ?? []), new HumanMessage(text)],
      });
    },
  };
}
