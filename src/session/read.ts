import type { UsageMetadata } from "@langchain/core/messages";
import { readFile, stat } from "node:fs/promises";

import { isInjected, isSkillActivation, SKILL_ACTIVATION_PREFIX } from "../context";
import { addSpend, bucketsOf, noSpend, type Spend } from "../usage";
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
  /**
   * Messages a person would recognise as part of the conversation.
   *
   * **Not** the number of bodies in the file, and the gap is not small. Four
   * middlewares inject a `HumanMessage` that nobody typed — project
   * instructions, memory, the skill catalogue, a skill activation — so every
   * session carried a constant three or so of them, and the one measured here
   * read `5 msg` for a conversation of one question and one answer. A count that
   * inflates every row by the same amount is worse than no count: it makes an
   * abandoned session and a real one look the same size.
   *
   * The same verdict decides what `console/transcript.ts` replays, and that is
   * the point — a row that promises five messages and a resume that prints three
   * are two numbers about one conversation.
   */
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
  /**
   * The same tokens, split by the model that spent them.
   *
   * A mixed total stops meaning anything once more than one model is in play,
   * and that is reachable today rather than hypothetically: change `LLM_MODEL`,
   * `--resume` an older session, and one number would be two providers' tokens
   * added together. pi keys its breakdown the same way
   * (`packages/coding-agent/src/core/usage-totals.ts:37-45`).
   *
   * `"unknown"` collects everything written before the model was recorded —
   * which is every message in this repository's history at the time this landed.
   */
  byModel: Record<string, Spend>;
}

/** How much of the first message becomes the title. */
const TITLE_WIDTH = 72;

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
  // Bodies on disk, injections included. Kept apart from `messages` because the
  // two answer different questions: this one decides whether the file is a
  // session at all, and filtering it would hide a run that died before its first
  // reply instead of listing it as the stub it is.
  let bodies = 0;
  let title = "";
  const spent: Spend = noSpend();
  const byModel: Record<string, Spend> = {};
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
      bodies += 1;
      // Tokens are summed off every body, injected or not: the question that
      // column answers is what the session *cost*, and a catalogue nobody typed
      // was still paid for on every request that carried it.
      collect(spent, byModel, record.data);

      const stored = attributed(record);
      if (isInjected(stored)) continue;
      messages += 1;

      if (title === "") {
        if (isSkillActivation(stored)) {
          // A session that is *only* a slash command still deserves a name, and
          // `/wayfinder` is a better one than the body of the skill it loaded.
          if (fallback === "") {
            fallback = `/${(stored.id ?? "").slice(SKILL_ACTIVATION_PREFIX.length)}`;
          }
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
  // Deliberately `bodies` rather than `messages`: a session whose only stored
  // message is an injection is still a file on disk with a thread behind it, and
  // dropping it from the list would be this reader deciding it never happened.
  if (bodies === 0) return undefined;

  return {
    id: basename(path, ".jsonl"),
    path,
    title: title !== "" ? title : fallback !== "" ? fallback : "(无标题)",
    messages,
    lastActive,
    atGate: newest !== undefined && gated.has(newest),
    spent,
    byModel,
  };
}

/**
 * The provenance fields of a stored message, in the shape `isInjected` reads.
 *
 * ⚠️ **The id is read from two places, and that is the whole subtlety.** A body
 * on disk is `{ kind, id, data: { type, data: { content, additional_kwargs, … } } }`
 * — langchain's serialisation nested inside this file's own envelope — and the
 * id appears in both, matching, on every message this version writes. It is
 * taken from the envelope when the inner one is absent, because this reader
 * exists for **files somebody else wrote, possibly a while ago**: an older line
 * carries the envelope id and nothing inside. Reading only the inner one turned
 * `/wayfinder` back into a title of `<skill name="wayfinder">`, which is the
 * exact failure the id was made a contract to prevent (`tests/session.test.ts`).
 *
 * Reading the fields rather than rehydrating the message is the other half.
 * This lister must not instantiate langchain classes from a file it did not
 * write — `repro/08-load-trust-boundary.ts` measured what `load()` will
 * construct from a hand-edited line — and a list would do it once per session.
 */
function attributed(record: { id?: unknown; data?: unknown }): {
  id?: string;
  additional_kwargs?: Record<string, unknown>;
} {
  const stored = record.data as { data?: unknown } | null;
  const inner = stored?.data as
    { id?: unknown; additional_kwargs?: unknown } | null | undefined;
  const id = typeof inner?.id === "string" ? inner.id : record.id;
  const kwargs = inner?.additional_kwargs;
  return {
    ...(typeof id === "string" ? { id } : {}),
    ...(kwargs !== null && typeof kwargs === "object"
      ? { additional_kwargs: kwargs as Record<string, unknown> }
      : {}),
  };
}

/**
 * Adds one stored message's tokens to the totals, and to its model's column.
 *
 * Two shapes, because two kinds of work are being paid for: the agent's own
 * model calls, whose numbers langchain puts in `usage_metadata`, and dispatches,
 * whose numbers `tools/task.ts` puts on the tool result — already split by model
 * — because the subagent's messages are never stored at all.
 */
function collect(total: Spend, byModel: Record<string, Spend>, data: unknown): void {
  const stored = data as {
    type?: unknown;
    data?: {
      usage_metadata?: unknown;
      response_metadata?: { model?: unknown; usage?: unknown };
    };
  } | null;

  const into = (key: unknown, spend: Spend): void => {
    addSpend(total, spend);
    const label = typeof key === "string" && key !== "" ? key : "unknown";
    addSpend((byModel[label] ??= noSpend()), spend);
  };

  if (stored?.type === "ai") {
    if (stored.data?.usage_metadata === undefined) return;
    into(
      stored.data.response_metadata?.model,
      bucketsOf(stored.data.usage_metadata as UsageMetadata),
    );
    return;
  }

  if (stored?.type === "tool") {
    const dispatched = stored.data?.response_metadata?.usage;
    if (dispatched === null || typeof dispatched !== "object") return;
    for (const [model, spend] of Object.entries(
      dispatched as Record<string, unknown>,
    )) {
      if (spend === null || typeof spend !== "object") continue;
      const parts = spend as Record<string, unknown>;
      into(model, {
        uncachedInput: count(parts["uncachedInput"]),
        output: count(parts["output"]),
        cacheRead: count(parts["cacheRead"]),
        cacheWrite: count(parts["cacheWrite"]),
      });
    }
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
