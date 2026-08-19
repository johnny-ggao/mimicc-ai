import type { BaseMessage, UsageMetadata } from "@langchain/core/messages";
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
/**
 * Tokens, in four buckets that do not overlap.
 *
 * The shape is borrowed from DeepSeek's own harness (`dsh`), whose type carries
 * the warning that makes it worth borrowing —
 * `packages/llm/llm/src/types.ts:130-131`: *Counts are **DISJOINT**:
 * `inputTokens` is uncached input only*. **langchain's convention is the
 * opposite**: `input_tokens` is the whole prompt and
 * `input_token_details.cache_read` is a slice of it (`@langchain/core`
 * `messages/metadata.d.ts:34-52`: *Breakdown of input token counts. Does not
 * need to sum to full input token count*).
 *
 * Getting that wrong is not a naming problem, it is a numbers problem: add one
 * provider's `input` to another's and the cached tokens are counted once or
 * twice depending on which library reported them. So the buckets here are
 * disjoint by construction, and `uncachedInput` is stated as what it is —
 * *input the provider did not tell us was cached* — because the breakdown is
 * allowed to be incomplete.
 *
 * No money. We run against several providers and their price lists are theirs,
 * not ours: tokens are the part we can count exactly. pi carries a `cost` block
 * (`packages/ai/src/types.ts:380-387`) and can, because it owns a price table;
 * `dsh` counts tokens only, and that is the side of the fence we are on.
 */
export interface Spend {
  /** Input the provider did not report as cached. */
  uncachedInput: number;
  output: number;
  /** Input served from the provider's cache — the column the scale exists for. */
  cacheRead: number;
  /** Input written *into* the cache. Reported by Anthropic-shaped providers; 0 elsewhere. */
  cacheWrite: number;
}

