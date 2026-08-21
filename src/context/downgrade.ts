import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ToolMessage, type BaseMessage } from "@langchain/core/messages";

/**
 * Downgrading: a third fate for a message, between keeping it whole and letting
 * a summary dissolve it.
 *
 * ## Why this is not "importance"
 *
 * Pinning (`projection.ts`) asks *of a message* whether it must survive, and the
 * answer is carried on the message because only its producer knows. This asks
 * nothing of the message. Its criteria are **content type and size** — a tool
 * result, over a threshold — which is a property of the bytes, not of anyone's
 * judgement about them. The two mechanisms are orthogonal on purpose: trying to
 * rank "a 60KB file listing" against "the user's rejection reason" on one scale
 * produces a scale that means nothing. Both reference implementations arrived at
 * the same split independently (`.scratch/retention-policy/research/01`).
 *
 * ## Deterministic, and that is a requirement
 *
 * The synopsis is built by this file, not by the model. Two reasons, and the
 * second is the one that would bite: a downgrade that costs a model call spends
 * money to save money, and a downgrade that is not reproducible means the same
 * history projects to two different views on two runs — which is the property
 * `CONTEXT.md` calls 投影 and the reason it is a projection at all.
 *
 * ## Non-destructive
 *
 * This runs over the messages on their way to one request. The history in state
 * and on disk is untouched, exactly as with the cut — see `docs/adr/0004`. The
 * substitution is 1:1, so indices mean the same thing before and after and a
 * `Cut` computed against one is valid against the other.
 */

/**
 * Where the full text goes.
 *
 * ⚠️ **The name is load-bearing.** It cannot be `.mimicc`: the hard floor's
 * `SECRET` pattern blacklists that directory outright (`tools/permission.ts`)
 * because that is where session files live, so a pointer into it is a pointer the
 * model's own `Read` refuses to open. It cannot be `/tmp` either — the hard
 * floor confines every read to the working directory. `tests/downgrade.test.ts`
 * reads a pointer back through the real tool, which is the only way to know this
 * stayed true.
 */
export const DOWNGRADE_DIR = ".mimicc-outputs";

/**
 * Above this many characters a tool result is worth downgrading.
 *
 * Sits under the caps the tools already impose on themselves — `Read` clips at
 * 64,000 bytes and `Bash` at 32,000 — so it selects the results that are large
 * *for this thread*, not the pathological ones the tools already refuse to
 * return. Below it the synopsis would not be smaller than what it replaces.
 */
export const DOWNGRADE_LIMIT = 8_000;

/** How many lines of the original the synopsis shows from each end. */
const EDGE_LINES = 3;

export interface DowngradeOptions {
  /** The working directory the pointer must be readable from. */
  root: string;
  /** Characters above which a tool result is downgraded. */
  limit?: number;
}

/** One result that was replaced, for the log. */
export interface Downgraded {
  tool: string;
  from: number;
  to: number;
  /** Where the full text went, or absent when the disk refused it. */
  path?: string;
}

/**
 * The replacement text: what it is, how big the original was, and where it went.
 *
 * The first line exists because of a specific failure mode: a synopsis that
 * reads like output gets used like output. Saying outright that this is not the
 * result is the difference between the model fetching the rest and the model
 * answering from a head and a tail.
 */
export function synopsis(
  text: string,
  tool: string,
  pointer: string,
  edgeLines = EDGE_LINES,
): string {
  const lines = text.split("\n");
  const head = lines.slice(0, edgeLines);
  const tail = lines.slice(-edgeLines);

  return [
    `[downgraded ${tool} result — a synopsis, not the output itself]`,
    `${String(lines.length)} lines, ${String(text.length)} characters.`,
    `Full output: ${pointer} — Read it if you need more than the edges below.`,
    "",
    `first ${String(head.length)} lines:`,
    ...head,
    "…",
    `last ${String(tail.length)} lines:`,
    ...tail,
  ].join("\n");
}

