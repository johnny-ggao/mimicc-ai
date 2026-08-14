/**
 * The terminal the user actually talks to.
 *
 * `repl.ts` is the loop that reads a line, drives one turn, and renders it;
 * `markdown.ts` turns the model's reply into something a terminal can show. They
 * are a pair — the renderer exists only because the console prints replies — and
 * nothing outside this directory has any reason to reach past the barrel.
 *
 * The seam to the rest of the program is one interface, `AgentGraph`, declared
 * in `agents/loop.ts` and deliberately narrow: the console uses exactly one
 * method, so changing what middleware is installed does not ripple in here.
 */
export { runRepl, type ReplOptions } from "./repl";
// `fromSubagent` and `summarizeCall` are exported for their tests rather than
// for callers: both encode a fact about langchain's stream that was measured
// rather than read off documentation (a subagent's chunks are told apart by
// `checkpoint_ns` depth, not by `name`), and a fact like that has to be pinned
// somewhere a change would fail.
export { fromSubagent, summarizeCall } from "./repl";
export {
  markdownStream,
  renderLine,
  stylingEnabled,
  STYLES,
  type MarkdownStream,
} from "./markdown";
