# Skills are user-channel instructions that outrank nothing

A skill is a directory of instructions installed outside the repository
(`~/.mimicc/skills` and `~/.claude/skills`), loaded on demand rather than
resident. Where its text lands in the context is the same question 0001 answered
for `AGENTS.md`, one hop further out: the skill's author is neither the operator
nor the repository owner, so the text must not reach the operator channel, and it
must not override either of them.

**Skills enter the `user` channel, exactly like project instructions.** Putting a
skill in `role: "system"` would let an installed skill rewrite the agent's safety
rules. The argument is 0001's, applied to a third party the user opted into but
did not author — the repository owner controls `AGENTS.md`, the skill author
controls the skill.

**Authority is system prompt > project instructions > skill, and the system
prompt states it, not the tag.** The tag `<skill name="…">` carries provenance
only, the same reason `<project-instructions>` carries no authority. The ordering
is not cosmetic: a skill is _global_ — installed once, applies in every
repository — while `AGENTS.md` is _local_. A rule the repository states must win
over a generic workflow a skill prescribes.

## Two further decisions, recorded together rather than split off

- **Main agent only.** The catalogue injection and the `Skill` tool are added to
  the main agent's middleware, not `agentStack`, so an Explore subagent never
  carries them. This is 0003's reasoning again: a subagent's capabilities are its
  tool list, and skills are not on it.
- **Lazy, with two entries into one loader.** Only a catalogue of _model-invoked_
  skills' names and descriptions is resident; a body loads through `Skill(name)`
  (model) or `/name` (user), both producing the same wrapped product. A
  `disable-model-invocation` skill is user-invoked only — the `Skill` tool
  refuses it, because the flag's whole point is that the human is the index.

## Consequences

A loaded body is a pinned `user` message, so a summary does not eat it mid-task —
the same treatment as project instructions. The catalogue is injected once per
thread under a stable id, and its absence (no model-invoked skills) means no
injection at all.

The confirmation gate does not apply to a skill: it is content, not a tool call.
A malicious skill can still tell the model to run a command, but so can the
repository's own files, and the same answer holds — the model cannot relax the
Safety section of the system prompt, and the gate still stops the command before
it runs.
