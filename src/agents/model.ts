import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import {
  AIMessage,
  AIMessageChunk,
  isAIMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import {
  ChatGenerationChunk,
  type ChatGeneration,
  type ChatResult,
} from "@langchain/core/outputs";
import {
  ChatOpenAI,
  ChatOpenAICompletions,
  convertMessagesToCompletionsMessageParams,
} from "@langchain/openai";

/**
 * Reasoning-model message echo, and the model class that carries it.
 *
 * ## The problem
 *
 * DeepSeek v4 and Moonshot's Kimi models both return a chain of thought in
 * `reasoning_content`, which langchain stores on the AIMessage as
 * `additional_kwargs.reasoning_content` (see the console, which renders it
 * dimmed). When the same message is sent back on the next lap — which is the
 * entire shape of this program, model → tool → model — the provider wants the
 * `reasoning_content` field echoed back on that assistant message.
 *
 * DeepSeek only insists when the assistant round carries a tool_call whose id it
 * did not itself sign, so the normal loop survives the omission. Moonshot is
 * stricter: `kimi-k3` / `kimi-k2.7-code` require the full assistant message back
 * unconditionally, and `kimi-k2.6` errors inside a tool loop when it is dropped
 * (`docs/research/moonshot-provider-facts.md` §5).
 *
 * `ChatOpenAI` drops the field on the way out. Its request-side message mapper,
 * `convertMessagesToCompletionsMessageParams`, forwards `name`, `function_call`,
 * `tool_calls` and `audio` and nothing else — `reasoning_content` never makes it
 * to the wire. This repository's README already records the consequence for
 * DeepSeek ("ChatOpenAI 发出去时会丢掉这个字段").
 *
 * ## The fix
 *
 * `ChatOpenAI` delegates its calls to a `completions` backend (an instance of
 * {@link ChatOpenAICompletions}), injected through the `completions` field. This
 * class subclasses that backend and re-attaches `reasoning_content` to each
 * assistant message after mapping, before the request goes out. The echo is
 * harmless for DeepSeek (it accepts the field on messages it signed) and fixes
 * the one case it currently fails.
 *
 * Two methods are overridden, both surgical copies of
 * `@langchain/openai@1.5.6` `ChatOpenAICompletions` with one change each:
 * `messagesMapped` is built through {@link attachReasoning} instead of the raw
 * converter. `_streamResponseChunks` covers the main agent (which streams);
 * `_generate`'s non-streaming branch covers subagents (run via `graph.invoke`).
 * `_generate`'s streaming branch is left to `super`, which already reaches this
 * class's `_streamResponseChunks`. `_streamChatModelEvents` (the `streamEvents`
 * path) is not used by this program and is not overridden.
 *
 * The alternative fixes were rejected: a `wrapModelCall` middleware only sees
 * `BaseMessage[]`, and the field is dropped *after* the middleware, inside the
 * model; and passing the echo out-of-band through `AsyncLocalStorage` or an
 * `options` side-channel is clever where this code prefers explicit.
 */

/**
 * Re-attaches `reasoning_content` to the assistant messages in a freshly mapped
 * request.
 *
 * The converter is one-to-one for every message type this program sends (string
 * content, no audio/multimodal splitting), so the mapped array lines up with the
 * input array by index. The lockstep stops rather than guesses if that ever
 * stops holding.
 */
function attachReasoning<T>(messages: BaseMessage[], mapped: T[]): T[] {
  const out = [...mapped];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    const param = out[i];
    if (message === undefined || param === undefined) break;
    if (!isAIMessage(message)) continue;
    const reasoning = message.additional_kwargs.reasoning_content;
    if (typeof reasoning === "string" && reasoning.length > 0) {
      const p = param as { role?: unknown } & Record<string, unknown>;
      if (p.role === "assistant") p.reasoning_content = reasoning;
    }
  }
  return out;
}

export class ReasoningEchoCompletions extends ChatOpenAICompletions {
  override async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    options.signal?.throwIfAborted();
    const params = this.invocationParams(options);

    if (params.stream) {
      // The streaming branch recomputes the mapping inside `_streamResponseChunks`,
      // which is this class's override — so `super` is already correct here.
      return super._generate(messages, options, runManager);
    }

