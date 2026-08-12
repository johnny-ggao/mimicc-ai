import { describe, expect, test } from "bun:test";

import { AmbiguousMatch, locate } from "@/tools/matching";

/** Applies what `locate` found, so assertions read as before/after text. */
function apply(source: string, oldString: string, newString: string): string {
  const found = locate(source, oldString, newString);
  if (found === null) throw new Error("no match");
  return source.slice(0, found.start) + found.replacement + source.slice(found.end);
}

function level(source: string, oldString: string): string | null {
  return locate(source, oldString, "X")?.level ?? null;
}

describe("level 1 — exact", () => {
  test("replaces a substring inside a line", () => {
    // The strictest level is still a substring match: renaming a symbol within a
    // line is an ordinary edit, and requiring whole lines would forbid it.
    expect(apply("const total = a + b;\n", "a + b", "b + a")).toBe(
      "const total = b + a;\n",
    );
  });

  test("is preferred over any looser level", () => {
    expect(level("  const x = 1;\n", "  const x = 1;")).toBe("exact");
  });
});

describe("level 2 — line endings", () => {
  const CRLF = "function f() {\r\n  return 1;\r\n}\r\n";

  // The target has to span a line boundary to reach this level at all: a
  // single line is still a plain substring of a CRLF file, so level 1 takes it.
  test("matches LF text against a CRLF file", () => {
    expect(level(CRLF, "function f() {\n  return 1;")).toBe("line endings normalised");
  });

  // The failure mode this guards: normalise the file, splice, write it back, and
  // one edit silently converts every line ending in the file.
  test("leaves the rest of the file's CRLF endings alone", () => {
    const after = apply(
      CRLF,
      "function f() {\n  return 1;",
      "function f() {\n  return 2;",
    );

    expect(after).toBe("function f() {\r\n  return 2;\r\n}\r\n");
    expect(after.split("\r\n")).toHaveLength(4);
  });
});

describe("level 3 — blank lines around the block", () => {
  const SRC = "a();\nb();\nc();\n";

  test("ignores blank lines the model padded the block with", () => {
    expect(level(SRC, "\n\nb();\n\n")).toBe("surrounding blank lines ignored");
  });

  test("replaces only the real lines", () => {
    expect(apply(SRC, "\n\nb();\n\n", "B();")).toBe("a();\nB();\nc();\n");
  });
});

describe("level 4 — indentation", () => {
  const TABBED = "function f() {\n\tconst x = 1;\n\treturn x;\n}\n";

  test("matches spaces against tabs", () => {
    expect(level(TABBED, "  const x = 1;")).toBe("indentation ignored");
  });

  // Matching loosely and then writing the model's indentation would leave the
  // file half tabs and half spaces. The replacement is shifted back onto the
  // indentation the file actually uses.
  test("re-indents the replacement to the file's own indentation", () => {
    const after = apply(TABBED, "  const x = 1;", "  const x = 2;");

    expect(after).toBe("function f() {\n\tconst x = 2;\n\treturn x;\n}\n");
  });

  test("re-indents every line of a multi-line replacement", () => {
    const after = apply(TABBED, "  const x = 1;", "  const a = 1;\n  const b = 2;");

    expect(after).toBe(
      "function f() {\n\tconst a = 1;\n\tconst b = 2;\n\treturn x;\n}\n",
    );
  });

  test("does not put whitespace on blank lines it re-indents past", () => {
    const after = apply(TABBED, "  const x = 1;", "  const a = 1;\n\n  const b = 2;");

    expect(after).toContain("\n\n\tconst b = 2;");
  });
});

/* ---------- 唯一性：整条梯子的安全底线 ---------- */

describe("uniqueness", () => {
  test("refuses an ambiguous exact match", () => {
    expect(() => locate("x();\ny();\nx();\n", "x();", "z();")).toThrow(AmbiguousMatch);
  });

  // The whole point of the ladder: looser levels find *more* candidates, so this
  // is where a fuzzy matcher would quietly pick the wrong one.
  test("refuses when only the loose level makes two blocks look alike", () => {
    // Neither block contains "  do();" verbatim — one is tab-indented, the
    // other double-tab — so levels 1 to 3 find nothing. Only trimming makes
    // them identical, and then there are two of them.
    const source = "if (a) {\n\tdo();\n}\nif (b) {\n\t\tdo();\n}\n";

    expect(() => locate(source, "  do();", "done();")).toThrow(AmbiguousMatch);
  });

  test("reports how many and at which level", () => {
    try {
      locate("x();\ny();\nx();\n", "x();", "z();");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(AmbiguousMatch);
      expect((error as AmbiguousMatch).count).toBe(2);
      expect((error as AmbiguousMatch).level).toBe("exact");
    }
  });

  // Ambiguity stops the walk rather than falling through: a looser level can
  // only ever match more places, so "try fuzzier" would be strictly worse.
  test("does not fall through to a looser level after an ambiguity", () => {
    expect(() => locate("a();\na();\n", "a();", "b();")).toThrow(AmbiguousMatch);
  });
});

describe("no match", () => {
  test("returns null rather than guessing", () => {
    expect(locate("const x = 1;\n", "const y = 2;", "z")).toBeNull();
  });

  // Not covered by any level, and deliberately so: `2\t` is content, not
  // whitespace, so trimming cannot reach it. The tool's error message names it.
  test("still rejects a target carrying Read's line-number prefix", () => {
    expect(locate("  const x = 1;\n", "2\t  const x = 1;", "z")).toBeNull();
  });
});

describe("deleting", () => {
  // Replacing the line's content with nothing but keeping its ending turns
  // "remove this line" into "leave a blank line here", and a blank line is
  // invisible in a terminal.
  test("removes the whole line rather than blanking it", () => {
    expect(apply("func f() {\n\tx := 1\n\treturn x\n}\n", "  x := 1", "")).toBe(
      "func f() {\n\treturn x\n}\n",
    );
  });

  test("removes every line of a multi-line target", () => {
    expect(apply("a();\nb();\nc();\n", "\n\nb();\n\n", "")).toBe("a();\nc();\n");
  });

  // An exact match is a substring match, so deleting part of a line must not
  // take the line's newline with it.
  test("an exact match deletes only what was matched", () => {
    expect(apply("const total = a + b;\n", " + b", "")).toBe("const total = a;\n");
  });
});

describe("overlapping occurrences", () => {
  // "aa" is at offset 0 and at offset 1. Counting non-overlapping occurrences
  // reports one and quietly edits the first — exactly the pick-one-of-several
  // that uniqueness exists to forbid.
  test("counts overlapping matches as ambiguous", () => {
    expect(() => locate("aaa", "aa", "B")).toThrow(AmbiguousMatch);
  });

  test("a genuinely unique target is still unique", () => {
    expect(level("abcabd", "abc")).toBe("exact");
  });
});

describe("whitespace-only targets", () => {
  // The loose levels cannot reach these by construction: trimming the blank
  // lines off a whitespace-only target leaves an empty needle, and an empty
  // needle matches nothing. Without that property the level would match *any*
  // blank line, and a file with exactly one would be edited silently.
  test("never reaches a loose level", () => {
    expect(locate("a := 1\n\nb := 2", "  \n ", "INSERTED")).toBeNull();
  });
});

describe("file shape", () => {
  test("keeps the trailing newline where it was", () => {
    expect(apply("a();\nb();\n", "b();", "B();")).toBe("a();\nB();\n");
  });

  test("handles a file with no trailing newline", () => {
    expect(apply("a();\nb();", "b();", "B();")).toBe("a();\nB();");
  });
});
