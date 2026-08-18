# Moonshot (Kimi) China-region provider facts

Research notes for adding Moonshot China as a second OpenAI-compatible provider
next to DeepSeek. Every claim below is quoted from Moonshot's own docs
(`platform.kimi.com`, the China platform, formerly `platform.moonshot.cn`).
Doc markdown was fetched directly via the `.md` endpoints (mintlify), so line
references are to the primary source text, not a third-party write-up.

Primary sources:

- Docs index: <https://platform.kimi.com/docs/llms.txt>
- API overview: <https://platform.kimi.com/docs/api/overview>
- Model list: <https://platform.kimi.com/docs/models>
- Model parameter reference: <https://platform.kimi.com/docs/api/models-overview>
- Chat Completions (OpenAPI schema): <https://platform.kimi.com/docs/api/chat>
- Thinking models: <https://platform.kimi.com/docs/guide/use-thinking-models>
- Context caching: <https://platform.kimi.com/docs/guide/use-context-caching-feature-of-kimi-api>
- Streaming: <https://platform.kimi.com/docs/guide/utilize-the-streaming-output-feature-of-kimi-api>
- OpenAI migration notes: <https://platform.kimi.com/docs/guide/migrating-from-openai-to-kimi>
- Kimi K3 quickstart: <https://platform.kimi.com/docs/guide/kimi-k3-quickstart>
- Kimi K2.7 Code quickstart: <https://platform.kimi.com/docs/guide/kimi-k2-7-code-quickstart>
- Kimi K2.6 quickstart: <https://platform.kimi.com/docs/guide/kimi-k2-6-quickstart>
- Reasoning effort: <https://platform.kimi.com/docs/guide/use-reasoning-effort>

---

## 1. Endpoint

