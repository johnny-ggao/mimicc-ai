# repro / — 复现探针

**先复现，再定方案。** 这个目录里每个脚本都对应一个「当时不知道、靠论证也不该定」的问题，
跑一次就有答案。它们进 git 的理由和 `bench/` 一样：**结论在 `docs/adr/` 与 `CONTEXT.md` 里，
证据不能只存在于一台机器上。** 同样不进 prettier / eslint / tsconfig。

## 那它们腐烂了谁知道？——`bun run probes:smoke`

**改接口会无声打死探针。** 2026-08-19 实测过：给 `AgentGraph` 加一个方法、给 `ReplOptions`
加两个字段，`repro/15` 当场抛，而 `bun run check` 全绿。

**判过一次：不把 `repro/` 纳入 typecheck**（2026-08-20）。量过代价——**32 个错、9 个文件**，
其中绝大多数是 strict 噪音（探针本来就写得松），而最像「真错」的那条是**假信号**：
`profile-probe.ts` 的 `getProfileLimits` 运行时确实导出
（`langchain/dist/agents/middleware/summarization.js:573`），只是 `.d.ts` 不声明它，
探针注释里写着这是**故意穿过 dist 拿的**。反过来，同一天真正烂掉的那个
（`05-write-lost-update.ts` 读弃用的 `LLM_API_KEY`，今天的 `.env` 不再定义它，
死在客户端构造上、一个请求都没发出去）**typecheck 一个字都不会说**。

所以判据是**起不起得来**：`scripts/probe-smoke.ts` 把每个探针跑一遍，断言退出码。
**花钱的那三个也在里面**——它们跑在一个只回 200 + 空 `choices` 的本地 stub 上，
判据换成「stub 收到过请求没有」，即「它活到了发请求那一步」。⚠️ 不用死端口：
连接被拒会触发下面那条重试警告，实测 30 秒内读不到任何信号。

⚠️ **它抓不到什么，写在这里免得被当成保险**：一个探针可以「跑得起来」但**答错**——
比如引用一个已经改了语义的符号。冒烟只回答「它还活着吗」，不回答「它的结论还成立吗」。
后者只有重新读它的注释和输出才知道。

从仓库根跑，例如 `bun repro/profile-probe.ts`。

