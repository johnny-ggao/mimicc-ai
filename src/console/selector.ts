import type { ClarifyAnswer, ClarifyQuestion } from "../tools";

/**
 * The arrow-key selector: the same questions `clarify.ts` renders as a numbered
 * list, on a terminal that can be redrawn.
 *
 * ## Why both exist
 *
 * The numbered list is the one that is always reachable — piped stdin has no
 * cursor to move — and this one is the one that is nicer when there is a person
 * at a keyboard. Neither is a fallback for the other: `runRepl` picks by whether
 * stdin is a TTY, the same condition readline itself is configured with.
 *
 * ## Why the state machine is pure
 *
 * `picker.ts` opens with the argument this file has to answer: a numbered list
 * was chosen over an arrow-key selector because *"the console has one readline
 * interface and everything reads through it"*, and because two pure functions are
 * testable without a terminal. The first half is now measured rather than
 * argued (`repro/26-handing-stdin-to-raw-mode.ts`) and it turned out to be an
 * argument against **one particular handoff**, not against selectors. The second
 * half still stands, so it is kept: {@link frame} and {@link press} never touch
 * the terminal, and {@link runSelector} is the thin impure shell around them.
 */

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** Below this a frame cannot be drawn at all, so it is drawn as if there were room. */
const MIN_COLUMNS = 40;

/** The last row of every question: say something the model did not think of. */
const OWN_ANSWER = "Type your own answer";

/** What a keypress looks like once `emitKeypressEvents` has parsed it. */
export interface Key {
  name?: string | undefined;
  sequence?: string | undefined;
  ctrl?: boolean | undefined;
  meta?: boolean | undefined;
}

/** Where the cursor is, and what has been decided so far. */
export interface SelectorState {
  questions: readonly ClarifyQuestion[];
  /** Which question is on screen. `questions.length` is the Submit tab. */
  tab: number;
  /** Row within the current question: `0..options.length` — the last is free text. */
  row: number;
  /** One slot per question, filled as they are answered. */
  answers: (ClarifyAnswer | undefined)[];
  /** Non-null while the free-text row is being typed into. */
  typing: string | null;
}

export function initial(questions: readonly ClarifyQuestion[]): SelectorState {
  return {
    questions,
    tab: 0,
    row: 0,
    answers: questions.map(() => undefined),
    typing: null,
  };
}

/** What a keypress did. */
export type Step =
  { kind: "redraw" } | { kind: "done"; answers: ClarifyAnswer[] } | { kind: "cancel" };

/** Whether the Submit tab is where the cursor is. */
function onSubmit(state: SelectorState): boolean {
  return state.tab >= state.questions.length;
}

/** Rows on the current question: one per option, plus the free-text row. */
function rows(state: SelectorState): number {
  const question = state.questions[state.tab];
  return question === undefined ? 1 : question.options.length + 1;
}

/**
 * Folds one keypress into the state.
 *
 * Mutates rather than returning a new state, and that is not laziness: the caller
 * redraws from the same object every frame, and a copy-on-write version would
 * make "which object is the live one" a question the driver has to keep answering
 * correctly at four call sites.
 */
export function press(state: SelectorState, key: Key): Step {
  // Typing wins over every navigation key, or the letters that move the cursor
  // could not be typed into an answer.
  if (state.typing !== null) return typeInto(state, key);

  if (key.name === "escape" || (key.ctrl === true && key.name === "c")) {
    return { kind: "cancel" };
  }

  if (key.name === "left") {
    state.tab = (state.tab + state.questions.length) % (state.questions.length + 1);
    state.row = 0;
    return { kind: "redraw" };
  }
  if (key.name === "right" || key.name === "tab") {
    state.tab = (state.tab + 1) % (state.questions.length + 1);
    state.row = 0;
    return { kind: "redraw" };
  }

  if (key.name === "up") {
    state.row = (state.row + rows(state) - 1) % rows(state);
    return { kind: "redraw" };
  }
  if (key.name === "down") {
    state.row = (state.row + 1) % rows(state);
    return { kind: "redraw" };
  }

  // A digit picks a row directly. Keeps the muscle memory of the numbered list
  // working on the terminal where both are available.
  const digit = Number(key.sequence);
  if (
    !onSubmit(state) &&
    Number.isInteger(digit) &&
    digit >= 1 &&
    digit <= rows(state)
  ) {
    state.row = digit - 1;
    return commit(state);
  }

  if (key.name === "return" || key.name === "enter" || key.name === "space") {
    return commit(state);
  }

  return { kind: "redraw" };
}

