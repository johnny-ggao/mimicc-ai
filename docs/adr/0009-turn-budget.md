# 回合预算：工作预算在 token/时间轴上，步数不是预算

圈数工作预算（`LAP_BUDGET` → 节点上限的翻译）**整体删除**（commit `5fea7ee`，另参
`189f6ec` 之前的两次上调 `4af4cac`）。一个回合花多少，现在按两个轴计：**累计 input token**
（默认 = 窗口 × 4）与**墙钟**（默认 10 分钟）。耗尽先注入说明、给模型一次不带新工具调用的
交卷机会，它还发工具调用才被 cap（`budget_exhausted`）。`RECURSION_LIMIT` 退为 langgraph
的格式占位（它要求 ≥1 的有限数，取 1_000_000），真正的护栏 = 回合预算 + loop guard +
stall guard + 墙钟。

**为什么**：csv-to-parquet 三连撞顶（48 → 102 → 150 节点，`.scratch/external-bench/`
票 03 存档为证），每次把「健康地忙」的回合当坏的切掉——它每圈都在修不同的 bug，loop guard
从不响。圈预算的数值只能逐任务追着现象调，而上一轮上调（16→24）的验证轮证明 24 仍不够
（25 次调用撞 150，离产出文件差 1-3 圈）。同一张票里的横向调研（pi / deepseek-harness /
deer-flow 本地 checkout 一手源码）结论一致：**没有一家把步数当工作预算**——pi 的 drive loop
逐字 `while (true)`、DSH `while (await this.turn())` 直到模型完成或 max-tokens、deer-flow
只有单一崩溃网（默认 100、服务端钳制 1000）。圈翻译（`NODES_PER_LAP`）还有自己的漂移源：
栈每加一个中间件，一圈的节点数就变，预算暗中缩水。

## Considered Options

- **16→32 继续上调（否决）**——用户判定「逐任务调上限不是办法」，且 24 圈的验证轮已证明
  再调也追不上；420s 墙钟还会先于节点成为约束。
- **pi 式无上限（采纳为「无步数预算」）**——langgraph 硬性要求 `recursionLimit` 是 ≥1 的
  有限数（`pregel/index.js:1010` 否则 throw），所以「无上限」落地为占位数 `1_000_000`：
  撞到它的图不是忙、不是坏，是失控。
- **token/时间轴（采纳）**——每次调用的 input ≈ 当前视图大小，所以每 turn 总 input ≈
  跳数 × 视图：token 预算随窗口自标定，不需要逐任务拍数；墙钟兜底防「不花 token 的失控」。

## 关键子决定

- **单位 token 主 + 墙钟兜底；粒度 per turn；耗尽先交卷机会、再 cap。** 交卷机会是 DSH 式
  自然收尾（模型在预算内自行结束），cap 才是罐头收尾——`onCap("budget_exhausted")` 与
  loop guard 的 `loop_capped` 走同一条结构化上报（`turn_capped`）。
- **默认 token = 窗口 × 4**（`MIMICC_TURN_TOKEN_BUDGET_MULTIPLIER` 覆盖）、**墙钟 10 分钟**
  （`MIMICC_TURN_TIME_BUDGET_MS` 覆盖）。硬题实测 83 万 input/turn，4 倍窗口是 ~4.8 倍余量。
- **`RECURSION_LIMIT = 1_000_000` 占位**；loop guard / stall guard 不动（病理护栏是预算的
  搭档，不是对象）。
- **判据是「上限不再绑定」，不是分数**：复验只跑 csv-to-parquet——递归注入语消失、任务
  通过（agent 84 秒）；全量 9 题复跑——5/9、9/9 会话存档、**全 9 题零递归注入语**。⚠️
  通过与否在单题方差里，不可读成预算修复的因果；可读成因果的只有「预算/递归上限不再是
  绑定约束」。

## Consequences

- **失控护栏从前排（步数网）换成预算与守卫**：模型不断发**不同**的、成功的工具调用时，
  只有 token/墙钟预算能停它——比旧网（150 节点）宽松得多，这是 pi/DSH 同款取舍；重复调用
  与连续失败仍被 loop guard / stall guard 在前排截住。
- **测试里「靠跑到 recursion limit 结束」的假设随设计删除**：stallguard 测试改为靠墙钟
  预算结束 turn——这正是新护栏接班的直接证据。
- `describeError` 的 recursion 文案不再引用步数；词表新增「回合预算」、改写「被 cap 的完成」
  与「失败」的边界（失败清单里不再有「撞 RECURSION_LIMIT」）。
