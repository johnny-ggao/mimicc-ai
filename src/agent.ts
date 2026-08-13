import { SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { MemorySaver } from "@langchain/langgraph";
import type { BaseCheckpointSaver, Command } from "@langchain/langgraph";
import {
  createAgent,
  humanInTheLoopMiddleware,
  type AnyAgentMiddleware,
  type InterruptOnConfig,
} from "langchain";

import { projectInstructions } from "./instructions";
import { TOOLS } from "./tools";
import { usageMeter, type ModelUsage } from "./usage";

/**
 * A ceiling on one user turn. The graph counts *node* executions, and one lap of
 * the loop is two nodes (model, then tools) — so this is roughly 12 model calls.
 * Exceeding it raises GraphRecursionError.
 *
 * It is a crash guard, not a strategy: it stops a runaway turn, it does not
 * notice a model going in circles. Recognising that and bowing out gracefully is
 * a separate job nobody has done yet.
 */
export const RECURSION_LIMIT = 24;

export interface AgentOptions {
  baseURL: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  /**
   * The system prompt, handed to `createAgent` rather than seeded into state.
   *
   * That distinction is the whole point and it is not cosmetic. A system message
   * living in state is message zero of the thread, and
   * `summarizationMiddleware` treats message zero as summarisable input: it
   * splits it off, unshifts it into the pile being condensed, and returns
   * `[RemoveMessage(REMOVE_ALL_MESSAGES), summary, ...preserved]` — where
   * `preserved` never contains it. The prompt would come back as a paraphrase of
   * itself inside a HumanMessage.
   *
   * Passed here it never enters state at all. `AgentNode` keeps it and prepends
   * it to the message list on every single model call, so nothing that rewrites
   * history can reach it.
   *
   */
  systemPrompt?: string;
  /**
   * The repository's own instructions (AGENTS.md / CLAUDE.md), already read and
   * wrapped, or undefined when the repository has none.
   *
   * A string rather than a path, because the reading is somebody else's job:
   * `main.ts` calls `readProjectInstructions`, exactly as it calls
   * `describeEnvironment` for the system prompt. That keeps the filesystem out
   * of the agent builder, and it is also the seam that makes the current
   * read-once-at-startup behaviour temporary — making instructions live means
   * changing what main.ts passes, not this.
   */
  projectInstructions?: string;
  /**
   * Where threads are persisted.
   *
   * Optional, and the default is deliberately the in-process saver: most tests
   * only care about the loop, and making them all name a directory would be
   * noise. `main.ts` always passes a real one — a history that dies with the
   * process is not a history.
   */
  checkpointer?: BaseCheckpointSaver;
  /**
   * Where per-request token and cache numbers go. Optional because the loop runs
   * fine without a scale — but every context-engineering change is judged on
   * these numbers, so main.ts always passes one.
   */
  onUsage?: (usage: ModelUsage) => void;
}

/**
 * All the console needs from the loop: hand it messages, get a stream back.
 *
 * Stated outright rather than derived as `ReturnType<typeof
 * createUniversalAgent>`. That alias would drag langchain's whole compiled graph
 * type into the console's signature, so every change to what middleware is
 * installed would ripple into repl.ts — which uses exactly one method. Naming the
 * surface the caller actually uses is what keeps that seam a seam.
 *
 * The payload stays `unknown`: the tuple shape depends on streamMode, and repl.ts
 * is the one place that asserts it.
 */
export interface AgentGraph {
  stream(
    input: { messages: BaseMessage[] } | Command,
    options: {
      streamMode: ["messages", "values"];
      recursionLimit: number;
      signal: AbortSignal;
      configurable: { thread_id: string };
    },
  ): Promise<AsyncIterable<unknown>>;
}

function createModel(options: AgentOptions): ChatOpenAI {
  return new ChatOpenAI({
    model: options.model,
    apiKey: options.apiKey,
    configuration: { baseURL: options.baseURL },
    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
  });
}

/**
 * Which tools stop and ask before they run.
 *
 * A tool that is **absent** from this map is auto-approved — the middleware
 * treats "no config" as "no interrupt", which is fail-open. So every registered
 * tool is listed explicitly, including the ones that do not ask, and
 * `tests/agent.test.ts` fails if a newly registered tool is missing from here.
 * The point is that adding a tool forces a decision rather than inheriting one.
 *
 * Why the split: Write and Edit are contained by `resolveInside` — they cannot
 * leave the working directory and cannot touch a credential file — so the blast
 * radius is bounded by code rather than by judgement. Bash has no such bound. It
 * can curl, it can rm, it can rewrite git history, and telling a safe command
 * from a dangerous one is a parsing arms race (`foo && rm -rf`). Asking every
 * time costs a keypress and needs no parser.
 */
export const CONFIRMATION_POLICY: Record<string, false | InterruptOnConfig> = {
  Read: false,
  Glob: false,
  Grep: false,
  Write: false,
  Edit: false,
  Bash: {
    allowedDecisions: ["approve", "edit", "reject"],
    description: "Bash runs with your shell. Approve, edit the command, or reject.",
  },
};

/**
 * Builds the gate, and quarantines one cast.
 *
 * `humanInTheLoopMiddleware`'s parameter resolves to `never` under
 * `exactOptionalPropertyTypes: true`: langchain declares the optional fields of
 * its options schema without `| undefined`, and the signature collapses. No
 * value can satisfy `never`, so this is not fixable by typing the argument
 * better — it is a defect in a dependency's types, and the runtime value is
 * correct (the gate is exercised end to end in `tests/agent.test.ts`).
 *
 * The alternative was dropping the compiler flag, which the whole codebase pays
 * for — `createModel` below spreads `maxTokens` conditionally precisely because
 * that flag is on. One quarantined cast is cheaper than that. Try deleting this
 * wrapper on the next langchain bump; verified needed against langchain 1.5.5.
 */
function confirmationGate(): AnyAgentMiddleware {
  const options = { interruptOn: CONFIRMATION_POLICY };
  return humanInTheLoopMiddleware(
    options as unknown as Parameters<typeof humanInTheLoopMiddleware>[0],
  ) as AnyAgentMiddleware;
}

/**
 * The loop.
 *
 * `createAgent` is `new ReactAgent(...)`, which builds a StateGraph over two
 * nodes joined by a back edge — the loop itself is not what it adds. What it adds
 * is four middleware slots (beforeAgent / beforeModel / afterModel / afterAgent)
 * plus `wrapModelCall` and `wrapToolCall`, and the routing between them. All
 * three middlewares below hang off one of those slots, which is why this
 * repository once kept the same loop drawn by hand as a control and no longer
 * does — see docs/the-hand-drawn-loop.md.
 *
 * The checkpointer is not optional and not a feature request. `interrupt()` —
 * which is how the gate asks — throws `GraphValueError: No checkpointer set`
 * without one, because pausing mid-run means the run has to be persisted to be
 * resumed. It also means every call needs `configurable.thread_id`.
 *
 * Which saver is the caller's business — and that is the whole point of the
 * seam. The in-process default dies with the process; `main.ts` hands in the
 * JSONL one, so a thread outlives the terminal. Nothing else about the loop
 * changes, which is what "durable history is a different saver, not a different
 * design" was always claiming and now demonstrates.
 */
export function createUniversalAgent(options: AgentOptions) {
  return createAgent({
    model: createModel(options),
    tools: TOOLS,
    // Wrapped, not handed over as a string, and the difference is on the wire.
    // `normalizeSystemPrompt` returns a SystemMessage untouched but converts a
    // string into `new SystemMessage({ content: [{ type: "text", text }] })` —
    // which serialises as `content: [{...}]` instead of `content: "..."`
    // (measured; @langchain/openai/dist/converters/completions.js:464).
    //
    // Both reach the model, but only one of them is the shape this prompt was
    // designed against. src/prompt.ts splits static from per-session text so that
    // DeepSeek's longest-common-prefix cache keeps hitting; changing the
    // serialisation changes the prefix and resets that cache once for no gain.
    // The block form buys multimodal and per-block cache markers, neither of
    // which this agent uses.
    ...(options.systemPrompt !== undefined
      ? { systemPrompt: new SystemMessage(options.systemPrompt) }
      : {}),
    checkpointer: options.checkpointer ?? new MemorySaver(),
    // The meter is outermost so it times the gate rather than the gate timing
    // it. Order matters for `wrapModelCall`, which nests: the first middleware
    // in the array is the outer wrapper.
    middleware: [
      usageMeter(options.onUsage ?? (() => {})),
      // Only a beforeAgent hook, so its position among the others is not
      // load-bearing the way the meter's is.
      ...(options.projectInstructions !== undefined
        ? [projectInstructions(options.projectInstructions)]
        : []),
      confirmationGate(),
    ],
  });
}
