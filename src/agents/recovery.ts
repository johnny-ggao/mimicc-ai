import { ToolMessage } from "@langchain/core/messages";
import { createMiddleware, type AnyAgentMiddleware } from "langchain";

import { ToolJournal } from "../checkpoint";
import { bothSafe, replayOf } from "../tools";

/**
 * What happens to a tool call when the process dies in the middle of it.
 *
 * ## The half `durability: "sync"` does not buy
 *
 * Turning on `sync` (see `DURABILITY`) makes the *graph* resume in the right
 * place: the batch of `Send`s is on disk before any tool starts, so a restart
 * continues the run instead of replaying it from an earlier checkpoint. What it
 * does not buy is per-call certainty. The barrier sits at the superstep boundary,
 * and a task's own result write is still handed to the saver and forgotten
 * (`pregel/loop.js:164-172`) — so a call that finished can still come back and
 * run again. Measured, in `repro/13-crash-mid-tool.ts`: with a zero-delay kill,
 * a tool that had already completed re-ran on resume.
 *
 * **"Already completed calls do not re-run" is a race, not a guarantee**, and
 * this middleware is what turns it into one. It writes down the intent before the
 * effect and the result after it, and on a re-run it reads its own note first.
 *
 * ## Fail closed before the effect, swallow after it
 *
 * The one rule worth stating outright, because both halves look inconsistent
 * until you say why:
 *
 * - **Before**: if the intent cannot be written, the tool does not run. Nothing
 *   is lost by refusing — the effect never happened — while running anyway would
 *   produce exactly the unrecoverable state this exists to prevent.
 * - **After**: if the settlement cannot be written, the result stands. The work
 *   is already done and already paid for; discarding it to report a bookkeeping
 *   failure would be the more destructive choice. The cost is that a later resume
 *   treats a call that succeeded as interrupted, which is the safe direction.
 *
 * ## What it does not protect
 *
 * A tool that returns a `Command` rather than a `ToolMessage` — one that updates
 * graph state directly — is passed through unrecorded. Recording its content
 * would lose the state update, and reconstructing one from a journal line is a
 * contract this file has no business inventing. None of this program's tools do
 * that today; a tool that starts to will need this reconsidered, which is why it
 * is written down rather than left to be discovered.
 */

export interface ToolRecoveryOptions {
  /** Where session files live. The journal is a sibling of the session's own file. */
  directory: string;
}

/**
 * The text a call gets when it was interrupted and may not be repeated.
 *
 * It says three things on purpose: that this is a crash and not a tool failure,
 * that the state is genuinely unknown rather than known-bad, and that checking is
 * the next move. The model has `Read` and `Grep`; it can find out. What it cannot
 * do is guess, and a vaguer message would invite exactly that.
 */
export function interruptedText(tool: string): string {
  return [
    `[interrupted: this ${tool} call was recorded as about to run, and no result was ever recorded]`,
    "The process died between the two. It may have taken effect, may have taken",
    "effect partly, or may never have started — nothing on disk can say which.",
    `It was not run again, because ${tool} declares itself unsafe to repeat.`,
    "Check the current state before doing anything that assumes either outcome.",
  ].join("\n");
}

/**
 * Records tool calls to a per-session journal and recovers them after a crash.
 *
 * Only the main agent gets this. A subagent runs with `checkpointer: false`
 * (`tools/task.ts`), so it has no session to be a sibling of — and from the
 * parent's side a dispatch is one call with one intent and one settlement anyway.
 */
export function toolRecovery(options: ToolRecoveryOptions): AnyAgentMiddleware {
  return createMiddleware({
    name: "ToolRecovery",
    /**
     * Drops the records this turn no longer needs.
     *
     * `afterAgent` and not the console, because the journal is this middleware's
     * data and the console has no business knowing the file exists. `afterAgent`
     * and not `beforeAgent`, because a turn that opens after a crash must read
     * those records *before* anything clears them — clearing on the way in is the
     * same work in the one order that breaks it.
     *
     * 🔑 The safety of this rests on **when it does not run**: a turn suspended at
     * the confirmation gate and a turn killed by Ctrl+C never reach here, and
     * those are exactly the two endings whose records are still needed. Measured
     * rather than assumed — `repro/21-when-a-turn-closes.ts` aborts a batch with
     * one call already settled and checks that its settlement survives.
     */
    afterAgent: async (_state, runtime) => {
      const threadId = (runtime as { configurable?: { thread_id?: unknown } })
        ?.configurable?.thread_id;
      if (typeof threadId !== "string") return undefined;
      await forgive(new ToolJournal(options.directory, threadId).prune());
      return undefined;
    },
    wrapToolCall: async (request, handler) => {
      const threadId = (
        request.runtime as { configurable?: { thread_id?: unknown } } | undefined
      )?.configurable?.thread_id;
      const call = request.toolCall;
      // No thread id means no durable anything — the in-process saver, a test, a
      // dynamically registered tool with no definition to read. Recovery has
      // nothing to hang on, so it steps out of the way rather than half-working.
      if (typeof threadId !== "string" || request.tool === undefined) {
        return handler(request);
      }

      const journal = new ToolJournal(options.directory, threadId);
      const current = replayOf(request.tool);
      const state = await journal.lookup(call.id ?? "");

      if (state.kind === "settled") {
        // The call ran before the crash and its result never reached state. This
        // is the whole point: hand back what it produced instead of doing it again.
        return new ToolMessage({
          tool_call_id: state.settlement.toolCallId,
          name: call.name,
          content: state.settlement.content,
          status: state.settlement.isError ? "error" : "success",
        });
      }

      if (state.kind === "interrupted" && !bothSafe(state.intent.replay, current)) {
        const settlement = {
          toolCallId: state.intent.toolCallId,
          content: interruptedText(call.name),
          isError: true,
        };
        // Settled as interrupted, so a second resume does not ask again — and so
        // the conversation ends up with exactly one result for this call, which
        // the provider requires.
        await forgive(journal.recordSettlement(settlement));
        return new ToolMessage({
          tool_call_id: settlement.toolCallId,
          name: call.name,
          content: settlement.content,
          status: "error",
        });
      }

      // Either untouched, or interrupted with both declarations saying `safe`, in
      // which case running it again is free by definition. The arguments come from
      // the live request rather than from the journal: they are already durable in
      // the assistant message the checkpoint holds, so the recorded copy is for
      // reading, not for replaying.
      try {
        await journal.recordIntent({
          toolCallId: call.id ?? "",
          tool: call.name,
          args: call.args,
          replay: current,
        });
      } catch (error) {
        return new ToolMessage({
          tool_call_id: call.id ?? "",
          name: call.name,
          content:
            `[refused: could not record that ${call.name} was about to run — ${String(error)}]\n` +
            "The call was not made. Running it without a record is the one thing this\n" +
            "cannot do, because a crash would then leave no way to tell whether it had.",
          status: "error",
        });
      }

      const result = await handler(request);

      if (ToolMessage.isInstance(result)) {
        await forgive(
          journal.recordSettlement({
            toolCallId: call.id ?? "",
            content: typeof result.content === "string" ? result.content : "",
            isError: result.status === "error",
          }),
        );
      }
      return result;
    },
  }) as AnyAgentMiddleware;
}

/** Runs a write that must not be allowed to undo work already done. See the header. */
async function forgive(write: Promise<void>): Promise<void> {
  try {
    await write;
  } catch {
    // Deliberately silent at this layer. The turn continues; the cost is that a
    // later resume treats a call that succeeded as interrupted, which is the
    // direction that cannot cause a second effect.
  }
}
