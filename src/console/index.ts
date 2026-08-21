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
 * `transcript.ts` is the third pure one, and it is pure for a different reason:
 * it renders messages that have already happened. The live loop and a resumed
 * session both go through it, which is what stops the same tool call from
 * printing two ways depending on whether you were watching when it ran.
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
// `fromModel` is the same kind of fact and was the same kind of bug: the
// `"messages"` stream carries node output as well as model tokens, so a message
// injected by a `beforeAgent` was rendered as the model's own prose on the first
// turn of every session (`repro/22`).
// `parked` is the same kind again: it reads a resumed session's snapshot and
// decides whether the console asks a question or finishes a job. Reading only
// half of it — the half that was there first — is how a batch of tool calls
// interrupted by a crash used to vanish without a word (`repro/23`).
export { describeError, fromModel, fromSubagent, parked } from "./repl";
// `transcript.ts` holds the vocabulary both render paths share, and
// `renderHistory` is the one thing here whose output nobody watches being
// produced: it is printed once, at resume, before the user can type. What it
// leaves out is a judgement about somebody else's conversation — the four
// injected `HumanMessage`s that no human typed — so which messages survive
// the filter is pinned in tests rather than left to the terminal to reveal.
export {
  renderHistory,
  summarizeCall,
  summarizeReasoning,
  summarizeResult,
} from "./transcript";
// Same reason, and the sharpest case of it: `readDecision` decides whether a
// keystroke approves a shell command. That an empty line is *not* a decision was
// a shipping bug once (`repro/15`), so it is pinned where a change fails.
export { readDecision, type Pending } from "./repl";
// The input queue is exported for the same reason as everything above it. Its
// three rules — a line belongs to the question that was on screen when it
// arrived, at most one line may wait, only an abort empties it — are each the
// kind that fails silently: the symptom of getting one wrong is a turn the user
// did not ask for, which looks exactly like a turn they did.
export {
  describeDrops,
  InputQueue,
  QUEUE_LIMIT,
  type Arrived,
  type Dropped,
  type Tag,
} from "./queue";
export { parseArgs, type Invocation } from "./args";
export { cachedShare, compact, spendBreakdown, spendLine } from "./spend";
export {
  describeSession,
  readChoice,
  renderSessionList,
  PAGE,
  type Choice,
} from "./picker";
// The `Clarify` tool's half of the console, exported for the same reason
// `readDecision` is: `readAnswer` decides what a keystroke means when the model
// has asked a question, and getting it wrong is silent. An empty line must not
// become an answer — the identical rule the gate learned the hard way — and a
// line that is not one of the numbers must become the user's own words rather
// than an error, because the case this tool exists for is the one where none of
// the options the model thought of is right.
export { readAnswer, renderQuestion, type Quiz } from "./clarify";
// The arrow-key half of the same question. `frame` and `press` are pure — the
// whole argument `picker.ts` made against a selector was that one could not be
// tested without a terminal, and the half of that argument which survived
// `repro/26` is this one. What they encode is what a keystroke means while a
// decision is on screen, which is exactly as silent to get wrong as `readAnswer`.
export {
  frame,
  initial,
  press,
  runSelector,
  width,
  type Key,
  type SelectorIO,
  type SelectorState,
  type Step,
} from "./selector";
export {
  markdownStream,
  renderLine,
  stylingEnabled,
  STYLES,
  type MarkdownStream,
} from "./markdown";
// The chain of thought's one row, exported for its tests for the same reason
// everything above it is. Three of these encode a fact that was measured rather
// than reasoned out: `columnsOf` because a truncated row that wraps is two rows
// and `\x1b[2K` can only take back one; `latestSentence` because which
// punctuation ends a sentence decides whether the reader sees half of one; and
// `statusRow`'s contract that the row is erased before anything else prints,
// which is silent to get wrong — the symptom is output that vanishes.
export {
  clipColumns,
  columnsOf,
  latestSentence,
  rowFor,
  statusRow,
  type StatusRow,
  type StatusRowIO,
} from "./reasoning";
