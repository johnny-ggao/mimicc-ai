/**
 * The block-order tripwire: the view's blocks must sit least-changing first,
 * and every beforeAgent middleware must say out loud what it brings to the view.
 *
 * The invariant it guards was measured upstream (view-layout ticket 01): the
 * view is re-read from the top every turn, so a block that changes often costs
 * the whole history when it sits in front of one that changes rarely — HEAD
 * 4.0% vs TAIL 39.3% of the view's cost. The ordering rule is "least-changing
 * first", and today every block happens to be frozen (`never`), which makes the
 * order check idle — the day AGENTS.md goes live moves `ProjectInstructions` to
 * `rare`, and the check gets its first real user (view-layout-impl ticket 01).
 *
 * The failure mode this exists to stop is not a reordering someone performs on
 * purpose — it is a *new block added by someone who does not know the rule
 * exists*. That is why the registry is fail-closed: a beforeAgent middleware
 * that is not registered fails assembly. ADR 0007's unlisted-tools-default-ask
 * is the same sentence in the permission axis. "Forgot to register" passing in
 * silence would be the very thing this line was opened to prevent.
 *
 * Throwing rather than logging, for the reason `assertMeterInsideWindow` gives:
 * a view assembled in the wrong order is worse than no view at all, so there is
 * nothing to degrade to.
 */

/** The one fact the tripwire reads off a middleware: its name, and whether it has a beforeAgent hook. */
export interface BeforeAgentCarrier {
  name?: string;
  beforeAgent?: unknown;
}

/** How often the block a beforeAgent middleware injects changes, from the view's point of view. */
export type Freq = "never" | "rare" | "perTurn" | "notABlock";

/** The change-frequency axis, least-changing first. `notABlock` does not participate. */
const FREQ_ORDER: readonly Freq[] = ["never", "rare", "perTurn"];

/**
 * Every beforeAgent middleware in this program, saying what it brings to the view.
 *
 * Fail-closed: the assertion refuses any beforeAgent middleware whose name is
 * not here, so a new block added without a line in this table stops the
 * program at assembly instead of silently breaking the view's cost order.
 *
 * `notABlock` is not "no opinion": it is a claim — the middleware runs
 * beforeAgent but injects no message of its own, so its position carries no
 * cost. A middleware whose block this table forgot would be exactly the bug
 * the assertion throws on, so the mark must be stated, not defaulted.
 */
export const BLOCKS: Record<string, Freq> = {
  ProjectInstructions: "never", // bytes identical every turn (context/instructions.ts:183)
  Memory: "never", // frozen; only a refreeze changes it (memory/inject.ts:147)
  SkillCatalog: "never", // read once at startup (skills/inject.ts:12-13)
  PinTurnTask: "notABlock", // merges in place under the same id — no new position
  StaleReads: "notABlock", // resets only, injects nothing
  LoopGuard: "notABlock", // resets its streak, injects nothing
  StallGuard: "notABlock", // resets its streak, injects nothing
  EmptyReplyGuard: "notABlock", // resets its retry flag, injects nothing
};

/**
 * Refuses a stack whose view would break the order invariant.
 *
 * Two checks, both about what `beforeAgent` hooks bring to the view:
 *
 * 1. **Registration** — every middleware with a beforeAgent hook must be in
 *    `blocks`. This is the fail-closed half: it is the only one of the three
 *    options that catches the real failure mode, a block added by someone who
 *    does not know the rule exists (view-layout-impl ticket 01, 判了).
 * 2. **Order** — among the middlewares that do inject blocks, the relative
 *    order must be least-changing first (`never` before `rare` before
 *    `perTurn`). `notABlock` middlewares sit anywhere; they do not count.
 *
 * `blocks` is a parameter so a test can hand the check a tomorrow it cannot
 * build from today's middlewares — all three real blocks are `never`, so a
 * wrong order cannot be assembled from the real registry. Overriding
 * `ProjectInstructions` to `rare` is the day AGENTS.md goes live.
 *
 * Called from `agentStack` (every kind's stack) and again from `loop.ts` after
 * the main-agent-only appendices are added — `SkillCatalog` is appended there,
 * where the assembler's own check cannot see it.
 */
export function assertBlocksInFrequencyOrder(
  stack: readonly BeforeAgentCarrier[],
  blocks: Record<string, Freq> = BLOCKS,
): void {
  for (const middleware of stack) {
    if (middleware.beforeAgent === undefined) continue;
    if (blocks[middleware.name ?? ""] === undefined) {
      throw new Error(
        `${middleware.name ?? "an unnamed middleware"} has a beforeAgent hook but is not registered in BLOCKS. Say what it brings to the view: "never", "rare", "perTurn", or "notABlock" when it injects no message.`,
      );
    }
  }

  let previous: { name: string; freq: Freq; index: number } | undefined;
  for (let index = 0; index < stack.length; index += 1) {
    const middleware = stack[index];
    if (middleware === undefined || middleware.beforeAgent === undefined) continue;
    const freq = blocks[middleware.name ?? ""];
    if (freq === undefined || freq === "notABlock") continue;
    if (previous !== undefined && FREQ_ORDER.indexOf(freq) < FREQ_ORDER.indexOf(previous.freq)) {
      throw new Error(
        `${middleware.name ?? "an unnamed middleware"} ("${freq}", index ${index}) sits after ${previous.name} ("${previous.freq}", index ${previous.index}). Blocks are ordered least-changing first: never, then rare, then perTurn.`,
      );
    }
    previous = { name: middleware.name ?? "unnamed", freq, index };
  }
}
