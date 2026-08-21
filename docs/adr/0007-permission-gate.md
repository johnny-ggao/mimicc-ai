# 权限门：一个统一入口判 allow / ask / deny

`src/agents/loop.ts` 的确认门（`humanInTheLoopMiddleware` + `CONFIRMATION_POLICY`，只拦 `Bash`、
其余 fail-open）和 `src/tools/workspace.ts` 的路径约束（`resolveInside` + `SECRET`，工具体内同步
throw）是两套彼此不知情的机制。**它们被替换成一个权限门**：一个纯函数规则引擎
`decide(toolCall) → allow | ask | deny`，两个 effector 挂在它后面——deny 走 `wrapToolCall`
（返回拒绝 `ToolMessage`，不跑工具）、ask 复用现有确认门的 interrupt。

## 为什么是替换，不是另加一层

另加一层会得到三套并存的权限机制（确认门 / `resolveInside` / 新规则层），而 `workspace.ts` 的注释
已经写明：写两遍的安全检查会漂移。统一成一个决策点是那条注释的自然结论。

## Considered Options

**deepagents 式两条正交轴（否决）**——路径 allow/deny 在工具体内（`checkPermission` 每个工具开头），
「ask」是另一套 interrupt。它最接近「纯路径 glob 门」，但：① allow/deny 无 ask；② 无命中默认放行
（fail-open）；③ 检查散在每个工具体内——正是要消灭的漂移。

**保留确认门、只把 `resolveInside` 泛化成可配置（否决）**——最小改动，但 `Bash` 依旧完全游离在
路径约束之外、靠「永远 ask」硬扛，而「允不允许」和「问不问」两条轴仍旧分属两套机制。

**统一规则引擎（采纳）**——一个 `decide()` 纯函数，deny/ask/allow 三判同源。

## 关键子决定

- **deny 恒胜 + 类别优先**（deny → ask → allow），不是声明序首条命中。排序不该是安全边界。
- **`Bash` 按命令前缀进规则**（`Bash(git status:*)`），不按路径——路径 glob 对一个 shell 命令无效。
- **硬地板不可放宽**（逃出工作目录 + `SECRET` 正则），任何层的规则都翻不动。「允不允许」与「问不问」
  是两条轴：自动模式只翻 ask→allow，永不碰 deny。
- **两层配置、仓库只能更严**：用户级 `~/.mimicc/permissions.json` + 仓库级 `.mimicc-permissions.json`
  （tracked）；合并严格者胜；仓库层只许写 ask/deny。
- **内置基线**：只读 allow / Write・Edit ask / `Bash` ask——「默认 ask」落在改型工具上，只读的
  Read/Glob/Grep 不设问（否则撞上「频繁的闸没人读」）。**未列工具默认 ask（fail-closed）**：新注册的
  改型工具不会静默放行，而是问，直到被显式命名进 allow 集。

## Consequences

- 姿态从 fail-open 翻成「改型默认 ask」：Write/Edit 今天自动放行（靠 `resolveInside` 圈），此后默认问。
- `resolveInside` 的拒绝从工具体内同步 throw 变成 middleware 的 deny `ToolMessage`；`SECRET` 正则收敛到
  规则引擎一处，Grep 的 `isSecret` 改为从那里 import。
- 确认门不再是独立机制，而是权限门三判里的「ask」出口；其拒绝理由钉住、resume 恢复路径原样保留。
- 子 agent 保留只读（`docs/adr/0003` 原样不动——它不能 `interrupt()` 问），但 deny 半权限门经
  `agentStack` 共享给它，所以 Explore 的 `Read` 仍被硬地板与 deny 规则拦住。