    const usageMetadata: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
      input_token_details?: { audio?: number; cache_read?: number };
      output_token_details?: { audio?: number; reasoning?: number };
    } = {};
    const messagesMapped = attachReasoning(
      messages,
      convertMessagesToCompletionsMessageParams({ messages, model: this.model }),
    );
    const data = await this.completionWithRetry(
      { ...params, stream: false, messages: messagesMapped },
      { signal: options?.signal, ...options?.options },
    );
    const {
      completion_tokens: completionTokens,
      prompt_tokens: promptTokens,
      total_tokens: totalTokens,
      prompt_tokens_details: promptTokensDetails,
      completion_tokens_details: completionTokensDetails,
    } = data?.usage ?? {};
    if (completionTokens)
      usageMetadata.output_tokens =
        (usageMetadata.output_tokens ?? 0) + completionTokens;
    if (promptTokens)
      usageMetadata.input_tokens = (usageMetadata.input_tokens ?? 0) + promptTokens;
    if (totalTokens)
      usageMetadata.total_tokens = (usageMetadata.total_tokens ?? 0) + totalTokens;
    if (
      promptTokensDetails?.audio_tokens != null ||
      promptTokensDetails?.cached_tokens != null
    ) {
      usageMetadata.input_token_details = {
        ...(promptTokensDetails?.audio_tokens != null && {
          audio: promptTokensDetails?.audio_tokens,
        }),
        ...(promptTokensDetails?.cached_tokens != null && {
          cache_read: promptTokensDetails?.cached_tokens,
        }),
      };
    }
    if (
      completionTokensDetails?.audio_tokens != null ||
      completionTokensDetails?.reasoning_tokens != null
    ) {
      usageMetadata.output_token_details = {
        ...(completionTokensDetails?.audio_tokens != null && {
          audio: completionTokensDetails?.audio_tokens,
        }),
        ...(completionTokensDetails?.reasoning_tokens != null && {
          reasoning: completionTokensDetails?.reasoning_tokens,
        }),
      };
    }

    const generations: ChatGeneration[] = [];
    for (const part of data?.choices ?? []) {
      const converted = this._convertCompletionsMessageToBaseMessage(
        part.message ?? { role: "assistant" },
        data,
      );
      if (isAIMessage(converted)) {
        // `usage_metadata` collapses to `undefined` in the generic message types —
        // the same defect `usageOf` quarantines — so the write goes through a cast.
        (converted as unknown as { usage_metadata: unknown }).usage_metadata =
          usageMetadata;
      }
      const message = new AIMessage(
        Object.fromEntries(
          Object.entries(converted).filter(([key]) => !key.startsWith("lc_")),
        ),
      );
      const generation: ChatGeneration = {
        text: part.message?.content ?? "",
        message,
        ...(part.finish_reason !== undefined || part.logprobs !== undefined
          ? {
              generationInfo: {
                ...(part.finish_reason !== undefined
                  ? { finish_reason: part.finish_reason }
                  : {}),
                ...(part.logprobs !== undefined ? { logprobs: part.logprobs } : {}),
              },
            }
          : {}),
      };
      generations.push(generation);
    }
    return {
      generations,
      llmOutput: {
        tokenUsage: {
          promptTokens: usageMetadata.input_tokens,
          completionTokens: usageMetadata.output_tokens,
          totalTokens: usageMetadata.total_tokens,
        },
      },
    };
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const messagesMapped = attachReasoning(
      messages,
      convertMessagesToCompletionsMessageParams({ messages, model: this.model }),
    );
    // `invocationParams` returns a union of the streaming and non-streaming param
    // shapes, so the spread below widens `stream: true` back to `boolean` and the
    // `completionWithRetry` overload that wants the `true` literal stops matching.
    // Pin the literal back on the way in.
    const params = {
      ...this.invocationParams(options, { streaming: true }),
      messages: messagesMapped,
      stream: true,
    };
    let defaultRole;
    const streamIterable = await this.completionWithRetry(
      params as typeof params & { stream: true },
      options,
    );
    let usage;
    for await (const data of streamIterable) {
      if (options.signal?.aborted) return;
      const choice = data?.choices?.[0];
      if (data.usage) usage = data.usage;
      if (!choice) continue;
      const { delta } = choice;
      if (!delta) continue;
      const chunk = this._convertCompletionsDeltaToBaseMessageChunk(
        delta,
        data,
        // 🔴 **`?? "assistant"` is not tidying — without it a whole provider is
        // unusable.** The converter picks the chunk class from `delta.role ??
        // defaultRole`, and `defaultRole` is only whatever an earlier delta
        // carried. OpenAI and DeepSeek open every stream with a role-bearing
        // delta, so it is always set by the time one arrives without a role.
        // 智谱 does not: its `tool_calls` delta carries no `role` at all, and it
        // can be the **first** delta of the stream — measured 2026-08-30,
        // `{"delta":{"tool_calls":[…]}}` with nothing before it. `defaultRole`
        // is then still `undefined`, the converter falls back to
        // `ChatMessageChunk`, and the accumulated reply is no longer an
        // `AIMessage` — langchain's own AgentNode rejects it with *expected
        // AIMessage or Command, got object* and the turn dies before any tool
        // runs. A completions stream has exactly one author, so naming it is
        // safe for every provider and load-bearing for this one.
        // `tests/streaming-role.test.ts` pins it.
        defaultRole ?? "assistant",
      );
      defaultRole = delta.role ?? defaultRole;
      const newTokenIndices = {
        prompt: options.promptIndex ?? 0,
        completion: choice.index ?? 0,
      };
      if (typeof chunk.content !== "string") {
        console.log(
          "[WARNING]: Received non-string content from OpenAI. This is currently not supported.",
        );
        continue;
      }
      const generationInfo: Record<string, unknown> = { ...newTokenIndices };
      if (choice.finish_reason != null) {
        generationInfo.finish_reason = choice.finish_reason;
        generationInfo.system_fingerprint = data.system_fingerprint;
        generationInfo.model_name = data.model;
        generationInfo.service_tier = data.service_tier;
      }
      if (this.logprobs) generationInfo.logprobs = choice.logprobs;
      const generationChunk = new ChatGenerationChunk({
        message: chunk,
        text: chunk.content,
        generationInfo,
      });
      yield generationChunk;
      await runManager?.handleLLMNewToken(
        generationChunk.text ?? "",
        newTokenIndices,
        void 0,
        void 0,
        void 0,
        { chunk: generationChunk },
      );
    }
    if (usage) {
      const inputTokenDetails = {
        ...(usage.prompt_tokens_details?.audio_tokens != null && {
          audio: usage.prompt_tokens_details?.audio_tokens,
        }),
        ...(usage.prompt_tokens_details?.cached_tokens != null && {
          cache_read: usage.prompt_tokens_details?.cached_tokens,
        }),
      };
      const outputTokenDetails = {
        ...(usage.completion_tokens_details?.audio_tokens != null && {
          audio: usage.completion_tokens_details?.audio_tokens,
        }),
        ...(usage.completion_tokens_details?.reasoning_tokens != null && {
          reasoning: usage.completion_tokens_details?.reasoning_tokens,
        }),
      };
      const generationChunk = new ChatGenerationChunk({
        // `usage_metadata` collapses to `undefined` in the generic message types,
        // so the fields object is cast wholesale — same defect as `usageOf`.
        message: new AIMessageChunk({
          content: "",
          response_metadata: { usage: { ...usage } },
          usage_metadata: {
            input_tokens: usage.prompt_tokens,
            output_tokens: usage.completion_tokens,
            total_tokens: usage.total_tokens,
            ...(Object.keys(inputTokenDetails).length > 0 && {
              input_token_details: inputTokenDetails,
            }),
            ...(Object.keys(outputTokenDetails).length > 0 && {
              output_token_details: outputTokenDetails,
            }),
          },
        } as unknown as ConstructorParameters<typeof AIMessageChunk>[0]),
        text: "",
      });
      yield generationChunk;
      await runManager?.handleLLMNewToken(
        generationChunk.text ?? "",
        { prompt: 0, completion: 0 },
        void 0,
        void 0,
        void 0,
        { chunk: generationChunk },
      );
    }
    if (options.signal?.aborted) throw new Error("AbortError");
  }
}

/**
 * Builds the program's model: a `ChatOpenAI` whose completions backend echoes
 * `reasoning_content`. Everything else — the fields, the retry policy that stops
 * on context overflow — is the caller's, exactly as before.
 */
export function createChatModel(fields: {
  model: string;
  apiKey: string;
  baseURL: string;
  maxTokens?: number;
  onFailedAttempt?: (error: unknown) => void;
}): ChatOpenAI {
  const chatFields = {
    model: fields.model,
    apiKey: fields.apiKey,
    configuration: { baseURL: fields.baseURL },
    ...(fields.maxTokens !== undefined ? { maxTokens: fields.maxTokens } : {}),
    ...(fields.onFailedAttempt !== undefined
      ? { onFailedAttempt: fields.onFailedAttempt }
      : {}),
  };
  return new ChatOpenAI({
    ...chatFields,
    completions: new ReasoningEchoCompletions(chatFields),
  });
}
