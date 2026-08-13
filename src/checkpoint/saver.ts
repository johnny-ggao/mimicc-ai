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
 * A checkpointer that keeps each thread in its own append-only JSONL file.
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
 * into memory **once**, when a thread is first touched, and every read after that
 * is a map lookup. One process, one thread, one replay.
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
  /** Replayed threads, by thread id. A thread is replayed at most once. */
  readonly #threads = new Map<string, Thread>();

  constructor(private readonly directory: string) {
    super();
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = requireThreadId(config, "get a checkpoint");
    const ns = namespaceOf(config);
    const thread = await this.#open(threadId);

    const id = checkpointIdOf(config) ?? thread.latest(ns);
    if (id === undefined) return undefined;
    const stored = thread.checkpoint(ns, id);
    if (stored === undefined) return undefined;

    return thread.toTuple(stored, threadId);
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const threadId = requireThreadId(config, "list checkpoints");
    const thread = await this.#open(threadId);

    const wantedNs = config.configurable?.checkpoint_ns as string | undefined;
    const wantedId = checkpointIdOf(config);
    const before = options?.before?.configurable?.checkpoint_id as string | undefined;
    let remaining = options?.limit;

    // Newest first, which is what `before` paging and "give me the latest" both
    // assume. Checkpoint ids are uuid6 — lexicographic order is time order.
    for (const stored of thread.newestFirst()) {
      if (wantedNs !== undefined && stored.ns !== wantedNs) continue;
      if (wantedId !== undefined && stored.id !== wantedId) continue;
      if (before !== undefined && stored.id >= before) continue;
      if (options?.filter && !matches(stored.metadata, options.filter)) continue;
      if (remaining !== undefined) {
        if (remaining <= 0) break;
        remaining -= 1;
      }
      yield thread.toTuple(stored, threadId);
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    const threadId = requireThreadId(config, "put a checkpoint");
    const ns = namespaceOf(config);
    const thread = await this.#open(threadId);

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
      channels[channel] = thread.asAppend(ns, parentId, channel, ids);
      for (const { id, message } of messages) {
        if (thread.messages.has(id)) continue;
        const stored = encodeMessage(message);
        thread.messages.set(id, stored);
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

    thread.putCheckpoint(line);
    await appendLines(thread.path, [...fresh, line]);

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
    const thread = await this.#open(threadId);

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
      if (thread.hasWrite(ns, checkpointId, slot)) continue;
      const stored: WriteEntry = {
        slot,
        task: taskId,
        channel,
        value: encodeValue(value),
      };
      thread.addWrite(ns, checkpointId, stored);
      kept.push(stored);
    }
    if (kept.length === 0) return;

    await appendLines(thread.path, [
      { kind: "writes", checkpoint: checkpointId, ns, entries: kept },
    ]);
  }

  /**
   * Deletes the thread's file outright.
   *
   * The unit of deletion is a file, which is the point of one thread per file:
   * `/clear` mints a new thread, so a session boundary is visible in a directory
   * listing and removing one thread cannot disturb another.
   */
  async deleteThread(threadId: string): Promise<void> {
    this.#threads.delete(threadId);
    await removeFile(this.#pathFor(threadId));
  }

  async #open(threadId: string): Promise<Thread> {
    const cached = this.#threads.get(threadId);
    if (cached !== undefined) return cached;

    const path = this.#pathFor(threadId);
    const thread = Thread.replay(path, await readLines(path));
    this.#threads.set(threadId, thread);
    return thread;
  }

  #pathFor(threadId: string): string {
    // A thread id is a uuid we minted, but it arrives through config, so it is
    // still caller input and must not be able to name a path.
    if (!/^[\w-]{1,128}$/.test(threadId)) {
      throw new Error(`thread_id is not usable as a file name: ${threadId}`);
    }
    return join(this.directory, `${threadId}.jsonl`);
  }
}

/** One thread's file, decoded. Everything here is memory; nothing touches disk. */
class Thread {
  readonly messages = new Map<string, StoredMessage>();
  readonly #checkpoints = new Map<string, CheckpointLine>();
  /** Keyed by namespace + checkpoint id, then by slot. */
  readonly #writes = new Map<string, Map<string, WriteEntry>>();
  /** Memoised id lists, keyed by namespace + checkpoint id + channel. */
  readonly #resolved = new Map<string, string[]>();

  private constructor(readonly path: string) {}

  static replay(path: string, lines: Line[]): Thread {
    const thread = new Thread(path);
    for (const line of lines) {
      switch (line.kind) {
        case "header":
          break;
        case "message":
          thread.messages.set(line.id, line.data as StoredMessage);
          break;
        case "checkpoint":
          thread.putCheckpoint(line);
          break;
        case "writes":
          for (const entry of line.entries)
            thread.addWrite(line.ns, line.checkpoint, entry);
          break;
      }
    }
    return thread;
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
   * Memoised, so a thread of N checkpoints resolves in N steps overall rather
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
    // Sorted, not reverse-insertion: a resumed thread can append a checkpoint
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
