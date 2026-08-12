import { bashTool, editTool, writeTool } from "./mutating";
import { globTool, grepTool, readTool } from "./readonly";

export { globTool, grepTool, readTool } from "./readonly";
export { bashTool, editTool, writeTool } from "./mutating";

/**
 * The six the system prompt advertises. Order is the order the model sees them
 * in, and `tests/agent.test.ts` pins it.
 *
 * Three of these can destroy work, and the guards are split by what can actually
 * be contained. Write and Edit are confined by `resolveInside` — they cannot
 * leave the working directory or touch a credential file — so they run without
 * asking. Bash cannot be confined that way: it can curl, it can rm, it can
 * rewrite git history, and a command classifier is an arms race. It is gated by
 * `humanInTheLoopMiddleware` instead, which is a decision the user made rather
 * than a limitation of the parser we did not write.
 *
 * Dispatch is not here: `ToolNode` looks tools up by name, validates arguments
 * against the zod schema, runs them in parallel, and turns every failure —
 * unknown tool, bad arguments, a tool that throws — into a tool message the
 * model can read.
 */
export const TOOLS = [readTool, writeTool, editTool, bashTool, globTool, grepTool];
