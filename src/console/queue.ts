/**
 * The lines the user has typed and the console has not acted on yet.
 *
 * ## Why the console owns this at all
 *
 * A line belongs to whatever the console was asking when it **arrived**, not to
 * whatever it happens to be asking when the line is read. That distinction was a
 * shipping bug rather than a nicety (ticket 04): `for await (const line of rl)`
 * does not pause readline while the body is awaiting a turn — the events keep
 * firing and the async iterator buffers them, then replays them when the loop
 * comes back (measured, both on a TTY and on a pipe:
 * `repro/15-typing-during-a-turn.ts`). The arrival order survives; the arrival
 * *moment* does not, and the moment is the only thing that distinguishes
 * "answering the gate" from "was typed before the gate existed".
 *
 * So the queue is collected here instead of being borrowed from readline. That
 * ownership is what the rest of this file is: a buffer somebody else holds can
 * only be read, while a queue of our own can also be **capped** and **cleared**,
 * and can say what it threw away.
 *
 * ## Why so much of it is terminal-only
 *
 * Piped input has no arrival moment: the whole script was written before the
 * process started, its order is deliberate, and there is no human whose stray
 * keystroke needs protecting. Enforcing arrival there would make it impossible
 * to answer a gate from a script at all — which is how this program is driven in
 * probes and tests. The cap has the same shape of problem and the same answer:
 * a piped script's lines all arrive at once, tagged "input", and a cap would kill
 * every probe in the repository. So both rules are on where they protect somebody
 * and off where they would only get in the way, and that is a decision rather
 * than an oversight.
 *
 * ## Why nothing here writes to the terminal
 *
 * Dropping a line silently is the same class of bug as acting on the wrong one,
 * so everything discarded comes back out of {@link sweep} for the caller to
 * print. Keeping the writing in the loop is also what keeps this testable, and
 * it is what puts the words at a moment when they will not collide with a reply
 * being streamed.
 */

/** Which question a line was answering when it arrived. */
export type Tag = "input" | "gate" | "picker";

/** One line, and what it was an answer to. */
export interface Arrived {
  tag: Tag;
  text: string;
  /**
   * True when it was typed while a turn was in flight — that is, when it is the
   * *queued input* of the glossary rather than an ordinary prompt line. The
   * console says so before running it, because by then the reply it was typed
   * over has scrolled and the two are indistinguishable on screen.
   */
  queued: boolean;
}

/** A line the console will never act on, and why. */
export interface Dropped {
  reason: "stale" | "capped" | "aborted";
  text: string;
}

/**
 * How many typed-ahead lines may wait.
 *
 * One, and the reason is not terminal ergonomics. A second queued line means the
 * user is giving instructions to a turn whose output they have not seen yet —
 * which is not something they can have reasoned about, so running it is the
 * console deciding on their behalf. Dropping it out loud is the smaller error,
 * and it is the same direction ticket 04 chose when it had to pick one.
 *
 * ⚠️ Counted over `"input"` lines alone. A batch of tool calls is answered with
 * one line per request — three `y`s at a gate are three lines, all tagged
 * `"gate"`, consumed one at a time without starting a single turn. Counting
 * those would cap the confirmation gate, which is the opposite of the point.
 */
export const QUEUE_LIMIT = 1;

export class InputQueue {
  readonly #strict: boolean;
  #lines: Arrived[] = [];
  #drops: Dropped[] = [];

  /** @param strict Whether arrival rules apply — true on a terminal. */
  constructor(strict: boolean) {
    this.#strict = strict;
  }

  /** How many lines are waiting. For tests; the console never asks. */
  get depth(): number {
    return this.#lines.length;
  }

  /**
   * Records a line as it arrives, or refuses it when the queue is already full.
   *
   * The cap is enforced here rather than at the far end because "it never
   * entered the queue" is a cleaner thing to explain than "it waited and was
   * then thrown away" — and because the newest line is the right one to refuse:
   * the earlier one is the thought the user had already finished having.
   */
  push(tag: Tag, text: string, queued: boolean): void {
    if (this.#strict && tag === "input" && this.#count("input") >= QUEUE_LIMIT) {
      this.#drops.push({ reason: "capped", text });
      return;
    }
    this.#lines.push({ tag, text, queued });
  }

  /**
   * Everything the user should be told about since the last call: lines refused
   * by the cap, lines emptied by an abort, and lines whose question has since
   * been answered and can therefore never be consumed.
   *
   * @param alive Whether the console can still act on a line with that tag —
   * a decision typed at a gate that is now closed cannot be, and neither can a
   * choice typed at a picker that is gone.
   */
  sweep(alive: (tag: Tag) => boolean): Dropped[] {
    if (this.#strict) {
      this.#lines = this.#lines.filter((line) => {
        if (alive(line.tag)) return true;
        this.#drops.push({ reason: "stale", text: line.text });
        return false;
      });
    }
    const drops = this.#drops;
    this.#drops = [];
    return drops;
  }

  /**
   * The next line the console may act on, or undefined when nothing waiting
   * answers the question currently being asked.
   *
   * On a pipe there is no tag to respect, so the head comes off in order — see
   * the note at the top of this file.
   */
  take(want: Tag): Arrived | undefined {
    const index = this.#strict ? this.#lines.findIndex((line) => line.tag === want) : 0;
    if (index === -1 || this.#lines.length === 0) return undefined;
    const [line] = this.#lines.splice(index, 1);
    return line;
  }

  /**
   * Empties the queue, remembering what was in it so the caller can say so.
   *
   * Only an abort may do this, and the reason is in the glossary rather than
   * here: `/clear` and `/resume` are themselves lines *in* the queue, so
   * anything ahead of them was typed first and first-come is the honest order.
   * An abort is not a line at all — it is the orthogonal control signal, and
   * being outside the queue is exactly what earns it the right to empty it.
   */
  clear(): void {
    for (const line of this.#lines)
      this.#drops.push({ reason: "aborted", text: line.text });
    this.#lines = [];
  }

  #count(tag: Tag): number {
    return this.#lines.filter((line) => line.tag === tag).length;
  }
}

/**
 * The lines to print for a batch of drops.
 *
 * Capped drops are collapsed into a count, because the case that produces more
 * than one of them is a paste: five pasted lines produced five back-to-back
 * turns before this existed (measured), and printing five refusals to explain
 * that would just be the same flood wearing a different hat. One refusal still
 * shows its text — a single stray line is worth naming, and it is short.
 */
export function describeDrops(drops: readonly Dropped[]): string[] {
  const lines: string[] = [];
  const capped: Dropped[] = [];

  for (const drop of drops) {
    if (drop.reason === "capped") capped.push(drop);
    else if (drop.reason === "aborted") lines.push(`(dropped, ^C: ${drop.text})`);
    else lines.push(`(dropped, the question it answered is gone: ${drop.text})`);
  }

  if (capped.length === 1 && capped[0] !== undefined) {
    lines.push(
      `(dropped, only one line can wait for the current turn: ${capped[0].text})`,
    );
  } else if (capped.length > 1) {
    lines.push(
      `(dropped ${String(capped.length)} lines — only one line can wait for the current turn)`,
    );
  }

  return lines;
}
