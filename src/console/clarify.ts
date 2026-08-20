import type { ClarifyAnswer, ClarifyQuestion } from "../tools";

/**
 * The question the model asked, on a terminal that reads lines.
 *
 * Two pure functions and a value, the same shape as `picker.ts` and for the same
 * reason: the console has **one** readline interface and everything reads through
 * it, so nothing here consumes input. It renders, and it interprets a line the
 * repl already has.
 *
 * ## Why a numbered list and not the arrow-key selector
 *
 * Because this is the half that has to work when there is no terminal at all.
 * Piped stdin — every probe, every test, `bun src/main.ts < script` — has no
 * cursor to move and no screen to redraw, and a tool the model can call in those
 * runs must still be answerable or the run parks forever on an interrupt nobody
 * can see. So the line-based renderer is not a degradation of the selector; it is
 * the other one of the two, and the one that is always reachable.
 *
 * `repro/26-handing-stdin-to-raw-mode.ts` measured what the selector will cost
 * when it lands: readline has to be **closed and rebuilt** around it, because
 * `rl.pause()` leaves both consumers on the stream and the Enter that dismisses
 * the selector arrives a second time as an empty line — into the same queue whose
 * empty-line handling was a shipping bug once (`readDecision`, repl.ts:543).
 */

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** A question set the console is part-way through. */
export interface Quiz {
  questions: readonly ClarifyQuestion[];
  /** One per question already answered, in order. Its length is the cursor. */
  answers: ClarifyAnswer[];
}

/**
 * The question now waiting, with its options numbered.
 *
 * The counter is the confirmation gate's (`ask`, repl.ts:524) rather than a new
 * idea: a batch the user is part-way through has to say how far, or answering
 * four questions in a row is four identical-looking prompts.
 */
export function renderQuestion(quiz: Quiz): string {
  const question = quiz.questions[quiz.answers.length];
  if (question === undefined) return "";

  const counter =
    quiz.questions.length > 1
      ? ` ${DIM}(${String(quiz.answers.length + 1)}/${String(quiz.questions.length)})${RESET}`
      : "";

  const options = question.options
    .map(
      (option, index) =>
        `  ${String(index + 1)}  ${option.label}\n` +
        `     ${DIM}${option.description}${RESET}`,
    )
    .join("\n");

  return (
    `\n${DIM}?${RESET} ${question.question}${counter}  ${DIM}[${question.header}]${RESET}\n\n` +
    `${options}\n` +
    `${DIM}  a number, or type your own answer${RESET}\n`
  );
}

/**
 * Folds one line into the quiz. Returns the answers once every question has one,
 * and null while more input is needed.
 */
export function readAnswer(input: string, quiz: Quiz): ClarifyAnswer[] | null {
  const question = quiz.questions[quiz.answers.length];
  if (question === undefined) return null;

  // ⚠️ **An empty line is not an answer**, and this is the gate's rule rather
  // than a new one. `readDecision` has a branch for exactly this because sharing
  // one with "approve" was a shipping bug: a line typed while a turn was running
  // is replayed when the loop comes back (`repro/15`), so an Enter pressed out of
  // impatience answered a question nobody had read yet. Here the same keystroke
  // would silently pick option 1, or record "" as a considered preference.
  if (input === "") return null;

  const index = Number(input);
  const picked =
    Number.isInteger(index) && index >= 1 && index <= question.options.length
      ? question.options[index - 1]
      : undefined;

  quiz.answers.push(
    picked !== undefined
      ? { header: question.header, chosen: [picked.label], typed: false }
      : // Anything that is not one of the numbers is the user's own answer. Not
        // an error: the options are what the model thought of, and the case this
        // tool exists for is the one where none of them is right.
        { header: question.header, chosen: [input], typed: true },
  );

  return quiz.answers.length < quiz.questions.length ? null : quiz.answers;
}
