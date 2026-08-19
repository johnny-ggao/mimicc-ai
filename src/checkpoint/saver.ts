import { join } from "node:path";

import {
  BaseCheckpointSaver,
  WRITES_IDX_MAP,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  type PendingWrite,
} from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { BaseMessage, StoredMessage } from "@langchain/core/messages";

import {
  appendLines,
  readLines,
  removeFile,
  type CheckpointLine,
  type Line,
  type WriteEntry,
} from "./file";
import { decodeMessage, decodeValue, encodeMessage, encodeValue } from "./messages";

/**
 * A checkpointer that keeps each session in its own append-only JSONL file.
 *
 * ## Why the names here say `thread` when a file holds a session
 *
 * `thread_id` is LangGraph's key and it addresses **the whole tree** — which is
 * what `CONTEXT.md` calls a *session*; a *thread* is one branch inside it, of
 * which there is exactly one today. The two vocabularies cannot be reconciled by
 * renaming: `deleteThread` is an abstract method on `BaseCheckpointSaver`
 * (`langgraph-checkpoint/dist/base.d.ts:77`) and `thread_id` is a config key, so
 * both are load-bearing spellings rather than our choices.
 *
 * The rule is therefore positional, not a translation: **anything holding the
 * value of `thread_id` is called `threadId`**, and prose describing what is *in*
 * a file says session. Rename the first group and the interface breaks; believe
 * the second group when it says "thread" and you learn the wrong model, which is
 * what it used to say and why this paragraph exists.
 *
 * ## Why this is written by hand
 *
 * Of the four savers LangGraph ships, three need a server. The fourth,
 * `SqliteSaver`, depends on `better-sqlite3` — a native module Bun refuses to
 * load (`ERR_DLOPEN_FAILED`; Bun's own error suggests its built-in sqlite
 * instead). A persistent checkpointer on this stack is ours to write either way,
 * which turns the storage format into a choice rather than a constraint.
 *
 * ## Why JSONL rather than Bun's sqlite
 *
 * Sqlite is the better shape for the access pattern — the interface asks for
 * random access by id and reverse-ordered paging, which is what an index is for.
 * JSONL wins anyway, and the reason is what this repository is: a project for
 * understanding how an agent works. A history you can read with `jq` beats one
 * that needs a program, and `{"type":"ai","data":{…}}` beats
 * `{"lc":1,"type":"constructor",…}`.
 *
 * The performance objection does not survive the design: the file is replayed
 * into memory **once**, when a session is first touched, and every read after
 * that is a map lookup. One process, one session, one replay.
 *
 * ## Why messages are stored by id
 *
 * `put` is handed the entire message list on every super-step. Writing that list
 * into every checkpoint line is what makes the stock configuration quadratic —
 * measured at 1.1 MB for thirty-two turns of a conversation whose text is a few
 * hundred characters. So a checkpoint line stores **message ids**, and each body
 * is written once on its own line. Storage becomes linear, and the `message`
 * lines turn out to be exactly the durable transcript this agent needed anyway:
 * the store is the export, and no second mechanism is required.
 *
 * Safe because the reducer guarantees it — `messagesStateReducer` stamps a uuid
 * onto any message arriving without one, so everything reaching a channel value
 * has an id (`@langchain/langgraph/dist/graph/messages_reducer.js:48-58`).
 * Pending writes are *pre*-reducer and may hold an id-less message, so those are
 * serialised inline instead; they are small and short-lived.
 */
export class JsonlSaver extends BaseCheckpointSaver {
  /** Replayed session files, by thread id. Each is replayed at most once. */
  readonly #files = new Map<string, SessionFile>();

