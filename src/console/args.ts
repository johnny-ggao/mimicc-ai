/**
 * The command line, which until now did not exist: `main.ts` read no arguments
 * at all.
 *
 * Parsing is separated from acting for one reason — `--resume <id>` exists to be
 * **testable**. The interactive picker cannot be driven from `bun test`, so the
 * non-interactive path is the one that pins the behaviour, and a parser that
 * also touches the filesystem could not be called from a test either.
 *
 * ⚠️ The program is started as `bun run chat`, so a flag reaches it as
 * `bun run chat -- --resume`.
 */

/** What the arguments asked for. */
export type Invocation =
  | { kind: "new" }
  /** `--resume`, bare: show the picker before the first prompt. */
  | { kind: "pick" }
  /** `--resume <id>`: an id, or the front of one. */
  | { kind: "resume"; prefix: string }
  | { kind: "error"; message: string };

const USAGE = "usage: mimicc [--resume [<session-id>]]";

export function parseArgs(argv: string[]): Invocation {
  const [first, ...rest] = argv;

  if (first === undefined) return { kind: "new" };

  if (first === "--resume" || first === "-r") {
    const [prefix, ...extra] = rest;
    if (extra.length > 0) return { kind: "error", message: USAGE };
    if (prefix === undefined) return { kind: "pick" };
    // A second flag where an id belongs is a typo, not a session named `--foo`.
    if (prefix.startsWith("-")) return { kind: "error", message: USAGE };
    return { kind: "resume", prefix };
  }

  const inline = /^(?:--resume|-r)=(.+)$/.exec(first);
  if (inline?.[1] !== undefined) {
    if (rest.length > 0) return { kind: "error", message: USAGE };
    return { kind: "resume", prefix: inline[1] };
  }

  return { kind: "error", message: `unknown argument: ${first}\n${USAGE}` };
}
