import {
  appendFile,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * The JSONL file underneath a session: how it is read, how it is appended to, and
 * what happens when the process died mid-write.
 *
 * The shape of the file is borrowed from pi, whose spec states the idea more
 * precisely than a comment can: *The file is not the state; it is the replay
 * recipe.* One physical line per commit. Opening a session is decoding — parse
 * every line into memory once — and every query after that runs against memory.
 * pi is emphatic that this is **not** crash-recovery logic, and the distinction
 * earns its keep: the moment "open the file" becomes "recover the session" it
 * grows tolerance branches and state inference, and nobody dares touch it again.
 */

/** Bumped only when an older file can no longer be read by this code. */
export const FORMAT_VERSION = 1;

export interface CheckpointLine {
  kind: "checkpoint";
  id: string;
  parent: string | undefined;
  ns: string;
  /**
   * Channel values. A message-bearing channel holds either the full list of ids
   * or `{ base, add }` — the parent checkpoint's list plus a tail — which is
   * what keeps the ids from growing quadratically alongside the bodies.
   */
  channels: Record<string, unknown>;
  /** Which channels in `channels` hold ids rather than values. */
  messageChannels: string[];
  versions: Record<string, unknown>;
  seen: Record<string, unknown>;
  v: number;
  ts: string;
  metadata: unknown;
}

/**
 * A pending write. `slot` is stored rather than recomputed on replay: the slot
 * is what makes "first write to a slot wins" hold, and recomputing it after a
 * restart produces different keys and silently breaks that rule.
 */
export interface WriteEntry {
  slot: string;
  task: string;
  channel: string;
  value: unknown;
}

export type Line =
  | { kind: "header"; version: number; thread: string; createdAt: number; cwd: string }
  | { kind: "message"; id: string; data: unknown }
  | CheckpointLine
  | { kind: "writes"; checkpoint: string; ns: string; entries: WriteEntry[] };

export class CorruptSessionFile extends Error {
  constructor(
    readonly path: string,
    readonly line: number,
    cause: string,
  ) {
    super(`${path}:${String(line)} is not a valid session line (${cause})`);
    this.name = "CorruptSessionFile";
  }
}

/**
 * Reads every line, repairing a torn tail and refusing anything else.
 *
 * Appending is not atomic, so a process killed mid-write leaves half a line —
 * and in this program that is a *routine* event, not an exotic one: the console's
 * SIGINT handler lets the user interrupt a turn whenever they like. The repair
 * has three conditions and each one blocks a different misdiagnosis:
 *
 * 1. **It must be the last line.** A broken line in the middle means something
 *    else damaged the file; silently dropping it would hide real data loss.
 * 2. **It must be a syntax error.** Unparseable means the write was cut short.
 *    Parseable but wrong-shaped means a format problem, and treating that as a
 *    tear would quietly discard a line we simply failed to understand.
 * 3. **The repair is an atomic publish of the valid prefix** — temp file, then
 *    rename — rather than truncation in place. A crash during the repair leaves
 *    an ignored temp file instead of a second kind of damaged session.
 *
 * Drop any one of the three and "torn" and "corrupt" become the same case, which
 * is precisely the silent failure this program is not allowed to have.
 */
export async function readLines(path: string): Promise<Line[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }

  // A trailing newline yields one empty final element; a torn tail does not.
  const physical = raw.split("\n");
  if (physical.at(-1) === "") physical.pop();

  const lines: Line[] = [];
  for (const [index, text] of physical.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      if (index === physical.length - 1) {
        await publishAtomically(path, `${physical.slice(0, index).join("\n")}\n`);
        return lines;
      }
      throw new CorruptSessionFile(
        path,
        index + 1,
        "unparseable, and not the last line",
      );
    }
    if (!isLine(parsed)) {
      throw new CorruptSessionFile(
        path,
        index + 1,
        "parses, but is not a known line kind",
      );
    }
    lines.push(parsed);
  }
  return lines;
}

/** One line, one append. The caller owns ordering; this owns the newline. */
export async function appendLines(path: string, lines: Line[]): Promise<void> {
  if (lines.length === 0) return;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(
    path,
    lines.map((line) => `${JSON.stringify(line)}\n`).join(""),
    "utf8",
  );
}

export async function removeFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

/**
 * Writes `contents` to a temp file and renames it over `path`.
 *
 * `rename` within a directory is atomic, so a reader either sees the whole old
 * file or the whole new one. Writing in place would expose a third state.
 */
async function publishAtomically(path: string, contents: string): Promise<void> {
  const temp = join(dirname(path), `.${String(process.pid)}.tmp`);
  await writeFile(temp, contents, "utf8");
  await rename(temp, path);
}

const KINDS = new Set(["header", "message", "checkpoint", "writes"]);

function isLine(value: unknown): value is Line {
  return (
    value !== null &&
    typeof value === "object" &&
    "kind" in value &&
    typeof value.kind === "string" &&
    KINDS.has(value.kind)
  );
}

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
