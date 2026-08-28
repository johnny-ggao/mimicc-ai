/**
 * The model's chain of thought, on a terminal that can only append.
 *
 * ## Why this is not just "print it dimmed"
 *
 * It was, and that is what this file replaces. Measured on three real turns
 * against `kimi-k3` (`repro/29-what-reasoning-really-costs.ts`): the chain of
 * thought took **76% of the screen**, one unbroken block ran **64 screen rows**,
 * and the model thinks on **every lap** — one block per model call, so the cost
 * grows with the number of tool hops rather than staying put.
 *
 * ## The constraint that decides the shape
 *
 * This console writes to a plain stdout: once a row is printed it belongs to the
 * scrollback and cannot be taken back. So folding has exactly two
 * implementations — print nothing, or print inside a unit that can be erased
 * cleanly. **That unit is one screen row and nothing else**, because `\x1b[2K`
 * clears one screen row while a soft-wrapped logical line occupies several
 * (`markdown.ts` records the same trap for the same reason).
 *
 * Hence: while the model is thinking, one row, hard-truncated, repainted in
 * place. When the block ends the row is erased and replaced by a single dim
 * trace — `· 思考 356 字` — which is what stays.
 *
 * ## What the row says
 *
 * The **latest complete sentence**, not a scrolling tail. A tail cuts words in
 * half and jitters as wide characters straddle the edge; the first sentence
 * would be stable but is usually the least informative one — `agents/prompt.ts`
 * records that this provider opens with "好的，我来帮你" often enough that the
 * system prompt bans it, and nothing bans it inside the chain of thought.
 *
 * A tail *is* the fallback, for the passage that has no sentence in it yet: the
 * opening words of a block, a formula, a pasted snippet.
 */

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
/** Return to column 0 and clear this screen row. Exactly one row — see above. */
const CLEAR_ROW = "\r\x1b[2K";

/**
 * How many columns a string occupies, which is not how many characters it has.
 *
 * East Asian characters take two columns, and this repository's chains of
 * thought are mostly Chinese — measured, 6554 of them in three turns. Counting
 * `length` instead would let a truncated row wrap, and a wrapped row is exactly
 * the thing `\x1b[2K` cannot clean up.
 */
export function columnsOf(text: string): number {
  let columns = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6);
    columns += wide ? 2 : 1;
  }
  return columns;
}

/**
 * Cuts a string down to a column budget, keeping one end and marking the cut.
 *
 * `"head"` keeps the beginning — right for a sentence, whose subject comes
 * first. `"tail"` keeps the end — right for the fallback, where the point is
 * that the text is still arriving.
 *
 * The ellipsis is inside the budget rather than added to it. A row that is one
 * column too wide wraps, and then it is two rows.
 */
export function clipColumns(
  text: string,
  budget: number,
  keep: "head" | "tail",
): string {
  if (budget <= 0) return "";
  if (columnsOf(text) <= budget) return text;
  if (budget === 1) return "…";

  const room = budget - 1;
  const characters = [...text];
  let used = 0;

  if (keep === "head") {
    const out: string[] = [];
    for (const ch of characters) {
      const width = columnsOf(ch);
      if (used + width > room) break;
      out.push(ch);
      used += width;
    }
    return `${out.join("")}…`;
  }

  const out: string[] = [];
  for (let i = characters.length - 1; i >= 0; i--) {
    const ch = characters[i];
    if (ch === undefined) break;
    const width = columnsOf(ch);
    if (used + width > room) break;
    out.unshift(ch);
    used += width;
  }
  return `…${out.join("")}`;
}

/**
 * The last sentence that has finished, or `""` while none has.
 *
 * "Finished" is decided by punctuation, and the set is deliberately narrow:
 * the CJK stops, `!`, `?`, a newline, and a `.` that is followed by a space or
 * the end of the text. A bare `.` is left out because it is also a decimal point
 * and an abbreviation, and a wrong split here shows the reader half a sentence —
 * worse than the fallback, which at least admits it is a fragment.
 *
 * ⚠️ The consequence is worth stating: a chain of thought written in English
 * with no trailing space after its full stops falls back to the tail. That is
 * accepted rather than fixed, because the alternative is sentence segmentation,
 * and this is a status row.
 */
