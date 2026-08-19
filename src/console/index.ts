/**
 * The terminal the user actually talks to.
 *
 * `repl.ts` is the loop that reads a line, drives one turn, and renders it;
 * `markdown.ts` turns the model's reply into something a terminal can show. They
 * are a pair — the renderer exists only because the console prints replies — and
 * nothing outside this directory has any reason to reach past the barrel.
 *
 * `picker.ts` renders the list of earlier sessions and reads a choice out of a
 * typed line; `args.ts` parses the command line. Both are pure — the console has
 * exactly one readline interface and everything reads through it, so nothing
 * else here is allowed to consume input.
 *
 * The seam to the rest of the program is one interface, `AgentGraph`, declared
 * in `agents/loop.ts` and deliberately narrow: the console uses two of its
 * methods — one to drive a turn, one to ask what is parked on a thread — so
 * changing what middleware is installed does not ripple in here.
 */
export { runRepl, type ReplOptions, type Start } from "./repl";
// `describeError`, `fromSubagent` and `summarizeCall` are exported for their
// tests rather than for callers. `fromSubagent` and `summarizeCall` encode a
// fact about langchain's stream that was measured rather than read off
// documentation (a subagent's chunks are told apart by `checkpoint_ns` depth,
// not by `name`) — a fact like that has to be pinned somewhere a change would
// fail. `describeError` is pinned so the turn-ending wording the user reads
// does not drift (ticket 08).
export { describeError, fromSubagent, summarizeCall } from "./repl";
// Same reason, and the sharpest case of it: `readDecision` decides whether a
// keystroke approves a shell command. That an empty line is *not* a decision was
// a shipping bug once (`repro/15`), so it is pinned where a change fails.
export { readDecision, type Pending } from "./repl";
export { parseArgs, type Invocation } from "./args";
export { cachedShare, compact, spendBreakdown, spendLine } from "./spend";
export {
  describeSession,
  readChoice,
  renderSessionList,
  PAGE,
  type Choice,
} from "./picker";
export {
  markdownStream,
  renderLine,
  stylingEnabled,
  STYLES,
  type MarkdownStream,
} from "./markdown";