/**
 * Replaces oversized tool results with a synopsis and a pointer.
 *
 * **The current lap is never touched.** Everything after the last assistant
 * message is what the model asked for a moment ago and is about to use — and it
 * is also what breaks the one loop this mechanism can create. A pointer is only
 * useful if `Read` can fetch it; if the fetched text were itself downgraded on
 * arrival, the model would be handed a synopsis of the thing it just went to get,
 * forever. Exempting the current lap costs nothing and needs no rule about which
 * tool or which path, which is what makes it hold for tools nobody has written
 * yet.
 *
 * Returns the same array when nothing changed, so a caller can tell.
 */
export function downgrade(
  history: BaseMessage[],
  options: DowngradeOptions,
): { messages: BaseMessage[]; downgraded: Downgraded[] } {
  const limit = options.limit ?? DOWNGRADE_LIMIT;
  const exemptFrom = currentLapStart(history);
  const downgraded: Downgraded[] = [];

  const messages = history.map((message, index) => {
    if (index >= exemptFrom) return message;
    if (!ToolMessage.isInstance(message)) return message;

    const text = typeof message.content === "string" ? message.content : "";
    if (text.length <= limit) return message;

    const tool = message.name ?? "tool";
    const pointer = persist(text, options.root);
    // The third tier. A pointer nobody can follow is worse than no pointer, so
    // when the write fails the synopsis says so and carries the edges itself.
    const replacement =
      pointer === undefined
        ? truncated(text, tool, limit)
        : synopsis(text, tool, pointer);
    downgraded.push({
      tool,
      from: text.length,
      to: replacement.length,
      ...(pointer === undefined ? {} : { path: pointer }),
    });

    // Same `tool_call_id`, because the pairing is the provider's hard rule: an
    // assistant turn with tool calls must be answered, one result each.
    return new ToolMessage({
      ...(message.id !== undefined ? { id: message.id } : {}),
      tool_call_id: message.tool_call_id,
      ...(message.name !== undefined ? { name: message.name } : {}),
      content: replacement,
      additional_kwargs: { ...message.additional_kwargs },
    });
  });

  return downgraded.length === 0
    ? { messages: history, downgraded }
    : { messages, downgraded };
}

/**
 * Index of the first message of the lap in flight, or the length when there is
 * none.
 *
 * "The lap in flight" is the trailing run after the last assistant message: the
 * model spoke, tools ran, and their results have not been answered yet.
 */
function currentLapStart(history: BaseMessage[]): number {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.getType() === "ai") return index + 1;
  }
  return history.length;
}

/**
 * Writes the full text under a content-addressed name and returns the path the
 * model should use.
 *
 * Content-addressed so it is idempotent: the same output downgraded on two
 * requests writes one file and yields one pointer, which is what keeps the view
 * stable across recomputation. Relative, because that is what `Read` takes.
 */
function persist(text: string, root: string): string | undefined {
  const digest = createHash("sha256").update(text).digest("hex").slice(0, 16);
  const relative = join(DOWNGRADE_DIR, `${digest}.txt`);
  const absolute = join(root, relative);

  try {
    if (!existsSync(absolute)) {
      mkdirSync(join(root, DOWNGRADE_DIR), { recursive: true });
      writeFileSync(absolute, text, "utf8");
    }
    return relative;
  } catch {
    // Read-only checkout, full disk, a directory somebody replaced with a file.
    // Nothing here is worth failing a turn over — the caller has a tier for it.
    return undefined;
  }
}

/**
 * The bottom tier: no pointer, so the synopsis has to carry what it can.
 *
 * Head and tail rather than a head alone, because the ends of a tool result
 * carry different things — a file's first lines say what it is, a command's last
 * lines say how it went.
 */
function truncated(text: string, tool: string, limit: number): string {
  const half = Math.max(1, Math.floor(limit / 2));
  return [
    `[downgraded ${tool} result — a truncation, not the output itself]`,
    `${String(text.length)} characters, and the full text could not be written to disk.`,
    "",
    text.slice(0, half),
    `\n… ${String(text.length - half * 2)} characters omitted …\n`,
    text.slice(-half),
  ].join("\n");
}
