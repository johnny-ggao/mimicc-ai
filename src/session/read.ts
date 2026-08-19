import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";

/**
 * One session file, read the only way a lister is allowed to read it: **without
 * writing anything back**.
 *
 * The obvious move is to reuse `checkpoint/file.ts`'s `readLines`, and it is
 * wrong for this caller. That function *repairs* a torn tail — temp file, then
 * rename — because a half-written last line is routine here (the console lets
 * you Ctrl+C a turn whenever you like). Repairing is right when you are about to
 * append to the file. It is not right when the user typed `--resume` and is
 * merely looking at a list: **listing must not mutate what it lists**, or a
 * glance at your history rewrites five files.
 *
 * So this parses independently, and its tolerance is different in a second way
 * too: a file it cannot understand is **skipped**, not thrown. One damaged
 * session must not take the whole list down with it — the other nine are still
 * openable, and hiding them behind an exception is a worse failure than the one
 * being reported.
 */

/** One row of the list. Everything here is derived; nothing new is on disk. */
export interface Session {
  /** The thread id, which is also the file's basename. */
  id: string;
  path: string;
  /**
   * The first user message, clipped. There is no stored name to use — pi has one
   * (`session_info.name`) and we have no facts store at all, so this is the same
   * fallback pi itself uses when the name is unset (`firstMessage`).
   *
   * ⚠️ **The first human message is not always something a human typed.** A
   * session opened with `/skillname` starts with a pinned skill activation,
   * which is a human message carrying the skill's whole body — measured on this
   * repository's own history, that made the newest session read
   * `<skill name="wayfinder">`, which identifies nothing. Those are skipped by
   * id (`skill:<name>`, minted in `skills/registry.ts`) rather than by sniffing
   * the text, because the id is a contract and the text is a payload.
   */
  title: string;
  /** Message bodies stored in this file. One per line, so this is a line count. */
  messages: number;
  /** File mtime. The `header` line that would carry a real timestamp is never written yet. */
  lastActive: Date;
  /**
   * This session is parked at a confirmation gate: the process went away while
   * the gate was waiting for a human, and the question is still on disk.
   *
   * Measured, not inferred (`repro/18-resume-at-an-open-gate.ts`, and re-checked
   * against every session file in `.mimicc/`): the interrupt is a *pending write*
   * attached to the newest checkpoint. Answering it produces a newer checkpoint
   * without one, which is why "newest checkpoint carries an `__interrupt__`
   * write" is the whole judgement — and why looking anywhere else in the file
   * would report every session that was ever gated, rather than the ones parked
   * at a gate right now.
   */
  atGate: boolean;
  /**
   * What this session spent, in tokens.
   *
   * Summed off the messages rather than kept in a ledger of its own, because it
   * is already there: every persisted `ai` message carries `usage_metadata`
   * (measured — 28 of 28 in this repository's own history, 24 of them with a
   * cache-read figure), and `messages.ts` round-trips that field. The survey
   * that settled it found the same principle everywhere — pi writes a usage row
   * in the same transaction as the entry and points back with `entryId`
   * (`packages/agent/docs/harness.md:281-288`); Claude Code puts `usage` on the
   * assistant message; codex records one row per inference naming the items it
   * consumed. **The cost travels with the work that caused it**, and a second
   * store for it would be a second thing to keep in step.
   *
   * A dispatch's tokens ride in on the `Task` result's `response_metadata`,
   * because a subagent's own messages are never written down (`tools/task.ts`).
   *
   * ⚠️ Two things are outside this number, and both are structural rather than
   * oversights: a summary's own model call lands in a channel value rather than
   * in the message list, and `elapsedMs` is not a provider figure at all.
   */
  spent: Spend;
}

export interface Spend {
  input: number;
  output: number;
  /** Input tokens the provider served from its cache — the column the scale exists for. */
  cacheRead: number;
}

/** How much of the first message becomes the title. */
const TITLE_WIDTH = 72;

/** The id prefix `skills/registry.ts` mints for a slash command's activation. */
const SKILL_ID = "skill:";