/** Enter on whatever the cursor is on. */
function commit(state: SelectorState): Step {
  if (onSubmit(state)) {
    const missing = state.answers.findIndex((answer) => answer === undefined);
    // Not an error and not a refusal: move to what is still missing. A Submit
    // that silently does nothing is the worst of the three.
    if (missing !== -1) {
      state.tab = missing;
      state.row = 0;
      return { kind: "redraw" };
    }
    return { kind: "done", answers: state.answers.filter((a) => a !== undefined) };
  }

  const question = state.questions[state.tab];
  if (question === undefined) return { kind: "redraw" };

  const option = question.options[state.row];
  if (option === undefined) {
    // The free-text row.
    state.typing = "";
    return { kind: "redraw" };
  }

  state.answers[state.tab] = {
    header: question.header,
    chosen: [option.label],
    typed: false,
  };
  return advance(state);
}

/** After an answer lands: the next unanswered question, or Submit. */
function advance(state: SelectorState): Step {
  const next = state.answers.findIndex((answer) => answer === undefined);
  state.tab = next === -1 ? state.questions.length : next;
  state.row = 0;
  return { kind: "redraw" };
}

/** Keystrokes while the free-text row is open. */
function typeInto(state: SelectorState, key: Key): Step {
  const typed = state.typing ?? "";

  if (key.name === "escape") {
    state.typing = null;
    return { kind: "redraw" };
  }
  if (key.ctrl === true && key.name === "c") return { kind: "cancel" };

  if (key.name === "backspace") {
    state.typing = typed.slice(0, -1);
    return { kind: "redraw" };
  }

  if (key.name === "return" || key.name === "enter") {
    // ⚠️ An empty line is not an answer — the confirmation gate's rule
    // (`readDecision`, repl.ts:543) and the numbered list's. Committing "" here
    // would record a considered preference nobody expressed.
    if (typed === "") return { kind: "redraw" };
    const question = state.questions[state.tab];
    if (question !== undefined) {
      state.answers[state.tab] = {
        header: question.header,
        chosen: [typed],
        typed: true,
      };
    }
    state.typing = null;
    return advance(state);
  }

  // Printable characters only. `sequence` is the raw input, so a control key that
  // reached here without a name must not be appended as mojibake.
  const sequence = key.sequence ?? "";
  if (sequence.length > 0 && key.ctrl !== true && key.meta !== true) {
    const code = sequence.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) state.typing = typed + sequence;
  }
  return { kind: "redraw" };
}

// ───────────────────────────────────────────────────────────── rendering

/**
 * Display width, counting East Asian wide characters as two columns.
 *
 * Needed for clipping rather than for looks: the driver redraws by moving the
 * cursor up by the number of lines it last wrote, so **a line that wraps is a
 * line the redraw miscounts** and the frame walks down the screen. Clipping to
 * the terminal's width is what keeps one line one row.
 */
export function width(text: string): number {
  let total = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    total +=
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff)
        ? 2
        : 1;
  }
  return total;
}