  constructor(private readonly directory: string) {
    super();
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = requireThreadId(config, "get a checkpoint");
    const ns = namespaceOf(config);
    const file = await this.#open(threadId);

    const id = checkpointIdOf(config) ?? file.latest(ns);
    if (id === undefined) return undefined;
    const stored = file.checkpoint(ns, id);
    if (stored === undefined) return undefined;

    return file.toTuple(stored, threadId);
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const threadId = requireThreadId(config, "list checkpoints");
    const file = await this.#open(threadId);

    const wantedNs = config.configurable?.checkpoint_ns as string | undefined;
    const wantedId = checkpointIdOf(config);
    const before = options?.before?.configurable?.checkpoint_id as string | undefined;
    let remaining = options?.limit;

    // Newest first, which is what `before` paging and "give me the latest" both
    // assume. Checkpoint ids are uuid6 — lexicographic order is time order.
    for (const stored of file.newestFirst()) {
      if (wantedNs !== undefined && stored.ns !== wantedNs) continue;
      if (wantedId !== undefined && stored.id !== wantedId) continue;
      if (before !== undefined && stored.id >= before) continue;
      if (options?.filter && !matches(stored.metadata, options.filter)) continue;
      if (remaining !== undefined) {
        if (remaining <= 0) break;
        remaining -= 1;
      }
      yield file.toTuple(stored, threadId);
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    const threadId = requireThreadId(config, "put a checkpoint");
    const ns = namespaceOf(config);
    const file = await this.#open(threadId);

    // Split message channels out of the values: bodies become their own lines,
    // the checkpoint keeps only ids, and the ids themselves are stored as an
    // append onto the parent's list rather than repeated in full.
    //
    // Both halves are needed, and it took measuring to find that out. Storing
    // bodies once looked like enough — thirty-two turns fell from 1,110,958
    // bytes to 262,969 — but the growth ratio per doubling was still climbing
    // (2.20 → 2.35 → 2.59 → 2.91, on its way to 4). An id list repeated in every
    // checkpoint is quadratic on its own; only the constant had improved.
    //
    // Storing the tail instead flattens it: 2.02 → 2.01 → 2.00 → 2.01 across the
    // same doublings, and because one curve is linear and the other is not, the
    // gap widens with the conversation — 2x at eight turns, 7.4x at thirty-two,
    // 14.5x at sixty-four (repro/09-growth.ts).
    //
    // The lesson generalises past this file: a ratio that improves is not the
    // same as a curve that changed shape, and only the second one holds up.
    const channels: Record<string, unknown> = {};
    const messageChannels: string[] = [];
    const fresh: Line[] = [];
    const parentId = checkpointIdOf(config);

    for (const [channel, value] of Object.entries(checkpoint.channel_values)) {
      const messages = asMessageList(value);
      if (messages === undefined) {
        channels[channel] = encodeValue(value);
        continue;
      }
      messageChannels.push(channel);
      const ids = messages.map(({ id }) => id);
      channels[channel] = file.asAppend(ns, parentId, channel, ids);
      for (const { id, message } of messages) {
        if (file.messages.has(id)) continue;
        const stored = encodeMessage(message);
        file.messages.set(id, stored);
        fresh.push({ kind: "message", id, data: stored });
      }
    }

    const line: CheckpointLine = {
      kind: "checkpoint",
      id: checkpoint.id,
      parent: parentId,
      ns,
      channels,
      messageChannels,
      versions: checkpoint.channel_versions,
      seen: checkpoint.versions_seen,
      v: checkpoint.v,
      ts: checkpoint.ts,
      metadata: encodeValue(metadata),
    };

    file.putCheckpoint(line);
    await appendLines(file.path, [...fresh, line]);

    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: ns,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    const threadId = requireThreadId(config, "put writes");
    const checkpointId = checkpointIdOf(config);
    if (checkpointId === undefined) {
      throw new Error("cannot put writes without a checkpoint_id in configurable");
    }
    const ns = namespaceOf(config);
    const file = await this.#open(threadId);

    // The stock savers key each write by task and index and let the *first*
    // write to a slot win, so a retried task cannot overwrite what landed.
    // Special channels map to negative indices, keeping them clear of
    // positional writes. The slot is stored rather than recomputed on replay —
    // recomputing gives different keys after a restart and silently breaks the
    // first-write-wins rule.
    const kept: WriteEntry[] = [];
    for (const [index, write] of writes.entries()) {
      const [channel, value] = write;
      const slot = `${taskId},${String(WRITES_IDX_MAP[channel] ?? index)}`;
      if (file.hasWrite(ns, checkpointId, slot)) continue;
      const stored: WriteEntry = {
        slot,
        task: taskId,
        channel,
        value: encodeValue(value),
      };
      file.addWrite(ns, checkpointId, stored);
      kept.push(stored);
    }
    if (kept.length === 0) return;

    await appendLines(file.path, [
      { kind: "writes", checkpoint: checkpointId, ns, entries: kept },
    ]);
  }

  /**
   * Deletes the session's file outright.
   *
   * The unit of deletion is a file, which is the point of one session per file:
   * `/clear` mints a new one, so a session boundary is visible in a directory
   * listing and removing one session cannot disturb another.
   *
   * ⚠️ The name is LangGraph's — see the note at the top of this file. Renaming
   * it to match the vocabulary was proposed and is impossible: the base class
   * declares it abstract.
   */
  async deleteThread(threadId: string): Promise<void> {
    this.#files.delete(threadId);
    await removeFile(this.#pathFor(threadId));
    // ⚠️ A session has a second file: `<threadId>.tools.jsonl`, the tool journal
    // (`checkpoint/journal.ts`). It is deliberately not removed from here — this
    // saver implements a langchain interface and has no business owning a sidecar
    // it never writes. Nothing calls this method today; whoever gives it a caller
    // owns deleting both, and `ToolJournal.remove()` is the other half.
  }

  async #open(threadId: string): Promise<SessionFile> {
    const cached = this.#files.get(threadId);
    if (cached !== undefined) return cached;

    const path = this.#pathFor(threadId);
    const file = SessionFile.replay(path, await readLines(path));
    this.#files.set(threadId, file);
    return file;
  }

  #pathFor(threadId: string): string {
    // The id is a uuid we minted, but it arrives through config, so it is still
    // caller input and must not be able to name a path. `src/session/repo.ts`
    // checks the same shape before it builds a path of its own: one rule in two
    // places beats one rule with a hole, and neither module can reach the other's.
    if (!/^[\w-]{1,128}$/.test(threadId)) {
      throw new Error(`thread_id is not usable as a file name: ${threadId}`);
    }
    return join(this.directory, `${threadId}.jsonl`);
  }
}

