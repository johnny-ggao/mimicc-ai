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
 * module.
 */
export {
  createUniversalAgent,
  CONFIRMATION_POLICY,
  MAIN_AGENT,
  RECURSION_LIMIT,
  type AgentGraph,
  type AgentOptions,
} from "./loop";
export {
  agentStack,
  assertMeterInsideWindow,
  EXPLORE_PROMPT,
  EXPLORE_TOOLS,
  subagentSpecs,
  type AgentEnvironment,
} from "./kinds";
export { buildSystemPrompt, STATIC_PROMPT, type PromptEnvironment } from "./prompt";