- China base URL for SDKs is exactly **`https://api.moonshot.cn/v1`**. The docs'
  "服务地址" (service address) is `https://api.moonshot.cn`, and direct HTTP
  paths are under `/v1`, e.g. `https://api.moonshot.cn/v1/chat/completions`.
  So `/v1` is required in the path.
  Source: <https://platform.kimi.com/docs/api/overview>
  ("base_url 设置为 https://api.moonshot.cn/v1；…完整路径如
  https://api.moonshot.cn/v1/chat/completions").

- OpenAI-compatible endpoints listed by the migration guide:
  `/v1/chat/completions`, `/v1/files`, `/v1/files/{file_id}`,
  `/v1/files/{file_id}/content`.
  Source: <https://platform.kimi.com/docs/guide/migrating-from-openai-to-kimi>

- International vs China: the international platform uses
  **`https://api.moonshot.ai/v1`** (platform.moonshot.ai), China uses
  `https://api.moonshot.cn/v1` (platform.kimi.com / platform.moonshot.cn). They
  are **separate platforms with separate API keys** — a China key returns 401
  against the `.ai` endpoint and vice versa. This is corroborated by OpenClaw
  issues tracking exactly this 401 mismatch:
  - <https://github.com/openclaw/openclaw/issues/32607> ("CN users get 401 … api.moonshot.ai instead of api.moonshot.cn")
  - <https://github.com/openclaw/openclaw/issues/3924> ("Support for China mainland endpoint (api.moonshot.cn)")
  - <https://github.com/openclaw/openclaw/issues/6222> (".cn baseUrl — silent 401 for international API keys")

  Note: the China docs I fetched only document `.cn`; they do not describe the
  `.ai` platform's model availability, so any `.ai`-specific model matrix is
  "未查到" from the China docs (the international models doc lives at
  <https://platform.moonshot.ai/docs/models>).

## 2. Model specs

All three names the task asked about exist verbatim in the current China model
list (`kimi-k3`, `kimi-k2.7-code`, `kimi-k2.6`). None are aliases.
Source: <https://platform.kimi.com/docs/models>

|                         | `kimi-k3`                                                        | `kimi-k2.7-code` (and `-highspeed`)                          | `kimi-k2.6`                                                                                           |
| ----------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Context window          | **1M tokens** (1,048,576)                                        | **256K tokens**                                              | **256K tokens**                                                                                       |
| Reasoning / CoT         | Always on; cannot disable                                        | Always on; cannot disable                                    | **Default on**; disable with `thinking: {"type":"disabled"}`                                          |
| Reasoning control param | top-level `reasoning_effort` (`low`/`high`/`max`, default `max`) | `thinking` (only `{"type":"enabled","keep":"all"}` accepted) | `thinking` (`{"type":"enabled"}` default / `{"type":"disabled"}` / `{"type":"enabled","keep":"all"}`) |
| Tool calling            | yes; `tool_choice` `auto`/`none`/`required`                      | yes; `tool_choice` `auto`/`none` only (no `required`)        | yes; `tool_choice` `auto`/`none` only (no `required`)                                                 |
| Max output tokens       | default **131072**, max **1048576**                              | default **32768**; hard upper bound **未查到**               | default **32768**; hard upper bound **未查到**                                                        |
| `temperature`           | fixed 1.0 (do not pass)                                          | fixed 1.0 (do not pass)                                      | thinking 1.0 / non-thinking 0.6 (do not pass)                                                         |

Model list + parameter table sources:
<https://platform.kimi.com/docs/models>,
<https://platform.kimi.com/docs/api/models-overview>,
<https://platform.kimi.com/docs/guide/kimi-k3-quickstart>,
<https://platform.kimi.com/docs/guide/kimi-k2-7-code-quickstart>,
<https://platform.kimi.com/docs/guide/kimi-k2-6-quickstart>.

Specific points:

- `kimi-k3`: "2.8 万亿参数…100 万 token 上下文窗口" (models.md).
  `max_completion_tokens` "默认 131072，最大可设置为 1048576" (k3 quickstart
  "重要限制"; also chat.md OpenAPI). K3 always reasons and Preserved Thinking is
  always on (use-thinking-models.md).
- `kimi-k2.7-code`: 256K context (models.md). "始终开启思考、不可禁用" and
  Preserved Thinking always on; `thinking` only accepts
  `{"type":"enabled","keep":"all"}` (models-overview + use-thinking-models).
  `max_tokens` "默认值为32k，即32768" (k2.7 quickstart parameter table) — no
  maximum value is stated.
- `kimi-k2.7-code-highspeed`: same model, same parameter constraints, only faster
  output (~180 t/s, up to 260 t/s short-context) (models.md, models-overview).
- `kimi-k2.6`: 256K context, vision+text, thinking **and** non-thinking modes
  (models.md). `max_tokens` "默认值为32k，即32768" (k2.6 quickstart) — no
  maximum stated. Thinking-mode recommendation: "设置 max_tokens>=16000"
  for multi-step tool calling so reasoning+content fit (use-thinking-models.md).

Reasoning chain field (all three): the chain-of-thought is returned in
**`reasoning_content`**, a sibling of `content` on both `message` (non-stream)
and `delta` (stream). There is no `thinking` response field.
Source: <https://platform.kimi.com/docs/guide/use-thinking-models>
("推理过程通过响应中的 reasoning_content 字段返回").

`stream_options: { include_usage: true }` is supported.
Source: <https://platform.kimi.com/docs/api/chat> (OpenAPI `stream_options.include_usage`);
also <https://platform.kimi.com/docs/guide/utilize-the-streaming-output-feature-of-kimi-api>
and <https://platform.kimi.com/docs/guide/migrating-from-openai-to-kimi>.

## 3. usage / cache fields (this decides `cacheRead` / `reasoningTokens`)

- Cache-hit tokens are reported in a **top-level `usage.cached_tokens`** field,
  described as "命中缓存的 Token 数量". It is NOT
  `prompt_tokens_details.cached_tokens`, and Moonshot has **no**
  `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` (those are DeepSeek
  spellings). Source: <https://platform.kimi.com/docs/api/chat> — usage schema
  lists `prompt_tokens`, `completion_tokens`, `total_tokens`, `cached_tokens`;
  response examples show `"usage": { ..., "cached_tokens": 10 }` and a streaming
  chunk `"usage":{...,"cached_tokens":12}`.

- Reasoning tokens have **no dedicated usage field**. There is no
  `completion_tokens_details.reasoning_tokens` anywhere in the schema; the
  thinking doc states `reasoning_content` tokens count into the normal
  input/output token totals ("reasoning_content 会计入 token 消耗…计入输入/输出
  token"). Source: <https://platform.kimi.com/docs/guide/use-thinking-models>
  (Q1/Q2 + "reasoning_content 中包含的 Tokens 也受 max_tokens 参数控制").

- Consequence for this repo's mapping. `@langchain/openai` (installed) maps only
  the OpenAI spellings into the vendor-neutral shape
  (`node_modules/@langchain/openai/dist/chat_models/completions.js`):
  - `usage.prompt_tokens_details.cached_tokens` → `usage_metadata.input_token_details.cache_read`
  - `usage.completion_tokens_details.reasoning_tokens` → `usage_metadata.output_token_details.reasoning`
    Moonshot emits neither shape, so with the current code:
  - `cacheRead` (`input_token_details.cache_read`) → **0**, because Moonshot's
    top-level `cached_tokens` is dropped by the mapper.
  - `reasoningTokens` (`output_token_details.reasoning`) → **undefined**,
    because Moonshot reports no reasoning token count at all.
    Therefore neither field can "reuse the DeepSeek mapping" as-is. `cacheRead`
    would need to read the raw top-level `usage.cached_tokens` from the chunk's
    `response_metadata.usage` (same place DeepSeek's `prompt_cache_hit_tokens`
    rides today), and `reasoningTokens` has no Moonshot source — the best proxy is
    `completion_tokens` itself (which includes reasoning tokens).

## 4. Context caching mechanism

- Moonshot Context Caching is **automatic, enabled for all models, no explicit
  opt-in** — no manual cache creation, no cache ID to pass, no TTL to manage. It
  matches repeated initial context by prefix: "系统检测到重复的初始上下文（如
  system prompt、知识文档、工具定义等）时，会自动复用已缓存的内容".
  Source: <https://platform.kimi.com/docs/guide/use-context-caching-feature-of-kimi-api>

- Like DeepSeek, this is prefix/auto caching, not Anthropic-style
  `cache_control`. The project's "static prefix + tail environment segment"
  ordering strategy still applies. Moonshot's own ordering advice: "将固定的大段
  上下文（如知识文档）放在 messages 数组的最前面（system 消息之前），然后将用户
  问题和模型回复追加其后" — i.e. fixed content at the very front (they even say
  before the system message). Whether the project's current system-prompt-first
  ordering also hits the cache should be verified empirically; the doc's
  normative example puts fixed content first.

- Threshold note: "当前一个请求的 prompt tokens 大于 256 时，新的请求才能命中前缀
  缓存；…小于 256 时，请求不会被缓存而是被丢弃".
  Source: same caching doc.

- There is additionally an optional **`prompt_cache_key`** request parameter
  (string) to "缓存相似请求的响应以优化缓存命中率" — for a coding agent it is
  typically a stable session/task id kept constant across resume; required for
  Kimi Code Plan. Source: <https://platform.kimi.com/docs/api/chat> (OpenAPI
  `prompt_cache_key`).

- Switching `reasoning_effort` tiers breaks the prefix cache: "切换档位会破坏前缀
  缓存命中". Source: <https://platform.kimi.com/docs/api/models-overview>.

## 5. `reasoning_content` semantics vs DeepSeek v4

- Same field name as DeepSeek: **`reasoning_content`**, returned alongside
  `content` (non-stream: `message.reasoning_content`; stream:
  `delta.reasoning_content`, and it always arrives before `content`).
  Source: <https://platform.kimi.com/docs/guide/use-thinking-models>.

- Default-on, not a separate model. All three Moonshot models return
  `reasoning_content` by default; `kimi-k3` and `kimi-k2.7-code` cannot turn it
  off, `kimi-k2.6` can via `thinking.type:"disabled"`. This differs from
  DeepSeek's split of chat vs reasoner models — Moonshot has no "non-reasoning"
  variant of K3/K2.7, only the `thinking`/`reasoning_effort` knobs.
  Sources: <https://platform.kimi.com/docs/models>,
  <https://platform.kimi.com/docs/api/models-overview>.

- Echo-back requirement (the analogue of DeepSeek's "request must carry reasoning
  to receive reasoning" constraint, but not identical): Moonshot **requires** you
  to pass the full assistant message — including `reasoning_content` — back into
  `messages` for multi-turn and tool calls. For `kimi-k3` and `kimi-k2.7-code`
  this is unconditional ("必须原样回传完整 assistant message…包括
  reasoning_content"); for `kimi-k2.6` in a tool-call loop, dropping
  `reasoning_content` errors out ("必须…保留…否则会报错"). Cross-turn retention is
  governed by `thinking.keep` (k2.6 default `null` = drop history; `"all"` =
  preserve; k2.7-code and K3 always preserve). There is **no** gate where you must
  send a reasoning flag to receive reasoning — reasoning is produced by default,
  and the requirement is that you echo it back.
  Sources: <https://platform.kimi.com/docs/guide/use-thinking-models>,
  <https://platform.kimi.com/docs/guide/use-reasoning-effort>.

## Measured against the live API (2026-08-18)

Live probe against `kimi-k3` at `https://api.moonshot.cn/v1` (real key, no stub).
Three corrections to the doc-derived claims above:

- **`reasoning_tokens` IS reported.** §3 said the schema has no reasoning-token
  field; the live response does carry `completion_tokens_details.reasoning_tokens`
  (observed 44), which langchain maps straight into
  `usage_metadata.output_token_details.reasoning`. So `ModelUsage.reasoningTokens`
  works for kimi-k3 with no extra code. The raw usage shape observed:
  `{ prompt_tokens, completion_tokens, total_tokens, completion_tokens_details: { reasoning_tokens } }`
  — no `prompt_tokens_details`, confirming the cache field is the top-level
  `cached_tokens` as §3 states, and that the `cacheRead` fallback in
  `src/usage.ts` is what surfaces it (observed `cacheRead: 2560` on a second
  request whose prefix hit the cache).
- **The echo-back requirement is not unconditional in practice.** §5 quotes the
  docs saying kimi-k3 requires the full assistant message back "unconditionally".
  Tested the opposite way: a plain `ChatOpenAI` — which drops `reasoning_content`
  on send — re-sent a kimi-k3 assistant message carrying both `reasoning_content`
  and a real Moonshot-signed `tool_call` id (`Read_0`), paired with its
  `ToolMessage`. It returned 200, as did a plain multi-turn with no tool call.
  So kimi-k3 follows the **same "self-signed id → tolerant" pattern the README
  documents for DeepSeek v4**, not the strict reading of its own docs. The
  `ReasoningEchoCompletions` backend in `src/agents/model.ts` is therefore a
  safety net — harmless on the happy path, and still covering the
  non-self-signed-id case (HITL injection, test fixtures) that DeepSeek's README
  flags — rather than a hard requirement for the normal loop.
- End-to-end agent turn (`Read` package.json → answer) completed with the echo
  backend: two model calls, second one `cacheRead: 2560`, no 400.

## Unresolved / verify empirically

- Hard upper bound of `max_tokens` for `kimi-k2.7-code` and `kimi-k2.6`: docs
  state only the default 32768. "未查到" a documented maximum (context is 256K,
  so the effective cap is 256K minus input, but no explicit number is given).
- Streaming `usage` placement discrepancy: the chat.md OpenAPI says
  `stream_options.include_usage` adds a final chunk with top-level `usage` and
  empty `choices`; the streaming guide (kimi-k3 default) shows `usage` nested in
  `choices[0].usage` and warns `chunk.usage` is `None`. The migration guide says
  Kimi also always places usage in each choice's ending chunk. These likely
  describe with/without `include_usage`, but the exact shape (and whether
  `cached_tokens` is present in the `choices[0].usage` variant) should be checked
  against a live response before wiring `usageMeter`.
  Sources: <https://platform.kimi.com/docs/api/chat>,
  <https://platform.kimi.com/docs/guide/utilize-the-streaming-output-feature-of-kimi-api>,
  <https://platform.kimi.com/docs/guide/migrating-from-openai-to-kimi>.
- International (`.ai`) model matrix: not covered by the China docs; "未查到"
  from these pages. See <https://platform.moonshot.ai/docs/models>.
