/**
 * FROZEN FIXTURE — do not edit, do not import from src/.
 *
 * Read by the bench's second question, which names this file's path outright.
 *
 * It used to name only the constant and let the model find it. That was wrong:
 * searching is a variable-cost act — sometimes Grep then answer, sometimes Grep
 * then Read then answer — and the request count swung 17% between two passes of
 * the same task. The bench measures the cost of carrying context, not the
 * model's search taste, so every question now names its file.
 */

/** Base delay before the first retry. Each further attempt doubles it. */
export const RETRY_BACKOFF_MS = 400;

/** Ceiling on the doubling, so a long outage does not push a retry into next week. */
const MAX_BACKOFF_MS = 30_000;

/**
 * Full jitter: sleep a random amount up to the computed backoff rather than the
 * backoff exactly. Retrying on the dot is what turns one failed request into a
 * thundering herd — every client that failed together wakes together.
 */
export function backoffFor(attempt: number, random: () => number): number {
  const exponential = Math.min(RETRY_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  return Math.floor(random() * exponential);
}
