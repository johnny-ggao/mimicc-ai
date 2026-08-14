# Subagents are read-only, and cannot ask

The `Task` tool dispatches a subagent inside a tool call. Every kind registered
today — currently one, `explore` — carries only `Read`, `Glob` and `Grep`.
**That tool list is the whole of the guarantee**: a subagent can only act through
the tools it was given, so "read-only" is a property of the registry rather than
a check somewhere that could be forgotten.

The reason it is written down is that the obvious explanation is wrong. It is
**not** that the framework forbids it. `interrupt()` works inside a nested run —
it reads the ambient config from AsyncLocalStorage and needs a checkpointer in it
(`@langchain/langgraph/dist/interrupt.js:54`) — so a subagent could in principle
stop and ask. What makes that expensive is the resume path: **a tool body is not
resumable**, so when the user answers, the parent re-runs the whole tool call
from the top, and the subagent would start its investigation again unless we
built a durable thread for it and threaded the resume value into it by hand.

Two further reasons stand on their own, and would survive even if that plumbing
existed:

- **The confirmation gate cannot reach a subagent.** It is
  `humanInTheLoopMiddleware` on the _agent's_ middleware stack, and a subagent is
  a separate agent instance. A subagent that could write would write without ever
  passing the gate that `Bash` passes every time — see
  [0001](0001-repository-content-never-enters-the-operator-channel.md) for the
  same shape of argument about authority.
- **Parallel writes would serialise anyway.** `withPathLock` makes concurrent
  edits to one file take turns, so three subagents editing would give up exactly
  the concurrency that motivates dispatching three of them.

## Consequences

A subagent that cannot ask must not be able to do anything worth asking about,
so the two halves of this decision are one decision. Adding a kind that may write
means answering the resume question first — and at that point the registry entry
is the smallest part of the work.

The gate's fail-open behaviour is unchanged and still guarded:
`CONFIRMATION_POLICY` lists every registered tool including `Task` itself, and
`tests/agent.test.ts` fails when a newly registered tool is missing from it.
`Task` is listed as auto-approved because dispatching a read-only subagent can do
nothing a `Read` could not.
