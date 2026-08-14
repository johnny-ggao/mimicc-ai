import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import { projectInstructions } from "./instructions";
import { globTool, grepTool, readTool, type SubagentSpec } from "./tools";
import { usageMeter, type ModelUsage } from "./usage";
import { contextWindow, type ContextWindowOptions } from "./window";

/**
 * Which kinds of subagent this program can dispatch, and what each one may do.
 *
 * The policy half of `Task`. The tool itself (`src/tools/task.ts`) knows how to
 * run a subagent and nothing about what subagents are for; everything specific —
 * these tools, this prompt, this contract, what it is metered as, how its own
 * context window is managed — is here. Adding a kind is an entry in
 * {@link subagentSpecs}; adding a kind that may write is the same entry with a
 * different tool list, and no change to the tool at all.
 */

/** The three an Explore agent is given. Not writing anything is a property of this list. */
export const EXPLORE_TOOLS = [readTool, globTool, grepTool];

/**
 * The Explore agent's system prompt.
 *
 * Separate from `src/prompt.ts` because the contract is different, not because
 * the wording is. An Explore agent is single-shot: nobody will ask it a follow-up, and
 * its working notes are discarded, so anything it does not put in the report is
 * lost. That is why the output rules read as hard constraints — they are the
 * only channel it has.
 *
 * The word "Explore" appearing here is load-bearing for the tests, which tell a
 * subagent's request from its parent's by the system message.
 */
export const EXPLORE_PROMPT = `You are an Explore agent: a read-only subagent dispatched by mimicc to investigate one question inside the user's repository.

You have three tools: Read, Glob, Grep. You cannot change files, run commands, or dispatch subagents of your own. Do not offer to.

Your working notes are discarded. Only your final message is returned, and whoever reads it cannot see anything you looked at. Anything you leave out is lost.

Report like this:

- Answer the question you were given, first, in one or two sentences.
- Cite every claim as \`path/to/file.ts:42\`. A claim without a location is not usable.
- Say what you could not establish, plainly. "No AGENTS.md in the repository root" is a finding; silence is not.
- Do not narrate your search. Which patterns you tried, which files turned out to be irrelevant, and how many matches you scanned are all noise to the reader.
- Stay under thirty lines. Quote code only when the exact bytes matter.

Write the report in the language of the task you were given.`;

export interface SubagentEnvironment {
  /** The model subagents run on — the agent's own instance. */
  model: BaseChatModel;
  /** The repository's instructions, already read and wrapped, when it has any. */
  instructions?: string;
  /** Where per-request token numbers go, labelled by the kind that spent them. */
  onUsage?: (usage: ModelUsage) => void;
  /** Overrides for where a subagent's own context window is cut. Tests only. */
  window?: Omit<ContextWindowOptions, "model" | "onEvent" | "onUsage" | "usageAgent">;
}

/**
 * The kinds, ready to register.
 *
 * A function rather than a constant because everything it needs is resolved at
 * startup and handed in — the same reason `AgentOptions` takes the instruction
 * text rather than a path. Subagents get those instructions for the same reason
 * the agent does: they are binding on anyone working in this repository, and an
 * Explore agent that does not know the conventions reports against the wrong ones.
 *
 * Why an Explore agent is read-only, written down because it is a decision and not a
 * limitation: `interrupt()` does work inside a nested run, but it needs a
 * checkpointer in the ambient config (langgraph/interrupt.js:54) *and* a resume
 * path — and a tool body is not resumable, so the parent re-runs the whole call
 * on resume. Without that plumbing a subagent cannot ask for confirmation, and a
 * subagent that cannot ask must not be able to do anything worth asking about.
 * Two further reasons stand on their own: its writes would bypass the
 * confirmation gate entirely, which lives in the parent's middleware; and
 * parallel writes would serialise against `withPathLock` anyway, so the
 * concurrency that motivates dispatching several at once would be gone.
 */
export function subagentSpecs(environment: SubagentEnvironment): SubagentSpec[] {
  const { model, instructions, onUsage, window } = environment;

  return [
    {
      name: "explore",
      description:
        "Read-only investigator for a question that needs hunting. Tools: Read, Glob, Grep. It cannot change files or run commands. Use it when finding the answer will take several searches and you only need the conclusion.",
      prompt: EXPLORE_PROMPT,
      tools: EXPLORE_TOOLS,
      // Everything a kind needs rides in as middleware rather than as parameters
      // of the task tool, and that is what keeps the tool free of any knowledge
      // about this program: a kind is metered, and manages its own window,
      // because its spec says so.
      middleware: [
        // An Explore agent has a context window of its own, and it is the one agent here
        // that can fill it in a single lap: nothing stops a model asking for
        // twenty Reads at once, and each of those is up to MAX_FILE_BYTES. The
        // alternative to summarising is the dispatch failing outright and its
        // work being thrown away — the parent would get an error where it
        // expected a report.
        contextWindow({
          model,
          ...window,
          usageAgent: "explore summary",
          ...(onUsage !== undefined ? { onUsage } : {}),
        }),
        // Innermost, for the reason the agent's own meter is: it has to count
        // the messages that were sent, which is what the middleware above
        // decides.
        usageMeter("explore", onUsage ?? (() => {})),
        ...(instructions !== undefined ? [projectInstructions(instructions)] : []),
      ],
    },
  ];
}
