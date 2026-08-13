# Delete the hand-drawn loop

`src/agent.ts` exported two builders: `createAgentGraph`, the loop drawn by hand
as a `StateGraph`, and `createUniversalAgent`, langchain's `createAgent`. Only
the second was ever run; the first was kept as a control, run through the same
assertions with `describe.each` so that "what does the middleware layer buy" had
a measured answer. **It is deleted, and what it taught is preserved as prose in
[the-hand-drawn-loop.md](../the-hand-drawn-loop.md).**

The trigger is that the control stopped being able to disagree. Four capabilities
landed on `createUniversalAgent` that the hand-drawn loop silently ignored —
`onUsage`, `systemPrompt`, `projectInstructions`, and a state key for the
file-read registry. The last one is different in kind: a tool returning a
`Command` whose update names a channel that is not in the schema has that write
**silently dropped**, not rejected
(`@langchain/langgraph/dist/pregel/algo.js:124`). So the hand-drawn loop would
have kept passing every shared assertion while recording nothing. **A control
group that reports agreement it does not have is worse than not having one.**

## Consequences

`tests/agent.test.ts` no longer runs `describe.each` over two implementations;
the loop assertions run once, against the builder that is actually shipped. That
is a real loss of regression coverage on the graph wiring, accepted because the
wiring is now `node_modules`' to get right, not ours.

`learn/MISSION.md` lists "can judge `createAgent` versus `StateGraph` and say
what the trade-off is" as a success criterion. That criterion is met and stays
met — the answer is written down. Deleting the code does not delete the
conclusion, and this is the second time on this project that the right move was
to keep the finding and drop the scaffolding (see LR-0005 on removing prompt text
only once there is evidence).