| 脚本 | 回答了什么 | 花钱 |
| --- | --- | --- |
| `profile-probe.ts` | langchain 知不知道 `deepseek-v4-flash` 的窗口多大？**不知道，它编了 4097** | 否 |
| `05-stale-edit.ts` | Read 与 Edit 之间文件被改会怎样：`locate()` 三种走法全部拒绝 | 否 |
| `05-write-lost-update.ts` | 模型会不会拿 `Write` 覆盖读过的文件（3 次采样：0/3） | 是（小） |
| `06-context-editing.ts` | `contextEditingMiddleware` 的剪枝到不到 state：**到，永久** | 否（stub） |
| `08-delta-channel.ts` | checkpointer 到底往盘上写了多少字节（**量在写入侧**） | 否（stub） |
| `08-jsonl-roundtrip.ts` | 消息写成 jsonl 再读回来还是不是原来那条 | 否 |
| `08-load-trust-boundary.ts` | `load()` 的信任边界：手编一行就能实例化任意类 | 否 |
| `08-overflow.ts` | 撞满 1M 窗口会怎样：**硬 400**，错误串命中 langchain 的匹配 | **是 ≈ $0.09** |
| `08-transcript-survival.ts` | 摘要之后完整历史还在不在 checkpointer 里 | 否（stub） |
| `09-growth.ts` | 落盘量随回合数怎么涨：O(n²) → O(n) 的验收判据 | 否 |
| `10-overflow-path.ts` | 兜底路径：溢出接住了吗、接住之后切点动了吗 | 否（stub） |
| `10-summary-fail.ts` | 摘要一直失败时一个回合还能不能走完 | 否（stub） |
| `13-crash-mid-tool.ts` | 崩溃打断一批工具调用后盘上剩什么：**默认档 `"async"` 会丢掉 intent 且整批重跑，`"sync"` 不会** | 否（stub） |
| `14-recovery-end-to-end.ts` | 崩溃打断**我们自己的 agent** 之后重启：跑完的调用会不会再跑一次（**不会**） | 否（stub） |
| `18-resume-at-an-open-gate.ts` | 门**还开着**时被 kill，重启后那道门还在不在：**在**（`getState` 里 `tasks=1 interrupts=1`），且冷启动的 `Command({resume})` 能答它；**但拿旧 id 直接敲一句话会把它吃掉** | 否（stub） |
| `19-orphan-tool-call.ts` | 悬空的 `tool_calls`（后面没有 tool 结果）真 provider 认不认：**400，硬错误**；完整工具轮与平的历史都被接受，所以原因就是悬空本身 | **是 ≈ $0.001** |
| `20-abort-mid-tool-then-type.ts` | 出货路径造不造得出那个形状：**造得出**——Ctrl+C 打断跑着工具的回合、再敲一句话，下一次请求就带着悬空的 `tool_call` | 否（stub） |
| `21-when-a-turn-closes.ts` | 把 `prune()` 接到 `afterAgent` 上安不安全：**安全**——中止的回合到不了 `afterAgent`，已 settle 的记录留了下来；而跑完的回合把旁挂清空 | 否（stub） |
| `22-injected-messages-hit-the-message-stream.ts` | `beforeAgent` 注入的消息会不会被 `streamMode: "messages"` 当成模型的话流出来：**会，而且只在第一个回合**（后面的回合它已经在节点输入里，被 langgraph 的 dedup 挡掉）；skill 目录与项目 instructions **两个都漏** | 否（stub） |
| `23-crash-mid-approved-tools.ts` | 门批准之后、工具跑到一半断电，冷启动还剩什么：**`next=["tools"] tasks=1` 但 `interrupts=0`**——盘上看得见，而 `adopt` 只看 interrupts 所以看不见；`invoke(null)` 在冷进程里能收完（合成结果、**副作用不重复**）并拿到最终回答 | 否（stub） |
| `24-what-a-failed-turn-leaves.ts` | 一个回合**失败**之后历史里留下什么：**`human → ai`，那条 ai 是 harness 写的失败标记**（`FAILURE_PREFIX`），不是「一条没人回答的 user 消息」——旧 `README.md` 记的那条**已经不成立**，撤它之前核出来的 | 否（stub） |
| `25-interrupt-inside-a-tool-body.ts` | 工具体里 `interrupt()` 能不能问：初测**堵死**，两个原因都是我们自己的缺陷（`stallGuard` 把 `GraphInterrupt` 当异常吞掉，`toolRecovery` 把「停下来问人」判成「进程死在半路」）——**已修，d9406c9**，复测四个场景全部与 `bare` 一致。剩下一条修不掉：**体会整个重放**（`kinds.ts:228` 那条反证对工具体成立），所以问题工具仍然走 `afterModel`——那条路上没有体可重跑 | 否（stub） |
| `26-handing-stdin-to-raw-mode.ts` | 方向键选单要把 stdin 从 readline 手里接过来：**`rl.pause()` 是错的**——选单里的 Enter 被两边各收一份，readline 那份变成空行进队列（`readDecision` 专门防的就是空行）；**`rl.close()` + 重建是干净的**，四项全过。硬边：交接后要自己 `stdin.resume()`；`rl.close()` 会触发 `repl.ts:249` 的 `ended = true` | 否 |
| `27-does-the-model-reach-for-clarify.ts` | 给了它 `Clarify`，它会不会**先问再动手**：基线 12 跑 **0 次**；判断挂进工作流第一步 + 工具描述里再写一遍 + cost/benefit 之后 `build` **0/5 → 5/5**、反向断言 `trivial` 仍 0/2。⚠️ 又试三版去攻 `analysis` 全部没成，**而最大的收获是方法上的：n=5 分不出这几版**（`build` 四版 5/4/3/4 全在噪声里）——`analysis` 已降为观察项，判据只落在 `build` 与 `trivial` | **是**（一轮约 60k in / 20k out） |
| `28-what-reasoning-costs-the-screen.ts` | 终端上那段灰字：**一个回合的灰字段数 == 模型调用次数**（1 + 工具跳数），所以「段数太多」不是「一段太长」；`reasoning_content` **落盘且冷读回得来**（图里标着「读代码读不出来」的那条前提，核掉了）；**活着那条印它、`renderHistory` 不印**——两条渲染路径不一致，量出来的 | 否（stub） |
| `29-what-reasoning-really-costs.ts` | 屏幕上思维链与正文各占多少行、真模型是不是每一跳都想、单段峰值。**用出货那套装配量**（真提示词、真工具），只把 `maxTokens` 压到 2048 | **是**（3 个回合，约 50k in / 15k out） |
| `30-the-thinking-row-on-a-real-terminal.ts` | 那一行思考在**真 pty** 上印成了什么：把 `\r` 与 `\x1b[2K` 真的执行一遍之后，**屏幕上只剩每段一行痕迹、思考原文一个字不留**；子 agent 的点与状态行不打架（点在痕迹行之后）；正文完整。🔴 **顺带抓到一个出货 bug**：这个 pty 报 0 列，而 `process.stdout.columns ?? 80` 接不住 0，整行会塌成一个省略号 | 否（假图，连模型都没有） |
| `31-the-cache-bill.ts` | 每轮都变的那一块放 messages 开头 vs 末尾，前缀缓存差多少。**deepseek-v4-flash**：三个臂 input 逐位相同、只差位置，HEAD **4.0%** / TAIL **39.3%** / 对照组（块永不变）**61.9%**——**放头部基本等于没有缓存**，命中恒定在 system 那一段。🔴 **但「尾部块只花它自己那点」证伪**：实测代价是预测的 2.7～11 倍，逐轮恰好少一个 history chunk，机制不明。⚠️ 同一个探针在 `kimi-k3` 上**量不出来**——引擎 `429 engine_overloaded` 时前缀缓存几乎不服务 | **是**（约 48.8 万 in，out 可忽略） |
| `32-what-the-provider-allows.ts` | 注册表 `maxOutputTokens` 的证据指针：拿一个不可能的 `max_tokens` 去撞，从拒绝文案里读出每个注册型号的真实输出上限，和注册表对表。🔑 **`GET /models` 没有任何上限字段**（2026-08-24 核过，只有 `id`/`object`/`owned_by`），所以「主动通过 API 获取」这条路在 provider 侧不存在——**这也正是它是探针而不是启动步骤的理由**：它挂在错误文案的措辞上，对面改一个字就静默失效 | 否（每发都是 400，零计费） |
| `33-does-output-share-the-window.ts` | 窗口算不算输出？🔑 **算**——provider 逐字：*maximum context length is 1048576 … you requested 1249764 (856548 in the messages, 393216 in the completion)*，对照组同输入配 `max_tokens: 4096` 则 200。**所以要多少输出就少多少历史**：发满 393,216 会把有效输入压到 655,360，低于压缩阈值 838,860，溢出保护来不及触发。⚠️ 顺带二次证明了压缩那 20% 余量的必要性——**本探针自己的填充估算偏了 22%**（目标 70 万，实际 856,548）| **是**（约 86 万未命中输入 ×2 发） |
| `35-how-wrong-is-our-estimate.ts` | `estimate()`（字符÷4）对着 provider 的 `prompt_tokens` 量五类内容。🔑 **误差按内容类型差 2.7 倍**，而且**低估的那些才是我们真会遇到的**：英文散文 1.11 / TS 源码 1.04（偏高，安全）｜🔴 **中文 0.48**、JSON 0.67、高熵十六进制 0.41（低估，危险）。**用户就是用中文提问的。** ⚠️ 这张表**不提供修正系数**——正解是 `requestTokens` 那种锚定式估算 | **是**（约 3 万 in，$0.01 量级） |
| `36-does-finish-reason-survive-streaming.ts` | 流式路径上 `finish_reason` 还在不在最终那条 AIMessage 上。🔑 **在——两条路径都读得到**，且 `usage_metadata.output_tokens` 也带得回来（能和额度比，判是谁截的）。读代码读不出来是因为流式是分片拼的：`src/agents/model.ts:183-187` 只管往分片上塞，「拼完还在不在」是拼装逻辑的性质 | 否（本地 stub） |
| `37-does-position-change-adherence.ts` | 同一条二值规则放三个位置（system / 视图头 / 视图尾）× 两档深度，遵循与取回分开发。🔑 **deepseek-v4-pro，31.7 万 token 深处，三个位置全部 5/5**——**换位置没有可测差异，规则放在最前面也照样被遵守**。⚠️ **天花板效应**：满分意味着这把尺子量不出小差异。🔴 v1 栽过两次：`max_tokens: 256` 装不下 reasoning，正文空被误记成「没取回」；对照组只验了一半，坏的正是没验那一面 | **是**（深档每臂约 31.7 万 in） |
| `40-does-freezing-memory-pay.ts` | 冻结记忆块之后，改一次记忆还要不要缓存的钱。**走真 agent 和真中间件栈**（不是合成消息——这正是 `repro/31` 答不了这问题的原因），三个臂：QUIET（记忆不变，对照）/ CHURN（每轮加一条）/ NONE_（无记忆，第二对照）；**新旧两版各跑一遍**。🔑 **deepseek-v4-pro：CHURN−QUIET 从旧代码的 −10.4 收到新代码的 −4.2**，四个复本方向幅度一致。⚠️ **不能比跨运行的总数**：新 r1 的 QUIET 只有 76.9% 而其余三个复本都是 92.2%，那是首次填充没赶上；**差值对暖机免疫，总数不免疫**。🔴 **顺带独立复现了 `repro/31` 那个没解释的现象**：尾部块的实际代价 ≈ 自身体积的 **2.3 倍**（不同型号、不同路径） | **是**（两版合计约 52.7 万 in） |
| `34-can-a-middleware-change-max-tokens.ts` | `wrapModelCall` 能不能决定这一发的 `max_tokens`。🔑 **能，但只有换实例这一条路**：`@langchain/openai/dist/chat_models/completions.js:60-61` 读的是 **`this.maxTokens`（实例字段）**不是 call options，而这个版本的 `ChatOpenAI` 连 `.bind` 都没有（实测抛）。✅ **换实例不丢工具**——`AgentNode.js:143-145` 在中间件之后才 `#bindTools(request.model, …)`，线上 `tools` 仍是 1。⚠️ `request.model` 就是我们自己那个实例（`===` 为真），字段可读 | 否（本地 stub，不出网） |
| `38-does-the-written-check-run.ts` | 写在 `AGENTS.md` 里的那道「自动检查」，出货的 harness 上到底跑不跑。主臂给一个**应该失败**的输入（这周只干了一件事，凑不出 2 个亮点）。🔑 **deepseek-v4-pro：3/3 停下来问，且点名了那道检查**（*自动检查会因亮点不足而不过*）；**捏造 0/3、静默略过 0/3**；对照组 3/3 干净通过。⚠️ **只有让传感器不通过才看得见它跑没跑**——输入本来就满足时，「检查跑了并通过」和「根本没跑」长得一模一样。🔴 捏造没发生很可能是 `Clarify` 的功劳（它给了第二条出路），不是模型的 | **是**（约 10.8 万 in / 1.7 万 out） |
| `39-does-the-check-slot-matter.ts` | 把**同一条要求**（避免套话）从「风格要求」挪进第 4 步「自动检查」，遵循率变不变。🔑 **没有可测差异**：被点名的词两臂都 0/3 漏出，没点名的 BASE 漏 3 次 / CHECKED 漏 4 次，**臂内方差大于臂间差异**。⚠️ **它证伪的只是「换个小标题就能得到反馈」**——两臂都没有引入「行动之后的新观测」，所以在「反馈有没有用」这条轴上**零信息量**（这一条我第一版放大过，见 `.scratch/deterministic-gate/issues/02`） | **是**（约 13 万 in / 2.3 万 out） |
| `41-does-the-gate-hold-in-the-loop.ts` | read-before-write 那道闸装在出货循环上还成立吗。四格：①a 不指定工具 → 🔴 **模型走 `Bash` 绕过去了，闸根本没被触到**（D1 那条「已知缺口」不是理论上的）；①b 指定 `Write` → 拦下、文件没变；② 读了再改 → 通过、无误报；③ 改两次 → `Read → Edit → Edit →` **拦** `→ Read → Edit`。🔑 **③ 答了单测答不了的那问：拦下之后模型接得住吗——它去重读了**，不是原地重试也不是放弃。⚠️ `thread_id` 不能带中文（检查点按文件名校验，第一版三格全抛） | **是**（约 5.6 万 in / 1.6k out） |
| `42-what-post-hoc-hashing-costs.ts` | 选项 C（每条 `Bash` 之后重 hash 所有带标记的文件）要多少延迟。🔑 **可以忽略**：真实会话的标记数是 1 / 2 / **19**（`.mimicc` 数出来的上界），N=19 时中位 **0.34ms**，是最便宜的一条 `Bash`（`ls` 3.1ms）的 11%、`git status` 的 3%。悲观档 N=152 也只有 1.79ms。⚠️ **这是延迟不是 token**——C 只在真检测到变化时才往上下文里放东西 | 否（无模型、无网络） |
| `43-does-a-real-task-reach-for-write.ts` | 给它**真实的写码任务**（不指定工具），它会不会自己伸手拿 `Write`/`Edit`。🔑 **会——3/3 格都用了，6 次调用**，所以票 04「五条 session 里 0 次」是**样本全是只读任务**，不是模型不用写工具（`Write`/`Edit` 早在 `633ea63`／08-12 就进了工具表，早于那五条）。🔑 **但闸 0/3 次拦下**：②格模型自己就 `Read -> Read -> Edit -> Edit`——**缺的从来不是「写」的实证，是「不读就写」的实证**，而且闸在真任务上零误报。⚠️ `Bash` 三格都用了，但只做 `ls`／`bun test`，**一次都没拿来写**——`repro/41` ①a 那次绕过很可能是提示措辞推出来的 | **是**（约 6.8 万 in / 1.6k out） |
| `44-was-it-the-wording.ts` | `repro/41` ①a 那次「模型用 `Bash` 绕开闸」，是措辞推出来的吗。把那半句当变量、其余一字不动，两臂各 5 次。🔑 **是措辞的锅，完全分离**：照抄 ①a 的 A 臂 **5/5 走 `Bash`**（逐字都是 `printf 'REPLACED' > notes.md`），只删掉 *Do not read the file first — just write it.* 的 B 臂 **0/5**、全部自己走 `Read → Edit`（Fisher 双侧 p≈0.008）。⚠️ **缺口仍是真的**，但不是模型的默认倾向，且真实交互里那条命令在 `auto` 关时判 `ask`（`decide()` 实测）——关它的是确认门。🔴 **与 41 不完全可比**：41 跑时 `Write` 还在闸里，后来摘掉了 | **是**（约 11.1 万 in / 3.5k out） |
| `45-how-many-laps-fit-in-the-limit.ts` | `RECURSION_LIMIT = 48` 等于几圈。🔑 **8 圈，每圈 6.0 个节点**（`1 agent + 4 afterModel + 1 tools`），而那 4 个 afterModel **全是守卫本身**（LoopGuard／EmptyReplyGuard／Clarify 门／确认门）。🔴 **`loop.ts:41-48` 那段「守卫会先于上限触发」说反了一半**：守卫判的是病态（同调用重复 3/5、连续失败 3），不是长度——**一个老实跑 12 个不同往返的任务一个守卫都不响**。起因是外部 benchmark 实测撞顶（只走了 7 圈）| 否（本地 stub） |

