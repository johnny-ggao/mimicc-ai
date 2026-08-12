/**
 * Locating an edit target when the model's copy of the text is imperfect.
 *
 * The model never sees the file's bytes. `Read` renders them — it prefixes every
 * line with `N\t`, and a terminal shows a tab, four spaces and a trailing space
 * as the same nothing. So what comes back in `oldString` is a *reconstruction*,
 * and it drifts in predictable ways: line endings, blank lines around a block,
 * indentation width, tabs against spaces.
 *
 * The answer is a ladder of progressively looser matches, and one invariant that
 * never loosens: **a level that finds more than one match fails**. Tolerance is
 * allowed to reduce the number of false rejections; it is never allowed to pick
 * one of several candidates. That is what keeps a fuzzy match from turning a
 * loud failure into a silent wrong edit.
 */

/** How the target was found. Reported back so a loose match is never invisible. */
export type MatchLevel =
  | "exact"
  | "line endings normalised"
  | "surrounding blank lines ignored"
  | "indentation ignored";

export interface Located {
  /** Byte offset of the match in the original text. */
  start: number;
  /** Byte offset just past the match. */
  end: number;
  level: MatchLevel;
  /** Replacement text, re-indented when the level ignored indentation. */
  replacement: string;
}

export class AmbiguousMatch extends Error {
  constructor(
    readonly count: number,
    readonly level: MatchLevel,
  ) {
    super(`matches ${String(count)} places`);
    this.name = "AmbiguousMatch";
  }
}

interface Line {
  /** Content without the line ending. */
  text: string;
  /** "\n", "\r\n" or "" for a final line with no terminator. */
  ending: string;
  /** Byte offset of `text` in the source. */
  start: number;
}

/**
 * Splits while keeping each line's own ending and offset.
 *
 * Both matter: the offsets are how a line-level match maps back to a byte range,
 * and the endings are how the untouched part of a CRLF file stays CRLF. A
 * normalise-then-write implementation would silently rewrite every line ending
 * in the file as a side effect of one edit.
 */
function splitLines(source: string): Line[] {
  const lines: Line[] = [];
  let start = 0;

  for (let i = 0; i < source.length; i += 1) {
    if (source[i] !== "\n") continue;
    const hasCarriage = i > start && source[i - 1] === "\r";
    lines.push({
      text: source.slice(start, hasCarriage ? i - 1 : i),
      ending: hasCarriage ? "\r\n" : "\n",
      start,
    });
    start = i + 1;
  }
  if (start <= source.length) {
    lines.push({ text: source.slice(start), ending: "", start });
  }

  return lines;
}

/** Leading whitespace of a line. */
function indentOf(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? "";
}

/**
 * Shifts `lines` from one indentation base to another.
 *
 * Only used by the level that ignored indentation: if the model wrote two spaces
 * where the file has a tab, applying its replacement verbatim would leave the
 * block indented the model's way. Blank lines keep their emptiness rather than
 * gaining trailing whitespace.
 */
function reindent(lines: string[], from: string, to: string): string[] {
  if (from === to) return lines;
  return lines.map((line) => {
    if (line.trim() === "") return line;
    return line.startsWith(from) ? to + line.slice(from.length) : line;
  });
}

/** Drops blank lines from both ends. */
function trimBlank(lines: string[]): string[] {
  let first = 0;
  let last = lines.length;
  while (first < last && lines[first]?.trim() === "") first += 1;
  while (last > first && lines[last - 1]?.trim() === "") last -= 1;
  return lines.slice(first, last);
}

/**
 * Slides a window of `needle.length` lines and returns every window where every
 * pair compares equal under `same`.
 */
function windows(
  haystack: Line[],
  needle: string[],
  same: (a: string, b: string) => boolean,
): number[] {
  if (needle.length === 0 || needle.length > haystack.length) return [];

  const hits: number[] = [];
  for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    let ok = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (!same(haystack[i + j]?.text ?? "", needle[j] ?? "")) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  return hits;
}

/**
 * Counts occurrences of `needle`, **including overlapping ones**.
 *
 * `"aa"` occurs twice in `"aaa"`, not once. The split-and-count shortcut reports
 * one and would let the first position be edited silently — which is the one
 * thing uniqueness is here to forbid. Counting overlaps only ever turns a silent
 * choice into a visible refusal.
 */
function countSubstring(haystack: string, needle: string): number {
  let count = 0;
  for (let from = 0; ; from += 1) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at;
  }
}

/**
 * Walks the ladder and returns the one place to edit.
 *
 * Returns null when no level found anything. Throws `AmbiguousMatch` as soon as
 * a level finds several — deliberately without trying looser levels, because a
 * looser level can only ever find more.
 */
export function locate(
  source: string,
  oldString: string,
  newString: string,
): Located | null {
  // 1 — exact. Substring rather than whole-line, because renaming a symbol
  // inside a line is a normal edit and the strictest level should still allow it.
  const exact = countSubstring(source, oldString);
  if (exact > 1) throw new AmbiguousMatch(exact, "exact");
  if (exact === 1) {
    const start = source.indexOf(oldString);
    return {
      start,
      end: start + oldString.length,
      level: "exact",
      replacement: newString,
    };
  }

  const fileLines = splitLines(source);
  const oldLines = splitLines(oldString).map((line) => line.text);
  const newLines = splitLines(newString).map((line) => line.text);

  // Levels 2 to 4, loosest comparison last. Each entry is the needle to look for
  // and how two lines are considered equal.
  const ladder: {
    level: MatchLevel;
    needle: string[];
    same: (a: string, b: string) => boolean;
  }[] = [
    // 2 — line endings. Comparing line *content* is what normalises them; the
    // file keeps its own endings because only whole lines get spliced.
    { level: "line endings normalised", needle: oldLines, same: (a, b) => a === b },
    // 3 — a block the model padded with blank lines at either end.
    {
      level: "surrounding blank lines ignored",
      needle: trimBlank(oldLines),
      same: (a, b) => a === b,
    },
    // 4 — the one that does the real work. Indentation is the thing a terminal
    // renders identically for tabs and spaces, so it is the thing the model gets
    // wrong most.
    {
      level: "indentation ignored",
      needle: trimBlank(oldLines),
      same: (a, b) => a.trim() === b.trim(),
    },
  ];

  for (const { level, needle, same } of ladder) {
    const hits = windows(fileLines, needle, same);
    if (hits.length > 1) throw new AmbiguousMatch(hits.length, level);
    if (hits.length !== 1) continue;

    const first = hits[0] ?? 0;
    const head = fileLines[first];
    const tail = fileLines[first + needle.length - 1];
    if (head === undefined || tail === undefined) continue;

    // Up to but not including the final line's ending: replacing "a\nb\n" with
    // one line should leave the file's trailing newline where it was.
    const start = head.start;
    const end = tail.start + tail.text.length;

    // Deleting is the exception. Leaving the ending behind turns "remove these
    // lines" into "blank these lines out", and the residue is invisible in a
    // terminal — the same class of thing this whole module exists to avoid.
    // Only line-level matches do this; an exact match deleting part of a line
    // must not swallow that line's newline.
    if (newString.length === 0) {
      return { start, end: end + tail.ending.length, level, replacement: "" };
    }

    const body =
      level === "indentation ignored"
        ? reindent(newLines, indentOf(needle[0] ?? ""), indentOf(head.text))
        : newLines;

    return { start, end, level, replacement: body.join(head.ending || "\n") };
  }

  return null;
}
