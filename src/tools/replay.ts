/**
 * What a tool promises about being run twice.
 *
 * ## The criterion, written down because it is not "does it write files"
 *
 * **Would running this again with the same arguments leave the world unchanged?**
 * That is wider than the filesystem and the width is the point:
 *
 * - `Bash` is `never` even when the command is `ls`. The declaration is per
 *   **tool**, not per call, and the runtime cannot read a shell command.
 * - `Task` is `never` although an Explore agent only reads. Re-running it costs
 *   another uncached model run — measured at a 50x price difference against the
 *   parent's cached prefix. **"Unchanged" includes money.**
 * - A tool that sent mail would be `never` even though nothing on this machine
 *   changed. Side effects are not required to be local.
 *
 * ## Why it hangs on the tool
 *
 * Because it is the tool's own promise, not a policy somebody applies to it.
 * `Bash` is unreplayable for a reason that lives inside `Bash`. This is the
 * difference from `CONFIRMATION_POLICY`, which genuinely is policy — *we* decided
 * Bash asks and Write does not, and a different operator could decide otherwise.
 * Nobody gets to decide `Bash` is safe to re-run.
 *
 * It rides in `metadata`, which is a field of the tool definition itself
 * (`@langchain/core/dist/tools/types.d.ts:70`), so the declaration sits in the
 * same object literal as the name and the schema.
 */
export type Replay = "never" | "safe";

/** The `metadata` key a tool declares under. */
export const REPLAY_KEY = "replay";

/** Spread into a tool's `metadata` to declare it. */
export const SAFE_TO_REPLAY = { [REPLAY_KEY]: "safe" } as const;
export const NEVER_REPLAY = { [REPLAY_KEY]: "never" } as const;

/**
 * What this tool declared, defaulting to `never`.
 *
 * ⚠️ **The default is the conservative one and has to be.** An undeclared tool is
 * assumed to have changed the world; the cost of being wrong that way is one
 * synthetic "interrupted" result and a model that goes and checks. The cost of
 * defaulting to `safe` is running a deletion twice. pi settles it the same way —
 * *omission means "never"* (`packages/agent/docs/harness.md:2611`).
 */
export function replayOf(tool: object): Replay {
  return declaredReplay(tool) ?? "never";
}

/**
 * The declaration as written, or nothing when the tool did not write one.
 *
 * Separate from {@link replayOf} because the two questions differ: execution
 * wants a value and takes the safe default, while the test that keeps this
 * honest wants to know whether anyone actually decided. **A tool that meant
 * `safe` and forgot to say so does not fail — it just quietly costs a re-read
 * that could have been free**, and that is the kind of thing nobody notices.
 */
export function declaredReplay(tool: object): Replay | undefined {
  // A quarantined cast, and the fifth appearance of one declaration defect in
  // this repository — see the same note in usage.ts, agents/loop.ts and
  // context/projection.ts. `metadata` is a field of the object `tool()` takes
  // (@langchain/core/dist/tools/types.d.ts:70) and it is there at runtime
  // (measured), but `StructuredToolInterface` does not declare it, so the
  // compiler believes no tool can have one. Taking `object` rather than a tool
  // type is the other half: `wrapToolCall` hands over `ClientTool | ServerTool`,
  // and those two share almost nothing. Retry on the next @langchain/core bump.
  const value = (tool as { metadata?: Record<string, unknown> }).metadata?.[REPLAY_KEY];
  return value === "safe" || value === "never" ? value : undefined;
}

/**
 * Whether a call may be re-run after a crash: the declaration captured before
 * the effect and the one the code makes now must **both** say `safe`.
 *
 * pi requires the same (`packages/agent/docs/harness.md:1727`) and its reasoning
 * reads like a thought experiment — you might have upgraded the program between
 * the crash and the restart, and a tool that used to only read might now write a
 * cache. **Here it is not a thought experiment.** `bun run dev` is `--watch`:
 * changing a file restarts the process. "The program changed between the crash
 * and the restart" is the ordinary case in this repository, not the exotic one.
 */
export function bothSafe(stored: Replay, current: Replay): boolean {
  return stored === "safe" && current === "safe";
}
