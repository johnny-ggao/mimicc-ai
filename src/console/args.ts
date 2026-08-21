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

/** What the arguments asked for. `auto` is the auto-approve posture switch. */
export type Invocation =
  | { kind: "new"; auto: boolean }
  /** `--resume`, bare: show the picker before the first prompt. */
  | { kind: "pick"; auto: boolean }
  /** `--resume <id>`: an id, or the front of one. */
  | { kind: "resume"; prefix: string; auto: boolean }
  | { kind: "error"; message: string };

const USAGE = "usage: mimicc [--auto] [--resume [<session-id>]]";

export function parseArgs(argv: string[]): Invocation {
  let auto = false;
  let resume: { prefix: string } | "bare" | undefined = undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) break;

    if (arg === "--auto") {
      auto = true;
      continue;
    }

    if (arg === "--resume" || arg === "-r") {
      const next = argv[i + 1];
      // A flag where an id belongs is a flag, not a session named `--foo`.
      if (next !== undefined && !next.startsWith("-")) {
        resume = { prefix: next };
        i += 1;
      } else {
        resume = "bare";
      }
      continue;
    }

    const inline = /^(?:--resume|-r)=(.+)$/.exec(arg);
    if (inline?.[1] !== undefined) {
      resume = { prefix: inline[1] };
      continue;
    }

    return { kind: "error", message: `unknown argument: ${arg}\n${USAGE}` };
  }

  if (resume === undefined) return { kind: "new", auto };
  if (resume === "bare") return { kind: "pick", auto };
  return { kind: "resume", prefix: resume.prefix, auto };
}