**三个花钱**：`08-overflow.ts`（一次约 1.1M token 的未命中输入，标称 $0.15，实测 $0.09，
2026-08-13 用户批准）、`19-orphan-tool-call.ts`（三次小请求，`maxTokens: 16`，
合计 < $0.001，2026-08-19 用户批准），与 `29-what-reasoning-really-costs.ts`
（3 个回合，约 50k in / 15k out，2026-08-21 用户批准）。其余要么打本地 stub server，
要么纯算术，要么小请求。

⚠️ **花钱的探针必须同时登记两处**：这张表里的「花钱」栏，**以及 `scripts/probe-smoke.ts`
的 `PAID`**。只登记前者的后果是：`bun run probes:smoke` 会拿真 provider 去跑它，
然后在 `TIMEOUT_MS` 上限被杀掉——**跑一次守卫就花一次钱，而且它永远报红**。
2026-08-21 在 `27-does-the-model-reach-for-clarify.ts` 上实际发生过。

⚠️ **别用 `expect -ex {中文}`**：这台机器上的 expect 匹配 CJK 模式会**直接被信号 10 打死**
（2026-08-20 实测，`/bin/echo 明白了` + `expect -ex {明白了}` 就复现，退出码 138）。
死的是 expect 这个**父进程**，被驱动的子进程随后收到 SIGHUP——现场看起来像「程序跑到一半崩了」，
查半天才发现被测的东西一直是好的。观测标记一律用 ASCII（`[[TUI-CLOSE]]`、`ALLDONE` 这种）。

⚠️ **任何「让某个调用失败」的探针，别用失败状态码**：带失败码的响应会被 `AsyncCaller` 重试六次
（实测一次溢出的 400 打了服务器**七次**）。用 200 + 空 `choices`。
2026-08-19 在 `19-orphan-tool-call.ts` 上**原样复现**：一次真 400，`onFailedAttempt` 数到 7 次。
那个探针必须打真 provider（问的就是 provider 收不收），所以它只能把重试**数出来**，压不掉。
