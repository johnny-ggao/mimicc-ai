/**
 * Markdown, rendered for a terminal, one line at a time.
 *
 * ## Why line-buffered and not token-by-token
 *
 * The model's reply arrives as streamed chunks that split wherever the tokeniser
 * happened to split. `**bold**` reaches this file as `**bo`, `ld`, `**` on three
 * separate calls, so there is no point at which a chunk can be rendered on its
 * own — a renderer applied per chunk would emit the asterisks and then have
 * nothing left to match. Text is therefore held until a newline completes a
 * line, and the line is what gets rendered.
 *
 * The cost is real and worth stating: output no longer appears character by
 * character, it appears line by line. At streaming speed a line lands every half
 * second or so. The alternative — printing raw, then rewinding the cursor and
 * reprinting the rendered line — breaks the moment a line is long enough for the
 * terminal to soft-wrap it, because one `\x1b[2K` clears one screen row and a
 * wrapped line occupies several. Choosing the version that cannot corrupt the
 * scrollback.
 *
 * ## Why the subset is this subset
 *
 * Taken from what the model actually writes, read out of a real thread file
 * rather than guessed: bold, inline code, ordered and unordered lists,
 * paragraphs. Headings, fences, quotes and rules are included because they cost
 * a line each and appear as soon as you ask for code. Tables are not: they need
 * the whole block buffered and column widths measured, and nothing in the
 * transcripts produced one.
 *
 * ## The one rule that comes from the domain
 *
 * **`_underscore italics_` is deliberately not supported.** This is an agent
 * that talks about code, and its output is full of `tool_call_id`,
 * `__pregel_tasks` and `_windowCutoff`. Supporting that syntax means eating the
 * middle of identifiers — a renderer that corrupts the text it renders is worse
 * than no renderer. `*asterisk italics*` carries no such risk here and is kept.
 */

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";
/** Cyan. Inline code and code blocks, so verbatim text is obvious at a glance. */
const CODE = "\x1b[36m";
/** Bright blue, for the one thing in a line that is a destination. */
const LINK = "\x1b[34m";

/**
 * Whether to emit escape codes at all.
 *
 * Two conditions, both of them conventions the terminal ecosystem already
 * agreed on: `NO_COLOR` set to anything means the user asked for none
 * (no-color.org), and a stdout that is not a TTY is a pipe or a file, where
 * escapes are corruption rather than colour. `bun src/main.ts > out.txt` should
 * produce readable text.
 */
export function stylingEnabled(
  env: Record<string, string | undefined> = process.env,
  isTTY: boolean = process.stdout.isTTY === true,
): boolean {
  if (env["NO_COLOR"] !== undefined && env["NO_COLOR"] !== "") return false;
  return isTTY;
}

/** Set once per stream so a single decision applies to the whole reply. */
interface Style {
  (code: string, text: string): string;
}

const styled: Style = (code, text) => `${code}${text}${RESET}`;
const plain: Style = (_code, text) => text;

/**
 * Inline spans within one line.
 *
 * Code spans are split out **first** and never looked at again, which is the
 * whole reason this is a split rather than a chain of replaces: `` `a**b**c` ``
 * is code containing asterisks, not code containing bold, and any order that
 * runs the emphasis pass over the raw line gets that wrong.
 *
 * The known limitation of doing it this way is the mirror image — emphasis
 * *containing* code, `**see `foo()`**`, comes out unbolded because the markers
 * end up in different pieces. That form does not appear in the transcripts and
 * unpicking it costs a real parser.
 */
