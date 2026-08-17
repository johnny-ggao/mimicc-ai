// Public surface of the package. Keep this file side-effect free — the runnable
// entry point lives in src/main.ts.
//
// Everything comes through a directory's barrel rather than a file inside it, so
// this list says what the package offers by area — agents, context, console,
// tools, persistence — and moving a file within an area does not touch it.
export {
  agentStack,
  assertMeterInsideWindow,
  buildSystemPrompt,
  createUniversalAgent,
  DURABILITY,
  EXPLORE_PROMPT,
  EXPLORE_TOOLS,
  MAIN_AGENT,
  RECURSION_LIMIT,
  STATIC_PROMPT,
  subagentSpecs,
  type AgentEnvironment,
  type AgentGraph,
  type AgentOptions,
  type PromptEnvironment,
} from "./agents";
export {
  CorruptSessionFile,
  JsonlSaver,
  resolveStateDir,
  STATE_DIR_NAME,
  type StateLocation,
} from "./checkpoint";
export { loadConfig, type Config } from "./config";
export {
  markdownStream,
  renderLine,
  runRepl,
  stylingEnabled,
  type MarkdownStream,
  type ReplOptions,
} from "./console";
export {
  contextWindow,
  KEEP_FRACTION,
  projectInstructions,
  PROJECT_INSTRUCTIONS_ID,
  readProjectInstructions,
  TRIGGER_FRACTION,
  WINDOW_LIMIT,
  type ContextWindowOptions,
  type WindowEvent,
  type WindowTuning,
} from "./context";
export { createLogger, type Logger, type LogLevel } from "./logger";
export {
  bashTool,
  createTaskTool,
  editTool,
  globTool,
  grepTool,
  readTool,
  writeTool,
  SUBAGENT_RECURSION_LIMIT,
  TASK_TOOL_NAME,
  TOOLS,
  type SubagentSpec,
  type TaskToolOptions,
} from "./tools";
export { usageMeter, usageOf, type ModelUsage } from "./usage";