/** One session's file, decoded. Everything here is memory; nothing touches disk. */
class SessionFile {
  readonly messages = new Map<string, StoredMessage>();
  readonly #checkpoints = new Map<string, CheckpointLine>();
  /** Keyed by namespace + checkpoint id, then by slot. */
  readonly #writes = new Map<string, Map<string, WriteEntry>>();
  /** Memoised id lists, keyed by namespace + checkpoint id + channel. */
  readonly #resolved = new Map<string, string[]>();

  private constructor(readonly path: string) {}

  static replay(path: string, lines: Line[]): SessionFile {
    const file = new SessionFile(path);
    for (const line of lines) {
      switch (line.kind) {
        case "header":
          break;
        case "message":
          file.messages.set(line.id, line.data as StoredMessage);
          break;
        case "checkpoint":
          file.putCheckpoint(line);
          break;
        case "writes":
          for (const entry of line.entries)
            file.addWrite(line.ns, line.checkpoint, entry);
          break;
      }
    }
    return file;
  }

  putCheckpoint(line: CheckpointLine): void {
    this.#checkpoints.set(key(line.ns, line.id), line);
  }

  /**
   * Encodes `ids` as an append onto the parent's list when it is one.
   *
   * The common case by far: a super-step adds messages to the end and changes
   * nothing before them. When that does not hold — a summary rewriting the front
   * of the list, a fork off an older checkpoint — the full list is stored, so
   * correctness never depends on the optimisation applying.
   */
  asAppend(
    ns: string,
    parentId: string | undefined,
    channel: string,
    ids: string[],
  ): string[] | { base: string; add: string[] } {
    if (parentId === undefined) return ids;
    const base = this.#resolveIds(ns, parentId, channel);
    if (base === undefined || base.length > ids.length) return ids;
    for (const [index, id] of base.entries()) if (ids[index] !== id) return ids;
    return { base: parentId, add: ids.slice(base.length) };
  }

  /**
   * The full id list for one channel of one checkpoint, following `base` links.
   *
   * Memoised, so a session of N checkpoints resolves in N steps overall rather
   * than N per lookup — the walk is only ever from a checkpoint to its parent,
   * whose list is already resolved.
   */
  #resolveIds(ns: string, checkpointId: string, channel: string): string[] | undefined {
    const cacheKey = key(ns, checkpointId, channel);
    const cached = this.#resolved.get(cacheKey);
    if (cached !== undefined) return cached;

    const line = this.#checkpoints.get(key(ns, checkpointId));
    if (line === undefined) return undefined;
    const stored = line.channels[channel];

    let ids: string[];
    if (Array.isArray(stored)) {
      ids = stored as string[];
    } else if (isAppend(stored)) {
      const base = this.#resolveIds(ns, stored.base, channel);
      if (base === undefined) {
        throw new Error(
          `${this.path}: checkpoint ${checkpointId} appends to ${stored.base}, which is not in the file`,
        );
      }
      ids = [...base, ...stored.add];
    } else {
      return undefined;
    }

