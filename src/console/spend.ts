import type { Spend } from "../usage";

/**
 * What a session has spent, in the shape the console shows it.
 *
 * Three numbers rather than one total, and the choice is this repository's own
 * rule rather than taste: `CONTEXT.md` says every context-engineering change is
 * weighed on **`input` and `cached`**. A single total folds those two together
 * and loses exactly the thing the scale exists to show — measured on real
 * history, one session reads 557k as a total, 179k uncached, 65% served from
 * cache, and those are three different statements.
 *
 * There is deliberately no money here. We run against several providers whose
 * price lists are theirs and change without telling us; tokens are the part we
 * can count exactly (`dsh` counts tokens only for the same reason; pi carries a
 * cost block and can, because it owns a price table).
 */

/** A token count short enough to sit at the end of a line. */
export function compact(total: number): string {
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`;
  if (total >= 1_000) return `${String(Math.round(total / 1_000))}k`;
  return String(total);
}

/**
 * The share of input the provider served from its cache.
 *
 * Undefined rather than zero when nothing has been sent yet: "0% cached" and
 * "no requests yet" are different things, and the first one reads as a problem.
 */
export function cachedShare(spent: Spend): number | undefined {
  const input = spent.uncachedInput + spent.cacheRead;
  return input === 0 ? undefined : Math.round((spent.cacheRead / input) * 100);
}

/** One line, printed at the end of a turn. */
export function spendLine(spent: Spend): string {
  const share = cachedShare(spent);
  return (
    `${compact(spent.uncachedInput)} in · ${compact(spent.output)} out` +
    (share === undefined ? "" : ` · ${String(share)}% cached`)
  );
}

/**
 * The same numbers per model, for `/cost`.
 *
 * Per model because a mixed total stops meaning anything the moment two models
 * are involved — pi keys its breakdown the same way. `unknown` is what history
 * written before the model was recorded lands in, and saying so is better than
 * a blank.
 */
export function spendBreakdown(byModel: Record<string, Spend>): string {
  const rows = Object.entries(byModel).sort(
    ([, a], [, b]) => b.uncachedInput + b.output - (a.uncachedInput + a.output),
  );
  if (rows.length === 0) return "nothing spent yet.";

  const width = Math.max(...rows.map(([model]) => model.length));
  return rows
    .map(([model, spent]) => `  ${model.padEnd(width)}  ${spendLine(spent)}`)
    .join("\n");
}
