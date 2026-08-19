import type { Session } from "../session";
import type { Spend } from "../usage";

/**
 * The list you pick from, and how a typed line becomes a pick.
 *
 * Deliberately two pure functions rather than a component that owns the
 * terminal: the console has **one** readline interface and everything reads
 * through it (see the note on `Pending` in `repl.ts` — two consumers of "line"
 * events make which one wins a matter of timing). So the picker never reads
 * anything; it renders, and it interprets a line the repl already has.
 *
 * That is also what makes it testable without a terminal, which was the whole
 * argument for a numbered list over an arrow-key selector.
 */

/** How many rows are shown before the list is cut off. */
export const PAGE = 20;

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export function renderSessionList(sessions: Session[]): string {
  if (sessions.length === 0) return "no earlier sessions.";

  const shown = sessions.slice(0, PAGE);
  const width = String(shown.length).length;
  const rows = shown.map((session, index) => {
    const number = String(index + 1).padStart(width);
    // The gate marker is the one column worth colour: it is the difference
    // between "carry on chatting" and "a command is waiting for your answer".
    const gate = session.atGate ? "⚠" : " ";
    return (
      `  ${number}  ${gate} ${DIM}${session.id.slice(0, 8)}  ` +
      `${String(session.messages).padStart(3)} msg  ${tokens(session.spent).padStart(6)}  ` +
      `${stamp(session.lastActive)}${RESET}  ` +
      session.title
    );
  });

  const more =
    sessions.length > PAGE
      ? `\n${DIM}  …and ${String(sessions.length - PAGE)} more${RESET}`
      : "";

  return `${rows.join("\n")}${more}\n${DIM}  enter a number to carry on, or press enter for a new session${RESET}`;
}

/** What a line typed at the picker meant. */
export type Choice =
  { kind: "pick"; session: Session } | { kind: "skip" } | { kind: "again" };

export function readChoice(input: string, sessions: Session[]): Choice {
  if (input === "") return { kind: "skip" };

  // Only the rows that were printed can be picked. Accepting a number past the
  // cut-off would address a session the user never saw.
  const index = Number(input);
  const session = Number.isInteger(index)
    ? sessions.slice(0, PAGE)[index - 1]
    : undefined;
  if (session === undefined) return { kind: "again" };
  return { kind: "pick", session };
}

/** One line naming the session that was just adopted. */
export function describeSession(session: Session): string {
  return (
    `${DIM}(resuming ${session.id.slice(0, 8)} · ${String(session.messages)} messages · ` +
    `${stamp(session.lastActive)})${RESET} ${session.title}`
  );
}

/**
 * What the session moved, short enough for a column.
 *
 * All four buckets added, because the question a list answers is "how big was
 * this one", not "where did it go". The split that decides the real price — how
 * much was served from cache — and the per-model breakdown are on the `Session`
 * for anything that wants to ask properly.
 */
function tokens(spent: Spend): string {
  const total = spent.uncachedInput + spent.output + spent.cacheRead + spent.cacheWrite;
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`;
  if (total >= 1_000) return `${String(Math.round(total / 1_000))}k`;
  return String(total);
}

function stamp(when: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${pad(when.getMonth() + 1)}-${pad(when.getDate())} ` +
    `${pad(when.getHours())}:${pad(when.getMinutes())}`
  );
}
