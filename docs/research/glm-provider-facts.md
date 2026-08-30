# 智谱 (GLM) China-region provider facts

Research notes for adding 智谱开放平台 (BigModel) as a **third** OpenAI-compatible
provider next to DeepSeek and Moonshot, running `glm-5.3-flash`.

🔴 **Everything in §1–§6 is doc-derived. Nothing here has been measured yet.**
The distinction is the point of this file: the registry in `src/models.ts` may
only carry measured or documented numbers, and "documented" has to be traceable
to the sentence it came from. §7 is the list the probes have to close, and
"Measured against the live API" — the section that made
`moonshot-provider-facts.md` worth writing, because it **overturned three of that
file's doc-derived claims** — does not exist here yet.

Primary sources (智谱's own docs, `docs.bigmodel.cn`):

- 模型卡 GLM-5.3-Flash: <https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash>
- 对话补全 API 参考: <https://docs.bigmodel.cn/api-reference/模型-api/对话补全>
- OpenAI SDK 兼容: <https://docs.bigmodel.cn/cn/guide/develop/openai/introduction>
- 上下文缓存: <https://docs.bigmodel.cn/cn/guide/capabilities/cache>
- 错误码: <https://docs.bigmodel.cn/cn/faq/api-code>

Secondary (international platform, same model): <https://docs.z.ai/guides/vlm/glm-5.3-flash>

---

## 1. Endpoint

- Base URL is **`https://open.bigmodel.cn/api/paas/v4`**, and the path prefix is
  part of it: the OpenAI-SDK page gives `base_url` verbatim as
  `https://open.bigmodel.cn/api/paas/v4/`, and chat lives at
  `/api/paas/v4/chat/completions`. Same shape as Moonshot's required `/v1`,
  unlike DeepSeek's bare host.

- OpenAI-compatible for the endpoints this program uses: `chat.completions.create`,
  streaming, and function calling with `tools` / `tool_choice` / `message.tool_calls`.
  The compat page hedges — "certain scenarios still have differences … does not
  affect overall compatibility" — without enumerating the differences, so the
  hedge is worth nothing and §7 has to close it by measurement.

- ⚠️ **Two platforms, two key namespaces.** 国内 `open.bigmodel.cn` (docs at
  `docs.bigmodel.cn`) and 海外 `z.ai` (`docs.z.ai`) are separate platforms; a key
  from one 401s against the other. Identical to the Moonshot `.cn` / `.ai` split
  that cost other projects a string of silent-401 bug reports. **We register the
  CN platform only**, and the provider id says so: `zhipu-cn`.

## 2. Model spec — `glm-5.3-flash`

Released 2026-08-26, first of the GLM-5.3 line, natively multimodal
(image/video input). This program sends no images, so the multimodality is
irrelevant here — noted only because it is _not_ a reason to leave the model out:
unlike DeepSeek's separate `deepseek-v4-flash-vision-exp`, there is no text-only
variant to prefer, so registering it advertises nothing the tools cannot reach.

|                    | documented                                                                        | source            |
| ------------------ | --------------------------------------------------------------------------------- | ----------------- |
| Context window     | "1M" — **the exact integer is 未查到**                                            | 模型卡            |
| Max output tokens  | 模型卡 says 128K; the API reference gives `max_tokens` range **[1, 131072]**      | 模型卡 + 对话补全 |
| Parameter name     | **`max_tokens`** (not `max_completion_tokens`)                                    | 对话补全          |
| Thinking           | `thinking.type` **仅支持 `enabled`，不支持关闭思考**                              | 模型卡            |
| Thinking retention | `thinking.clear_thinking`, **default `true`**; doc recommends `false`             | 对话补全 + 模型卡 |
| Reasoning strength | `reasoning_effort`: `low` / `high` / `max`; doc recommends `max`                  | 模型卡            |
| Sampling           | recommends `temperature: 1`, `top_p: 0.95`                                        | 模型卡            |
| Tool calling       | yes; streaming doc recommends `stream: true` **and** `tool_stream: true` together | 模型卡            |

Two contradictions inside 智谱's own docs, both live in §7:

- 🔴 **128K vs 131072.** These are the same number if "128K" means 131,072, and
  differ if it means 128,000. `maxOutputTokens` is not a field to round.
- 🔴 **`temperature` recommended as `1`, while the OpenAI-compat page says the
  range is `(0,1)`** — an open interval that excludes the recommended value.
  Low stakes for us: `ChatOpenAI` declares `temperature` with no initializer and
  only sends it when set (`node_modules/@langchain/openai/dist/chat_models/base.js:31,235`,
  emitted at `completions.js:29`), and `createChatModel` never sets it. So this
  program sends no `temperature` at all and the contradiction cannot bite —
  **unless someone later sets one**, which is why it is written down.

## 3. usage / cache fields — this decides `cacheRead` and `reasoningTokens`

Documented `usage` object (对话补全):

- `prompt_tokens` — 用户输入的 Token 数量
- `completion_tokens` — 输出的 Token 数量
- `total_tokens`
- `prompt_tokens_details.cached_tokens` — 命中的缓存 Token 数量

Two consequences, and they point opposite ways:

- ✅ **`cacheRead` should work with no new code.** `prompt_tokens_details.cached_tokens`
  is exactly the OpenAI spelling `@langchain/openai` maps into
  `usage_metadata.input_token_details.cache_read`. This is the first of the three
  providers to report it in that shape out of the box — DeepSeek fills it too,
  Moonshot needed the top-level-`cached_tokens` fallback in `src/usage.ts`.
  ⚠️ A prediction from a schema table, not a measurement.
- ⚠️ **`reasoningTokens` has no documented source.** No `completion_tokens_details`
  and no `reasoning_tokens` anywhere in the schema. Taken at face value,
  `ModelUsage.reasoningTokens` is `undefined` for GLM. **Do not take it at face
  value**: Moonshot's docs said the same thing and the live probe found
  `completion_tokens_details.reasoning_tokens` present and correctly mapped.

## 4. Context caching

- **Implicit and automatic**: "隐式缓存，智能识别重复的上下文内容，无需手动配置".
  No cache id, no TTL, and **no `prompt_cache_key`-style parameter** — one less
  knob than Moonshot, which does have one.
- **Threshold 512 tokens**: "对于智谱部署的 GLM 模型，当请求之间存在不少于 512
  Token 的相同前缀时，该公共前缀具备隐式缓存写入和命中的技术条件." ⚠️ **Twice
  Moonshot's 256** — a prefix experiment that cached on Moonshot may simply not
  cache here, and that is a measurement artefact, not a regression.
- Placement advice matches what this repo already does: stable system prompt,
  fixed content first, stable history structure. The project's "static prefix +
  tail environment segment" ordering carries over unchanged.
- The docs warn hits are probabilistic: identical contexts may still miss.
  **That is why "cacheRead must be observed non-zero" was deliberately kept out
  of this line's finish line** — it would be a criterion the provider is allowed
  to fail on purpose.

## 5. `reasoning_content` semantics

- Same field name as the other two providers: the OpenAI-compat page reads it as
  `chunk.choices[0].delta.reasoning_content`, streamed separately from `content`.
- 🔴 **The API reference contradicts the model card.** It documents
  `reasoning_content` as "仅在使用 `glm-4.5` 系列, `glm-4.1v-thinking` 系列模型时
  返回" — which cannot hold for a model whose thinking **cannot be turned off**.
  Reads as a line that was never updated for GLM-5.x. Probe decides.
- **No echo-back requirement is documented.** Moonshot demands the assistant
  message be replayed with its `reasoning_content`; 智谱's docs say nothing. Our
  `ReasoningEchoCompletions` is unconditional in `createChatModel`, so GLM gets
  it whether or not it wants it — §7 asks whether that is harmless, not whether
  it is required.
- `clear_thinking` is the inverse of Moonshot's `thinking.keep`: `true` (the
  default) drops the chain across turns, `false` keeps it. The doc recommends
  `false`, i.e. **carry every turn's full chain of thought in history** — which
  this repository has measured the price of elsewhere (the thinking row is 76% of
  the screen; `repro/29-what-reasoning-really-costs.ts`). A recommendation is not
  a measurement, so the default stands until a probe says otherwise.

