import { relative, resolve, sep } from "node:path";

/** Everything is resolved against this. Set once, at module load. */
export const ROOT = process.cwd();

/**
 * Output cap shared by everything that reads a file. A tool result goes straight
 * into the next prompt, so an unbounded read is an unbounded bill — and it
 * evicts the conversation.
 */
export const MAX_FILE_BYTES = 64_000;

/**
 * Reading is not risk-free and writing is worse. Tool output is sent to the
 * model, which makes an unconstrained path an exfiltration channel rather than
 * merely a read; an unconstrained write is a way out of the workspace entirely.
 *
 * Two guards, and they live here rather than in either tool module because a
 * security check with two copies is a security check that will drift.
 *
 * `.mimicc` is the odd one out: it holds no credentials, it holds this agent's
 * own conversation history. In development that directory sits inside the
 * working directory, so without this entry the agent's `Read` could open its own
 * past turns — a channel back into itself that nothing in the design calls for
 * and that carries the full text of every earlier conversation. Blocked for the
 * same reason as a private key, arrived at from the opposite direction.
 */
const SECRET =
  /(^|\/)\.env(\.|$)|(^|\/)\.git\/|(^|\/)\.mimicc(\/|$)|(^|\/)id_[a-z]+$|\.pem$|\.key$/;

/**
 * Resolves `path` against the working directory and refuses anything that leaves
 * it or that looks like a credential.
 *
 * Throwing is the right move — `ToolNode` turns a thrown error into a tool
 * message, so the model reads the refusal and can explain it to the user.
 */
export function resolveInside(path: string): string {
  const full = resolve(ROOT, path);
  if (full !== ROOT && !full.startsWith(ROOT + sep)) {
    throw new Error(`path escapes the working directory: ${path}`);
  }
  const rel = relative(ROOT, full);
  if (SECRET.test(`/${rel}`)) {
    throw new Error(
      `refusing to touch ${rel}: it may hold credentials, and tool output is sent to the model`,
    );
  }
  return full;
}

/** Whether a workspace-relative path is one of the files we never search. */
export function isSecret(path: string): boolean {
  return SECRET.test(`/${path}`);
}

/**
 * One promise chain per resolved path. A tail that has settled is dropped, so
 * this does not grow with the number of files ever touched.
 */
const chains = new Map<string, Promise<unknown>>();

/**
 * Serialises `work` against anything else holding the same path.
 *
 * The engine runs every tool call in a batch concurrently and is right to: the
 * model only batches calls with no data dependency between them, and it is the
 * only party that knows its own intent. But "no data dependency" is not "no
 * shared resource" — two edits to different lines of one file are independent in
 * the first sense and not in the second, and only the tool knows that `Edit` is
 * a read-modify-write rather than an atomic operation.
 *
 * Measured before this existed: the model batched `port: 3000 -> 8080` and
 * `retries: 3 -> 5` on one file, both calls reported success, and only the first
 * change was in the file. Both tools lied, and the prompt tells the model not to
 * re-read after a successful edit.
 *
 * So the mutual exclusion belongs here rather than in the scheduler: the
 * scheduler stays stateless and does no dependency analysis, and each tool is
 * responsible for the resource it touches. The key is the resolved absolute
 * path, so two different files still run at the same time.
 */
export function withPathLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  const previous = chains.get(path) ?? Promise.resolve();

  // Run on both settlement paths: a predecessor that threw must not wedge the
  // queue behind it.
  const result = previous.then(work, work);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );

  chains.set(path, settled);
  void settled.then(() => {
    if (chains.get(path) === settled) chains.delete(path);
  });

  return result;
}
