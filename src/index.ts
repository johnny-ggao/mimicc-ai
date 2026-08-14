// Public surface of the package. Keep this file side-effect free — the runnable
// entry point lives in src/main.ts.
export {
  createUniversalAgent,
  MAIN_AGENT,
  RECURSION_LIMIT,
  type AgentGraph,
  type AgentOptions,
} from "./agent";
export {
  CorruptSessionFile,
  JsonlSaver,
  resolveStateDir,
  STATE_DIR_NAME,
  type StateLocation,
} from "./checkpoint";
export { loadConfig, type Config } from "./config";
export { createLogger, type Logger, type LogLevel } from "./logger";
export {
  markdownStream,
  renderLine,
  stylingEnabled,
  type MarkdownStream,
} from "./markdown";
export {
  contextWindow,
  KEEP_FRACTION,
  TRIGGER_FRACTION,
  WINDOW_LIMIT,
  type ContextWindowOptions,
  type WindowEvent,
  type WindowTuning,
} from "./window";
export { buildSystemPrompt, STATIC_PROMPT, type PromptEnvironment } from "./prompt";
export {
  agentStack,
  assertMeterInsideWindow,
  EXPLORE_PROMPT,
  EXPLORE_TOOLS,
  subagentSpecs,
  type AgentEnvironment,
} from "./kinds";
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
