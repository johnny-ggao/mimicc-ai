import type { UsageMetadata } from "@langchain/core/messages";
import { createMiddleware, type AnyAgentMiddleware } from "langchain";

/**
 * One model request's cost, in the only three numbers that matter here: what
 * went in, what came back, and how much of the input the provider had already
 * cached.
 *
 * `cacheRead` is the one this file exists for. Every context-engineering change
 * trades tokens against the cache prefix — a middleware that rewrites history to
 * save 2k tokens can lose a 20k prefix discount doing it — and that trade is
 * invisible without this field.
 */
export interface ModelUsage {
  /**
   * Who made this request: `"main"` for the agent, a subagent's kind for a
   * dispatch, `"summary"` for the call that compacts the window.
   *
   * Without it the log is a single column of numbers from three different
   * spenders, and the one question worth asking of it — what did dispatching
   * three explore agents actually cost — cannot be asked at all.
   */
  agent: string;
  /** Messages handed to the model on this call. Identifies the lap. */
  messages: number;
  inputTokens: number;
  outputTokens: number;
  /** Input tokens the provider served from its prefix cache. */
  cacheRead: number;
  /** Present when the model returns a native chain of thought, as DeepSeek v4 does. */
  reasoningTokens: number | undefined;
  elapsedMs: number;
}

/**
 * The scale.
 *
 * Nothing in the running program reported token cost before this: `logger.ts`
 * wrote one `repl_start` line with `systemPromptChars` and that was the whole of
 * it. Every later change to what goes into the context is supposed to be judged
 * on prompt tokens and cache hits, so the scale has to exist before the first
 * such change, not after.
 *
 * ## Why `wrapModelCall`
 *
 * It brackets exactly one request to the provider, so one call is one record and
 * nothing needs de-duplicating. The alternatives both make you work out what is
 * new: `afterModel` sees the whole state, and repl.ts's `values` events replay
 * the entire thread on every lap. It is also the only hook holding both sides of
 * the call, which is what makes `elapsedMs` honest.
 *
 * ## Why the numbers survive streaming
 *
 * The console runs `streamMode: ["messages", "values"]`, and usage normally
 * arrives only if the request opted in. It does: `_streamResponseChunks` calls
 * `invocationParams(options, { streaming: true })`, and that branch adds
 * `stream_options: { include_usage: true }`
 * (`@langchain/openai/dist/chat_models/completions.js:26,154`). The final chunk
 * then carries `usage_metadata`, and the accumulated `AIMessage` this hook
 * returns carries it too.
 *
 * ## Why `cacheRead` reaches us at all
 *
 * `@langchain/openai` maps exactly one field into the vendor-neutral shape:
 * `prompt_tokens_details.cached_tokens` becomes
 * `usage_metadata.input_token_details.cache_read` (same file, line 224). That is
 * OpenAI's spelling, and DeepSeek fills it on the compatible endpoint — measured,
 * not assumed.
 *
 * Measured alongside it: DeepSeek reports its own `prompt_cache_hit_tokens` and
 * `prompt_cache_miss_tokens` at the top level of `usage`, and the mapper drops
 * both. They are redundant with `cache_read` today, so nothing is lost — but if a
 * question ever needs them, the untouched provider object rides on the usage
 * chunk's `response_metadata.usage`, and only on the streaming path: the
 * non-streaming branch of that file never attaches it.
 */
export function usageMeter(
  agent: string,
  report: (usage: ModelUsage) => void,
): AnyAgentMiddleware {
  return createMiddleware({
    name: "UsageMeter",
    wrapModelCall: async (request, handler) => {
      const startedAt = Date.now();
      const response = await handler(request);
      const elapsedMs = Date.now() - startedAt;

      const usage = usageOf(response);
      // A provider that returns no usage is a broken scale, not a free call —
      // report zeroes rather than staying silent, so the gap is visible in the
      // log instead of looking like the model was never called.
      report({
        agent,
        messages: request.messages.length,
        inputTokens: usage?.input_tokens ?? 0,
        outputTokens: usage?.output_tokens ?? 0,
        cacheRead: usage?.input_token_details?.cache_read ?? 0,
        reasoningTokens: usage?.output_token_details?.reasoning,
        elapsedMs,
      });

      return response;
    },
  }) as AnyAgentMiddleware;
}

/**
 * The usage a provider reported on one reply, or undefined when it reported none.
 *
 * A quarantined cast, in one place rather than three. `usage_metadata` is
 * declared through the generic message-structure machinery —
 * `$InferMessageProperty<TStructure, "ai", "usage_metadata">`,
 * @langchain/core/dist/messages/ai.d.ts:15 — and with that structure parameter
 * left at its default the property collapses to `undefined`, so the compiler
 * believes the field can never hold a value. The runtime object is correct; the
 * declaration is not. Same defect class as the humanInTheLoopMiddleware cast in
 * agent.ts. Try deleting it on the next @langchain/core bump; verified needed
 * against 1.2.5.
 */
export function usageOf(message: unknown): UsageMetadata | undefined {
  return (message as { usage_metadata?: unknown }).usage_metadata as
    UsageMetadata | undefined;
}
