import {
  MessagesValue,
  StateGraph,
  StateSchema,
  END,
  START,
} from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import type { BaseMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { createAgent } from "langchain";

import { TOOLS } from "./tools";

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
    input: { messages: BaseMessage[] },
    options: {
      streamMode: ["messages", "values"];
      recursionLimit: number;
      signal: AbortSignal;
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
 * The same loop, built by langchain instead of by us.
 *
 * `createAgent` is `new ReactAgent(...)`, which builds a StateGraph over the
 * same two nodes and the same back edge — the loop is not what it adds. What it
 * adds is four middleware slots (beforeAgent / beforeModel / afterModel /
 * afterAgent) plus `wrapModelCall` and `wrapToolCall`, and the routing between
 * them. That is where a confirmation gate, a doom-loop counter, or history
 * summarisation would hang; none of those has a place in the graph above.
 *
 * This is what the console runs. Verified equivalent to `createAgentGraph` under
 * the console's stream modes — same message sequence, same values/messages event
 * counts — which is what makes the comparison in `tests/agent.test.ts` meaningful
 * rather than a formality.
 */
export function createUniversalAgent(options: AgentOptions) {
  return createAgent({ model: createModel(options), tools: TOOLS });
}
