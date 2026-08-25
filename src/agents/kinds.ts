import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { AnyAgentMiddleware } from "langchain";

import { pinTurnTask, projectInstructions } from "../context";
import { injectMemory, type MemoryStore } from "../memory";
import { OUTPUT_BUDGET } from "../models";
import { globTool, grepTool, readTool, type SubagentSpec } from "../tools";
import { type RuleSet } from "../tools/permission";
import { permissionGate } from "./permissionGate";
import { readBeforeWrite } from "./readBeforeWrite";
import { staleReads } from "./staleReads";
import { usageMeter, type ModelUsage } from "../usage";
import { contextWindow, type WindowEvent, type WindowTuning } from "../context";

/**
 * Which kinds of agent this program runs, and what each one is fitted with.
 *
 * The policy half of `Task`. The tool itself (`src/tools/task.ts`) knows how to
 * run a subagent and nothing about what subagents are for; everything specific —
 * these tools, this prompt, this contract, what it is metered as, how its own
 * context window is managed — is here. Adding a kind is an entry in
 * {@link subagentSpecs}; adding a kind that may write is the same entry with a
 * different tool list, and no change to the tool at all.
 *
 * ## Why the main agent is in a file that used to be called `subagents.ts`
 *
 * Because a **kind** turned out to be the wider word. The main agent is also a
 * kind: it has an identity, it is metered, it manages its own window, it gets
 * the repository's instructions. Everything a kind needs comes from
 * {@link agentStack} here, and `src/agents/loop.ts` calls it exactly as
 * {@link subagentSpecs} does — the only difference between the two is what
 * `agent.ts` adds afterwards, which is the confirmation gate, and that gate is
 * the one thing a subagent may not have (docs/adr/0003).
 *
 * The alternative was a third file for the stack, and it was rejected on the
 * evidence: `deer-flow`'s equivalent shared builder
 * (`_build_runtime_middlewares`) lives inside
 * `agents/middlewares/tool_error_handling_middleware.py:155` — a shared
 * assembler homed in a file named after one unrelated middleware, because
 * nobody gave it a home. Widening this file's subject is giving it one.
 */

/** The three an Explore agent is given. Not writing anything is a property of this list. */
export const EXPLORE_TOOLS = [readTool, globTool, grepTool];

/**
 * The Explore agent's system prompt.
 *
 * Separate from `src/agents/prompt.ts` because the contract is different, not because
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

/**
 * Everything a kind of agent is built from that is not the kind itself.
 *
 * One interface for the main agent and for subagents, because there was never a
 * second thing here: what a kind needs is a model, the repository's
 * instructions, somewhere to report numbers, and somewhere to report events.
 * The two used to be separate types that differed only in which fields of the
 * window options they left reachable — which is not a difference, it is a drift.
 */
export interface AgentEnvironment {
  /** The model this kind runs on — the agent's own instance, shared. */
  model: BaseChatModel;
  /**
   * Builds a model instance with a chosen output ceiling.
   *
   * Exists because `maxTokens` is a constructor field rather than a call option
   * (`@langchain/openai/dist/chat_models/completions.js:60-61`), so a caller that
   * needs a different ceiling for one call needs a different instance.
   *
   * 🔑 **It is what stops the summariser inheriting the agent's ceiling by
   * accident.** That call is a raw `model.invoke` outside the graph, so no
   * middleware shapes it — before this field existed it simply used whatever
   * instance it was handed, and any output policy written as middleware would
   * have missed it in silence. Now it asks for its own budget, out loud.
   */
  modelFor: (maxTokens?: number) => BaseChatModel;
  /**
   * The most this program asks for on one answer, before the window clamps it.
   *
   * Absent means the registry's default. It is a *want*: `outputCeiling` in
   * `context/compaction` lowers it whenever the history leaves less room.
   */
  outputBudget?: number;
  /** The repository's instructions, already read and wrapped, when it has any. */
  instructions?: string;
  /** Where per-request token numbers go, labelled by the kind that spent them. */
  onUsage?: (usage: ModelUsage) => void;
  /** Where window events go, labelled the same way. */
  onWindow?: (event: WindowEvent) => void;
  /** Overrides for where this kind's context window is cut. Tests only. */
  window?: WindowTuning;
  /**
   * Cross-session memory, when the program was started with any.
   *
   * ⚠️ Only the main agent gets the memory tools — see `registeredTools`.
   * `EXPLORE_TOOLS` deliberately does not include them: an Explore is read-only,
   * single-shot, and stateless by design ("a dispatch is stateless" in
   * CONTEXT.md), so there is nothing for it to carry across sessions. That was
   * decided rather than overlooked (2026-08-17); the axis reopens the day a kind
   * of subagent exists that outlives one dispatch.
   */
  memory?: MemoryStore;
  /**
   * The permission rules, already read and merged, or absent for none. Shared by
   * every kind through `agentStack`, so a subagent's `Read` keeps the hard floor
   * and obeys the same deny rules.
   */
  rules?: RuleSet;
}

