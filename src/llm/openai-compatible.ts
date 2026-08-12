import OpenAI from "openai";
import type {
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

import {
  LLMError,
  type ChatOptions,
  type Delta,
  type FinishReason,
  type LLMClient,
  type Message,
  type ToolDefinition,
  type Usage,
} from "./types";

interface LoggerLike {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
}

export interface OpenAICompatibleOptions {
  baseURL: string;
  apiKey: string;
  model: string;
  logger?: LoggerLike;
}

const TIMEOUT_MS = 60_000;
const MAX_RETRIES = 2;

export function createOpenAICompatibleClient(
  options: OpenAICompatibleOptions,
): LLMClient {
  const { baseURL, apiKey, model, logger } = options;

  const openai = new OpenAI({
    baseURL,
    apiKey,
    timeout: TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
  });

  return {
    model,
    async *stream(chat: ChatOptions): AsyncIterable<Delta> {
      const params: ChatCompletionCreateParamsStreaming = {
        model,
        stream: true,
        stream_options: { include_usage: true },
        messages: chat.messages.map(toWireMessage),
        ...(chat.tools ? { tools: chat.tools.map(toWireTool) } : {}),
        ...(chat.temperature !== undefined ? { temperature: chat.temperature } : {}),
        ...(chat.maxTokens !== undefined ? { max_tokens: chat.maxTokens } : {}),
      };

      logger?.debug("llm_request", {
        model,
        baseURL,
        messages: params.messages,
        tools: params.tools,
      });

      const startedAt = Date.now();

      const response = await openai.chat.completions
        .create(params, chat.signal ? { signal: chat.signal } : {})
        .catch((error: unknown) => {
          throw toLLMError(error);
        });

      let finishReason: FinishReason = "unknown";
      let usage: Usage | undefined;

      try {
        for await (const chunk of response) {
          if (chunk.usage) usage = toUsage(chunk.usage);

          // The usage-only trailer chunk carries an empty choices array.
          const choice = chunk.choices[0];
          if (!choice) continue;

          if (choice.finish_reason) {
            finishReason = toFinishReason(choice.finish_reason);
          }

          // DeepSeek adds `reasoning_content`, which does not exist in the
          // OpenAI type definitions — this is the one place we assert. v4
          // returns it by default, so this branch is the common path, not an
          // edge case that only reasoning models hit.
          const { reasoning_content: reasoningChunk } = choice.delta as {
            reasoning_content?: string | null;
          };
          if (reasoningChunk) {
            yield { kind: "reasoning", text: reasoningChunk };
          }

          if (choice.delta.content) {
            yield { kind: "text", text: choice.delta.content };
          }

          for (const call of choice.delta.tool_calls ?? []) {
            yield {
              kind: "tool_call",
              index: call.index,
              ...(call.id !== undefined ? { id: call.id } : {}),
              ...(call.function?.name !== undefined
                ? { name: call.function.name }
                : {}),
              ...(call.function?.arguments !== undefined
                ? { argsChunk: call.function.arguments }
                : {}),
            };
          }
        }
      } catch (error) {
        throw toLLMError(error);
      }

      // The SDK ends its iterator cleanly when the request is aborted mid-stream
      // rather than throwing, so upholding the contract documented on
      // ChatOptions.signal is on us.
      if (chat.signal?.aborted) {
        throw new LLMError("aborted", "request aborted");
      }

      logger?.info("llm_response", {
        model,
        durationMs: Date.now() - startedAt,
        finishReason,
        ...usage,
      });

      yield { kind: "done", finishReason, ...(usage ? { usage } : {}) };
    },
  };
}

/* ---------- wire mapping ---------- */

function toWireMessage(message: Message): ChatCompletionMessageParam {
  switch (message.role) {
    case "system":
      return { role: "system", content: message.content };
    case "user":
      return { role: "user", content: message.content };
    case "assistant": {
      // DeepSeek v4 requires `reasoning_content` back on assistant turns that
      // carry tool_calls; omitting it is a 400 ("must be passed back to the
      // API"). Text-only turns accept it either way, so we skip it there and
      // keep the tokens. Not an OpenAI field, hence the untyped spread.
      const reasoning =
        message.toolCalls && message.reasoning !== undefined
          ? { reasoning_content: message.reasoning }
          : {};

      return {
        role: "assistant",
        content: message.content,
        ...(message.toolCalls
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function" as const,
                function: { name: call.name, arguments: call.arguments },
              })),
            }
          : {}),
        ...reasoning,
      };
    }
    case "tool":
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content,
      };
  }
}

function toWireTool(tool: ToolDefinition): ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function toFinishReason(reason: string): FinishReason {
  switch (reason) {
    case "stop":
    case "length":
    case "tool_calls":
    case "content_filter":
      return reason;
    default:
      return "unknown";
  }
}

function toUsage(usage: {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}): Usage {
  const { prompt_cache_hit_tokens: cached } = usage as {
    prompt_cache_hit_tokens?: number;
  };
  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    ...(cached !== undefined ? { cachedPromptTokens: cached } : {}),
  };
}

/* ---------- error mapping ---------- */

// Order matters: the abort, timeout and connection classes all extend APIError.
function toLLMError(error: unknown): LLMError {
  if (error instanceof LLMError) return error;

  if (error instanceof OpenAI.APIUserAbortError) {
    return new LLMError("aborted", "request aborted", { cause: error });
  }
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return new LLMError("timeout", error.message, { cause: error });
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return new LLMError("network", error.message, { cause: error });
  }
  if (error instanceof OpenAI.APIError) {
    // APIError is generic over its status type, and the bare class widens that
    // parameter to `any` — narrow it before branching on it.
    const raw: unknown = error.status;
    const status = typeof raw === "number" ? raw : undefined;
    const kind =
      status === 401 || status === 403
        ? "auth"
        : status === 429
          ? "rate_limit"
          : status !== undefined && status >= 500
            ? "server"
            : status !== undefined && status >= 400
              ? "bad_request"
              : "unknown";
    return new LLMError(kind, error.message, {
      cause: error,
      ...(status !== undefined ? { status } : {}),
    });
  }

  return new LLMError(
    "unknown",
    error instanceof Error ? error.message : String(error),
    { cause: error },
  );
}
