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
  /**
   * `--print <task>`: run one turn on a fresh thread and exit.
   *
   * It exists because a benchmark harness cannot type. Harbor's
   * `BaseInstalledAgent` runs an agent as `my-agent "<instruction>"` — one
   * invocation, the task as an argument — and until now this program had no
   * such shape at all.
   *
   * ⚠️ **It does not imply `--auto`.** `auto` is the user saying "stop asking",
   * and a flag that says it on their behalf is a back door into the posture
   * switch (CONTEXT.md 「自动模式」). Without it, a run with nobody attached
   * refuses every call the gate would have asked about — see `once.ts`.
   */
  | { kind: "print"; task: string; auto: boolean }
  | { kind: "error"; message: string };

const USAGE = "usage: mimicc [--auto] [--resume [<session-id>]] [--print <task>]";

export function parseArgs(argv: string[]): Invocation {
  let auto = false;
  let resume: { prefix: string } | "bare" | undefined = undefined;
  let task: string | undefined = undefined;

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

    if (arg === "--print" || arg === "-p") {
      const next = argv[i + 1];
      // Unlike `--resume`, a bare `--print` means nothing: there is no task to
      // run. Saying so beats starting a repl the caller did not ask for.
      if (next === undefined) {
        return { kind: "error", message: `--print needs a task\n${USAGE}` };
      }
      task = next;
      i += 1;
      continue;
    }

    const printInline = /^(?:--print|-p)=([\s\S]+)$/.exec(arg);
    if (printInline?.[1] !== undefined) {
      task = printInline[1];
      continue;
    }

    return { kind: "error", message: `unknown argument: ${arg}\n${USAGE}` };
  }

  if (task !== undefined) {
    // Mutually exclusive rather than composed, because one-shot is defined as a
    // fresh thread and there is no use for the other reading yet. An error is
    // reversible; a semantics guessed at now is not.
    if (resume !== undefined) {
      return {
        kind: "error",
        message: `--print cannot be combined with --resume\n${USAGE}`,
      };
    }
    return { kind: "print", task, auto };
  }

  if (resume === undefined) return { kind: "new", auto };
  if (resume === "bare") return { kind: "pick", auto };
  return { kind: "resume", prefix: resume.prefix, auto };
}
