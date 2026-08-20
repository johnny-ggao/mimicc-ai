import { describe, expect, test } from "bun:test";

import { frame, initial, press, width, type SelectorState } from "@/console";
import type { ClarifyQuestion } from "@/tools";

/**
 * The arrow-key selector's state machine and its frame.
 *
 * Both are pure on purpose. `picker.ts` argued against a selector partly because
 * one could not be tested without a terminal, and that half of the argument is
 * kept rather than overturned: everything below runs with no tty, no raw mode and
 * no redraw. What `repro/26` overturned was the other half — that stdin cannot be
 * lent out safely — and only for the `rl.pause()` handoff.
 */

const q = (header: string, ...labels: string[]): ClarifyQuestion => ({
  header,
  question: `${header}?`,
  options: labels.map((label) => ({ label, description: `${label} costs something` })),
});

const key = (name: string, extra: Record<string, unknown> = {}) => ({ name, ...extra });
const at = (...questions: ClarifyQuestion[]): SelectorState => initial(questions);

const plain = (state: SelectorState): string =>
  frame(state, 80)
    .join("\n")
    // eslint-disable-next-line no-control-regex -- stripping the escapes is the point.
    .replace(/\x1b\[[0-9;]*m/g, "");

describe("moving around", () => {
  test("down moves the cursor and wraps at the end", () => {
    const state = at(q("a", "x", "y"));
    press(state, key("down"));
    expect(state.row).toBe(1);
    // Three rows: two options plus "type your own answer".
    press(state, key("down"));
    press(state, key("down"));
    expect(state.row).toBe(0);
  });

  test("right walks the tabs and reaches Submit past the last question", () => {
    const state = at(q("a", "x", "y"), q("b", "p", "r"));
    press(state, key("right"));
    expect(state.tab).toBe(1);
    press(state, key("right"));
    expect(state.tab).toBe(2); // Submit
    press(state, key("right"));
    expect(state.tab).toBe(0); // wraps
  });

  test("left from the first tab lands on Submit rather than nowhere", () => {
    const state = at(q("a", "x", "y"));
    press(state, key("left"));
    expect(state.tab).toBe(1);
  });
});

describe("answering", () => {
  test("enter records the option under the cursor and moves to what is unanswered", () => {
    const state = at(q("持仓周期", "短周期", "不隔夜"), q("资金规模", "小", "中"));
    press(state, key("down"));
    press(state, key("return"));
    expect(state.answers[0]).toEqual({
      header: "持仓周期",
      chosen: ["不隔夜"],
      typed: false,
    });
    // Not "the next tab" — the next *unanswered* one, so answering out of order
    // does not skip a hole.
    expect(state.tab).toBe(1);
  });

  /** The numbered list's muscle memory has to keep working where both exist. */
  test("a digit picks that row directly", () => {
    const state = at(q("a", "x", "y"));
    const step = press(state, { name: "2", sequence: "2" });
    expect(step.kind).toBe("redraw");
    expect(state.answers[0]?.chosen).toEqual(["y"]);
  });

  test("submitting with a hole moves to the hole instead of doing nothing", () => {
    const state = at(q("a", "x", "y"), q("b", "p", "r"));
    state.tab = 2;
    const step = press(state, key("return"));
    expect(step.kind).toBe("redraw");
    expect(state.tab).toBe(0);
  });

  test("submitting when everything is answered returns the answers in order", () => {
    const state = at(q("a", "x", "y"), q("b", "p", "r"));
    press(state, key("return")); // a = x
    press(state, key("return")); // b = p
    expect(state.tab).toBe(2);
    const step = press(state, key("return"));
    expect(step).toEqual({
      kind: "done",
      answers: [
        { header: "a", chosen: ["x"], typed: false },
        { header: "b", chosen: ["p"], typed: false },
      ],
    });
  });

  test("escape dismisses", () => {
    expect(press(at(q("a", "x", "y")), key("escape")).kind).toBe("cancel");
  });
});

describe("typing an answer nobody offered", () => {
  const typing = (): SelectorState => {
    const state = at(q("a", "x", "y"));
    state.row = 2; // the free-text row
    press(state, key("return"));
    return state;
  };

  test("the last row opens a text field rather than picking anything", () => {
    const state = typing();
    expect(state.typing).toBe("");
    expect(state.answers[0]).toBeUndefined();
  });

  test("printable characters accumulate and backspace removes one", () => {
    const state = typing();
    for (const char of "第三种") press(state, { name: char, sequence: char });
    expect(state.typing).toBe("第三种");
    press(state, key("backspace"));
    expect(state.typing).toBe("第三");
  });

  /**
   * ⚠️ The same rule as everywhere else a keystroke becomes a commitment: an
   * empty Enter is not an answer (`readDecision`, repl.ts:543).
   */
  test("an empty field does not commit", () => {
    const state = typing();
    press(state, key("return"));
    expect(state.answers[0]).toBeUndefined();
    expect(state.typing).toBe("");
  });

  test("committing records it as typed, which the model is told", () => {
    const state = typing();
    press(state, { name: "z", sequence: "z" });
    press(state, key("return"));
    expect(state.answers[0]).toEqual({ header: "a", chosen: ["z"], typed: true });
  });

  test("navigation keys are text while the field is open", () => {
    const state = typing();
    press(state, { name: "left", sequence: "\x1b[D" });
    // The arrow moved nothing and added nothing: it is not printable.
    expect(state.tab).toBe(0);
    expect(state.typing).toBe("");
  });
});

describe("the frame", () => {
  test("tabs show what is answered, and the cursor marks the option", () => {
    const state = at(q("持仓周期", "短周期", "不隔夜"), q("资金规模", "小", "中"));
    expect(plain(state)).toContain("☐ 持仓周期");
    press(state, key("return"));
    const after = plain(state);
    expect(after).toContain("✔ 持仓周期");
    expect(after).toContain("❯ 1.");
  });

  test("Submit lists the decisions, and names what is still missing", () => {
    const state = at(q("a", "x", "y"), q("b", "p", "r"));
    press(state, key("return"));
    state.tab = 2;
    const shown = plain(state);
    expect(shown).toContain("✔ a: x");
    expect(shown).toContain("☐ b — not answered");
  });

  /**
   * ⚠️ A pty that reports **0 columns** clipped every line to a bare `…`
   * (measured, `expect`'s does). `?? 80` does not catch it because 0 is a number,
   * and the redraw counts lines — so a frame has to stay drawable at any width.
   */
  test("a nonsense width still draws content", () => {
    const drawn = frame(at(q("a", "x", "y")), 0).join("\n");
    expect(drawn).toContain("x");
    expect(drawn.replace(/[─\s…]/g, "").length).toBeGreaterThan(10);
  });

  test("wide characters count as two columns, or clipping cuts in the wrong place", () => {
    expect(width("abc")).toBe(3);
    expect(width("日内")).toBe(4);
  });
});
