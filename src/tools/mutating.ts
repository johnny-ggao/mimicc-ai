import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";

import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

import { NEVER_REPLAY } from "./replay";

import { AmbiguousMatch, locate } from "./matching";
import { ROOT, withPathLock } from "./workspace";

import { resolvePath } from "./permission";

import { clamp, type Clamped } from "../deadline";

/**
 * The longest a single command may be asked to run: the timer's own ceiling.
 *
 * Not a policy number — `setTimeout` cannot express more, so anything larger is
 * a typo rather than an intention. pi validates against the same bound and for
 * the same reason (`core/tools/bash.ts:24`).
 */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * The deadline a command gets when **nobody is attached to the session**.
 *
 * 🔴 **The number is inherited, not derived** — it was `MAX_COMMAND_MS = 120_000`
 * with the note "a command that has not produced anything in this long is not
 * going to", and until the deadline was fixed to actually bite (`3baf03c`) it had
 * never once fired, so it had never been wrong in public. It has been since:
 * Terminal-Bench's `build-initramfs-qemu` needed a command that takes two minutes
 * (booting a kernel under emulation) and its agent said so in as many words.
 *
 * What changed is not the number but that **it is no longer the only option**:
 * `timeout` is a parameter now, so a command that needs longer can say so.
 *
 * ⚠️ **Why unattended is the case that needs a ceiling at all.** Attached, the
 * human is the deadline — they watch the row a running command paints and
 * interrupt, which kills the whole process group. `--print` has no terminal and
 * nobody to press anything, and the program already models exactly this fact:
 * `console/once.ts` refuses confirmations with *"No one is attached to this
 * session"*. pi draws the same line — its print mode leaves the bound to whoever
 * invoked it.
 */
export const UNATTENDED_COMMAND_CEILING_MS = 120_000;

/**
 * The deadline for commands with no `timeout` of their own, or `undefined` for
 * none. Set once by the entry point, which is the layer that knows whether a
 * human is there — the same reason `killRunningCommands` is called rather than
 * self-installed.
 */
let ceilingMs: number | undefined;

/** Called by `src/main.ts`. `undefined` means "a human is watching; let it run". */
export function setCommandCeiling(ms: number | undefined): void {
  ceilingMs = ms;
}

/** Command output goes into the next prompt, same as any other tool result. */
const MAX_OUTPUT_BYTES = 32_000;

/**
 * How often a running command says it is still running.
 *
 * 🔑 **A timer, not the output.** Reporting on each chunk would go quiet exactly
 * when it matters — a hung command produces nothing, and "no news" is the state
 * being reported on. A tick that says *14s, 0 bytes* is the difference between
 * a console that looks asleep and one that shows a command that is asleep.
 */
const TICK_MS = 1_000;

/** The event a running command emits so a watching console can show it is alive. */
export const COMMAND_TICK_EVENT = "mimicc_command_tick";

/** What that event carries. */
export type CommandTick = { command: string; elapsedMs: number; bytes: number };

/** What {@link runCommand} saw. `code` is null exactly when the command was killed. */
export type CommandOutcome = {
  body: string;
  code: number | null;
  timedOut: boolean;
};

/** Distinguishes "the timer won the race" from an exit code, which can be 0. */
const TIMED_OUT = Symbol("timed out");

/**
 * Commands still running, so that leaving can take them along.
 *
 * `detached: true` (see {@link killTree}) means a child survives this process by
 * default. **That is the point while a command is running and exactly wrong once
 * we are on the way out.** The deadline kills, and an abort kills — but a clean
 * exit killed nothing, and Terminal-Bench measured what that costs: an orphaned
 * `apt-get` still holding `/var/lib/dpkg/lock-frontend` while the *grading* phase
 * ran, failing a task the agent was no longer part of.
 *
 * pi keeps the same registry and sweeps it from every entry point
 * (`utils/shell.ts:179-194`, `modes/print-mode.ts:58`) — this is that shape, not
 * an invention.
 */
