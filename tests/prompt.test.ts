import { expect, test } from "bun:test";

import { buildSystemPrompt, STATIC_PROMPT, type PromptEnvironment } from "@/prompt";

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
