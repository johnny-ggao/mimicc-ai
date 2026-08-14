import { describe, expect, test } from "bun:test";

import { markdownStream, renderLine, STYLES, stylingEnabled } from "@/markdown";

/**
 * Two ways to read this file, and both are needed.
 *
 * The `plain` style strips every escape, so a test can assert on the *text* —
 * that a bullet became `•`, that a code fence stopped being markup, that an
 * identifier survived. Those are the assertions that catch a renderer corrupting
 * what it renders, which is the failure that matters.
 *
 * The `styled` style is asserted only where the escape itself is the subject.
 * Pinning colour codes everywhere would make this a change-detector for a
 * palette nobody has decided on.
 */

const plain = (line: string, insideFence = false): string =>
  renderLine(line, insideFence, STYLES.plain);

describe("what the renderer must never break", () => {
  /**
   * The rule that came out of reading real output rather than the spec.
   *
   * This agent talks about code, and its replies are full of `tool_call_id`,
   * `__pregel_tasks` and `_windowCutoff`. A renderer that supports
   * `_underscore italics_` eats the middle of every one of them — it does not
   * merely fail to style, it deletes characters from the text. Asserted here
   * rather than left as a comment because the temptation to "add the missing
   * syntax" is exactly what this guards against.
   */
  test("snake_case and dunder identifiers pass through untouched", () => {
    expect(plain("state has _windowCutoff and __pregel_tasks and tool_call_id")).toBe(
      "state has _windowCutoff and __pregel_tasks and tool_call_id",
    );
    expect(plain("`__start__` then `_windowSummary`")).toBe(
      "__start__ then _windowSummary",
    );
  });

  test("a code span keeps asterisks that are part of the code", () => {
    // `a**b` is a dereference, a glob, a multiplication — not an emphasis
    // marker. Splitting code spans out before touching emphasis is what makes
    // this hold.
    expect(plain("call `f(a**b)` twice")).toBe("call f(a**b) twice");
  });

  test("inside a fence nothing is markup", () => {
    expect(plain("- **not** a bullet", true)).toBe("- **not** a bullet");
  });
});

describe("the subset the model actually writes", () => {
  test("bold, inline code and the two list forms", () => {
    // Taken verbatim in shape from a real reply in .mimicc: numbered items whose
    // label is bold and whose body is code.
    expect(plain("1. **src/window.ts:183** — `contextWindow(options)`")).toBe(
      "1. src/window.ts:183 — contextWindow(options)",
    );
    expect(plain("- plain item")).toBe("• plain item");
    expect(plain("  - nested item")).toBe("  • nested item");
  });

  test("headings lose their hashes, rules become a line", () => {
    expect(plain("## The heading")).toBe("The heading");
    expect(plain("---")).toBe("─".repeat(40));
  });

  test("a link keeps both the label and the address", () => {
    expect(plain("see [the docs](https://example.com/x)")).toBe(
      "see the docs https://example.com/x",
    );
  });

  test("bold is actually bold when styling is on", () => {
    expect(renderLine("**yes**", false, STYLES.styled)).toBe("\x1b[1myes\x1b[0m");
  });
});

describe("streaming, which is the whole difficulty", () => {
  const collect = (chunks: string[]): string => {
    let out = "";
    const stream = markdownStream((text) => (out += text), STYLES.plain);
    for (const chunk of chunks) stream.push(chunk);
    stream.flush();
    return out;
  };

  test("markers split across chunks still render", () => {
    // The failure this file exists for: the provider's tokeniser splits `**bold**`
    // wherever it likes, so no chunk contains a complete marker. Rendering per
    // chunk would print the asterisks; buffering to the newline does not.
    expect(collect(["**bo", "ld** and ", "`co", "de`\n"])).toBe("bold and code\n");
  });

  test("a partial line is held until a newline completes it", () => {
    let out = "";
    const stream = markdownStream((text) => (out += text), STYLES.plain);

    stream.push("**not yet");
    // Nothing written: the line could still turn out to be anything.
    expect(out).toBe("");

    stream.push(" done**\n");
    expect(out).toBe("not yet done\n");
  });

  test("flush writes the tail of a reply that never ends in a newline", () => {
    expect(collect(["one\n", "two, no trailing newline"])).toBe(
      "one\ntwo, no trailing newline",
    );
  });

  test("flush is idempotent and safe when nothing is held", () => {
    let out = "";
    const stream = markdownStream((text) => (out += text), STYLES.plain);
    stream.push("x\n");
    stream.flush();
    stream.flush();
    expect(out).toBe("x\n");
  });

  test("fence state spans chunks and closes again", () => {
    const out = collect([
      "before\n",
      "```ts\n",
      "const x = **1**;\n",
      "```\n",
      "- after\n",
    ]);
    // The body is verbatim — asterisks intact, no bullet — and the line after
    // the closing fence is markup again.
    expect(out).toBe("before\nts\nconst x = **1**;\n\n• after\n");
  });

  test("an unclosed fence does not leak past the end of the reply", () => {
    // Two replies, two streams. The second must not inherit the first's fence,
    // which is why the console builds one per turn.
    expect(collect(["```\nunclosed\n"])).toBe("\nunclosed\n");
    expect(collect(["- normal again\n"])).toBe("• normal again\n");
  });
});

describe("when to emit escapes at all", () => {
  test("NO_COLOR wins over a TTY, and a pipe needs no asking", () => {
    expect(stylingEnabled({ NO_COLOR: "1" }, true)).toBe(false);
    expect(stylingEnabled({}, false)).toBe(false);
    expect(stylingEnabled({}, true)).toBe(true);
    // Set-but-empty is the documented "not set" case at no-color.org.
    expect(stylingEnabled({ NO_COLOR: "" }, true)).toBe(true);
  });
});
