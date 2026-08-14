/**
 * FROZEN SOURCE for the re-read measurement — do not edit, do not import from src/.
 *
 * Unlike `fixture/`, this file is *meant* to be modified during a run — so the
 * run works on a fresh copy and this original stays byte-identical. Editing this
 * file invalidates every re-read measurement, the same way editing `fixture/`
 * invalidates every baseline.
 */

/** Base delay before the first retry. Each further attempt doubles it. */
export const RETRY_BACKOFF_MS = 250;

/** Ceiling on the doubling, so a long outage does not push a retry into next week. */
export const MAX_BACKOFF_MS = 20_000;

/** How many attempts before the scheduler gives up and surfaces the failure. */
export const MAX_ATTEMPTS = 5;

/** Requests allowed to be in flight at once. */
export const CONCURRENCY = 4;

/**
 * Full jitter: sleep a random amount up to the computed backoff rather than the
 * backoff exactly. Retrying on the dot is what turns one failed request into a
 * thundering herd — every client that failed together wakes together.
 */
export function backoffFor(attempt: number, random: () => number): number {
  const exponential = Math.min(RETRY_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  return Math.floor(random() * exponential);
}

/** Whether another attempt is allowed, given how many have already been made. */
export function shouldRetry(attempt: number, status: number): boolean {
  if (attempt >= MAX_ATTEMPTS) return false;
  return status >= 500 || status === 429;
}
