# mimicc-ai

一个跑在终端里的编码 agent：调模型 → 有工具调用就执行 → 结果回灌 → 再调模型。这份文件只定词，
不讲实现——实现变了词不该跟着变。

## Language

### 上下文的来源与权限

**操作方通道（operator channel）**：
线上 `role: "system"` 的那条消息。**只有我们写的内容进这里**——它是唯一无法被会话中的其它参与方
伪造的通道，所以进了这里就等于拿到操作方权限。
_Avoid_: 系统消息、system prompt（指通道时）

**项目指令（project instructions）**：
仓库根的 `AGENTS.md` / `CLAUDE.md` 的内容。**权限低于系统提示词**——谁能提交这个仓库，谁就能写它。
名字里有 instructions，是因为我们确实要模型照做；但它不能覆盖系统提示词里的任何规则。
_Avoid_: 项目约定、仓库指令、项目上下文

**注入（injection）**：
由 harness 而非模型，把内容放进消息历史。**与 prompt injection 是两个词**——后者是攻击，
中文里一律写全 `prompt injection`，不简称成「注入」。
_Avoid_: 装载、塞入、seed（指注入时）

**prompt injection**：
攻击面：进了上下文的内容里夹带指令，诱使模型把它当成操作方的话执行。**永远写全，不译**。

### 上下文的成本

**缓存前缀（cache prefix）**：
provider 按最长公共前缀命中的那一段。**请求里任何逐次变化的名字或编号都会砸掉它**，
而层序（哪一段排在前面）由 provider 决定，不由我们决定。
_Avoid_: 前缀缓存、KV cache

**变化频率（change frequency）**：
一段内容两次请求之间变不变。**它决定这段该排在哪**——不由重要性决定。

**所有权（ownership）**：
谁能写这段内容。**它决定这段该进哪条通道**——与变化频率是两条独立的轴。

### 循环

**回合（turn / run）**：
用户按一次回车到 agent 交还提示符之间。一个回合里模型可能被调用多次。
_Avoid_: 会话、轮次（指一次模型调用时）

**跳（lap）**：
回合内的一次「调模型 → 跑工具」。`beforeAgent` 每回合跑一次，`wrapModelCall` 每跳跑一次。

**thread**：
checkpointer 里的一条历史，由 `thread_id` 寻址。`/clear` 换一个新的，旧的仍然可寻址。
_Avoid_: 会话、session

**秤（the scale）**：
`src/usage.ts` 的 `usageMeter`，一次 provider 请求记一条。**每一项上下文工程改造都要用它称，
判据挂在 `input` 与 `cached` 上**——`output` 抖，只作参考。
