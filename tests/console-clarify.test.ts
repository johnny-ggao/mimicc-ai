import { describe, expect, test } from "bun:test";

import { readAnswer, renderQuestion, type Quiz } from "@/console";
import type { ClarifyQuestion } from "@/tools";

/**
 * Answering the model's question on a terminal that reads lines.
 *
 * This is the half that is always reachable — piped stdin has no cursor to move —
 * so it is also the half that must never silently mis-read a keystroke. Both
 * failures here are quiet: an empty line becoming a considered preference, and a
 * sentence the user typed being rejected because it was not a number.
 */

const question = (header: string, ...labels: string[]): ClarifyQuestion => ({
  header,
  question: `${header}?`,
  options: labels.map((label) => ({ label, description: `what ${label} costs` })),
});

const quiz = (...questions: ClarifyQuestion[]): Quiz => ({ questions, answers: [] });

describe("what is on screen", () => {
  test("the question, its options numbered, and the trade-off under each", () => {
    const shown = renderQuestion(
      quiz(question("持仓周期", "短周期波段", "严格不隔夜")),
    );
    expect(shown).toContain("持仓周期?");
    expect(shown).toContain("1  短周期波段");
    expect(shown).toContain("2  严格不隔夜");
    expect(shown).toContain("what 短周期波段 costs");
    // The escape hatch is on screen, not folklore.
    expect(shown).toContain("type your own answer");
  });

  /** Four questions in a row are four near-identical prompts without it. */
  test("a set says how far through it is; a single question does not", () => {
    expect(
      renderQuestion(quiz(question("a", "x", "y"), question("b", "x", "y"))),
    ).toContain("(1/2)");
    expect(renderQuestion(quiz(question("a", "x", "y")))).not.toContain("(1/1)");
  });

  test("a quiz with nothing left renders nothing", () => {
    const done: Quiz = { questions: [question("a", "x", "y")], answers: [] };
    readAnswer("1", done);
    expect(renderQuestion(done)).toBe("");
  });
});

describe("what a typed line means", () => {
  test("a number picks that option, by label", () => {
    const asking = quiz(question("持仓周期", "短周期波段", "严格不隔夜"));
    expect(readAnswer("2", asking)).toEqual([
      { header: "持仓周期", chosen: ["严格不隔夜"], typed: false },
    ]);
  });

  /**
   * ⚠️ The rule the confirmation gate learned as a shipping bug: a line typed
   * while a turn was running is replayed when the loop comes back (`repro/15`),
   * so an Enter pressed out of impatience would answer a question nobody had
   * read. Sharing a branch with "pick option 1" is exactly how that happened
   * once for `approve`.
   */
  test("an empty line is not an answer", () => {
    const asking = quiz(question("h", "x", "y"));
    expect(readAnswer("", asking)).toBeNull();
    expect(asking.answers).toEqual([]);
  });

  test("anything that is not one of the numbers is the user's own answer", () => {
    const asking = quiz(question("h", "x", "y"));
    expect(readAnswer("其实我想要第三种", asking)).toEqual([
      { header: "h", chosen: ["其实我想要第三种"], typed: true },
    ]);
  });

  /** Out of range is not a typo to reject — it is a number that names no option,
   * which reads as words. Rejecting it would trap the user between an invalid
   * pick and no way to say so. */
  test("a number outside the list is words, not an error", () => {
    const asking = quiz(question("h", "x", "y"));
    const answers = readAnswer("9", asking);
    expect(answers?.[0]?.typed).toBe(true);
    expect(answers?.[0]?.chosen).toEqual(["9"]);
  });

  test("a set is only finished when every question has an answer", () => {
    const asking = quiz(question("a", "x", "y"), question("b", "p", "q"));
    expect(readAnswer("1", asking)).toBeNull();
    expect(readAnswer("2", asking)).toEqual([
      { header: "a", chosen: ["x"], typed: false },
      { header: "b", chosen: ["q"], typed: false },
    ]);
  });
});