export function noSpend(): Spend {
  return { uncachedInput: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

/** Splits one langchain usage report into the four disjoint buckets. */
export function bucketsOf(usage: UsageMetadata | undefined): Spend {
  if (usage === undefined) return noSpend();
  const cacheRead = usage.input_token_details?.cache_read ?? 0;
  const cacheWrite = usage.input_token_details?.cache_creation ?? 0;
  return {
    // Clamped, because the breakdown is documented as not necessarily summing:
    // a provider that reports more cache than input would otherwise go negative.
    uncachedInput: Math.max(0, usage.input_tokens - cacheRead - cacheWrite),
    output: usage.output_tokens,
    cacheRead,
    cacheWrite,
  };
}

/**
 * What one message paid for, keyed by the model that was paid.
 *
 * Two shapes, and the second one is the reason this is shared rather than
 * written twice: an assistant message carries its own `usage_metadata`, while a
 * dispatch's cost rides on the **tool result** — the subagent's messages are
 * never stored, so `tools/task.ts` puts an already-split map there instead.
 * Anything that adds up a conversation has to know both, and knowing them in one
 * place is how the two stay in step.
 */
export function creditsOf(message: BaseMessage): [string, Spend][] {
  const usage = (message as { usage_metadata?: UsageMetadata }).usage_metadata;
  const metadata = (message as { response_metadata?: Record<string, unknown> })
    .response_metadata;

  if (usage !== undefined) {
    const label = metadata?.["model"];
    return [
      [typeof label === "string" && label !== "" ? label : "unknown", bucketsOf(usage)],
    ];
  }

  const dispatched = metadata?.["usage"];
  if (dispatched === null || typeof dispatched !== "object") return [];
  return Object.entries(dispatched as Record<string, Spend>).map(([model, spend]) => [
    model,
    spend,
  ]);
}

export function addSpend(total: Spend, next: Spend): void {
  total.uncachedInput += next.uncachedInput;
  total.output += next.output;
  total.cacheRead += next.cacheRead;
  total.cacheWrite += next.cacheWrite;
}

export interface ModelUsage {
  /**
   * Who made this request: a kind's identity — `"main"` for the agent,
   * `"explore"` for a dispatch — or `` `${identity} summary` `` for the call
   * that compacts that kind's window.
   *
   * Every one of those is derived from the kind's single identity in
   * `src/agents/kinds.ts`, which is why there is no bare `"summary"` in this column any
   * more: an unattributed label is exactly where a second kind's spending would
   * have gone to hide.
   *
   * Without this field the log is a single column of numbers from several
   * different spenders, and the one question worth asking of it — what did
   * dispatching three explore agents actually cost — cannot be asked at all.
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
  model: string,
  report: (usage: ModelUsage) => void,
): AnyAgentMiddleware {
  return createMiddleware({
    name: "UsageMeter",
    wrapModelCall: async (request, handler) => {
      const startedAt = Date.now();
      const response = await handler(request);
      const elapsedMs = Date.now() - startedAt;

      // ⚠️ **Which model spent this is not on the message otherwise.** Measured
      // on this repository's own history: a stored assistant message carries
      // `response_metadata.model_provider`, and its value is `"openai"` for
      // every one of them — we reach DeepSeek and Moonshot alike through an
      // OpenAI-compatible endpoint, so the provider label says nothing. The
      // model id does reach `generationInfo` (`agents/model.ts`), but that is
      // not `response_metadata` and does not survive into state.
      //
      // Without it a session's totals are a sum across whatever models it
      // happened to use — and that is reachable today, not hypothetical:
      // change `LLM_MODEL`, `--resume` an older session, and its ledger mixes
      // two providers' tokens into one number that means nothing.
      //
      // ⚠️ **This is the id we asked for, not the one that answered.** pi prefers
      // the response's own (`responseModel ?? model`), which is the more truthful
      // of the two when an alias resolves to a dated build. Ours is not reachable
      // here: the provider's model name lands in `generationInfo`
      // (`agents/model.ts`) and never joins `response_metadata`, so preferring it
      // would mean another change inside the surgical copy of langchain's
      // streaming path. Recorded as an approximation rather than left unrecorded.
      (response as { response_metadata?: Record<string, unknown> }).response_metadata =
        {
          ...(response as { response_metadata?: Record<string, unknown> })
            .response_metadata,
          model,
        };

      const usage = usageOf(response);
      // A provider that returns no usage is a broken scale, not a free call —
      // report zeroes rather than staying silent, so the gap is visible in the
      // log instead of looking like the model was never called.
      report({
        agent,
        messages: request.messages.length,
        inputTokens: usage?.input_tokens ?? 0,
        outputTokens: usage?.output_tokens ?? 0,
        cacheRead: cacheReadOf(response),
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

/**
 * Input tokens the provider served from its prefix cache, in one place.
 *
 * Two providers, two spellings of the same number:
 *
 * - OpenAI's `prompt_tokens_details.cached_tokens` — what `@langchain/openai`
 *   maps into `usage_metadata.input_token_details.cache_read`, and what DeepSeek
 *   fills in.
 * - Moonshot's top-level `usage.cached_tokens` — which the mapper drops. It rides
 *   through untouched on the chunk's `response_metadata.usage`, but only on the
 *   streaming path (the non-streaming branch never attaches it — see the note in
 *   `usageMeter` above).
 *
 * The fallback to `cached_tokens` is what keeps the scale honest for Moonshot;
 * without it every Moonshot request would report `cacheRead: 0`, and the one
 * number this file exists for would silently lie. The non-streaming summary call
 * cannot reach Moonshot's field, so its `cacheRead` stays 0 there — a known gap,
 * not a silent one.
 */
export function cacheReadOf(message: unknown): number {
  const mapped = usageOf(message)?.input_token_details?.cache_read;
  if (mapped !== undefined && mapped !== null) return mapped;
  const raw = (
    message as { response_metadata?: { usage?: { cached_tokens?: number } } }
  ).response_metadata?.usage;
  return raw?.cached_tokens ?? 0;
}