/**
 * The three middlewares every kind of agent gets, in the one order that is
 * correct.
 *
 * ## What this exists to stop
 *
 * The window and the meter were assembled twice, in two files, in an order held
 * only by a comment in each. Both ways of getting it wrong are silent:
 *
 * - **Wrong order** — the meter outside the window counts the whole history
 *   rather than the messages that were sent, and its `elapsedMs` swallows the
 *   summarising call. Nothing fails; the log just reports a request larger than
 *   the one that was made. This repository has already shipped that bug once.
 * - **A copied kind** — a second subagent pasted from the first keeps the first
 *   one's labels, and its spending is billed to a kind that never ran.
 *
 * Neither shows up as a failing test, which is why the order is now asserted
 * here at assembly time rather than only in `tests/kinds.test.ts`: a test runs
 * in CI, an assertion runs on every construction. The idea is taken from
 * `deer-flow`, whose chain has the same class of invariant and guards it the
 * same way (`assert_mcp_routing_before_deferred_filter`,
 * `agents/middlewares/mcp_routing_middleware.py:130`).
 *
 * ## What is deliberately not here
 *
 * The confirmation gate. It is the main agent's alone — a subagent cannot
 * `interrupt()` to ask, which is the whole reason it may not write
 * (docs/adr/0003) — so `agent.ts` appends it after this stack. Behind a flag it
 * would become a switch somebody can flip; outside the stack it stays a
 * property of who is being built. The gate belongs to the harness rather than to
 * context engineering, and it will move again when that line is worked.
 */
export function agentStack(
  identity: string,
  environment: AgentEnvironment,
): AnyAgentMiddleware[] {
  const { model, modelFor, outputBudget, instructions, memory, onUsage, onWindow, window, rules } =
    environment;

  const stack = [
    // Outside the meter, because it decides which messages are sent — and the
    // meter has to count the messages that were actually sent.
    contextWindow({
      // The factory, not the instance: the summarising call chooses its own
      // output ceiling rather than inheriting whatever this agent runs with.
      modelFor,
      outputBudget: outputBudget ?? OUTPUT_BUDGET,
      agent: identity,
      // Nothing to wire for pinning any more: a message that must survive a cut
      // now carries the mark itself, so the injector pins it at construction and
      // this assembler never hears about it. See `PINNED` in context/projection.
      ...window,
      ...(onWindow !== undefined ? { onEvent: onWindow } : {}),
      ...(onUsage !== undefined ? { onUsage } : {}),
    }),
    // Innermost, so `request.messages` here is exactly what goes on the wire and
    // `elapsedMs` is the provider's latency alone.
    // The model id is handed in rather than read off the response: the response
    // does not carry it (see the note in `usageMeter`), and this assembler is
    // the last place that still knows.
    usageMeter(identity, modelIdOf(model), onUsage ?? (() => {})),
    // Both are beforeAgent hooks, so their position among the others is not
    // load-bearing the way the two above are. Between themselves it does not
    // matter either: the instructions arrive pinned, so PinTurnTask skips them
    // whichever order they run in.
    ...(instructions !== undefined ? [projectInstructions(instructions)] : []),
    // A third beforeAgent hook, and it joins them for the same reason: it runs
    // once per turn, outside the loop, so five tool laps still inject once. It
    // arrives pinned, so PinTurnTask skips it whichever order they run in.
    //
    // ⚠️ Only the main agent has a store — see the note on `AgentEnvironment.memory`.
    // An Explore is stateless by design, so there is nothing to inject and this
    // slot is empty for it. That is decided, not incidental.
    ...(memory !== undefined ? [injectMemory(memory, identity, onWindow)] : []),
    pinTurnTask(),
    // The deny half of the permission gate. Unlike the confirmation gate (the
    // ask half, appended in `loop.ts`), this belongs to every kind: a subagent
    // cannot `interrupt()` to ask, but it can be denied, and denying needs no
    // checkpointer. Shared so an Explore's `Read` keeps the hard floor.
    permissionGate(rules),
    // A second gate, and the first one on the quality axis rather than the
    // permission axis: a write to an existing file needs a read of its current
    // version. Shared by every kind for the same reason the deny half is —
    // `wrapToolCall` needs no checkpointer, so a subagent is covered too. An
    // Explore has no Write/Edit, which makes this a no-op for it; that is not a
    // special case and must not become one (a second way to name a kind).
    readBeforeWrite(),
    // The sensor half of the same idea. The gate above refuses an edit built on
    // a stale read; this one says so when a command changed a file out from
    // under the model — the path with no tool call left to gate. It reports, it
    // never blocks, and its notice is a hint, so it leaves the history untouched.
    staleReads(),
  ];

  assertMeterInsideWindow(stack);
  return stack;
}

