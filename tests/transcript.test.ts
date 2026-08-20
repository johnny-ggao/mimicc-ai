import { describe, expect, test } from "bun:test";

import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";

import { renderHistory, summarizeResult } from "@/console";
import { PINNED, SUMMARY_SOURCE } from "@/context";
import { SKILL_CATALOG_ID, skillActivationMessage } from "@/skills";

/**
 * What a resumed session puts back on screen.
 *
 * The console's loop stays out of the tests (`repl.test.ts` says why), but this
 * renderer is not the loop — it is a pure function whose entire job is a
 * judgement about somebody else's conversation: **which of the messages in state
 * were said by a person, and which were said by the harness to itself.** Get it
 * wrong in one direction and resuming buries two sentences under three thousand
 * characters of tool descriptions; wrong in the other and the user's own words
 * are the thing that goes missing.
 *
 * Neither failure announces itself — both render *something* — which is why the
 * filter is pinned here rather than left to be noticed in a terminal.
 */

const pinned = (content: string, id?: string): HumanMessage =>
  new HumanMessage({
    content,
    additional_kwargs: { ...PINNED },
    ...(id ? { id } : {}),
  });

/** The five messages the session in `~/.mimicc` actually contained. */
const realSession = (): BaseMessage[] => [
  new HumanMessage("在 binance 上做 BTC/ETH/SOL 的永续合约"),
  pinned("<skill-catalog>\n- code-review: …\n</skill-catalog>", SKILL_CATALOG_ID),
  new AIMessage({
    content: "",
    tool_calls: [{ name: "Bash", args: { command: "ls -la" }, id: "Bash_0" }],
  }),
  new ToolMessage({
    content: "total 0\ndrwxr-xr-x\ndrwxr-xr-x",
    tool_call_id: "Bash_0",
  }),
  new AIMessage("空目录，纯绿项目。以下是业务分析。"),
];

describe("replaying a resumed session", () => {
  test("the user's own words come back", () => {
    const out = renderHistory(realSession());
    expect(out).toContain("> 在 binance 上做 BTC/ETH/SOL 的永续合约");
  });

  test("so does the model's reply, and the call it made on the way", () => {
    const out = renderHistory(realSession());
    expect(out).toContain("空目录，纯绿项目。");
    expect(out).toContain("Bash");
    expect(out).toContain('"ls -la"');
  });

  test("a tool's output is a line count, not the output", () => {
    const out = renderHistory(realSession());
    expect(out).toContain("3 lines");
    expect(out).not.toContain("drwxr-xr-x");
  });

  test("order is the order it happened in", () => {
    const out = renderHistory(realSession());
    expect(out.indexOf("binance")).toBeLessThan(out.indexOf("ls -la"));
    expect(out.indexOf("ls -la")).toBeLessThan(out.indexOf("空目录"));
  });

  /**
   * The one that pays for the whole file. Four middlewares inject a
   * `HumanMessage`, and the catalogue is the loud one: 3019 characters in a
   * session whose human half was 91.
   */
  test("what the harness injected is not replayed as something a human said", () => {
    const out = renderHistory([
      pinned("<project-instructions>build with bun</project-instructions>"),
      pinned("<memory>the user prefers …</memory>"),
      pinned("<skill-catalog>…</skill-catalog>", SKILL_CATALOG_ID),
      new HumanMessage("这句是我敲的"),
    ]);
    expect(out).toContain("> 这句是我敲的");
    expect(out).not.toContain("project-instructions");
    expect(out).not.toContain("<memory>");
    expect(out).not.toContain("skill-catalog");
  });

  /**
   * A skill activation is pinned like the rest, but it is the one with a person
   * behind it: they typed `/tdd`. Replaying the skill's body would be replaying
   * the catalogue's mistake; replaying nothing would lose a turn they took.
   */
  test("a slash command is replayed as the command, not as the skill it loaded", () => {
    const skill = skillActivationMessage({
      name: "tdd",
      description: "test-driven development",
      modelInvokable: true,
      dir: "/skills/tdd",
      body: "A VERY LONG SKILL BODY that nobody wants to reread on resume",
      files: [],
    });

    const out = renderHistory([skill, new AIMessage("ok")]);
    expect(out).toContain("> /tdd");
    expect(out).not.toContain("VERY LONG SKILL BODY");
  });

  /**
   * The summary is not plumbing: it is standing in for messages that are no
   * longer in the history at all. Filtering it would replay a conversation with
   * a hole in it and no sign that anything is missing.
   */
  test("a compaction summary survives, because the messages it replaced did not", () => {
    const summary = new HumanMessage({
      content: "Summary of the earlier part of this conversation:\n\nthey chose bun.",
      additional_kwargs: { lc_source: SUMMARY_SOURCE },
    });
    expect(renderHistory([summary])).toContain("they chose bun.");
  });

  test("there is a line saying where the past stops", () => {
    expect(renderHistory(realSession())).toContain("以上为恢复的历史");
  });

  /**
   * A run that died before its first reply leaves a file with nothing in it but
   * injections. A rule with nothing above it would say "here is your history"
   * about an empty screen.
   */
  test("a session with nothing a human would recognise prints nothing at all", () => {
    expect(renderHistory([pinned("<skill-catalog>…</skill-catalog>")])).toBe("");
    expect(renderHistory([])).toBe("");
  });
});

/**
 * The result summariser is shared with the live path, which is the whole reason
 * it is a function: a tool call must not read one way while you watch it and
 * another way when you come back to it.
 */
describe("standing in for a tool's output", () => {
  const result = (content: string): ToolMessage =>
    new ToolMessage({ content, tool_call_id: "x" });

  test("output is counted", () => {
    expect(summarizeResult(result("a\nb\nc"))).toBe("3 lines");
  });

  test("one line does not say lines", () => {
    expect(summarizeResult(result("only"))).toBe("1 line");
  });

  test("a failure keeps its first line, because that is what the next turn is about", () => {
    expect(summarizeResult(result("Error: no such file\nstack\nstack"))).toBe(
      "Error: no such file",
    );
  });
});