## 6. Errors — and the one that breaks something

Error shape (错误码): HTTP status outside, business code inside the body.

```json
{ "error": { "code": "1261", "message": "Prompt 超长" } }
```

`1261` / HTTP 400 is the **only** documented code for input length; there is no
documented code for `max_tokens` out of range.

🔴 **This is the shared assumption the third provider was expected to expose.**
`src/context/compaction.ts` does not parse the overflow itself — it relies on
langchain recognising the failure, and langchain recognises it by matching four
hard-coded English phrases written for OpenAI. `maximum context length` is the
one DeepSeek happens to hit, and that was **verified rather than assumed** at the
time. **"Prompt 超长" hits none of them.** If that holds live, `isOverflow`
never fires for GLM, `ContextOverflowError` is never raised, and the summarise-on-
overflow path is silently dead on this provider — the program keeps running and
the protection simply is not there.

🔴 **Second consequence: the window may not be readable from a refusal.**
DeepSeek's `1_048_576` was measured by walking into the 400 and reading the
number out of the refusal prose ("This model's maximum context length is 1048576
tokens"). `Prompt 超长` carries **no numbers at all**. If the live refusal is
that bare, the window cannot be measured this way, and the registry must say
"documented 1M, not measured" in as many words rather than quietly writing
1,048,576 because the other two providers happen to use it.

## 6.5 Measured against the live API (2026-08-30)

All of it against `glm-5.3-flash` with a real key. **Six doc-derived claims above
are wrong or incomplete, and two of the corrections were outages** — the provider
did not work at all until they were fixed.

### The endpoint is not the documented one

🔴 **智谱 serves the OpenAI protocol at two paths, and the account decides which
one answers.** `/api/paas/v4` — the base URL every doc page gives — returned
`429 {"code":"1113","message":"余额不足或无可用资源包,请充值。"}` for _every_
request, an impossible `max_tokens` and an ordinary `max_tokens: 16` alike. The
Coding Plan is served from **`/api/coding/paas/v4`**, which answers 200 with the
same key. The registry names the coding path; a balance-billed account overrides
it with `LLM_BASE_URL`.

⚠️ Second-order finding: **智谱 checks the balance before it validates
parameters.** `repro/32` is free precisely because DeepSeek and Moonshot answer an
impossible `max_tokens` with a 400 before anything is generated — on an empty
智谱 account even that free probe is unreachable.

### Numbers

- ✅ **`maxOutputTokens` = 131,072, measured.** `repro/32` now reads it out of
  `400 {"code":"1210","message":"max_tokens参数非法：限制数值范围[1,131072]"}`.
  It printed 读不出 at first: the probe's regex only spoke English
  (`range of max_tokens is [1, N]`). **That was the probe's hole, not the
  provider's** — fixed by teaching it the second wording, which does not remove
  the risk the probe's own header warns about, only spreads it across the three
  providers we actually have.
- ⚠️ **`windowLimit` is still documented-not-measured.** The overflow refusal
  carries no numbers (below), so the DeepSeek trick — read the window out of the
  refusal prose — has nothing to read. Distinguishing 1,000,000 from 1,048,576
  needs a prompt that _fits_, i.e. roughly a million billable input tokens. Not
  spent. The registry takes the low reading and says why.

### Errors, and the protection that was not there

Live overflow refusal, through this program's own stack
(`repro/53-does-the-overflow-reach-us.ts`):

```
[0] BadRequestError status=400 code=1261
    message: 400 Prompt exceeds max length
```

- 🔴 **The docs' wording is not the wire's.** 错误码 documents 1261 as
  `Prompt 超长`; the API says `Prompt exceeds max length`. The prose already
  drifts between doc and wire — which is why the fix keys on the code.
- 🔴 **`isOverflow` returned `false` for a textbook overflow.** langchain's three
  phrases match nothing here, so `ContextOverflowError` was never built and the
  summarise-and-retry path never ran: the turn just failed. Fixed by giving the
  registry `overflowCodes` and handing them to `contextWindow` the way
  `outputBudget` is already handed in — `compaction.ts` still knows nothing about
  providers. Now `true`.

### The outage that had nothing to do with overflow

🔴 **智谱's `tool_calls` delta carries no `role`, and it can be the first delta of
the stream.** Measured:

```
data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"call_…","function":{…}}]}}]}
```

The chunk class is chosen from `delta.role ?? defaultRole`, and `defaultRole` is
only ever what an earlier delta carried. OpenAI and DeepSeek always open with a
role-bearing delta; 智谱 sometimes does not — when it reasons first the stream
starts with `{"role":"assistant","reasoning_content":…}` and everything works,
and when it goes straight to the tool call it does not. The reply then
accumulates as a `ChatMessageChunk`, and langchain's own AgentNode refuses it —
_Invalid response from "wrapModelCall" … expected AIMessage or Command, got
object_ — **before a single tool runs**. One `?? "assistant"` in
`src/agents/model.ts`; `tests/streaming-role.test.ts` pins it on a stub, because
the provider only sometimes orders it this way.

⚠️ **Worth naming: this is why "it worked when I tried it by hand" is not
evidence.** Three manual streaming calls passed before the agent loop failed,
for no reason other than which delta arrived first.

### usage — both predictions held, and one doc claim was simply false

- ✅ **`cacheRead` works with no new code.** `prompt_tokens_details.cached_tokens`
  arrives in the OpenAI spelling and `@langchain/openai` maps it: a real agent
  turn logged `cacheRead: 5888` on both laps. **First of the three providers to
  need no fallback** (Moonshot needed the top-level `cached_tokens` read).
- 🔴 **`reasoning_tokens` exists**, though §3's schema has no such field:
  `completion_tokens_details.reasoning_tokens` observed at 81 and at 7, mapped
  straight into `output_token_details.reasoning`. **Moonshot's docs made the same
  omission and were wrong the same way** — two for two, so treat "no reasoning
  field documented" as unverified rather than as a fact.
- 🔴 **`reasoning_content` is returned by `glm-5.3-flash`**, though the API
  reference restricts it to the `glm-4.5` / `glm-4.1v-thinking` series (§5). That
  line is stale, as a model that cannot disable thinking implies.

### Behaviour

- ✅ **End-to-end agent turn works**: `--print` with a `Read`, two model calls,
  correct answer, `cacheRead` on both laps.
- ✅ **`ReasoningEchoCompletions` is harmless here.** No documented echo-back
  requirement, and the tool loop completes with it on — same position as
  DeepSeek: a safety net, not a requirement.
- ✅ **`clear_thinking: false` is not required, and cost nothing measurable**
  (`repro/54-what-clear-thinking-costs.ts`): both arms' second lap returned 200,
  and the token difference was inside the noise. So this program keeps sending no
  `thinking` field at all. ⚠️ Valid for _short_ conversations only — the price of
  retaining a chain of thought is a function of history length, and this probe's
  history was 250 tokens.
- ✅ **`tool_stream` is not needed.** The docs recommend it alongside `stream:
true`; tool calls arrive and parse without it.
- ✅ **`temperature` is never sent**, confirmed in the library
  (`base.js:31,235` → `completions.js:29`), so the docs' `(0,1)`-versus-`1`
  contradiction cannot bite this program.

## 7. Still unmeasured

Two, both for the same reason, and both cheap to state honestly:

1. **Exact `windowLimit`** — 1,000,000 or 1,048,576. The refusal names no number,
   so the only way to tell them apart is a prompt that _fits_ the larger reading,
   which bills roughly a million input tokens. The registry takes the low reading
   deliberately (see the entry's comment): on this provider an over-read is not a
   caught overflow, it is a failed request.
2. **Does the completion count against the window?** True for DeepSeek —
   `repro/33` — and the argument for `OUTPUT_BUDGET` being 16,384 rests on it.
   Same cost shape as (1): the informative outcome is the expensive one.

Everything else in this file has been measured. When either of these is worth a
million tokens, `repro/33-does-output-share-the-window.ts` is the probe to point
at 智谱.
