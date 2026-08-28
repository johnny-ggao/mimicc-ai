/**
 * What a tool leaves out, and how it says so.
 *
 * ## The rule this file exists to enforce
 *
 * **Whatever a tool did not do — gave less, skipped something, changed
 * approach, could not do it at all — has to appear in what it returns.** The
 * corollary is the sharp end: **"there is none" must be distinguishable from
 * "I did not look".**
 *
 * ## Why a module rather than an `if` in each tool
 *
 * Measured, and the measurement is the reason this is shared code. Terminal-Bench
 * (`.scratch/external-bench/issues/07-tools-must-not-lie.md`) turned up nine
 * places where a failure came back shaped like a success, and the repository was
 * already doing the right thing in seven others — `Read`'s `[clipped at N bytes
 * of M]`, `Bash`'s `[exit N]`, the projection's `[downgraded … a synopsis, not
 * the output itself]`. **So the defect was never ignorance, it was that each
 * tool decided on its own and half of them forgot.** A shared vocabulary is the
 * part that does not forget.
 *
 * pi reaches the same conclusion from the other direction: one `truncate.ts`,
 * a structured `TruncationResult` every tool renders the same way, and the limit
 * repeated in the tool description so the model knows it before it asks
 * (`~/Work/Project/pi/packages/coding-agent/src/core/tools/truncate.ts`).
 *
 * ⚠️ **Not unified here, on purpose**: `Read` and `Bash` already report their
 * byte clipping, in wording of their own. Rewriting working messages to match a
 * house style is churn that changes what the model reads for no gain. This file
 * owns the cases that said *nothing*.
 */

/** How many paths `Glob` returns before it stops looking. */
export const MAX_GLOB_HITS = 200;

/** How many matching lines `Grep` returns before it stops looking. */
export const MAX_GREP_HITS = 100;

/**
 * Why a file was passed over without being searched.
 *
 * Each one is a real skip in `grepTool` today, and each was silent before: all
 * four came out the other end as `no matches for /x/ in y` — a *positive claim
 * of absence* about files that were never opened.
 */
export type SkipReason =
  "too large to search" | "unreadable" | "binary" | "may hold credentials";

/** A tally of what a scan passed over, by reason. */
export type Skips = Partial<Record<SkipReason, number>>;

/** Counts one skip, in place. The caller owns the record. */
export function countSkip(skips: Skips, reason: SkipReason): void {
  skips[reason] = (skips[reason] ?? 0) + 1;
}

/** `""` when nothing was passed over — silence is correct only when it is true. */
export function skipNote(skips: Skips): string {
  const counted = Object.entries(skips).filter(([, count]) => count > 0);
  if (counted.length === 0) return "";
  const total = counted.reduce((sum, [, count]) => sum + count, 0);
  // One file for one reason reads badly as "1 file(s): 1 too large"; the plural
  // form only earns its keep when there is something to break down.
  if (counted.length === 1 && total === 1)
    return `[skipped 1 file: ${counted[0]?.[0] ?? ""}]`;
  const parts = counted.map(([reason, count]) => `${String(count)} ${reason}`);
  return `[skipped ${String(total)} files: ${parts.join(", ")}]`;
}

/**
 * The note for a scan that stopped at its limit, or `""` when it did not.
 *
 * `more` is a fact the caller has to establish, not guess: a scan that stops
 * *at* the limit cannot tell "exactly this many" from "the first this many", so
 * both `globTool` and `grepTool` look one past it. **Reporting the total would
 * be a lie in the other direction** — they never counted it.
 */
export function limitNote(unit: string, limit: number, more: boolean): string {
  return more
    ? `[stopped at the ${String(limit)}-${unit} limit; there are more — narrow the pattern]`
    : "";
}

/** Joins a result with whatever notes apply, keeping the notes on their own lines. */
export function withNotes(body: string, ...notes: string[]): string {
  const kept = notes.filter((note) => note !== "");
  if (kept.length === 0) return body;
  return body === "" ? kept.join("\n") : `${body}\n${kept.join("\n")}`;
}
