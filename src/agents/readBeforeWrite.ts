import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

import { ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { createMiddleware, type AnyAgentMiddleware } from "langchain";

import { markPinned } from "../context";
import { resolvePath } from "../tools/permission";

/**
 * A deterministic version gate: modifying a file that already exists requires a
 * `Read` of that file's *current* version earlier in the conversation — or your
 * own `Write` of it, which stamps the same mark (rbw-tax ticket 01).
 *
 * ## Why this is here, written down because it is not a bugfix
 *
 * 🔴 **This repository has never seen the failure mode this prevents.** Across
 * the five sessions on disk the tool mix is Read 2555 / Grep 770 / Bash 268 /
 * Glob 241 and **Write/Edit zero** — mimicc has only ever been used read-only.
 * The gate is here because the *shape* is the thing worth having: a check the
 * model cannot decline to run, whose trigger is provable rather than tuned.
 * Ticket 04 in `.scratch/deterministic-gate/` records that reasoning; do not
 * read this file as a fix for something that happened.
 *
 * The shape is taken from `deer-flow`'s
 * `agents/middlewares/read_before_write_middleware.py`, which *did* have the
 * evidence: its lead agent appended the same report section five times, from
 * "append-only, never read back" writes. **The shape is copied, the constants
 * are not.**
 *
 * ## Where the gate's state lives, and why that is the whole design
 *
 * On the `Read` result's `additional_kwargs`, beside `PINNED_KEY` — not in a
 * field of this middleware. That is deliberate: the projection decides what the
 * model can see, so the gate's evidence should live in the same place, and
 * **a summary that eats the read result eats the mark with it**. The gate can
 * never pass on a read the model can no longer see.
 *
 * A `Write` stamps its own mark — the file's bytes after a Write are exactly
 * what the model sent, so "knows the current version" is a fact, not a
 * courtesy (rbw-tax ticket 01). `Edit` never refreshes a mark: any successful
 * edit changes the file's hash, which invalidates every earlier read of it —
 * so two consecutive modifications of one file require a re-read between them.
 * External changes — Bash, the user — break whatever mark exists and are
 * refused either way.
 *
 * ## Fail-open
 *
 * If the gate cannot hash the file — binary, permissions, a race — it lets the
 * call through. **A gate's failure must never be worse than not having the
 * gate**, and passing here is exactly today's behaviour. ⚠️ This does not
 * contradict ticket 08's "fail closed before the effect": that rule is about the
 * journal, where a lost intent costs crash recovery. Here passing costs nothing.
 *
 * ## The concurrency window, and the one thing not copied
 *
 * `deer-flow` puts the gate check and the tool execution in one critical
 * section. **We cannot**: `withPathLock` (`src/tools/workspace.ts:37`) is a
 * promise-chain lock and is not reentrant, so a gate holding it while the tool
 * body takes it again (`mutating.ts:48`) would deadlock.
 *
 * Two layers instead. The hash comparison closes the window across turns and
 * restarts, because the mark is durable and lives in the messages. {@link inFlight}
 * closes the one it cannot: the engine runs a batch's tool calls concurrently,
 * so a second write could clear the gate on the same mark before the first
 * mutation lands. A path is recorded the moment a write is let through, and the
 * check that records it is synchronous — JavaScript cannot interleave another
 * gate call inside it.
 *
 * ⚠️ This is weaker than `deer-flow`'s lock in one respect: its critical section
 * also guarantees a mark hashes the exact bytes the model was shown, while ours
 * hashes the file in a second read just after the tool's. Fail-open covers that
 * micro-window.
 */

/** The key the read mark is stamped under, beside `PINNED_KEY`. */
export const READ_MARK_KEY = "mimicc_read_mark";

/** What a `Read` leaves behind: which file, and the bytes it had at the time. */
export interface ReadMark {
  path: string;
  hash: string;
}

const READ_TOOL = "Read";
const WRITE_TOOL = "Write";
/**
 * The tools this gate covers: `Edit` alone.
 *
 * 🔴 **`Write` was here and was wrong.** `writeTool` never overwrites at all —
 * it throws `already exists and Write never overwrites. Use Edit to change it`
 * (`src/tools/mutating.ts:48-54`). Gating it replaced that accurate message with
 * a misleading one: this gate says "read it first", and reading does not help,
 * because `Write` refuses either way. `repro/41` caught it — the model answered
 * *"I can't overwrite it with Write without first reading it"*, which is not
 * true. **A tool already covered by a stricter rule must not be covered again by
 * a weaker one**; the second rule can only make the first one harder to read.
 *
 * ⚠️ **`Bash` is deliberately absent**, and this is a boundary rather than a
 * gap in this gate. `echo x >> f` is a write too, but recognising it means
 * parsing a shell — not a two-valued predicate, and precise triggering is the
 * term that nearly killed this mechanism elsewhere (hermes turned its
 * verification guard off for three days over exactly that). This repository
 * already decided how far it reasons about shell commands, on the permission
 * axis: **by prefix, never by semantics** (`src/tools/permission.ts:123`), and
 * the hard floor is documented as not reaching `Bash` at all (`:212-215`).
 * Bash writes are held by a different control — the confirmation gate, which
 * auto-allows only `ls`, `pwd`, `git status`, `git branch`.
 */
const GATED_TOOLS = new Set(["Edit"]);

const BLOCK = (tool: string, path: string): string =>
  `Error: ${tool} blocked — ${path} already exists and you have not read its current version. ` +
  `Any write invalidates earlier reads, so re-read before every modification. ` +
  `Call Read on it, check what is already there, then retry.`;

/** Paths with a write let through but not yet settled. See the note above. */
const inFlight = new Set<string>();

/**
 * The file's bytes right now, or null when it cannot be hashed (fail-open).
 *
 * Exported for `staleReads`, which asks the same question about the same marks —
 * a second implementation would be a second answer.
 */
export function hashOf(full: string): string | null {
  try {
    if (!statSync(full, { throwIfNoEntry: false })?.isFile()) return null;
    return createHash("sha256").update(readFileSync(full)).digest("hex");
  } catch {
    return null;
  }
}

/** Whether the file exists at all. A file being created has no earlier version. */
function exists(full: string): boolean {
  try {
    return statSync(full, { throwIfNoEntry: false })?.isFile() === true;
  } catch {
    return false;
  }
}

/**
 * The newest mark per path across the surviving messages.
 *
 * Exported for `staleReads`. Newest wins because a path read twice has two marks
 * and only the later one describes what the model is holding.
 */
export function latestMarks(messages: BaseMessage[]): Map<string, string> {
  const marks = new Map<string, string>();
  for (const message of messages) {
    const mark = message.additional_kwargs[READ_MARK_KEY] as ReadMark | undefined;
    if (mark !== undefined) marks.set(mark.path, mark.hash);
  }
  return marks;
}

/** Whether any surviving message carries a read mark for this path at this hash. */
function hasCurrentMark(messages: BaseMessage[], full: string, hash: string): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const mark = messages[index]?.additional_kwargs[READ_MARK_KEY] as
      ReadMark | undefined;
    if (mark?.path === full && mark.hash === hash) return true;
  }
  return false;
}

