# The projection is separate from its adapter, and its adapter keeps slow tests

`src/context/` holds two halves of one feature. `projection.ts` answers "what
does the model see this time" — pure arithmetic over a list, no framework and no
I/O. `compaction.ts` is the adapter: it decides _when_ the view has to shrink,
calls the model to write a summary, reports what happened, writes two facts back
to graph state, and absorbs the overflow the estimate failed to predict.

They used to be one 483-line file in which six of those functions were private.
That is why this is written down: the split looks like an unarguable good, and
the argument against it was real enough that it has to survive the person who
next reads the file.

## The argument against, stated fairly

**Both bugs this feature has actually shipped were in an adapter, not in
arithmetic.** A subagent inherited its parent's checkpointer and wrote its entire
run into the user's thread file; the scale was installed on the wrong side of
this middleware and reported the length of the history instead of the size of the
request. In both cases the pure functions were correct, every unit test was
green, and the symptom was invisible without watching what actually reached the
disk or the wire.

So the honest risk of extracting the projection is not that it is wrong. It is
that making half of this feature's tests cheap invites making the other half
cheap too — and the half that is expensive is the half where the failures live.

## What settled it

An inconsistency lived inside the projection for the entire life of the code and
was found by a probe against the real provider, not by a test: `requestTokens`
measures **the request** (it anchors on the provider's `input_tokens`, which
includes the resident segment) while `planCut` measures **the view** (it walks
the message array, which does not). Measured on a small window, `requestTokens`
returned 4,483 against a 4,000 trigger while `planCut` refused to cut, because
roughly 2,400 of that total was resident.

It survived every reading this file has had because there was no way to put the
two functions side by side and ask. That is a projection-side defect, discovered
only once the projection could be questioned — which is the case the
counter-argument said did not exist.

## Consequences

1. **The adapter's tests stay on a stub server.** `tests/window.test.ts` drives
   `createUniversalAgent` against `Bun.serve` and asserts on what reached the
   wire and what reached the thread file. Do not rewrite those as pure tests
   against `compaction.ts` internals. The count of tests going through that
   server must not fall.
2. **`tests/projection.test.ts` is additive.** It exists so the arithmetic can be
   questioned directly. It does not replace anything.
3. **A new branch got a name and a test.** `planCut` returns `number | null`;
   `null` means "over the line, but no cut would make progress". That state was
   an anonymous `if (next > cutoff)` at two call sites and had never been
   exercised, while being reachable in production — the measurement above is
   exactly it. `tests/window.test.ts` covers it, with a positive control,
   because a "no event was reported" assertion is otherwise satisfied by a
   threshold that was never crossed.
4. **Pinned ids come from the caller.** `project(history, cut, pins)` takes
   message ids; `agentStack` supplies them, because the place that injects a
   resident message is the place that knows it must survive a cut. The
   projection no longer imports anything from `instructions.ts`, which removes
   the only edge in the module graph that crossed between features.

## The debt this deliberately leaves

`requestTokens` counts the resident segment and `planCut` does not. **That is not
fixed here, on purpose.** Making the resident segment an explicit parameter is
the correct end state, and it changes _when_ summaries fire in production — a
behaviour change this repository settles from observations rather than from
arguments. It is pinned as a characterisation test instead, so the next person
meets it as a stated fact rather than as a surprise.

**Trigger to revisit:** when the resident segment grows large enough relative to
the window to move the trigger point — today it is about 2,400 tokens against
1,048,576, or 0.2%. A second condition would also do it: any agent kind whose
window limit is set small enough that the resident segment is a material fraction
of it.

`pi` has already arrived at the split, and its shape is the one to copy when the
trigger fires: `shouldCompact(contextTokens, contextWindow, settings)` takes both
numbers as parameters, and `getLastAssistantUsage` and `estimateContextTokens`
are two separately exported functions rather than one blended figure
(`packages/agent/src/harness/compaction/compaction.ts`).
