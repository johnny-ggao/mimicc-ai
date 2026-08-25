import type { BaseMessage } from "@langchain/core/messages";
import { createMiddleware, type AnyAgentMiddleware } from "langchain";

import { hintInjector } from "./hint";
import { hashOf, latestMarks } from "./readBeforeWrite";

/**
 * Tells the model when a command it just ran changed a file it had read.
 *
 * ## What this is for, and what it is not for
 *
 * Not for catching writes the model made on purpose. If it ran `sed -i` itself,
 * it knows. **This is for the side effects it cannot see in the command text**:
 * `bun run build` regenerating a file it read, `git checkout .` reverting its
 * work, `npm ci` rewriting a lockfile, a test run dropping new snapshots. The
 * model is holding a copy of those files and has no reason to suspect it is
 * stale.
 *
 * ⚠️ **It is not the gate.** `readBeforeWrite` already refuses an `Edit` whose
 * mark no longer matches, and it does so by hashing at check time, so a file a
 * command changed is caught there whether or not this middleware exists
 * (`tests/read-before-write.test.ts` — "an edit never refreshes the mark").
 * What is uncovered without this is the path with **no tool call left to gate**:
 * the model answering the user out of a copy that is no longer true.
 *
 * ## Why it is deterministic where a shell parser could not be
 *
 * It never asks what the command *will* do — a question that is not decidable
 * in general (`eval "$CMD"`, `bun -e`, `./script.sh`, and `git checkout .`
 * writes files without naming one). **It observes what changed**: hash the
 * marked files before, hash them after, report the difference. The observation
 * *is* the trigger, so a false positive is not merely unlikely — it is
 * unconstructible.
 *
 * ## Cost
 *
 * Two hash passes over the marked files per `Bash` call. Measured in
 * `repro/42-what-post-hoc-hashing-costs.ts`: the real mark count in this
 * repository's own sessions tops out at 19, where one pass is 0.34ms — 11% of
 * `ls`, 3% of `git status`, 0.01% of `bun test`. The probe timed one pass; this
 * takes two, and 0.7ms is still not a number worth optimising against.
 *
 * ## What it costs the context: nothing durable
 *
 * The notice is a **hint**, so it goes out through {@link hintInjector}: appended
 * to `request.messages` for one model call and never written to the graph state.
 * That is the fifth term of the design rule this line arrived at — *a product's
 * lifetime must match the lifetime of what it is for*. A refusal (the gate's) is
 * long-lived and pinned; a notice like this one is one lap and leaves no trace.
 */

const NOTICE = (paths: string[]): string =>
  `[STALE READ] The command you just ran changed ${paths.length === 1 ? "a file" : "files"} you had already read: ` +
  `${paths.join(", ")}. Your copy is out of date. Read any of them again before you rely on, quote, or edit them.`;

/** The tool whose side effects nothing else can predict. */
const OBSERVED_TOOL = "Bash";

/** Marked paths whose bytes differ between two snapshots. */
function changedBetween(
  before: Map<string, string | null>,
  after: Map<string, string | null>,
): string[] {
  const changed: string[] = [];
  for (const [path, hash] of before) {
    // A null on either side means the gate could not hash it then — unknowable
    // rather than changed, and this middleware reports only what it knows.
    const now = after.get(path);
    if (hash !== null && now !== null && now !== undefined && now !== hash) {
      changed.push(path);
    }
  }
  return changed.sort();
}

function snapshot(paths: Iterable<string>): Map<string, string | null> {
  const shot = new Map<string, string | null>();
  for (const path of paths) shot.set(path, hashOf(path));
  return shot;
}

export function staleReads(): AnyAgentMiddleware {
  const inject = hintInjector();

  return createMiddleware({
    name: "StaleReads",
    beforeAgent: () => {
      // Cleared per turn, like the other guards. In practice this drops nothing:
      // a tool call is always followed by a model call, so a notice queued after
      // a `Bash` is delivered in the same turn.
      inject.reset();
      return undefined;
    },
    wrapModelCall: inject.wrapModelCall,
    wrapToolCall: async (request, handler) => {
      if (request.toolCall.name !== OBSERVED_TOOL) return handler(request);

      const state = request.state as { messages?: BaseMessage[] };
      const marks = latestMarks(state.messages ?? []);
      if (marks.size === 0) return handler(request);

      // Snapshot *before*, not just compare after: a mark can already be stale
      // when this call starts (the model edited the file a lap ago and knows),
      // and reporting that would be noise. Only what this command changed.
      const before = snapshot(marks.keys());
      const result = await handler(request);
      const changed = changedBetween(before, snapshot(marks.keys()));

      if (changed.length > 0) inject.queue(NOTICE(changed));
      return result;
    },
  }) as AnyAgentMiddleware;
}
