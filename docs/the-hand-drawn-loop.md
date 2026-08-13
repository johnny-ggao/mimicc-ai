# The hand-drawn loop

`src/agent.ts` used to export a second builder, `createAgentGraph` — the agent
loop drawn by hand as a `StateGraph`, next to `createUniversalAgent`, which is
langchain's `createAgent`. It was removed on 2026-08-13
([ADR-0002](adr/0002-delete-the-hand-drawn-loop.md)); this file is what it was
and what it settled.

## The loop is a back edge

```ts
/** The loop's entire memory. One key, and the reducer decides how it grows. */
export const AgentState = new StateSchema({ messages: MessagesValue });

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
```

There is no `while` anywhere in it. `.addEdge("tools", "llmCall")` **is** the
loop — a back edge — and `toolsCondition` is the exit: it reads the last message
and returns `"tools"` when it carries tool calls, `END` otherwise. Termination is
a pure function of the state, which is why it can be reasoned about separately
from the request that produced it.

Two node names are load-bearing. `toolsCondition` returns the literal string
`"tools"`, so renaming that node breaks the routing silently — the graph compiles
and the loop simply never runs tools.

## What running both proved

`tests/agent.test.ts` put both builders through the same assertions with
`describe.each`, so the comparison was measured rather than argued. What it
established, and the reason this file can be prose now:

- **The loop is not what the framework adds.** `createAgent` is
  `new ReactAgent(...)`, which builds a `StateGraph` over the same two nodes and
  the same back edge. Both loops passed the same four assertions — a full lap, the
  tool result landing in state, the tool list advertised on every call, and every
  tool call answered before the next model call.
- **What it adds is the middleware layer**: `beforeAgent` / `beforeModel` /
  `afterModel` / `afterAgent`, plus `wrapModelCall` and `wrapToolCall`, and the
  routing between them. Everything this repository has built since — the usage
  meter, the confirmation gate, project-instruction injection — hangs off one of
  those slots, and none of them had anywhere to attach on the hand-drawn graph.
- **`recursionLimit` counts node executions, not laps.** One lap is two nodes, so
  the ceiling has to be read in nodes. That assertion outlived the loop and is
  still in the test file.

## Why it went

Keeping it stopped being free once the two builders diverged in a way that could
not be asserted. Four capabilities landed on `createUniversalAgent` that
`createAgentGraph` silently ignored — `onUsage`, `systemPrompt`,
`projectInstructions`, and finally a state key for the file-read registry. The
last one is the one that forced the decision: a tool returning a `Command` whose
update names a channel absent from the schema has that write **silently dropped**
(`@langchain/langgraph/dist/pregel/algo.js:124`). The hand-drawn loop would have
gone on passing every shared assertion while recording nothing — a control group
that reports agreement it does not have is worse than no control group.

The loop it drew is unchanged and still runs; it is just built by `createAgent`
now. Everything above is still true of the graph underneath.
