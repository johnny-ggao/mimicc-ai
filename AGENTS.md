# mimicc-ai

学 harness 工程的仓库：产品是一个跑在 LangGraph 上的编码 agent（`src/`），但目的是学机制，
不是发产品——探针挖出的产品缺陷记一笔就停，票自己的判据是刹车。

## 开工先读

- `CONTEXT.md` — 领域词表。动 `src/` 之前先对词，词表里的词按词表的定义用。
- `docs/adr/` — 已定的决策。别重开已判的问题；新决策落新 ADR。
- `docs/harness-principles.md` — 这个仓库怎么做事的十二条原则，每条带自己的边界。

## 最常撞的几条规矩

- **先复现再定方案**：拿不准的机制问题先写便宜探针（`repro/`，规矩见 `repro/README.md`）。
- **抄成熟参考的机制，不抄常数**：pi（`/Users/johnny/Work/Project/pi`，只读）是默认参照；
  抄不动的地方明说。
- **bench/ 是冻结的**：改 `measure.ts` 的三个问题或 `fixture*/` 一个字节 = 作废历史基线。
  守卫：`bun run bench:fingerprint`；规矩见 `bench/README.md`。
- **直提 main**，提交拆开、各自跑绿；提交信息中文，`类型: 主题 —— 一句什么变了/为什么`。
- 门禁与 CI 同款：`bun run check` + `bun run probes:smoke`。

## 仓库外的东西

`.scratch/`（gitignore，只在这台机器）：各执行线的地图与票，结构约定在 `.scratch/README.md`。
`learn/MISSION.md`（gitignore）：任务清单。这些是有意的机器本地制品，取舍登记在
`docs/harness-principles.md` 原则 4 下。
