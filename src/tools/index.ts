import { bashTool, editTool, writeTool } from "./mutating";
import { globTool, grepTool, readTool } from "./readonly";

export { globTool, grepTool, readTool } from "./readonly";
export {
  bothSafe,
  declaredReplay,
  NEVER_REPLAY,
  replayOf,
  REPLAY_KEY,
  SAFE_TO_REPLAY,
  type Replay,
} from "./replay";
export {
  bashTool,
  COMMAND_TICK_EVENT,
  editTool,
  killRunningCommands,
  writeTool,
  type CommandTick,
} from "./mutating";
// `Clarify` is a schema declaration whose body never runs — `clarifyGate` answers
// the call in `afterModel` instead. Both are exported because the assembling
// caller wires them as a pair; installing one without the other is either a tool
// that throws or a middleware with nothing to intercept. The note at the top of
// clarify.ts says why the obvious design (interrupt inside the body) is measured
// broken here (`repro/25`).
export {
  clarifyGate,
  clarifySchema,
  clarifyTool,
  CLARIFY_TOOL_NAME,
  isClarifyRequest,
  MAX_OPTIONS,
  MAX_QUESTIONS,
  MIN_OPTIONS,
  readRequest,
  renderAnswers,
  type ClarifyAnswer,
  type ClarifyOption,
  type ClarifyQuestion,
  type ClarifyRequest,
} from "./clarify";

/**
 * The six the system prompt advertises. Order is the order the model sees them
 * in, and `tests/agent.test.ts` pins it.
 *
 * Three of these can destroy work, and the permission gate guards them on two
 * axes. Write and Edit are confined by the hard floor — they cannot leave the
 * working directory or touch a credential file — but they still ask by default,
 * the baseline treating a mutating tool as worth a question. Bash asks too, and
 * it cannot be confined that way: it can curl, it can rm, it can rewrite git
 * history, and a command classifier is an arms race.
 *
 * Dispatch is not here: `ToolNode` looks tools up by name, validates arguments
 * against the zod schema, runs them in parallel, and turns every failure —
 * unknown tool, bad arguments, a tool that throws — into a tool message the
 * model can read.
 */
export const TOOLS = [readTool, writeTool, editTool, bashTool, globTool, grepTool];

/**
 * `Task` is not in TOOLS, and cannot be: it needs a model, which the agent
 * builds. It is exported as a factory the assembling caller wires up — see the
 * note in task.ts about the cycle that the alternative would close.
 */
export {
  createTaskTool,
  SUBAGENT_RECURSION_LIMIT,
  TASK_TOOL_NAME,
  type SubagentSpec,
  type TaskToolOptions,
} from "./task";
