import { expect, test } from "bun:test";

import { buildSystemPrompt, STATIC_PROMPT, type PromptEnvironment } from "@/agents";

const ENV: PromptEnvironment = {
  cwd: "/tmp/example",
  platform: "darwin",
  today: "2026-08-11",
  isGitRepo: true,
};

// The load-bearing property of this module. DeepSeek's context cache keys on the
// longest common prefix, so the static block must stay first and byte-identical;
// interpolating anything into it would cost a cache hit on every turn.
test("keeps the static block as an untouched prefix", () => {
  const prompt = buildSystemPrompt(ENV);

  expect(prompt.startsWith(STATIC_PROMPT)).toBe(true);
  expect(prompt.slice(STATIC_PROMPT.length)).not.toContain(STATIC_PROMPT);
});

// 静态段拆成了带中文注释的分段再拼回来，因此多了一种静默失败：任何一段多出个换行或
// 尾随空格，整段提示词的字节就变了，历史缓存前缀全部失效。这条守着拼接契约。
test("has no stray whitespace that would shift the cached prefix", () => {
  expect(STATIC_PROMPT).toBe(STATIC_PROMPT.trim());
  expect(STATIC_PROMPT).not.toContain("\n\n\n");
  expect(STATIC_PROMPT).not.toMatch(/[ \t]+$/m);
});

test("appends the per-session environment after it", () => {
  const tail = buildSystemPrompt(ENV).slice(STATIC_PROMPT.length);

  expect(tail).toContain("<environment>");
  expect(tail).toContain("Working directory: /tmp/example");
  expect(tail).toContain("Platform: darwin");
  expect(tail).toContain("Today's date: 2026-08-11");
  expect(tail).toContain("Inside a git repository: yes");
});

test("reports a non-repository directory as such", () => {
  expect(buildSystemPrompt({ ...ENV, isGitRepo: false })).toContain(
    "Inside a git repository: no",
  );
});

/**
 * The `Clarify` gate is written twice on purpose, and this pins that both copies
 * still say it.
 *
 * The technique is deer-flow's: its complexity gate for `write_todos` appears in
 * the system prompt (*"DO NOT use this tool for simple tasks (< 3 steps)"*) **and**
 * in the tool's own description (*"Only use for complex tasks (3+ steps)"*), with
 * a test asserting the two agree (`backend/tests/test_subagent_routing_prompt.py::
 * test_general_purpose_and_task_descriptions_match_routing_policy`). The model
 * reads both places, and a rule that survives in only one of them is a rule that
 * fires half the time.
 *
 * ⚠️ **This asserts the words are there, not that the model obeys them.** That is
 * the whole limitation of deer-flow's suite and the reason `repro/27` exists:
 * measured 2026-08-21, the prompt *before* this section said "ask" in one place
 * and the model asked in **0 of 12 runs**. Green here means nothing about
 * behaviour — it means the next edit cannot silently delete half the rule.
 */
test("the Clarify gate is stated in both places the model reads", () => {
  // The workflow's first step: the judgement happens before the first tool call.
  expect(STATIC_PROMPT).toContain("Decide whether you can start");
  expect(STATIC_PROMPT).toContain("Clarify first, before any Bash, Write or Edit");

  // The tool list: same gate, in the entry the model reads when choosing a tool.
  expect(STATIC_PROMPT).toContain(
    "put a decision to the user as numbered options, **before you start working**",
  );
});

/**
 * Both directions, because over-asking and under-asking are two failures and a
 * prompt that only guards one gets pushed into the other. `repro/27`'s `trivial`
 * case is the behavioural half of this; these are the words it depends on.
 */
test("the ask rule keeps its brake as well as its trigger", () => {
  expect(STATIC_PROMPT).toContain("Asking costs one round-trip");
  // The trigger that targets the failure this tool was built for: an answer that
  // ends by listing decisions instead of putting them on screen.
  expect(STATIC_PROMPT).toContain("would otherwise end with a list of things");
  // The brakes.
  expect(STATIC_PROMPT).toContain("Read, Glob or Grep would settle it");
  expect(STATIC_PROMPT).toContain("picking wrong costs one small edit");
});

// —— 票 09：这次调用有多少时间，模型得知道 ——
//
// 起因是量出来的：`cartpole-rl-training` 里模型给一条训练命令要了 `timeout: 600`，
// 而那一刻这次调用只剩约 308 秒。它不是判断错，是**没有人告诉过它**。

test("有总闸时，环境块说出这次调用有多少秒", () => {
  const prompt = buildSystemPrompt({ ...ENV, runSeconds: 340 });
  const tail = prompt.slice(STATIC_PROMPT.length);

  expect(tail).toContain("Run deadline: about 340 seconds");
  // 光给数字不够：还要说清到点会发生什么，否则「340」只是一个没有后果的数。
  expect(tail).toContain("no final answer");
});

// 交互式没有总闸（人就是那把钟，CONTEXT.md「期限」）。那一格里这两句话一个字都不该出现
// ——否则模型会为一个不存在的期限缩手缩脚。
test("没有总闸时，环境块一个字都不提期限", () => {
  const tail = buildSystemPrompt(ENV).slice(STATIC_PROMPT.length);

  expect(tail).not.toContain("Run deadline");
  expect(tail).not.toContain("no final answer");
});

// 期限那两行进的是环境块，不是静态段——静态段变一个字节，所有历史的缓存前缀全失效。
test("期限不落在静态前缀里", () => {
  expect(STATIC_PROMPT).not.toContain("Run deadline");
  expect(buildSystemPrompt({ ...ENV, runSeconds: 340 }).startsWith(STATIC_PROMPT)).toBe(
    true,
  );
});

// —— 票 09 的另外两条：它们是**行为指令**，删掉不会有任何测试变红，所以在这里钉一下 ——

test("动手之前先跑现成的检查，这句话还在", () => {
  expect(STATIC_PROMPT).toContain("run it before you build anything");
});

test("跑得久的活要在中途留下产物，这句话还在", () => {
  expect(STATIC_PROMPT).toContain("leave something usable on the way");
});