function inline(text: string, style: Style): string {
  return text
    .split(/(`[^`]*`)/)
    .map((part) =>
      part.startsWith("`") && part.endsWith("`") && part.length >= 2
        ? style(CODE, part.slice(1, -1))
        : emphasis(part, style),
    )
    .join("");
}

function emphasis(text: string, style: Style): string {
  return (
    text
      // Doubles before singles, or `**x**` is read as an empty italic wrapping
      // `x` wrapping another empty italic.
      .replace(/\*\*([^*]+)\*\*/g, (_, inner: string) => style(BOLD, inner))
      .replace(/\*([^*]+)\*/g, (_, inner: string) => style(ITALIC, inner))
      // The label carries the meaning and the URL is reference material, so the
      // URL is dimmed rather than dropped: a terminal cannot be clicked through
      // reliably, and an address the reader cannot recover is worse than a noisy
      // line.
      .replace(
        /\[([^\]]+)\]\(([^)]+)\)/g,
        (_, label: string, url: string) => `${style(LINK, label)} ${style(DIM, url)}`,
      )
  );
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)(\d+[.)])\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const FENCE = /^\s*(?:```|~~~)(.*)$/;

/**
 * One completed line, ready to print. Exported for the tests, which assert on
 * strings rather than on a terminal.
 *
 * `insideFence` is passed in rather than kept here because it is the only state
 * that spans lines, and a pure function is the difference between testing this
 * with a table of inputs and testing it by driving a stream.
 */
export function renderLine(line: string, insideFence: boolean, style: Style): string {
  // Tested before the fence *body*, not after, and that ordering is the whole
  // of it: the closing fence is itself a line inside the fence, so a renderer
  // that checks `insideFence` first prints the backticks verbatim and never
  // leaves the block. Found by the test, not by reading.
  const fence = FENCE.exec(line);
  // The language tag is worth keeping and the backticks are not. A closing fence
  // has no tag and renders to nothing, which leaves one blank line between the
  // code and whatever follows it — the separation a fence was drawing anyway.
  if (fence) return fence[1]?.trim() ? style(DIM, fence[1].trim()) : "";

  // Inside a fence nothing is markup — that is what a fence is for. Coloured so
  // the block reads as verbatim, but not indented: indentation would be copied
  // along with the code.
  if (insideFence) return style(CODE, line);

  if (RULE.test(line)) return style(DIM, "─".repeat(40));

  const heading = HEADING.exec(line);
  if (heading) return style(BOLD, inline(heading[2] ?? "", style));

  const quote = QUOTE.exec(line);
  if (quote) return `${style(DIM, "│")} ${inline(quote[1] ?? "", style)}`;

  const bullet = BULLET.exec(line);
  if (bullet)
    return `${bullet[1] ?? ""}${style(DIM, "•")} ${inline(bullet[2] ?? "", style)}`;

  const ordered = ORDERED.exec(line);
  if (ordered) {
    return `${ordered[1] ?? ""}${style(DIM, ordered[2] ?? "")} ${inline(ordered[3] ?? "", style)}`;
  }

  return inline(line, style);
}

export interface MarkdownStream {
  /** Feed one streamed chunk. Whole lines are written out; a partial tail waits. */
  push(text: string): void;
  /** Write whatever is left. Safe to call repeatedly and when nothing is held. */
  flush(): void;
}

/**
 * A renderer for one reply.
 *
 * One instance per turn, because the fence state has to reset: a reply that ends
 * mid-fence — the model stopped, or the user pressed Ctrl+C — must not leave the
 * next reply rendering as code.
 *
 * `flush` exists for two callers, and both matter. The end of a reply is the
 * obvious one. The other is anything else that wants to print: the console
 * renders tool calls from a separate event stream, and a held partial line would
 * otherwise surface *after* the tool line that logically came later.
 */
export function markdownStream(
  write: (text: string) => void,
  style: Style = stylingEnabled() ? styled : plain,
): MarkdownStream {
  let buffer = "";
  let insideFence = false;

  const emit = (line: string): void => {
    const fence = FENCE.test(line);
    write(`${renderLine(line, insideFence, style)}\n`);
    if (fence) insideFence = !insideFence;
  };

  return {
    push(text: string): void {
      buffer += text;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        emit(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    },
    flush(): void {
      if (buffer === "") return;
      const held = buffer;
      // Cleared before writing, not after: `write` reaches the terminal and a
      // throw there must not leave the same text queued to be printed again.
      buffer = "";
      write(renderLine(held, insideFence, style));
    },
  };
}

/** The two styles, exported so callers and tests can pick without a terminal. */
export const STYLES = { styled, plain };
