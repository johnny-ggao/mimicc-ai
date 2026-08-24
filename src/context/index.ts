/**
 * What the model sees on one request, and everything that decides it.
 *
 * The grouping is the domain's, not the framework's. Two of these are langchain
 * middlewares and one is not, which is exactly why "middleware" was the wrong
 * name for this directory: it would have grouped by how the pieces are installed
 * rather than by what they are for. `CONTEXT.md` is named after this concept and
 * defines it — the **context window** is a computed view over the conversation
 * history, not a shortened copy of it.
 *
 * `projection.ts` computes that view — pure arithmetic over a list, no framework
 * and no I/O. `compaction.ts` is the adapter that decides when the view has to
 * shrink, calls the model to write a summary, and writes the result back to
 * state. `instructions.ts` injects the repository's own instructions into it.
 *
 * The scale (`usage.ts`) is deliberately *not* here: it measures the request,
 * and a request is the resident segment plus the view.
 */
export {
  abandonedText,
  closeDangling,
  estimate,
  isInjected,
  isPinned,
  isSkillActivation,
  markPinned,
  PINNED,
  PINNED_KEY,
  planCut,
  project,
  requestTokens,
  SKILL_ACTIVATION_PREFIX,
  SUMMARY_SOURCE,
  tailWithin,
  type Attributed,
  type Cut,
} from "./projection";
export {
  downgrade,
  DOWNGRADE_DIR,
  DOWNGRADE_LIMIT,
  synopsis,
  type Downgraded,
  type DowngradeOptions,
} from "./downgrade";
export {
  contextWindow,
  KEEP_FRACTION,
  CONTEXT_SAFETY_TOKENS,
  MIN_OUTPUT_TOKENS,
  outputCeiling,
  SUMMARY_INPUT_TOKENS,
  SUMMARY_OUTPUT_BUDGET,
  TRIGGER_FRACTION,
  WINDOW_LIMIT,
  type ContextWindowOptions,
  type WindowEvent,
  type WindowTuning,
} from "./compaction";
export {
  pinTurnTask,
  projectInstructions,
  readProjectInstructions,
  INSTRUCTION_FILES,
  MAX_INSTRUCTION_BYTES,
  PROJECT_INSTRUCTIONS_ID,
} from "./instructions";
