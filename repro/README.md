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

**两个花钱**：`08-overflow.ts`（一次约 1.1M token 的未命中输入，标称 $0.15，实测 $0.09，
2026-08-13 用户批准）与 `19-orphan-tool-call.ts`（三次小请求，`maxTokens: 16`，
合计 < $0.001，2026-08-19 用户批准）。其余要么打本地 stub server，要么纯算术，要么小请求。

⚠️ **任何「让某个调用失败」的探针，别用失败状态码**：带失败码的响应会被 `AsyncCaller` 重试六次
（实测一次溢出的 400 打了服务器**七次**）。用 200 + 空 `choices`。
2026-08-19 在 `19-orphan-tool-call.ts` 上**原样复现**：一次真 400，`onFailedAttempt` 数到 7 次。
那个探针必须打真 provider（问的就是 provider 收不收），所以它只能把重试**数出来**，压不掉。
