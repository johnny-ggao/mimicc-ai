# 仓库提供的内容一律进非操作方通道

仓库根的 `AGENTS.md` / `CLAUDE.md` 要自动进上下文，落点有两个：拼进系统提示词（`createAgent` 的
`systemPrompt` 参数），或作为一条 `HumanMessage` 进 `state.messages`。**我们选后者，理由是所有权
而不是性能。** 谁能提交这个仓库谁就能写这些文件，把它们放进 `role: "system"` 等于把仓库内容提升到
操作方（operator）权限——一个提交就能改写 agent 的安全规则。

## Considered Options

**拼进 `systemPrompt` 参数（否决）**——这条在缓存上其实**更优**：内容进程内不变，是完美的稳定前缀。
未来读者看到我们没选它，多半会以为是疏漏，所以要在这里写明是故意的。

**`dynamicSystemPromptMiddleware`（否决）**——它挂在 `wrapModelCall`，每跳跑一次；而 DeepSeek 的
层序是 `system → tools`（OpenAI 兼容 API 没有独立的 `system` 字段，系统提示词就是 `messages[0]`），
所以系统提示词逐次变化会连工具定义一起清零。内容若恒定，则退化成上一条，同样吃所有权否决。

**伪造一次 Read 的 `AIMessage(tool_calls)` + `ToolMessage` 配对（否决）**——来源语义上更诚实，
但历史里会多一条「模型决定调用 Read」而模型从没做过这个决定；且它把项目指令归进「工具结果」那一类，
将来清理老工具结果时会被一起清掉。

## Consequences

线上只有六个角色，**协议把「人类」和「不可信输入」压成了同一个 `user`**。所以选 `HumanMessage`
不是因为它语义上像「人说的」，而是因为它是协议里唯一那条非操作方通道。来源信息只能写在正文里
（`name` 字段在 user 分支不上线），所以包裹标签 `<project-instructions path="…">` 是 provenance
的唯一载体。

权限关系必须由**系统提示词**明说，标签名不承担这个职责。原先 `src/agents/prompt.ts` 里那句
`It outranks these defaults` 是这条决定的反面，已随本决定改写。