    this.#resolved.set(cacheKey, ids);
    return ids;
  }

  checkpoint(ns: string, id: string): CheckpointLine | undefined {
    return this.#checkpoints.get(key(ns, id));
  }

  latest(ns: string): string | undefined {
    for (const stored of this.newestFirst()) if (stored.ns === ns) return stored.id;
    return undefined;
  }

  *newestFirst(): Generator<CheckpointLine> {
    // Sorted, not reverse-insertion: a resumed session can append a checkpoint
    // whose id predates ones already in the file (time travel forks do this).
    const sorted = [...this.#checkpoints.values()].sort((a, b) =>
      b.id.localeCompare(a.id),
    );
    yield* sorted;
  }

  hasWrite(ns: string, checkpointId: string, slot: string): boolean {
    return this.#writes.get(key(ns, checkpointId))?.has(slot) ?? false;
  }

  addWrite(ns: string, checkpointId: string, write: WriteEntry): void {
    const bucketKey = key(ns, checkpointId);
    const bucket = this.#writes.get(bucketKey) ?? new Map<string, WriteEntry>();
    bucket.set(write.slot, write);
    this.#writes.set(bucketKey, bucket);
  }

  toTuple(stored: CheckpointLine, threadId: string): CheckpointTuple {
    const values: Record<string, unknown> = {};
    const messageChannels = new Set(stored.messageChannels);
    for (const [channel, value] of Object.entries(stored.channels)) {
      if (!messageChannels.has(channel)) {
        values[channel] = decodeValue(value);
        continue;
      }
      const ids = this.#resolveIds(stored.ns, stored.id, channel) ?? [];
      values[channel] = ids.map((id) => this.#message(id));
    }

    const pending = [
      ...(this.#writes.get(key(stored.ns, stored.id))?.values() ?? []),
    ].map(
      (write) =>
        [write.task, write.channel, decodeValue(write.value)] as [
          string,
          string,
          unknown,
        ],
    );

    const tuple: CheckpointTuple = {
      config: {
        configurable: {
          thread_id: threadId,
          checkpoint_ns: stored.ns,
          checkpoint_id: stored.id,
        },
      },
      checkpoint: {
        v: stored.v,
        id: stored.id,
        ts: stored.ts,
        channel_values: values,
        channel_versions: stored.versions as Record<string, number | string>,
        versions_seen: stored.seen as Record<string, Record<string, number | string>>,
      },
      metadata: decodeValue(stored.metadata) as CheckpointMetadata,
      pendingWrites: pending,
    };
    if (stored.parent !== undefined) {
      tuple.parentConfig = {
        configurable: {
          thread_id: threadId,
          checkpoint_ns: stored.ns,
          checkpoint_id: stored.parent,
        },
      };
    }
    return tuple;
  }

  #message(id: string): BaseMessage {
    const stored = this.messages.get(id);
    if (stored === undefined) {
      throw new Error(
        `${this.path}: a checkpoint references message ${id}, which is not in the file`,
      );
    }
    return decodeMessage(stored);
  }
}

/**
 * Messages paired with their ids, or `undefined` when this is not a message
 * channel.
 *
 * Detected structurally rather than by channel name: the name is `messages`
 * today, but a middleware is free to add another message-bearing channel, and
 * missing it would put whole message bodies back into every checkpoint line —
 * the quadratic growth this design exists to avoid, reintroduced silently.
 */
function asMessageList(
  value: unknown,
): { id: string; message: BaseMessage }[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const paired: { id: string; message: BaseMessage }[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object") return undefined;
    const candidate = item as BaseMessage;
    if (typeof candidate.getType !== "function" || typeof candidate.id !== "string") {
      return undefined;
    }
    paired.push({ id: candidate.id, message: candidate });
  }
  return paired;
}

/** A message channel stored as "the parent's list, plus these". */
function isAppend(value: unknown): value is { base: string; add: string[] } {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { base?: unknown }).base === "string" &&
    Array.isArray((value as { add?: unknown }).add)
  );
}

/**
 * A composite map key.
 *
 * JSON rather than a separator character, which is what the stock in-memory
 * saver does too: a namespace is caller-supplied, so any printable separator
 * lets one namespace forge a key belonging to another.
 */
function key(...parts: string[]): string {
  return JSON.stringify(parts);
}

function namespaceOf(config: RunnableConfig): string {
  return (config.configurable?.checkpoint_ns as string | undefined) ?? "";
}

function checkpointIdOf(config: RunnableConfig): string | undefined {
  const id = config.configurable?.checkpoint_id as string | undefined;
  return id === undefined || id === "" ? undefined : id;
}

function requireThreadId(config: RunnableConfig, action: string): string {
  const threadId = config.configurable?.thread_id as string | undefined;
  if (typeof threadId !== "string" || threadId === "") {
    throw new Error(`cannot ${action} without a thread_id in configurable`);
  }
  return threadId;
}

function matches(metadata: unknown, filter: Record<string, unknown>): boolean {
  if (metadata === null || typeof metadata !== "object") return false;
  const record = metadata as Record<string, unknown>;
  return Object.entries(filter).every(([field, value]) => record[field] === value);
}
