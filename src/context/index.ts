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
  estimate,
  planCut,
  project,
  requestTokens,
  tailWithin,
  type Cut,
} from "./projection";
export {
  contextWindow,
  KEEP_FRACTION,
  SUMMARY_INPUT_TOKENS,
  SUMMARY_SOURCE,
  TRIGGER_FRACTION,
  WINDOW_LIMIT,
  type ContextWindowOptions,
  type WindowEvent,
  type WindowTuning,
} from "./compaction";
export {
  projectInstructions,
  readProjectInstructions,
  INSTRUCTION_FILES,
  MAX_INSTRUCTION_BYTES,
  PROJECT_INSTRUCTIONS_ID,
} from "./instructions";
