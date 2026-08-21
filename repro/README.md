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
