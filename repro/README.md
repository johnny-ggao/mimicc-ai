# repro / — 复现探针

**先复现，再定方案。** 这个目录里每个脚本都对应一个「当时不知道、靠论证也不该定」的问题，
跑一次就有答案。它们进 git 的理由和 `bench/` 一样：**结论在 `docs/adr/` 与 `CONTEXT.md` 里，
证据不能只存在于一台机器上。** 同样不进 prettier / eslint / tsconfig。

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

**只有 `08-overflow.ts` 花钱**（一次约 1.1M token 的未命中输入，标称 $0.15，实测 $0.09，
2026-08-13 用户批准）。其余要么打本地 stub server，要么纯算术，要么小请求。

⚠️ **任何「让某个调用失败」的探针，别用失败状态码**：带失败码的响应会被 `AsyncCaller` 重试六次
（实测一次溢出的 400 打了服务器**七次**）。用 200 + 空 `choices`。
