# The loop does not judge correctness

The agent loop produces candidates and calls tools. It does not judge whether the
output is correct. Deciding who the judge is — and what oracle the verdict is
checked against — is a design decision each product makes for itself, not a
harness concern.

The non-obvious part is why correctness has no home in the harness even though
"the model may be wrong" is the most common failure an agent has. Two reasons,
each independent:

- **Correctness is a judgement, not a mechanical fact.** Detecting "wrong output"
  means comparing it to a standard — a golden answer, a test, a human label. A
  single-user CLI has none of these; its only standards are deterministic facts
  (exit codes, file contents, diffs). Without a reference, the only thing that can
  judge is another model, and an LLM judge is unreliable in three systematic ways
  — position bias, verbosity bias, and self-preference, the last of which a
  single-model program cannot even escape by switching judges
  (`.scratch/harness-engineering/research/17-llm-judge-practice.md`).
- **The harness is the runtime, not the task.** What the loop owns is already a
  full job: turn boundaries, tool dispatch, abort/failure/crash, compaction,
  memory. Its axis is mechanical and deterministic. Correctness belongs to whoever
  wrote the task, because only they can say what "done right" means for their
  business.

So the "error" axis — output that is wrong without throwing — splits in two: the
mechanical half (looping, tool stall, empty reply, capped completion) is the
harness's, detected deterministically and recorded as an observable
`stop_reason`; the judgement half (hallucination, wrong reasoning,
self-contradiction) is out of scope.

## Consequences

- The harness detects mechanical bad-signals and caps, never "wrong answers".
- LLM-as-judge, eval, and goal evaluators are not built into the loop. A product
  that wants them provides its own dataset/oracle and wires its own judge —
  outside the harness.
- "Deterministic scoring first" is not a preference; it is the only reliable
  observability a single-user CLI has.

## 增补（2026-08-27）：cap 的机制从一个变两个

「capped completion」的机制最初只有 loop guard 的 `loop_capped`；回合预算落地后
（ADR 0009）多了 `budget_exhausted`——token/墙钟耗尽、模型仍发工具调用时被 strip + 罐头收尾。
两者都走 `onCap` 的同一条结构化上报（`turn_capped`），都不是失败、不写失败 marker。
本 ADR 的轴不变：cap 判的是机械信号（重复、空转、预算耗尽），不是答案对不对。