/** Clips to a column count, ignoring the escape sequences already in the text. */
function clip(text: string, columns: number): string {
  // Escapes cost no columns, so measure the text without them and only walk the
  // string when it is actually too wide — which is the uncommon case.
  // eslint-disable-next-line no-control-regex -- ESC is the thing being matched.
  const bare = text.replace(/\x1b\[[0-9;]*m/g, "");
  if (width(bare) <= columns) return text;

  let out = "";
  let used = 0;
  let escaping = false;
  for (const char of text) {
    if (escaping) {
      out += char;
      if (/[a-zA-Z]/.test(char)) escaping = false;
      continue;
    }
    if (char === "\x1b") {
      escaping = true;
      out += char;
      continue;
    }
    const cost = width(char);
    if (used + cost > columns - 1) break;
    used += cost;
    out += char;
  }
  return `${out}…${RESET}`;
}

/**
 * The whole selector, as lines.
 *
 * Returned as an array rather than a string because the driver has to know how
 * many rows it wrote in order to move back over them.
 */
export function frame(state: SelectorState, columns: number): string[] {
  const lines: string[] = [];
  // ⚠️ Clamped, and this was a real frame rather than a hypothetical one: a pty
  // that reports **0 columns** (measured — `expect`'s does) clipped every line in
  // the selector to a bare `…`. `?? 80` does not catch it, because 0 is a number.
  // A too-narrow floor is a wrapped line, which the redraw miscounts; a zero is
  // no content at all, which is worse, so the floor is generous.
  const width = columns >= MIN_COLUMNS ? columns : MIN_COLUMNS;
  const rule = "─".repeat(Math.max(10, Math.min(width - 2, 78)));

  if (state.questions.length > 1) {
    lines.push(`${DIM}${rule}${RESET}`);
    lines.push(tabs(state));
  }
  lines.push("");

  if (onSubmit(state)) {
    lines.push(`${BOLD}Submit${RESET}`);
    lines.push("");
    for (const [index, question] of state.questions.entries()) {
      const answer = state.answers[index];
      lines.push(
        answer === undefined
          ? `  ${DIM}☐ ${question.header} — not answered${RESET}`
          : `  ✔ ${question.header}: ${answer.chosen.join(", ")}`,
      );
    }
  } else {
    const question = state.questions[state.tab];
    if (question !== undefined) {
      lines.push(`${BOLD}${question.question}${RESET}`);
      lines.push("");
      for (const [index, option] of question.options.entries()) {
        const here = state.row === index;
        // The reset is emitted only when something was set — an unconditional one
        // leaves a stray escape on every unselected row.
        lines.push(
          `${here ? "❯" : " "} ${String(index + 1)}. ` +
            (here ? `${BOLD}${option.label}${RESET}` : option.label),
        );
        lines.push(`     ${DIM}${option.description}${RESET}`);
      }
      const own = state.row === question.options.length;
      lines.push(
        state.typing === null
          ? `${own ? "❯" : " "} ${String(question.options.length + 1)}. ${DIM}${OWN_ANSWER}${RESET}`
          : `❯ ${state.typing}${DIM}▌${RESET}`,
      );
    }
  }

  lines.push("");
  lines.push(`${DIM}${rule}${RESET}`);
  lines.push(`${DIM}  ${hint(state)}${RESET}`);

  return lines.map((line) => clip(line, width));
}

function hint(state: SelectorState): string {
  if (state.typing !== null) return "type an answer · enter to accept · esc to go back";
  if (state.questions.length > 1) {
    return "↑↓ choose · ←→ switch question · enter to accept · esc to skip";
  }
  return "↑↓ choose · enter to accept · esc to skip";
}

/** The tab bar: one box per question plus Submit, the current one underlined. */
function tabs(state: SelectorState): string {
  const cells = state.questions.map((question, index) => {
    const mark = state.answers[index] === undefined ? "☐" : "✔";
    const label = `${mark} ${question.header}`;
    return state.tab === index ? `${BOLD}${label}${RESET}` : `${DIM}${label}${RESET}`;
  });

  const ready = state.answers.every((answer) => answer !== undefined);
  const submit = `${ready ? "✔" : "☐"} Submit`;
  cells.push(onSubmit(state) ? `${BOLD}${submit}${RESET}` : `${DIM}${submit}${RESET}`);

  return `${DIM}←${RESET}  ${cells.join("  ")}  ${DIM}→${RESET}`;
}

// ───────────────────────────────────────────────────────────── the driver

/** What the driver needs from the outside world. */
export interface SelectorIO {
  write: (text: string) => void;
  columns: () => number;
  /** Subscribes to keypresses; the returned function unsubscribes. */
  onKey: (handler: (key: Key) => void) => () => void;
}

/**
 * Runs the selector to an answer, or to null when it was dismissed.
 *
 * Redraw is "move up over what was written, clear to the end of the screen, write
 * again". Clearing rather than overwriting because a shorter frame — the free-text
 * row collapsing back to one line — would otherwise leave the tail of the taller
 * one on screen.
 */
export async function runSelector(
  questions: readonly ClarifyQuestion[],
  io: SelectorIO,
): Promise<ClarifyAnswer[] | null> {
  const state = initial(questions);
  let painted = 0;

  const draw = (): void => {
    const lines = frame(state, io.columns());
    // `\x1b[{n}A` up n rows, `\x1b[0J` clear from the cursor to the end.
    io.write(
      `${painted > 0 ? `\x1b[${String(painted)}A\x1b[0J` : ""}${lines.join("\n")}\n`,
    );
    painted = lines.length;
  };

  draw();

  return new Promise<ClarifyAnswer[] | null>((resolve) => {
    const off = io.onKey((key) => {
      const step = press(state, key);
      if (step.kind === "redraw") {
        draw();
        return;
      }
      off();
      // Repaint once more so the closing frame shows the final state rather than
      // the cursor sitting on a half-answered question.
      draw();
      resolve(step.kind === "done" ? step.answers : null);
    });
  });
}