const running = new Set<Bun.Subprocess>();

/**
 * Kills every command still running, and everything each of them started.
 *
 * Called from the process's exit paths rather than registered here: a module
 * that installs a global signal handler on import is a side effect nobody
 * greps for. `src/main.ts` owns the exit, so it owns the sweep.
 */
export function killRunningCommands(): void {
  for (const child of running) killTree(child);
  running.clear();
}

/**
 * Kills the command **and everything it started**.
 *
 * `child` is the `/bin/sh` this module spawned; the work is almost always in
 * *its* children — a pipeline, a background job, an `apt-get`. Signalling the
 * shell alone leaves those running, and that costs twice:
 *
 * 1. **The read below never ends.** A surviving grandchild still holds the write
 *    end of our stdout pipe, so `EOF` never arrives no matter what the shell did.
 * 2. **They outlive this process.** Terminal-Bench caught the shape whole: an
 *    orphaned `apt-get` still holding `/var/lib/dpkg/lock-frontend` while the
 *    *grading* phase ran, which failed a task the agent was no longer part of
 *    (`.scratch/external-bench/issues/05-failure-triage.md`, C3).
 *
 * `detached: true` at spawn makes the shell a session leader, so its pid is also
 * its process-group id and the negative form reaches the whole group.
 *
 * 🔴 **The negative pid cannot hit this process's own group by accident.** That
 * would require our process-group id to equal a pid the kernel has just handed
 * to the child, and a live pid belongs to one process. If `detached` ever stops
 * making the child a leader, the group kill fails with `ESRCH` and the fallback
 * below runs — the old behaviour, not a worse one.
 */
function killTree(child: Bun.Subprocess): void {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already reaped between the race and here. Nothing left to kill.
    }
  }
}

/** Appends a pipe's text as it arrives, so a killed command still reports what it printed. */
async function drain(
  stream: ReadableStream<Uint8Array> | undefined,
  into: string[],
): Promise<void> {
  if (stream === undefined) return;
  const decoder = new TextDecoder();
  for await (const chunk of stream) into.push(decoder.decode(chunk, { stream: true }));
  const tail = decoder.decode();
  if (tail.length > 0) into.push(tail);
}

/**
 * Runs one shell command under a deadline that actually bites.
 *
 * Split out of the tool because the deadline is the part worth testing and
 * 120 seconds is not a test. Two things make it bite, and **both are needed**:
 *
 * - {@link killTree} reaches the whole process group, not just the shell.
 * - The result is decided by a **race**, not by reading to EOF. Even a perfect
 *   kill can be escaped — a double fork leaves the group — and a command that
 *   escapes must not be able to hold this call open a second time. The old code
 *   awaited `new Response(child.stdout).text()`, so the kill it did fire could
 *   not end the wait it was fired for: mimicc sat on one `frotz` for 370s until
 *   the outer harness killed the whole agent.
 */