export function latestSentence(text: string): string {
  const ends: number[] = [];
  const characters = [...text];
  for (let i = 0; i < characters.length; i++) {
    const ch = characters[i];
    if (ch === undefined) continue;
    if (
      ch === "。" ||
      ch === "！" ||
      ch === "？" ||
      ch === "!" ||
      ch === "?" ||
      ch === "\n"
    ) {
      ends.push(i);
      continue;
    }
    if (ch === ".") {
      const next = characters[i + 1];
      if (next === undefined || next === " " || next === "\n") ends.push(i);
    }
  }

  if (ends.length === 0) return "";
  const last = ends[ends.length - 1];
  const previous = ends.length >= 2 ? ends[ends.length - 2] : -1;
  if (last === undefined || previous === undefined) return "";
  return characters
    .slice(previous + 1, last + 1)
    .join("")
    .trim();
}

/** What the row shows for a block that has produced `text` so far. */
export function rowFor(text: string, budget: number): string {
  const sentence = latestSentence(text);
  return sentence === ""
    ? clipColumns(text.replaceAll("\n", " ").trimStart(), budget, "tail")
    : clipColumns(sentence, budget, "head");
}

/**
 * What to assume when the terminal will not say how wide it is.
 *
 * ⚠️ Not a style choice — a measured one. Under a pty with no window size set,
 * `process.stdout.columns` is **0**, not `undefined`, so the obvious
 * `columns ?? 80` sails straight past it and the budget arithmetic lands on 1.
 * The symptom is a thinking row that is nothing but an ellipsis, and it is
 * invisible in unit tests because they pass a width. `repro/30` caught it on a
 * real pty; that is what the pty is for.
 */
const UNKNOWN_WIDTH = 80;

export interface StatusRowIO {
  write: (text: string) => void;
  /**
   * Read per repaint rather than captured: a terminal can be resized mid-block.
   *
   * Anything at or below zero means "would not say", and is treated as
   * {@link UNKNOWN_WIDTH} — see the note there.
   */
  columns: () => number;
  /** Cursor control needs a terminal. Without one there is no row to repaint. */
  isTTY: boolean;
  /** Dim is colour, and colour has its own switch (`NO_COLOR`). */
  styled: boolean;
}

export interface StatusRow {
  /** Add more of the block being thought, and repaint. */
  push: (chunk: string) => void;
  /**
   * Replace what the row shows, and repaint.
   *
   * The other content a live row carries is not a growing block of prose but a
   * fact that keeps being restated — *this command has been running for 14s* —
   * where appending would be wrong twice: the row would grow without bound, and
   * the tail is not what the reader wants, the latest value is. Same row, same
   * erase discipline, different content policy.
   */
  replace: (text: string) => void;
  /**
   * End the block: erase the row and hand back everything it showed, or
   * `undefined` when no block was open.
   *
   * The caller writes the trace line rather than this object, because the caller
   * is the one that knows what else is about to be printed — and the trace has
   * to read the same whether it comes from here or from a resumed session, which
   * is why its wording lives in `transcript.ts` with the rest of the shared
   * vocabulary.
   */
  settle: () => string | undefined;
}

/**
 * The one-row live view of a block of reasoning.
 *
 * Opens with a newline so the row is its own, which matters twice: `\r` clears
 * whatever row the cursor happens to sit on, and without a fresh row the trace
 * line that replaces it would land on the end of the model's prose.
 */
export function statusRow(io: StatusRowIO): StatusRow {
  let text = "";
  let open = false;

  const paint = (): void => {
    if (!open) {
      io.write("\n");
      open = true;
    }
    if (!io.isTTY) return;
    const width = io.columns();
    // One column held back. A row filled to the last column wraps on some
    // terminals as soon as the next character would be written, and a wrapped
    // row is two rows.
    const body = rowFor(text, (width > 0 ? width : UNKNOWN_WIDTH) - 1);
    io.write(io.styled ? `${CLEAR_ROW}${DIM}${body}${RESET}` : `${CLEAR_ROW}${body}`);
  };

  return {
    push(chunk) {
      if (chunk === "") return;
      text += chunk;
      paint();
    },

    replace(next) {
      text = next;
      paint();
    },

    settle() {
      if (!open) return undefined;
      if (io.isTTY) io.write(CLEAR_ROW);
      const shown = text;
      text = "";
      open = false;
      return shown;
    },
  };
}
