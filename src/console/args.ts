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
  | { kind: "new"; auto: boolean; excludeTools?: readonly string[] }
  /** `--resume`, bare: show the picker before the first prompt. */
  | { kind: "pick"; auto: boolean; excludeTools?: readonly string[] }
  /** `--resume <id>`: an id, or the front of one. */
  | { kind: "resume"; prefix: string; auto: boolean; excludeTools?: readonly string[] }
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
  | {
      kind: "print";
      task: string;
      auto: boolean;
      timeoutSec?: number;
      excludeTools?: readonly string[];
    }
  | { kind: "error"; message: string };

const USAGE =
  "usage: mimicc [--auto] [--exclude-tools <names>] [--resume [<session-id>]] " +
  "[--print <task> [--timeout <seconds>]]";

export function parseArgs(argv: string[]): Invocation {
  let auto = false;
  let resume: { prefix: string } | "bare" | undefined = undefined;
  let task: string | undefined = undefined;
  let timeoutSec: number | undefined = undefined;
  let excludeTools: string[] = [];

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

    // 不注册哪些工具，逗号分隔。**它同时改提示词**（`agents/prompt.ts` 的
    // `staticPromptFor`）：正文逐字教了每个工具，只不注册而正文照旧，等于留下一段
    // 谎话。名字对不对、拿不拿得掉，都在那两处判——这里只负责切开和去空白。
    const excluded = /^--exclude-tools(?:=([\s\S]+))?$/.exec(arg);
    if (excluded !== null) {
      const raw = excluded[1] ?? argv[i + 1];
      if (excluded[1] === undefined) i += 1;
      const names = (raw ?? "")
        .split(",")
        .map((one) => one.trim())
        .filter((one) => one.length > 0);
      // 同 `--timeout`：拒绝，不要退回默认值。一个写了却没生效的 `--exclude-tools`
      // 会让调用方以为工具已经拿掉了。
      if (names.length === 0) {
        return {
          kind: "error",
          message: `--exclude-tools needs at least one tool name\n${USAGE}`,
        };
      }
      excludeTools = [...excludeTools, ...names];
      continue;
    }

    // 这次调用的总闸，秒。它是 ADR 0010 那个「最外层必须有一个真的钟」的入口。
    const timeout = /^--timeout(?:=([\s\S]+))?$/.exec(arg);
    if (timeout !== null) {
      const raw = timeout[1] ?? argv[i + 1];
      if (timeout[1] === undefined) i += 1;
      const seconds = Number(raw);
      // 拒绝而不是退回默认值：一个打错的期限和一个没给的期限，后果差着数量级，
      // 而调用方（通常是脚本或 benchmark 适配器）看不见我们悄悄换了什么数。
      if (raw === undefined || !Number.isFinite(seconds) || seconds <= 0) {
        return {
          kind: "error",
          message: `--timeout needs a positive number of seconds\n${USAGE}`,
        };
      }
      timeoutSec = seconds;
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
    return {
      kind: "print",
      task,
      auto,
      ...(excludeTools.length > 0 ? { excludeTools } : {}),
      ...(timeoutSec !== undefined ? { timeoutSec } : {}),
    };
  }

  // 交互式没有总闸，因为人就是那把钟（CONTEXT.md「期限」）。一个在这里被静默忽略的
  // `--timeout` 会让调用方以为自己设了界限，而这正是本条不变式要治的病。
  if (timeoutSec !== undefined) {
    return { kind: "error", message: `--timeout only applies to --print\n${USAGE}` };
  }

  // 空数组也不带：省得每一处比较对象的测试都要写一个空数组，同 `timeoutSec` 的写法。
  const excluded = excludeTools.length > 0 ? { excludeTools } : {};
  if (resume === undefined) return { kind: "new", auto, ...excluded };
  if (resume === "bare") return { kind: "pick", auto, ...excluded };
  return { kind: "resume", prefix: resume.prefix, auto, ...excluded };
}
