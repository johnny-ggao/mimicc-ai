import { describe, expect, test } from "bun:test";

import { AIMessage } from "@langchain/core/messages";

import {
  clipColumns,
  columnsOf,
  latestSentence,
  renderHistory,
  rowFor,
  statusRow,
  summarizeReasoning,
} from "@/console";

/**
 * The chain of thought's one row, and the one line it leaves behind.
 *
 * Two things are pinned here and they are pinned for different reasons.
 *
 * **The row never exceeds its budget.** That is not tidiness: the row is erased
 * with `\x1b[2K`, which clears *one* screen row, so a row that wraps is a row
 * this console cannot take back — and the symptom is a terminal that slowly
 * fills with half-erased fragments. Every path into `rowFor` is checked against
 * the budget, including the ones where the ellipsis is what pushes it over.
 *
 * **Both render paths produce the same line.** A session shows a chain of
 * thought one way while it is happening and another way when it is resumed — that
 * asymmetry is the defect this whole change exists to remove (measured before the
 * change in `repro/28`: live printed it, `renderHistory` printed nothing). A test
 * that only checked one path would let it come back.
 */

const io = (options: { isTTY: boolean; styled?: boolean; columns?: number }) => {
  const written: string[] = [];
  return {
    written,
    row: statusRow({
      write: (text) => written.push(text),
      columns: () => options.columns ?? 40,
      isTTY: options.isTTY,
      styled: options.styled ?? true,
    }),
  };
};

describe("columnsOf", () => {
  test("east asian characters take two columns", () => {
    expect(columnsOf("abc")).toBe(3);
    expect(columnsOf("先看看")).toBe(6);
    expect(columnsOf("看 a")).toBe(4);
  });

  test("counts columns, not characters — the two differ and only one wraps", () => {
    expect("先看看".length).toBe(3);
    expect(columnsOf("先看看")).toBe(6);
  });
});

describe("clipColumns", () => {
  test("leaves a string that already fits", () => {
    expect(clipColumns("abc", 10, "head")).toBe("abc");
  });

  test("keeps the head and marks the cut", () => {
    expect(clipColumns("abcdef", 4, "head")).toBe("abc…");
  });

  test("keeps the tail and marks the cut", () => {
    expect(clipColumns("abcdef", 4, "tail")).toBe("…def");
  });

  test("the ellipsis is inside the budget, not added to it", () => {
    for (const budget of [2, 3, 5, 8, 13]) {
      expect(
        columnsOf(clipColumns("abcdefghijklmnop", budget, "head")),
      ).toBeLessThanOrEqual(budget);
      expect(
        columnsOf(clipColumns("先看看再想想还要读文件", budget, "tail")),
      ).toBeLessThanOrEqual(budget);
    }
  });

  test("never splits a wide character across the edge", () => {
    // Budget 4 = ellipsis (1) + room for 3, and a wide character costs 2, so
    // exactly one fits. Rounding this the other way is how a row ends up one
    // column too wide.
    expect(clipColumns("先看看再", 4, "head")).toBe("先…");
  });
});

describe("latestSentence", () => {
  test("returns the most recent finished sentence", () => {
    expect(latestSentence("先看看。再想想。")).toBe("再想想。");
  });

  test("is empty while no sentence has finished", () => {
    expect(latestSentence("先看看再想想")).toBe("");
  });

  test("holds the previous sentence while the next one is being written", () => {
    // The point of showing a finished sentence: the row stays readable instead
    // of jittering one character at a time.
    expect(latestSentence("先看看。再想")).toBe("先看看。");
  });

  test("a period only ends a sentence when a space or the end follows it", () => {
    expect(latestSentence("Read it. Then think")).toBe("Read it.");
    // A decimal point is not the end of a sentence. Splitting here would show
    // the reader a fragment, which is worse than the tail fallback.
    expect(latestSentence("it costs 0.09 dollars")).toBe("");
  });

  test("a newline ends a sentence", () => {
    expect(latestSentence("先看看\n再想想\n")).toBe("再想想");
  });
});

describe("rowFor", () => {
  test("shows the finished sentence when there is one", () => {
    expect(rowFor("先看看。再想", 40)).toBe("先看看。");
  });

  test("falls back to the tail when nothing has finished", () => {
    // Budget 10 = ellipsis (1) + 9 columns of room, and a wide character costs
    // 2, so four of them fit and a fifth would be one column over.
    expect(rowFor("先看看再想想还要读一下文件", 10)).toBe("…一下文件");
    expect(columnsOf(rowFor("先看看再想想还要读一下文件", 10))).toBe(9);
  });

  test("flattens newlines in the fallback — a row is one row", () => {
    expect(rowFor("abc\ndef", 40)).not.toContain("\n");
  });

  test("never exceeds the budget, whichever path it takes", () => {
    const samples = [
      "先看看。再想想还要读一下这个文件才知道",
      "先看看再想想还要读一下这个文件才知道",
      "Read the file. Then decide what to do about it",
      "0.09",
      "",
    ];
    for (const text of samples) {
      for (const budget of [1, 2, 6, 20, 79]) {
        expect(columnsOf(rowFor(text, budget))).toBeLessThanOrEqual(budget);
      }
    }
  });
});

