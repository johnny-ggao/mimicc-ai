import { describe, expect, test } from "bun:test";

import { FakeListChatModel } from "@langchain/core/utils/testing";

import { buildSystemPrompt, registeredTools, STATIC_PROMPT } from "@/agents";
import { staticPromptFor } from "@/agents/prompt";
import { parseArgs } from "@/console";
import { CLARIFY_TOOL_NAME } from "@/tools/clarify";

/**
 * `--exclude-tools`：不注册某个工具。
 *
 * 🔑 **这条改动有两个落点，测试也就有两半**：工具清单（`registeredTools`）和
 * **系统提示词**（`staticPromptFor`）。提示词逐字教了每个工具怎么用——只拿掉工具而
 * 正文照旧，等于留下一段谎话，模型会照着去调一个不存在的工具。**第二半才是这组测试
 * 存在的理由**，第一半自己不会错。
 *
 * 起点：批 1 换 GLM 那轮（票 10）。`--print` 下 `Clarify` 永远不可能被回答，
 * 而模型为了问一句话烧掉了两个回合。
 */

const environment = {
  model: new FakeListChatModel({ responses: ["unused"] }),
  modelFor: () => new FakeListChatModel({ responses: ["unused"] }),
};

describe("命令行", () => {
  test("不给就不带这个字段——空数组会让每一处比较对象的测试都要跟着改", () => {
    expect(parseArgs(["--auto"])).toEqual({ kind: "new", auto: true });
  });

  test("认 `--exclude-tools <名字>` 和 `--exclude-tools=<名字>`，逗号可以分隔多个", () => {
    expect(parseArgs(["--exclude-tools", "Clarify"])).toEqual({
      kind: "new",
      auto: false,
      excludeTools: ["Clarify"],
    });
    expect(parseArgs(["--exclude-tools=Clarify, Task"])).toEqual({
      kind: "new",
      auto: false,
      excludeTools: ["Clarify", "Task"],
    });
  });

  test("空的 `--exclude-tools` 是错，不是默认值", () => {
    // 同 `--timeout`：一个写了却没生效的开关，会让调用方以为工具已经拿掉了。
    const parsed = parseArgs(["--exclude-tools", ""]);
    expect(parsed.kind).toBe("error");
  });
});

describe("工具清单", () => {
  test("被排除的工具不注册", () => {
    const kept = registeredTools(environment, undefined, [CLARIFY_TOOL_NAME]).map(
      (tool) => tool.name,
    );
    expect(kept).not.toContain(CLARIFY_TOOL_NAME);
    // 别的工具一个不少——排除不是「重排」。
    const all = registeredTools(environment).map((tool) => tool.name);
    expect(kept).toEqual(all.filter((name) => name !== CLARIFY_TOOL_NAME));
  });

  test("名字打错要出声，不能静默忽略", () => {
    expect(() => registeredTools(environment, undefined, ["Clarfy"])).toThrow(
      /no tool named Clarfy/,
    );
  });
});

describe("系统提示词", () => {
  test("没有排除任何工具时，提示词逐字不变（缓存前缀不受这条改动影响）", () => {
    expect(staticPromptFor(new Set())).toBe(STATIC_PROMPT);
  });

  test("排除 Clarify 之后，正文里一个 Clarify 都不剩", () => {
    const text = staticPromptFor(new Set([CLARIFY_TOOL_NAME]));
    expect(text).not.toMatch(/\bClarify\b/);
    // 工具花名册的数目也要跟着改，否则它自己就是一句谎。
    expect(text).toContain("You have eight:");
    expect(text).not.toContain("You have nine:");
  });

  test("那句「自己定，并说清假设」搬进了提示词", () => {
    // 在这条改动之前，这句话只活在 `console/once.ts` 的 `NO_HUMAN_ANSWER` 里——
    // 也就是只有**调了 Clarify 才听得到**。拿掉工具而不搬这句话，是净减一条行为指引。
    const text = staticPromptFor(new Set([CLARIFY_TOOL_NAME]));
    expect(text).toContain("Decide it yourself and say what you assumed");
    expect(text).toContain("nobody is attached to this run");
  });

  test("提示词还在教的工具，拿不掉——宁可拒绝，也不留下一段谎话", () => {
    // 🔴 **这条是本组的红**：哪天有人给 `--exclude-tools` 加一个工具、却没教提示词
    // 怎么少了它，这里就会失败。失败信息里写着该去改哪个文件。
    expect(() => staticPromptFor(new Set(["Read"]))).toThrow(
      /cannot exclude Read: the system prompt still teaches it/,
    );
  });

  test("两个落点由同一个开关驱动：`buildSystemPrompt` 也认它", () => {
    const text = buildSystemPrompt({
      cwd: "/x",
      platform: "darwin",
      today: "2026-08-30",
      isGitRepo: true,
      excludedTools: [CLARIFY_TOOL_NAME],
    });
    expect(text).not.toMatch(/\bClarify\b/);
  });
});
