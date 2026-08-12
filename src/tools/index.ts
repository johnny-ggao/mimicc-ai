import { globTool, grepTool, readTool } from "./readonly";

export { globTool, grepTool, readTool } from "./readonly";

/**
 * Read-only for now. Write / Edit / Bash need a confirmation gate first, and the
 * repl has nowhere to ask.
 *
 * Dispatch is not here: `ToolNode` looks tools up by name, validates arguments
 * against the zod schema, runs them in parallel, and turns every failure —
 * unknown tool, bad arguments, a tool that throws — into a tool message the
 * model can read. That was ~50 hand-written lines before the graph landed.
 */
export const TOOLS = [readTool, globTool, grepTool];
