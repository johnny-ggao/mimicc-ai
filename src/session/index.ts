/**
 * A session: the unit a person can list, pick, and carry on from.
 *
 * One file on disk plus the tool journal beside it — the definition is in
 * `CONTEXT.md`, and the reason it is not the same word as `thread` is there too:
 * LangGraph's `thread_id` addresses this whole thing, while a `thread` is one
 * branch of the tree inside it, of which there is exactly one today.
 *
 * A barrel, following `agents/`, `tools/` and `checkpoint/`: everything outside
 * this directory imports `@/session`.
 */
export { readSession, type Session, type Spend } from "./read";
export { listSessions, openSession, resolveSession, type Resolution } from "./repo";
