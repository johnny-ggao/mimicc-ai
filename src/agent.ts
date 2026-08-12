import {
  MessagesValue,
  StateGraph,
  StateSchema,
  END,
  START,
} from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { ChatOpenAI } from "@langchain/openai";

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

export type AgentGraph = ReturnType<typeof createAgentGraph>;

/**
 * The core loop, as a graph.
 *
 * There is no `while` in this file. `.addEdge("tools", "llmCall")` is the loop —
 * a back edge — and `toolsCondition` is the exit: it reads the last message and
 * returns "tools" when it carries tool calls, END otherwise. Termination is a
 * pure function on the state, which is why it can be reasoned about separately
 * from the request that produced it.
 */
export function createAgentGraph(options: AgentOptions) {
  const model = new ChatOpenAI({
    model: options.model,
    apiKey: options.apiKey,
    configuration: { baseURL: options.baseURL },
    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
  }).bindTools(TOOLS);

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
