import {
  MessagesValue,
  StateGraph,
  StateSchema,
  END,
  START,
} from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { MemorySaver } from "@langchain/langgraph";
import type { Command } from "@langchain/langgraph";
import {
  createAgent,
  humanInTheLoopMiddleware,
  type AnyAgentMiddleware,
  type InterruptOnConfig,
} from "langchain";

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

/** The loop's entire memory. One key, and the reducer decides how it grows. */
export const AgentState = new StateSchema({ messages: MessagesValue });

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
   * Where per-request token and cache numbers go. Optional because the loop runs
   * fine without a scale — but every context-engineering change is judged on
   * these numbers, so main.ts always passes one.
   *
   * `createAgentGraph` ignores this. Measuring costs a middleware, and that loop
   * deliberately has none; see its doc comment.
   */
  onUsage?: (usage: ModelUsage) => void;
}

/**
 * All the console needs from either loop: hand it messages, get a stream back.
 *
 * Stated outright rather than derived from one of the builders below. They
 * compile to genuinely different graph types — langchain's carries its own
 * built-in state, ours carries AgentState — so `ReturnType<typeof …>` of either
 * one makes that one the standard the other has to imitate, and the compiler
 * rejects it. Naming the surface the caller actually uses is what lets both be
 * first-class. The payload stays `unknown`: the tuple shape depends on
 * streamMode, and repl.ts is the one place that asserts it.
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
 * The core loop, as a graph — hand-drawn, and **not what the console runs**.
 *
 * `src/main.ts` builds `createUniversalAgent` instead. Nothing in the running
 * program calls this function; the tests do, and that is deliberate.
 *
 * ## What it is
 *
 * There is no `while` in this file. `.addEdge("tools", "llmCall")` is the loop —
 * a back edge — and `toolsCondition` is the exit: it reads the last message and
 * returns "tools" when it carries tool calls, END otherwise. Termination is a
 * pure function on the state, which is why it can be reasoned about separately
 * from the request that produced it.
 *
 * ## Why it is still here
 *
 * 1. It is the artifact this repository exists to produce. The goal was to build
 *    the loop on LangGraph and understand it, not to configure an agent. Deleting
 *    it deletes the thing that was learned.
 * 2. It is the control. `tests/agent.test.ts` runs both loops through the same
 *    assertions with `describe.each`, so "what does the middleware layer actually
 *    buy" has an answer that is measured rather than argued.
 * 3. It is small enough to read in one sitting. `createUniversalAgent` compiles a
 *    graph whose shape depends on which middleware you passed; this one is four
 *    lines of wiring that are always the same four lines.
 *
 * ## What it is not
 *
 * It is not a half-built version of `createUniversalAgent`. Do not grow middleware
 * slots on it — beforeAgent / beforeModel / afterModel / afterAgent, jumpTo
 * routing, wrapModelCall — all of that is already installed in `node_modules`,
 * and reimplementing it here would be rewriting ~760 lines to arrive where
 * `createUniversalAgent` already is. When a turn needs a capability this loop
 * does not have, that is the signal to use the other builder, not to extend this
 * one.
 */
export function createAgentGraph(options: AgentOptions) {
  const model = createModel(options).bindTools(TOOLS);

  return (
    new StateGraph(AgentState)
      .addNode("llmCall", async (state) => ({
        messages: [await model.invoke(state.messages)],
      }))
      // The name is load-bearing: toolsCondition returns the literal string
      // "tools", so renaming this node silently breaks the routing.
      .addNode("tools", new ToolNode(TOOLS))
      .addEdge(START, "llmCall")
      .addConditionalEdges("llmCall", toolsCondition, ["tools", END])
      .addEdge("tools", "llmCall")
      .compile()
  );
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
 * The same loop, built by langchain instead of by us — and the one the console
 * actually runs.
 *
 * `createAgent` is `new ReactAgent(...)`, which builds a StateGraph over the
 * same two nodes and the same back edge — the loop is not what it adds. What it
 * adds is four middleware slots (beforeAgent / beforeModel / afterModel /
 * afterAgent) plus `wrapModelCall` and `wrapToolCall`, and the routing between
 * them. The confirmation gate below hangs off `afterModel`; there is no place in
 * `createAgentGraph` to put it.
 *
 * The checkpointer is not optional and not a feature request. `interrupt()` —
 * which is how the gate asks — throws `GraphValueError: No checkpointer set`
 * without one, because pausing mid-run means the run has to be persisted to be
 * resumed. It also means every call needs `configurable.thread_id`.
 *
 * MemorySaver is in-process: history survives `/clear` and time travel within a
 * session, and dies with the process. Durable history is a different saver, not
 * a different design.
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
    checkpointer: new MemorySaver(),
    // The meter is outermost so it times the gate rather than the gate timing
    // it. Order matters for `wrapModelCall`, which nests: the first middleware
    // in the array is the outer wrapper.
    middleware: [usageMeter(options.onUsage ?? (() => {})), confirmationGate()],
  });
}