/** The `path` argument, when the call has a usable one. */
function pathArg(args: unknown): string | null {
  if (typeof args !== "object" || args === null) return null;
  const path = (args as { path?: unknown }).path;
  return typeof path === "string" && path !== "" ? path : null;
}

export function readBeforeWrite(): AnyAgentMiddleware {
  return createMiddleware({
    name: "ReadBeforeWrite",
    wrapToolCall: async (request, handler) => {
      const name = request.toolCall.name;
      const raw = pathArg(request.toolCall.args);
      if (
        raw === null ||
        (name !== READ_TOOL && name !== WRITE_TOOL && !GATED_TOOLS.has(name))
      ) {
        return handler(request);
      }

      let full: string;
      try {
        full = resolvePath(raw);
      } catch {
        return handler(request);
      }

      // A read stamps the mark. The tool returns a string and langchain builds
      // the ToolMessage, so there is no constructor to reach — the mark is
      // added here, the same exception `markPinned` exists for.
      //
      // A successful Write stamps too: the file's bytes after a Write are
      // exactly what the model sent, so "knows the current version" is a fact,
      // not a courtesy (rbw-tax ticket 01). The hash is taken *after* the write
      // lands, so the stamp describes the real bytes — and any external change
      // (Bash, the user) breaks the hash and is still refused.
      if (name === READ_TOOL || name === WRITE_TOOL) {
        const result = await handler(request);
        if (ToolMessage.isInstance(result) && result.status !== "error") {
          const hash = hashOf(full);
          if (hash !== null) {
            result.additional_kwargs[READ_MARK_KEY] = { path: full, hash };
          }
        }
        return result;
      }

      // A write. Everything from here is synchronous until the decision, which
      // is what makes `inFlight` a sufficient guard for a concurrent batch.
      if (!exists(full)) return handler(request);

      const hash = hashOf(full);
      // Fail-open: unhashable means the gate cannot judge, not that the call is bad.
      if (hash === null) return handler(request);

      // `state` is the agent's own schema, which this middleware does not
      // declare — narrowed here rather than cast at the use site so the one
      // unchecked step is visible.
      const state = request.state as { messages?: BaseMessage[] };
      const messages = state.messages ?? [];
      if (inFlight.has(full) || !hasCurrentMark(messages, full, hash)) {
        // Pinned, because this is a refusal rather than a hint: a rejection the
        // summary eats is a write the model retries unchanged (CONTEXT.md
        // 「钉住」). The one-shot hints in `hint.ts` are the other kind and stay
        // out of the history entirely.
        return markPinned(
          new ToolMessage({
            tool_call_id: request.toolCall.id ?? "",
            name,
            content: BLOCK(name, raw),
            status: "error",
          }),
        );
      }

      inFlight.add(full);
      try {
        return await handler(request);
      } finally {
        inFlight.delete(full);
      }
    },
  }) as AnyAgentMiddleware;
}
