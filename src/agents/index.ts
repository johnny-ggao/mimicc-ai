/**
 * What an agent is, in this program.
 *
 * `loop.ts` builds one; `kinds.ts` says which kinds exist and what each is
 * fitted with; `prompt.ts` is the main agent's system prompt.
 *
 * The directory is plural because more than one kind of agent already runs here
 * — and because two further shapes of "more" are expected: more subagent kinds,
 * which are data in `kinds.ts`, and eventually agents standing side by side,
 * which would each take a subdirectory. Neither is built for yet: the seam that
 * matters is already open (`AgentOptions.systemPrompt` is a parameter, handed in
 * by `main.ts`), so the second agent is a move, not a redesign.
 *
 * A barrel, following `tools/` and `checkpoint/`: everything outside this
 * directory imports `@/agents`, and only files inside it reach for a specific
 * module. The one exception is `tools/task.ts`, which imports `./outcome`
 * directly — importing this barrel there would close the cycle
 * `agents → loop → tools → task → agents` (see the note in task.ts).
 */
export {
  assertLoopGuardBeforeGate,
  createUniversalAgent,
  pinRejections,
  CONFIRMATION_POLICY,
  DURABILITY,
  MAIN_AGENT,
  RECURSION_LIMIT,
  registeredTools,
  type AgentGraph,
  type AgentOptions,
} from "./loop";
export { turnBudget } from "./turnBudget";
export type { TurnCapReason } from "./loopguard";
export {
  agentStack,
  assertMeterInsideWindow,
  EXPLORE_PROMPT,
  EXPLORE_TOOLS,
  subagentSpecs,
  type AgentEnvironment,
} from "./kinds";
export {
  assertBlocksInFrequencyOrder,
  BLOCKS,
  type BeforeAgentCarrier,
  type Freq,
} from "./blockOrder";
export { buildSystemPrompt, STATIC_PROMPT, type PromptEnvironment } from "./prompt";
export { interruptedText, toolRecovery, type ToolRecoveryOptions } from "./recovery";
export { classify, failureMarker, failureText, type TurnOutcome } from "./outcome";
export { readBeforeWrite, READ_MARK_KEY, type ReadMark } from "./readBeforeWrite";
export { staleReads } from "./staleReads";
