import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Replay } from "../tools/replay";

import { removeFile } from "./file";

/**
 * What a tool call said about itself before it ran, and what came of it.
 *
 * ## Why a second file beside the session
 *
 * The checkpointer records the conversation. This records something else: that a
 * tool was *about to* run, with these exact arguments, and whether it declared
 * itself safe to run again. LangGraph has nowhere to put that — its per-task
 * write happens only after a task settles (`pregel/runner.js:67`), which is the
 * one moment this file exists to get ahead of.
 *
 * Beside the session rather than inside it, because the two have different
 * lifetimes and different readers. A settled record is dead weight the moment its
 * turn ends; a conversation is not. Folding them together would make "delete a
 * record" and "delete a message" the same action, which is exactly the confusion
 * `docs/adr/0004` spent a page avoiding elsewhere.
 *
 * ## What it costs
 *
 * ⚠️ A settlement carries the tool's output, so every recorded result is on disk
 * twice — once in the session file, once here. That is not free and it is not
 * hidden: {@link ToolJournal.prune} exists so a completed turn can drop what it
 * no longer needs, and the whole file dies with its session.
 *
 * The alternative — recording that a call settled and fetching the result from
 * history — does not work, and the reason is the point of the mechanism: on a
 * resume the task re-runs *because* its result never reached state. If it were
 * in history there would be nothing to recover.
 *
 * ## What this file does not do
 *
 * Nothing here is wired into tool execution — that is `08-wrap-tool-call`. This
 * is the storage and the vocabulary alone, so both can be tested without a graph.
 */

/** A tool call that is about to run. */
export interface Intent {
  toolCallId: string;
  tool: string;
  /** The arguments as they will actually be passed. */
  args: unknown;
  /** What the tool declared about itself, captured at this moment. */
  replay: Replay;
}

/** What the call produced. */
export interface Settlement {
  toolCallId: string;
  content: string;
  isError: boolean;
}

/**
 * Where a call stands, which is the only question a caller asks.
 *
 * `interrupted` is the state the whole design exists for: an intent is durable
 * and a settlement is not, so the call either ran, or partly ran, or never
 * started — and nothing on disk can say which.
 */
export type CallState =
  | { kind: "unrecorded" }
  | { kind: "interrupted"; intent: Intent }
  | { kind: "settled"; settlement: Settlement };

type Line = ({ kind: "intent" } & Intent) | ({ kind: "settlement" } & Settlement);

/**
 * One session's tool journal.
 *
 * Named for the session it belongs to and living next to that session's file, so
 * a directory listing shows the pair and removing a session can remove both.
 */
export class ToolJournal {
  readonly path: string;

  constructor(directory: string, threadId: string) {
    this.path = join(directory, `${threadId}.tools.jsonl`);
  }

  /**
   * Records that a call is about to run.
   *
   * ⚠️ **Awaited, and that is the entire point.** LangGraph hands its own writes
   * to the saver and moves on (`pregel/loop.js:164-172`), which is why a tool can
   * start before its checkpoint lands. This one returns when the bytes are down.
   *
   * First write wins. A re-run after a crash calls this again for the same id,
   * and the declaration that matters is the one captured *before* the effect —
   * overwriting it would erase the very thing {@link bothSafe} compares against.
   */
  async recordIntent(intent: Intent): Promise<void> {
    const state = await this.lookup(intent.toolCallId);
    if (state.kind !== "unrecorded") return;
    await this.#append({ kind: "intent", ...intent });
  }

  /** Records what the call produced. Awaited for the same reason. */
  async recordSettlement(settlement: Settlement): Promise<void> {
    await this.#append({ kind: "settlement", ...settlement });
  }

  /** Where this call stands. Reads the file, because after a crash it is the truth. */
  async lookup(toolCallId: string): Promise<CallState> {
    let intent: Intent | undefined;
    for (const line of await this.#read()) {
      if (line.toolCallId !== toolCallId) continue;
      if (line.kind === "settlement") {
        const { kind, ...settlement } = line;
        void kind;
        return { kind: "settled", settlement };
      }
      const { kind, ...rest } = line;
      void kind;
      intent ??= rest;
    }
    return intent === undefined
      ? { kind: "unrecorded" }
      : { kind: "interrupted", intent };
  }

  /**
   * Drops every call that has settled, keeping the ones still in doubt.
   *
   * A settled record has done its job the moment its turn ends: nothing will ever
   * ask again whether a call that is already in the conversation should re-run.
   * Rewrites the file rather than appending a tombstone, because the file's whole
   * purpose is to be small enough to read on every lookup.
   *
   * ⚠️ **Published atomically** — temp file, then rename — for the same reason
   * `checkpoint/file.ts` does it, and here the reason is sharper: this file's
   * entire purpose is that the process can die at any moment, so a rewrite that
   * can be caught half-done would be a crash-recovery file that is not itself
   * crash-safe. What would be lost is exactly the records with an intent and no
   * settlement, which are the only thing recovery has to go on.
   */
  async prune(): Promise<void> {
    const lines = await this.#read();
    const settled = new Set(
      lines.flatMap((line) => (line.kind === "settlement" ? [line.toolCallId] : [])),
    );
    if (settled.size === 0) return;

    const kept = lines.filter((line) => !settled.has(line.toolCallId));
    if (kept.length === 0) {
      await removeFile(this.path);
      return;
    }
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${String(process.pid)}.tmp`;
    await writeFile(
      temp,
      kept.map((line) => `${JSON.stringify(line)}\n`).join(""),
      "utf8",
    );
    await rename(temp, this.path);
  }

  /** Deletes the journal. Called when its session is deleted. */
  async remove(): Promise<void> {
    await removeFile(this.path);
  }

  async #append(line: Line): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(line)}\n`, "utf8");
  }

  async #read(): Promise<Line[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch {
      return [];
    }
    const lines: Line[] = [];
    for (const text of raw.split("\n")) {
      if (text.length === 0) continue;
      try {
        lines.push(JSON.parse(text) as Line);
      } catch {
        // A torn last line is the ordinary shape of a file whose writer was
        // killed — which is the case this whole file is about. Everything before
        // it is intact, so the sound move is to stop reading, not to fail.
        break;
      }
    }
    return lines;
  }
}
