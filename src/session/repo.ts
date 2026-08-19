import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { readSession, type Session } from "./read";

/**
 * The three questions the console needs answered about history: **what is
 * there**, **open this one**, and **which one did the user half-type**.
 *
 * ## Why this is not in `checkpoint/`
 *
 * A session is two files — `<id>.jsonl` and the tool journal beside it — and the
 * checkpointer owns exactly one of them. `checkpoint/saver.ts` says so itself,
 * in the comment on `deleteThread`: it *has no business owning a sidecar it
 * never writes*. Putting the lister in there would hand the saver that sidecar
 * through the back door. pi draws the same line one level up: `SessionRepo` sits
 * above `Storage`, and its `Storage` is "deliberately one-session only"
 * (`packages/agent/docs/harness.md:814`).
 *
 * ## What is deliberately missing
 *
 * `delete`. pi's repository has one, and we do not, because nothing would call
 * it: removing a session today is `rm .mimicc/<id>.jsonl*`, both files, one
 * glob. A method with no caller is precisely what that `deleteThread` comment is
 * warning about — shipping one to *look* complete would be the same mistake
 * spelled differently.
 *
 * `fork` is missing for a different reason: it is branch navigation, judged out
 * of scope (R10). The vocabulary already has a slot for it — `thread` is a
 * branch of a session's tree — so building it later adds an entry point, not a
 * rename.
 */

/** Sessions in `stateDir`, newest activity first. */
export async function listSessions(stateDir: string): Promise<Session[]> {
  let entries: string[];
  try {
    entries = await readdir(stateDir);
  } catch {
    // No history yet is not an error, and neither is a state directory that was
    // never created — an unused session never touches disk (the saver only
    // mkdirs on its first append), so this is the normal state of a fresh repo.
    return [];
  }

  const files = entries.filter(isSessionFile).map((name) => join(stateDir, name));
  const read = await Promise.all(files.map((path) => readSession(path)));

  return read
    .filter((session): session is Session => session !== undefined)
    .sort((a, b) => b.lastActive.getTime() - a.lastActive.getTime());
}

/**
 * One session by exact id.
 *
 * Separate from `listSessions` rather than a filter over it: `--resume <id>`
 * knows which file it wants, and reading the other forty to find out would make
 * the non-interactive path pay for the interactive one.
 */
export async function openSession(
  stateDir: string,
  id: string,
): Promise<Session | undefined> {
  if (!isSessionId(id)) return undefined;
  return readSession(join(stateDir, `${id}.jsonl`));
}

/** What a half-typed id turned out to name. */
export type Resolution =
  | { kind: "one"; session: Session }
  | { kind: "none" }
  | { kind: "many"; candidates: Session[] };

/**
 * Resolves a prefix to exactly one session.
 *
 * A prefix rather than a whole uuid because nobody types a whole uuid, and not a
 * list position because positions move: `--resume 3` means a different session
 * tomorrow, and this argument exists to be **testable**, which a drifting address
 * is not.
 *
 * The three outcomes are kept apart on purpose. "Nothing matched" and "four
 * things matched" want different words from the caller, and collapsing them into
 * `undefined` would make the caller guess which one happened.
 */
export async function resolveSession(
  stateDir: string,
  prefix: string,
): Promise<Resolution> {
  const exact = await openSession(stateDir, prefix);
  // An id is also a prefix of itself; taking it early means a full id never
  // becomes ambiguous just because some other session's id extends it.
  if (exact !== undefined) return { kind: "one", session: exact };

  const candidates = (await listSessions(stateDir)).filter((session) =>
    session.id.startsWith(prefix),
  );
  const [only] = candidates;
  if (only === undefined) return { kind: "none" };
  if (candidates.length === 1) return { kind: "one", session: only };
  return { kind: "many", candidates };
}

/**
 * Whether a directory entry is a session file.
 *
 * Three things live beside them and none is one: the tool journal
 * (`<id>.tools.jsonl`), probe directories (`.mimicc/probe-*`, which are real and
 * checked in as evidence), and the temp file an atomic repair leaves behind
 * (`.<pid>.tmp`). Matching the id shape rather than excluding the known
 * neighbours is what keeps the next kind of neighbour out for free.
 */
function isSessionFile(name: string): boolean {
  return name.endsWith(".jsonl") && isSessionId(name.slice(0, -".jsonl".length));
}

/**
 * The same shape `JsonlSaver` enforces before it will build a path from an id.
 * Checked here too, and not only there: this module turns caller input into a
 * filename, and a rule that lives in one of two places is a rule with a hole.
 */
function isSessionId(id: string): boolean {
  return /^[\w-]{1,128}$/.test(id);
}
