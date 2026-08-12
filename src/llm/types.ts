/* ---------- Messages ---------- */

export interface SystemMessage {
  role: "system";
  content: string;
}

export interface UserMessage {
  role: "user";
  content: string;
}

export interface ToolCall {
  id: string;
  name: string;
  /** 由模型输出的原始 JSON 字符串。请在调用处进行解析（及验证）。 */
  arguments: string;
}

export interface AssistantMessage {
  role: "assistant";
  content: string;
  toolCalls?: ToolCall[];
  /**
   * Not part of the OpenAI wire format. DeepSeek v4 returns it by default, so
   * expect it on ordinary turns — it is not reasoning-model-only. Turn it off
   * with `thinking: { type: "disabled" }` if you ever need to.
   *
   * The old constraint did not disappear — it inverted, and it is narrower than
   * it first looks. Verified against deepseek-v4-flash on 2026-08-12:
   *
   *   assistant turn                            no reasoning_content
   *   plain text                                200
   *   tool_calls, id DeepSeek issued            200
   *   tool_calls, id from another conversation  200
   *   tool_calls, well-formed id never issued   400
   *   tool_calls, made-up id ("c1")             400
   *
   * Error text: "The `reasoning_content` in the thinking mode must be passed
   * back to the API." Streaming makes no difference; `thinking: disabled` makes
   * it all pass. So the server recognises ids it issued — globally, not just
   * within one conversation — and only demands the reasoning when it cannot.
   *
   * A normal agent loop therefore never trips this: its ids come from the model.
   * `toWireMessage` sends the field back anyway for turns that carry `toolCalls`
   * — cheap insurance for histories that are persisted and replayed later, where
   * recognition may lapse (plausible, NOT measured), and for synthetic tool calls
   * whose ids we made up. Text-only turns skip it and keep the tokens.
   */
  reasoning?: string;
}

export interface ToolMessage {
  role: "tool";
  toolCallId: string;
  content: string;
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

/* ---------- Tools ---------- */

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/* ---------- Stream deltas ---------- */

export type FinishReason =
  "stop" | "length" | "tool_calls" | "content_filter" | "unknown";

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens?: number;
}

export type Delta =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | {
      kind: "tool_call";
      index: number;
      id?: string;
      name?: string;
      argsChunk?: string;
    }
  | { kind: "done"; finishReason: FinishReason; usage?: Usage };

/* ---------- Errors ---------- */

export type LLMErrorKind =
  | "auth"
  | "rate_limit"
  | "timeout"
  | "bad_request"
  | "server"
  | "network"
  | "aborted"
  | "unknown";

export class LLMError extends Error {
  readonly kind: LLMErrorKind;
  readonly status: number | undefined;

  constructor(
    kind: LLMErrorKind,
    message: string,
    options: { cause?: unknown; status?: number } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "LLMError";
    this.kind = kind;
    this.status = options.status;
  }
}

/* ---------- Client ---------- */

export interface ChatOptions {
  messages: Message[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  /** 中止操作会拒绝该流，并抛出类型为 "aborted" 的 LLMError。 */
  signal?: AbortSignal;
}

export interface LLMClient {
  readonly model: string;
  stream(options: ChatOptions): AsyncIterable<Delta>;
}