export async function runCommand(
  command: string,
  timeoutMs: number | undefined,
  signal?: AbortSignal,
  onTick?: (tick: { elapsedMs: number; bytes: number }) => void,
): Promise<CommandOutcome> {
  const child = Bun.spawn(["/bin/sh", "-c", command], {
    cwd: ROOT,
    // Its own process group — see killTree for why the deadline needs one.
    detached: true,
    stdout: "pipe",
    stderr: "pipe",
    // The model's own environment, minus the key variables it must never read
    // back out of a process it started. All three names are stripped — the two
    // per-provider keys and the legacy alias — because any one of them is the
    // credential for whichever provider the program happens to run on.
    env: {
      ...process.env,
      LLM_API_KEY: undefined,
      LLM_DEEPSEEK_API_KEY: undefined,
      LLM_MOONSHOT_CN_API_KEY: undefined,
    },
  });

  running.add(child);
  const out: string[] = [];
  const err: string[] = [];
  const finished: Promise<number> = (async () => {
    await Promise.all([drain(child.stdout, out), drain(child.stderr, err)]);
    return await child.exited;
  })();
  // Nothing awaits this once the race is lost. A pipe torn down by the kill is
  // the kill working, not a failure the caller needs to hear about.
  void finished.catch(() => undefined);

  const startedAt = Date.now();
  const ticker =
    onTick === undefined
      ? undefined
      : setInterval(() => {
          onTick({
            elapsedMs: Date.now() - startedAt,
            bytes: out.reduce((sum, part) => sum + part.length, 0),
          });
        }, TICK_MS);

  let timer: ReturnType<typeof setTimeout> | undefined;
  // No deadline is a real option, not a missing value: with a human attached the
  // interrupt is the deadline, and a promise that never settles would only add a
  // second thing that can never win the race.
  const expired =
    timeoutMs === undefined
      ? undefined
      : new Promise<typeof TIMED_OUT>((resolve) => {
          timer = setTimeout(() => {
            resolve(TIMED_OUT);
          }, timeoutMs);
        });

  // An interrupted turn used to be cleaned up by the terminal, which signals the
  // whole foreground group — but `detached` took this command out of that group,
  // so the abort has to carry the kill itself. It now reaches further than the
  // terminal did: the group, not just the shell.
  const onAbort = (): void => {
    killTree(child);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const settled =
      expired === undefined ? await finished : await Promise.race([finished, expired]);
    const body = [out.join(""), err.join("")]
      .filter((part) => part.length > 0)
      .join("\n");
    if (settled === TIMED_OUT) {
      killTree(child);
      return { body, code: null, timedOut: true };
    }
    return { body, code: settled, timedOut: false };
  } finally {
    running.delete(child);
    if (ticker !== undefined) clearInterval(ticker);
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Creates files. It refuses to overwrite one, and that refusal is the whole
 * point.
 *
 * A full-file write is the only way this agent can lose someone else's work.
 * Measured, not assumed (repro/05-stale-edit.ts):
 * when a file changes between a Read and a later write, `Edit` catches it every
 * way it can go wrong — the target no longer matches, or it now matches twice,
 * and `locate` refuses both — while a change made elsewhere in the file survives
 * untouched, because an Edit only rewrites the span it matched. `Write` has no
 * such property: it replaces the file with the caller's copy, and anything
 * written since that copy was taken is gone with no error and no trace.
 *
 * The alternative was a read registry — hash what was read, refuse a write when
 * the file no longer hashes the same. That is the standard fix and it was
 * dropped: it needs every write-path tool to take a ToolRuntime and return a
 * Command carrying its own ToolMessage, and the failure it guards was never
 * observed (0 of 3 samples, with a restructuring task chosen to tempt a full
 * rewrite; the model reached for Edit every time). Refusing the overwrite closes
 * the same hole with a narrower tool and no state at all.
 *
 * Nothing is lost that Edit cannot do: replacing a file entirely is an Edit whose
 * oldString is its current contents.
 */
export const writeTool = tool(
  async ({ path, content }): Promise<string> => {
    const full = resolvePath(path);

    return withPathLock(full, async () => {
      if (await Bun.file(full).exists()) {
        throw new Error(
          `${path} already exists and Write never overwrites. Use Edit to change it — ` +
            `to replace it entirely, pass its current contents as oldString`,
        );
      }

      // Bun.write does not create intermediate directories.
      await mkdir(dirname(full), { recursive: true });
      await Bun.write(full, content);

      return `created ${path} (${String(content.length)} bytes)`;
    });
  },
  {
    name: "Write",
    // It writes. Running it again after a crash overwrites whatever came since.
    metadata: { ...NEVER_REPLAY },
    description:
      "Create a new file. Refuses to overwrite an existing one — use Edit for anything that already exists, including replacing it in full. Creates parent directories as needed.",
    schema: z.object({
      path: z.string().describe("Path relative to the working directory"),
      content: z.string().describe("The complete file contents"),
    }),
  },
);

export const editTool = tool(
  async ({ path, oldString, newString }): Promise<string> => {
    if (oldString === newString) {
      throw new Error("oldString and newString are identical: nothing to do");
    }
    if (oldString.length === 0) {
      throw new Error("oldString is empty: there is nothing to locate");
    }

    const full = resolvePath(path);

    // The whole read-modify-write is inside the lock. Holding it for only the
    // write would leave exactly the gap that loses one of two concurrent edits.
    return withPathLock(full, async () => {
      const file = Bun.file(full);
      if (!(await file.exists())) throw new Error(`no such file: ${path}`);

      const text = await file.text();

      let found;
      try {
        found = locate(text, oldString, newString);
      } catch (caught) {
        // Ambiguity is the one thing no amount of tolerance may resolve. Say how
        // many, and ask for the one thing that actually fixes it.
        if (caught instanceof AmbiguousMatch) {
          throw new Error(
            `oldString ${caught.message} in ${path} (${caught.level}). Include more surrounding lines to make the target unique`,
            { cause: caught },
          );
        }
        throw caught;
      }

      if (found === null) {
        throw new Error(
          `oldString not found in ${path}. Read the file again and copy the target from it — note that Read prefixes every line with its number and a tab, and that prefix is not part of the file`,
        );
      }

      await Bun.write(
        file,
        text.slice(0, found.start) + found.replacement + text.slice(found.end),
      );

      const line = text.slice(0, found.start).split("\n").length;
      // A tolerated mismatch is reported. The prompt tells the model that a
      // successful Edit means the change landed and not to re-read — that stays
      // true only while the tool admits which level it had to fall back to.
      const note = found.level === "exact" ? "" : ` (${found.level})`;
      return `edited ${path} at line ${String(line)}${note}`;
    });
  },
  {
    name: "Edit",
    // Read-modify-write: a second run edits the result of the first, or refuses.
    metadata: { ...NEVER_REPLAY },
    description:
      "Replace one exact string in a file with another. The target must resolve to exactly one place; line endings, blank lines around the block, and indentation are tolerated, ambiguity is not.",
    schema: z.object({
      path: z.string().describe("Path relative to the working directory"),
      oldString: z.string().describe("Text to replace, copied from the file"),
      newString: z.string().describe("Text to put in its place"),
    }),
  },
);

/**
 * The gap the run's deadline keeps ahead of any command it contains.
 *
 * The invariant is that the inner clock is **strictly** smaller than the outer
 * one (ADR 0010), and a margin is what makes "strictly" mean something: a
 * command that ends at the very instant the run does leaves nothing between the
 * two, and which of them stopped it becomes a race.
 *
 * ⚠️ **Deliberately small.** The tempting reading is "leave room for one more
 * model call so the answer can be handed in", which argues for tens of seconds
 * — but a run that reaches its deadline has no answer to hand in by definition
 * (CONTEXT.md「期限」), and a margin that large creates its own defect: a window
 * at the end of every run where no command can be given any time at all.
 */
const RUN_DEADLINE_MARGIN_MS = 2_000;

/**
 * The deadline this call gets, in milliseconds, or `undefined` for none.
 *
 * A bad `timeout` throws rather than falling back to the ceiling: a model that
 * asked for one and silently got another would be told nothing, which is the
 * defect this whole area is being cleaned of.
 *
 * 🔑 **And the run's own deadline clamps whatever survives that** (ADR 0010):
 * `inner = min(what it asked for, what the run has left − margin)`. Without the
 * clamp a model could hand one command a longer deadline than the whole run has
 * — measured as reachable: `timeout` has no upper bound but the timer's own, so
 * `timeout: 3600` in a run with 200 seconds left used to be honoured in full.
 * The clamp is silent only when it changed nothing; {@link Clamped.asked}
 * carries the ask through to the message the model reads.
 */
function resolveTimeoutMs(timeout: number | undefined): Clamped {
  if (timeout !== undefined) {
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new Error(
        `invalid timeout: ${String(timeout)}s — give a positive number of seconds`,
      );
    }
    if (timeout * 1000 > MAX_TIMEOUT_MS) {
      throw new Error(
        `invalid timeout: ${String(timeout)}s is beyond the ${String(Math.floor(MAX_TIMEOUT_MS / 1000))}s a timer can hold`,
      );
    }
  }
  return clamp(timeout === undefined ? ceilingMs : timeout * 1000, RUN_DEADLINE_MARGIN_MS);
}

export const bashTool = tool(
  async ({ command, timeout }, config): Promise<string> => {
    const deadline = resolveTimeoutMs(timeout);

    // 没余地了就不开跑。一条注定在起跑线上被杀的命令只会留下副作用和一段没人读得完的输出，
    // 而「为什么它一个字都没输出」是模型猜不出来的——**说出是哪只钟，比让它去猜便宜。**
    if (deadline.ms === 0) {
      return `[not started: this run has less than ${String(RUN_DEADLINE_MARGIN_MS / 1000)}s left, so there is no time to run anything]`;
    }

    const { body, code, timedOut } = await runCommand(
      command,
      deadline.ms,
      (config as { signal?: AbortSignal } | undefined)?.signal,
      (tick) => {
        // Fire-and-forget, and swallowed on purpose: a console that is not
        // listening must not be able to fail a command. The tick is a courtesy
        // to whoever is watching, never part of the work.
        void dispatchCustomEvent(
          COMMAND_TICK_EVENT,
          { command, ...tick },
          config,
        ).catch(() => undefined);
      },
    );

    const clipped =
      body.length > MAX_OUTPUT_BYTES
        ? `${body.slice(0, MAX_OUTPUT_BYTES)}\n\n[clipped at ${String(MAX_OUTPUT_BYTES)} bytes of ${String(body.length)}]`
        : body;
    const prefix = `${clipped}${clipped.length > 0 ? "\n" : ""}`;

    // A non-zero exit is a *result*, not a tool failure: a failing test suite is
    // exactly what the model needs to read. The deadline is a result too, and it
    // says so in words: the model has to know the command was cut off rather
    // than read a partial transcript as the whole story.
    if (timedOut) {
      // 被夹短了才说，没夹不说——而夹了不说，就是这条线要治的那种沉默：模型会以为
      // 自己要的 3600 秒真的给了它，然后把「才跑了 200 秒就被杀」读成别的什么毛病。
      const why =
        deadline.asked === undefined
          ? "Pass a larger timeout if the command legitimately needs one"
          : timeout === undefined
            ? "that is all this run had left — a larger timeout would not have helped"
            : `you asked for ${String(timeout)}s, but that is all this run had left — a larger timeout would not have helped`;
      return `${prefix}[timed out after ${String((deadline.ms ?? 0) / 1000)}s; killed, along with everything it started. ${why}]`;
    }
    if (code !== 0) {
      return `${prefix}[exit ${String(code)}]`;
    }
    return clipped.length > 0 ? clipped : "[no output]";
  },
  {
    name: "Bash",
    // Never, even when the command is `ls` — the declaration is per tool, and the runtime cannot read a shell command.
    metadata: { ...NEVER_REPLAY },
    description: `Run one shell command in the working directory. Returns stdout and stderr combined; a non-zero exit is reported as [exit N] rather than as a failure. When a deadline applies and is reached, the command and everything it started are killed and the output so far comes back marked [timed out]. Do not use it to run an interactive program — it has no stdin.`,
    schema: z.object({
      command: z.string().describe("The command to run. One command per call."),
      timeout: z
        .number()
        .optional()
        .describe(
          "Seconds to allow this command. Give one when it legitimately takes longer than usual — a build, a boot, a long test run.",
        ),
    }),
  },
);