describe("statusRow on a terminal", () => {
  test("opens a row of its own before painting into it", () => {
    const { written, row } = io({ isTTY: true });
    row.push("先看看");
    // Without the newline, `\r` would clear whatever row the cursor was left on
    // — the end of the model's previous sentence, most of the time.
    expect(written[0]).toBe("\n");
    expect(written[1]).toContain("\r\x1b[2K");
  });

  test("repaints rather than appends", () => {
    const { written, row } = io({ isTTY: true });
    row.push("先看看。");
    row.push("再想想。");
    const paints = written.filter((text) => text.startsWith("\r"));
    expect(paints).toHaveLength(2);
    expect(paints[1]).toContain("再想想。");
  });

  test("settle erases the row and hands back the whole block", () => {
    const { written, row } = io({ isTTY: true });
    row.push("先看看。");
    row.push("再想想。");
    expect(row.settle()).toBe("先看看。再想想。");
    expect(written.at(-1)).toBe("\r\x1b[2K");
  });

  test("settle on a row that was never opened does nothing at all", () => {
    const { written, row } = io({ isTTY: true });
    expect(row.settle()).toBeUndefined();
    expect(written).toHaveLength(0);
  });

  test("a second settle does not report the same block twice", () => {
    const { row } = io({ isTTY: true });
    row.push("先看看。");
    expect(row.settle()).toBe("先看看。");
    expect(row.settle()).toBeUndefined();
  });

  test("no dim escapes when colour is not wanted", () => {
    const { written, row } = io({ isTTY: true, styled: false });
    row.push("先看看。");
    expect(written.join("")).not.toContain("\x1b[2m");
  });
});

describe("statusRow off a terminal", () => {
  test("paints nothing — there is no cursor to move", () => {
    const { written, row } = io({ isTTY: false });
    row.push("先看看。");
    expect(written.some((text) => text.includes("\x1b[2K"))).toBe(false);
  });

  test("still reports the block, so the trace line is printed either way", () => {
    // The decision behind this: a pipe gets the trace line but not the live row.
    // The row is cursor control and means nothing in a pipe; the trace is
    // ordinary output and is what keeps the two transcripts the same shape.
    const { row } = io({ isTTY: false });
    row.push("先看看。");
    expect(row.settle()).toBe("先看看。");
  });
});

describe("the trace line", () => {
  test("counts characters, not code units", () => {
    expect(summarizeReasoning("先看看")).toBe("思考 3 字");
  });

  test("a resumed session prints it", () => {
    const history = [
      new AIMessage({
        content: "答案",
        additional_kwargs: { reasoning_content: "先看看。再想想。" },
      }),
    ];
    expect(renderHistory(history)).toContain("· 思考 8 字");
  });

  test("both paths print the same line — this is the whole point", () => {
    const block = "先看看。再想想。";

    // Live: the row hands the block back, the console summarises it.
    const { row } = io({ isTTY: true });
    for (const chunk of ["先看看。", "再想想。"]) row.push(chunk);
    const live = `· ${summarizeReasoning(row.settle() ?? "")}`;

    // Resumed: the same block, arriving as a stored message.
    const resumed = renderHistory([
      new AIMessage({
        content: "答案",
        additional_kwargs: { reasoning_content: block },
      }),
    ]);

    expect(resumed).toContain(live);
  });

  test("an ai message with no reasoning gets no line", () => {
    const rendered = renderHistory([new AIMessage({ content: "答案" })]);
    expect(rendered).not.toContain("思考");
  });
});

describe("a terminal that will not say how wide it is", () => {
  test("zero columns is treated as unknown, not as no room", () => {
    // ⚠️ Measured, not imagined: under a pty with no window size set,
    // `process.stdout.columns` is 0 rather than undefined (`repro/30`), and the
    // obvious `columns ?? 80` sails past it. The budget then lands on 1 and the
    // whole row collapses to an ellipsis.
    const { written, row } = io({ isTTY: true, columns: 0, styled: false });
    row.push("先看看这个文件。再想想别的可能。");
    const painted = written.filter((text) => text.startsWith("\r")).at(-1) ?? "";
    expect(painted).not.toBe("\r\x1b[2K…");
    // The row shows the *latest* finished sentence, so this is the second one.
    expect(painted).toContain("再想想别的可能。");
  });

  test("a negative width is unknown too", () => {
    const { written, row } = io({ isTTY: true, columns: -1, styled: false });
    row.push("先看看这个文件。");
    expect(written.filter((text) => text.startsWith("\r")).at(-1)).toContain("先看看");
  });
});