export async function readSession(path: string): Promise<Session | undefined> {
  let raw: string;
  let lastActive: Date;
  try {
    [raw, lastActive] = await Promise.all([
      readFile(path, "utf8"),
      stat(path).then((stats) => stats.mtime),
    ]);
  } catch {
    return undefined;
  }

  let messages = 0;
  let title = "";
  const spent: Spend = { input: 0, output: 0, cacheRead: 0 };
  /** Used only when every human message in the file is a skill activation. */
  let fallback = "";
  let newest: string | undefined;
  // Interrupt writes, by the checkpoint they hang off. Collected as we go
  // because a `writes` line can appear before the checkpoint it belongs to is
  // the newest one, and we only learn which that is at the end of the file.
  const gated = new Set<string>();

  const physical = raw.split("\n");
  for (const [index, text] of physical.entries()) {
    if (text === "") continue;

    let line: unknown;
    try {
      line = JSON.parse(text);
    } catch {
      // A torn last line is the routine case and costs us nothing here. Anything
      // earlier means real damage, and this reader's answer to damage is to
      // decline the file rather than report half of it as if it were whole.
      if (index === physical.length - 1) continue;
      return undefined;
    }

    if (line === null || typeof line !== "object") return undefined;
    const record = line as {
      kind?: unknown;
      ns?: unknown;
      id?: unknown;
      checkpoint?: unknown;
      data?: unknown;
      entries?: unknown;
    };

    if (record.kind === "message") {
      messages += 1;
      addSpend(spent, record.data);
      if (title === "") {
        const id = typeof record.id === "string" ? record.id : "";
        if (id.startsWith(SKILL_ID)) {
          // A session that is *only* a slash command still deserves a name, and
          // `/wayfinder` is a better one than the body of the skill it loaded.
          if (fallback === "") fallback = `/${id.slice(SKILL_ID.length)}`;
        } else {
          title = titleOf(record.data);
        }
      }
      continue;
    }

    // Namespaced checkpoints belong to nested graphs, not to the conversation
    // the user is looking at. Subagents never reach a checkpointer at all
    // (`tools/task.ts` sets `checkpointer: false`), but the guard is on the
    // structure rather than on that decision holding forever.
    if (record.ns !== "" && record.ns !== undefined) continue;

    if (record.kind === "checkpoint" && typeof record.id === "string") {
      // Checkpoint ids are uuid6: lexicographic order is time order, which is
      // the same fact `JsonlSaver.newestFirst` relies on. A fork can append an
      // id that predates ones already in the file, so this cannot be "the last
      // one seen".
      if (newest === undefined || record.id > newest) newest = record.id;
      continue;
    }

    if (record.kind === "writes" && typeof record.checkpoint === "string") {
      const entries = record.entries;
      if (!Array.isArray(entries)) continue;
      const stops = entries.some(
        (entry: unknown) =>
          (entry as { channel?: unknown } | null)?.channel === "__interrupt__",
      );
      if (stops) gated.add(record.checkpoint);
    }
  }

  // A file with no message line is not a session anyone can resume into. It is
  // also not damage: a run that died before its first super-step lands here.
  if (messages === 0) return undefined;

  return {
    id: basename(path, ".jsonl"),
    path,
    title: title !== "" ? title : fallback !== "" ? fallback : "(无标题)",
    messages,
    lastActive,
    atGate: newest !== undefined && gated.has(newest),
    spent,
  };
}

/**
 * Adds one stored message's tokens to the running total.
 *
 * Two shapes, because two kinds of work are being paid for: the agent's own
 * model calls, whose numbers langchain puts in `usage_metadata`, and dispatches,
 * whose numbers `tools/task.ts` puts on the tool result because the subagent's
 * messages are never stored at all.
 */
function addSpend(total: Spend, data: unknown): void {
  const stored = data as {
    type?: unknown;
    data?: {
      usage_metadata?: {
        input_tokens?: unknown;
        output_tokens?: unknown;
        input_token_details?: { cache_read?: unknown };
      };
      response_metadata?: { usage?: unknown };
    };
  } | null;

  if (stored?.type === "ai") {
    const usage = stored.data?.usage_metadata;
    total.input += count(usage?.input_tokens);
    total.output += count(usage?.output_tokens);
    total.cacheRead += count(usage?.input_token_details?.cache_read);
    return;
  }

  if (stored?.type === "tool") {
    const usage = stored.data?.response_metadata?.usage as
      { input?: unknown; output?: unknown; cacheRead?: unknown } | undefined;
    total.input += count(usage?.input);
    total.output += count(usage?.output);
    total.cacheRead += count(usage?.cacheRead);
  }
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** The first line of a stored message's content, clipped to one row. */
function titleOf(data: unknown): string {
  const stored = data as { type?: unknown; data?: { content?: unknown } } | null;
  if (stored?.type !== "human") return "";

  const content = stored.data?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((block: unknown) => {
              const part = block as { text?: unknown } | null;
              return typeof part?.text === "string" ? part.text : "";
            })
            .join(" ")
        : "";

  const line = text.split("\n").find((candidate) => candidate.trim() !== "") ?? "";
  const trimmed = line.trim();
  return trimmed.length > TITLE_WIDTH
    ? `${trimmed.slice(0, TITLE_WIDTH - 1)}…`
    : trimmed;
}