/**
 * Refuses to hand back a stack whose scale would lie.
 *
 * By middleware name rather than by identity, because the names are what
 * langchain itself carries (`createMiddleware({ name })`) and comparing
 * instances would only prove that this function returned what it just built.
 * Throwing rather than logging: a scale reporting the wrong number is worse than
 * no scale, so there is nothing to degrade to.
 *
 * Exported so it can be handed a deliberately wrong stack. Called only from
 * {@link agentStack}, which builds the order it then checks — so from the
 * outside the check can never fire, and an assertion nobody can trigger is an
 * assertion nobody has shown to work. It guards the *next* edit to that array,
 * and this is how we know it still would.
 */
/**
 * The model's own id, for labelling what it spent.
 *
 * Read off the instance rather than plumbed through `AgentEnvironment`, because
 * it is the same fact by a shorter route: `createChatModel` is handed the id and
 * `ChatOpenAI` keeps it on `.model`. A model that does not expose one is labelled
 * so — an unattributed bucket is honest, a wrong label is not.
 */
function modelIdOf(model: BaseChatModel): string {
  const named = (model as { model?: unknown }).model;
  return typeof named === "string" && named !== "" ? named : "unknown";
}

export function assertMeterInsideWindow(stack: AnyAgentMiddleware[]): void {
  const at = (name: string) =>
    stack.findIndex((middleware) => middleware.name === name);
  const window = at("ContextWindow");
  const meter = at("UsageMeter");
  if (window === -1 || meter === -1 || window < meter) return;
  throw new Error(
    `the usage meter must be installed inside the context window, or it counts the history instead of the request (ContextWindow at ${String(window)}, UsageMeter at ${String(meter)})`,
  );
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
export function subagentSpecs(environment: AgentEnvironment): SubagentSpec[] {
  // One literal, used three times: it is the type the model types, the name the
  // nested graph runs under, and the identity everything in the stack is
  // labelled with. Written once because a kind has one name — an Explore agent
  // billed as something other than what the model dispatched would be a log
  // nobody can join back up.
  const explore = "explore";

  return [
    {
      name: explore,
      description:
        "Read-only investigator for a question that needs hunting. Tools: Read, Glob, Grep. It cannot change files or run commands. Use it when finding the answer will take several searches and you only need the conclusion.",
      prompt: EXPLORE_PROMPT,
      tools: EXPLORE_TOOLS,
      // Everything a kind needs rides in as middleware rather than as parameters
      // of the task tool, and that is what keeps the tool free of any knowledge
      // about this program: a kind is metered, and manages its own window,
      // because its spec says so.
      //
      // An Explore agent has a context window of its own, and it is the one
      // agent here that can fill it in a single lap: nothing stops a model
      // asking for twenty Reads at once, and each of those is up to
      // MAX_FILE_BYTES. The alternative to summarising is the dispatch failing
      // outright and its work being thrown away — the parent would get an error
      // where it expected a report.
      middleware: agentStack(explore, environment),
    },
  ];
}
