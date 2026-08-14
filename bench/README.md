# bench / — 量测基准

每一项上下文工程改造都要在这里称一遍。秤本身是 `src/usage.ts` 的 `usageMeter`（一次 provider
请求记一条），这个目录放的是**跑秤的固定任务**。

从仓库根跑，需要 `.env` 里的 `LLM_API_KEY`：

```
bun bench/measure.ts
```

## 三条量测规矩（每条都是踩出来的）

1. **跑两遍，只取第二遍。** DeepSeek 的前缀缓存跨进程存活，冷热不对称会被算成改造效果。
2. **只读冻结的 fixture。** 原本读 `src/`，而每张票都在改 `src/`——"同一个任务"就不是同一个了。
3. **每个问题点名文件路径。** 只给符号名会逼模型去搜，而搜索是变动成本：同一任务两遍差 17%。
   推广出去的判据是——**一个成本取决于「模型怎么找东西」的基准，量的是模型，不是被测的改动。**

## 不可以做的事

- **改 `measure.ts` 的三个问题、或改 `fixture/` 下任何一个字节 = 作废全部历史基线。**
  要加场景就新开一个文件（`measure-agents-md.ts` 就是这么来的）。
- 因此这个目录**不进 prettier / eslint / tsconfig**：一次重排就够毁掉可比性。它进 git 是因为
  它是 `docs/adr/` 与 `CONTEXT.md` 里那些结论的证据，不是因为它是产品代码。

## 判据挂在哪

**`input` 与 `cached`。`output` 只作参考**——三次跑出 261 / 466 / 363，模型有时思考有时不思考，
而回答又是下一轮的前缀；`input` 侧两遍只差 0.5%。

**正式基线**（`deepseek-v4-flash`，冻结 fixture，跑两遍取第二遍）：
6 次请求，input 19718 / cached 18432（**93%**）/ output 363。
**命中率本来就 93%，是后面每一项裁剪与摘要的对手盘**——省下的 token 要跟这个折扣比，不是跟原价比。

## 目录里有什么

| 脚本 | 量什么 | 花钱 |
| --- | --- | --- |
| `measure.ts` | **正式基线**：三个只读回合的固定任务 | 是（小） |
| `measure-agents-md.ts` | AGENTS.md 注入开 vs 关的差（票 04） | 是（小） |
| `measure-reread.ts` | 模型改完文件会不会复读（票 05 的前提） | 是（小） |
| `instructions-probe.ts` | 「没有标签 = 没有文件」这条契约模型读不读得懂 | 是（小） |
| `order-probe.ts` | DeepSeek 的缓存层序是 `system → tools`（与 Anthropic 相反） | 是（小） |
| `raw-usage.ts` | provider 归一化之前到底报了哪些字段 | 是（小） |
| `window-budget.ts` | 要多少次 Read 才填满 1M 窗口 | 否（纯算术） |
| `wire-check.ts` | 两种系统提示词形状上线到底长什么样 | 否（本地 stub server） |

`fixture/`（`measure.ts` 用）、`fixture-agents-md/`、`fixture-edit/` 三份都是**冻结**的。
`measure-reread.ts` 会把 `fixture-edit/` 拷进仓库根的 `bench-work/`（gitignore）再改，
原件从不被碰——`bench-work/` 不放在点目录里，因为 `Glob`/`Grep` 看不见点目录（工具层缺陷，未修）。
