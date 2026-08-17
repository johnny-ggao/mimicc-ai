import { ContextOverflowError } from "@langchain/core/errors";
import type { ClientTool } from "@langchain/core/tools";
import { SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { MemorySaver } from "@langchain/langgraph";
import type { BaseCheckpointSaver, Command } from "@langchain/langgraph";
import {
  createAgent,
  humanInTheLoopMiddleware,
  type AnyAgentMiddleware,
  type InterruptOnConfig,
} from "langchain";

import { agentStack, subagentSpecs, type AgentEnvironment } from "./kinds";
import { toolRecovery } from "./recovery";
import { createTaskTool, TASK_TOOL_NAME, TOOLS } from "../tools";
import type { ModelUsage } from "../usage";
import { markPinned, type WindowEvent, type WindowTuning } from "../context";

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

/**
 * When a checkpoint has to be **on disk** rather than merely handed to the saver.
 *
 * LangGraph queues its checkpoint writes and does not await them: `_putCheckpoint`
 * calls `_checkpointerPutAfterPrevious(...)` and drops the promise into a Set
 * (`pregel/loop.js:814`, `:164-172`). The `await` you see on `_putCheckpoint`
 * awaits the *function*, not the write. The only barrier during a run is
 * `pregel/loop.js:475` — `if (this.durability === "sync") await
 * this._awaitCheckpointerPromises()` — and it sits between `_putCheckpoint`
 * (`:474`) and `_prepareNextTasks` (`:487`).
 *
 * That position is the whole point. The model node's writes include one `Send`
 * per tool call, each carrying `lg_tool_call` — the tool name and its arguments —
 * into the `__pregel_tasks` channel, which is checkpointed like any other
 * (`pregel/index.js:291`, `channels/topic.js:78-81`). So the sentence "I am about
 * to run these N tools with these arguments" is already in the checkpoint; `sync`
 * is what makes it *durable before the tools start*.
 *
 * Measured, not assumed (`repro/13-crash-mid-tool.ts`): SIGKILL on the tool's
 * first line, then reopen the same thread. Under the default `"async"` the
 * pending calls are gone and the restart is not a resume at all — it replays the
 * whole batch from an earlier checkpoint, which shows up as *different task ids*
 * (they are uuid5, so a real resume reproduces them exactly). Under `"sync"` the
 * calls are on disk and the ids match.
 *
 * The cost is one disk wait per superstep boundary. Measured on this saver it is
 * inside the noise — 2.5ms vs 2.3ms for a six-lap turn, unchanged when the state
 * is padded to 200KB — because the write is a local append and any real model
 * call is three orders of magnitude slower.
 *
 * ⚠️ Never express this as `checkpointDuring: false`. That is the old spelling and
 * it maps silently to `durability: "exit"` (`pregel/index.js:886-889`), which
 * writes *nothing* during the run and flushes at the end — a kill then loses the
 * entire turn. Passing both throws.
 */
export const DURABILITY = "sync" as const;

/**
 * The main agent's identity: what its requests are billed under, what its window
 * events are attributed to, and — via `${identity} summary` — what its
 * summarising calls are called.
 *
 * A constant rather than a literal at the call site for the same reason the
 * Explore kind names itself once: one agent, one name. Note that its summary is
 * now `"main summary"` and not the bare `"summary"` it used to be, which is the
 * cost of the labels being derived instead of written — and the point, because
 * the exception was where a second kind's summary would have gone to hide.
 */
export const MAIN_AGENT = "main";

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
   * The repository's own instructions (AGENTS.md / CLAUDE.md), already read and
   * wrapped, or undefined when the repository has none.
   *
   * A string rather than a path, because the reading is somebody else's job:
   * `main.ts` calls `readProjectInstructions`, exactly as it calls
   * `describeEnvironment` for the system prompt. That keeps the filesystem out
   * of the agent builder, and it is also the seam that makes the current
   * read-once-at-startup behaviour temporary — making instructions live means
   * changing what main.ts passes, not this.
   */
  projectInstructions?: string;
  /**
   * Where threads are persisted.
   *
   * Optional, and the default is deliberately the in-process saver: most tests
   * only care about the loop, and making them all name a directory would be
   * noise. `main.ts` always passes a real one — a history that dies with the
   * process is not a history.
   */
  checkpointer?: BaseCheckpointSaver;
  /**
   * Where thread files live, so tool calls can be journalled beside them.
   *
   * Absent means no journalling, and that is the honest default rather than a
   * missing feature: without a directory there is no durable thread either, so
   * there would be nothing for a recovered call to be recovered *into*. `main.ts`
   * passes the same path it hands the saver.
   */
  stateDir?: string;
  /**
   * Told whenever the context window is recomputed.
   *
   * Optional in the same way `onUsage` is: the loop runs without a listener, but
   * a summary silently changing what the model can see is exactly the kind of
   * thing that should not be invisible, so main.ts always passes one.
   */
  onWindow?: (event: WindowEvent) => void;
  /**
   * Overrides for where the context window is cut.
   *
   * The defaults are the measured ones and nothing in the program changes them.
   * They are reachable only so a test can trigger a summary without first
   * producing eight hundred thousand tokens — which is the difference between
   * this behaviour being tested and being asserted about.
   *
   * `WindowTuning` is the same type the subagent kinds take. It used to be a
   * wider Omit here, leaving the summary's billing label reachable from the
   * caller — a second way to name an agent, which is a second way to name it
   * wrong.
   */
  window?: WindowTuning;
  /**
   * Where per-request token and cache numbers go. Optional because the loop runs
   * fine without a scale — but every context-engineering change is judged on
   * these numbers, so main.ts always passes one.
   */
  onUsage?: (usage: ModelUsage) => void;
}

/**
 * All the console needs from the loop: hand it messages, get a stream back.
 *
 * Stated outright rather than derived as `ReturnType<typeof
 * createUniversalAgent>`. That alias would drag langchain's whole compiled graph
 * type into the console's signature, so every change to what middleware is
 * installed would ripple into repl.ts — which uses exactly one method. Naming the
 * surface the caller actually uses is what keeps that seam a seam.
 *
 * The payload stays `unknown`: the tuple shape depends on streamMode, and repl.ts
 * is the one place that asserts it.
 */
export interface AgentGraph {
  stream(
    input: { messages: BaseMessage[] } | Command,
    options: {
      streamMode: ["messages", "values"];
      recursionLimit: number;
      /**
       * Required, not optional, and that is the point: it is a per-call option
       * with a default (`"async"`) that silently gives up crash durability, so a
       * new call site that forgets it would be wrong in a way nothing observes
       * until a process actually dies. Making the type demand it moves that from
       * "a test might catch it" to "it does not compile". See {@link DURABILITY}.
       */
      durability: typeof DURABILITY;
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
    // Retrying a request that was refused for being too long is retrying a
    // request that cannot succeed: the bytes do not change between attempts.
    // The default is six retries, and it applies here — measured: one oversized
    // call hit the server **seven times** before the error came back. Near the
    // window limit that is seven near-full-window requests, all billed, for one
    // failure. Stopping on this one error costs nothing, because every other
    // failure still retries normally.
    //
    // The contract is "throw to stop retrying, return to keep going", so this
    // singles out the one error and leaves every other failure — timeouts, rate
    // limits, provider hiccups — retrying exactly as before.
    onFailedAttempt: (error: unknown) => {
      if (ContextOverflowError.isInstance(error)) throw error;
    },
  });
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
  // An explore agent carries only the three read-only tools, so dispatching one can do
  // nothing a Read could not — the decision is already made by EXPLORE_TOOLS.
  [TASK_TOOL_NAME]: false,
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
  const gate = humanInTheLoopMiddleware(
    options as unknown as Parameters<typeof humanInTheLoopMiddleware>[0],
  ) as AnyAgentMiddleware;

  return pinRejections(gate);
}

/**
 * Pins the tool results the gate makes out of a rejection.
 *
 * When you reject a command, what you typed comes back to the model as a
 * `ToolMessage` — langchain builds it at `agents/middleware/hitl.js:399` and
 * returns it in the `afterModel` state update (`:501`). That message is an
 * operator-level instruction wearing a tool result's clothes: "don't delete
 * things on this machine" is binding, and if a summary eats it the model will
 * retry the command you just refused.
 *
 * ⚠️ **This is the one exception to "whoever produces a message pins it"**
 * (see `markPinned`). We do not build that message and there is no constructor
 * to reach, so it is pinned here, on the way past. Wrapping this middleware
 * rather than installing another one after it is what makes that deterministic:
 * whether a later `afterModel` hook can see an earlier one's update is a
 * question about langchain's chaining, and this does not need to ask it.
 *
 * Every `ToolMessage` in that update is a rejection — `hitl.js:492-493` only
 * pushes one when the decision was `reject` — so there is nothing to filter.
 */
function pinRejections(gate: AnyAgentMiddleware): AnyAgentMiddleware {
  const slot = (gate as { afterModel?: unknown }).afterModel;
  const hook = typeof slot === "function" ? slot : (slot as { hook?: unknown })?.hook;
  if (typeof hook !== "function") return gate;

  const wrapped = async (...args: unknown[]): Promise<unknown> => {
    const update = (await (hook as (...a: unknown[]) => Promise<unknown>)(...args)) as
      { messages?: unknown } | undefined;
    const messages = update?.messages;
    if (Array.isArray(messages)) {
      for (const message of messages) {
        if (ToolMessage.isInstance(message)) markPinned(message);
      }
    }
    return update;
  };

  if (typeof slot === "function") {
    return { ...gate, afterModel: wrapped } as AnyAgentMiddleware;
  }
  return {
    ...gate,
    afterModel: { ...(slot as object), hook: wrapped },
  } as AnyAgentMiddleware;
}

/**
 * Every tool this program registers: the six plus the one that dispatches an
 * explore agent.
 *
 * **Exported so the test that guards the confirmation gate can cross the same
 * seam the program does.** That test asserts every registered tool has an
 * explicit decision in {@link CONFIRMATION_POLICY}, and it used to compare
 * against a list copied by hand — `[...TOOLS.map(n), TASK_TOOL_NAME]`. Two
 * expressions computing what should be one set, and the gate is fail-open, so a
 * tool the copy forgot would run unconfirmed with nothing to say so. The `Task`
 * tool is the proof the case is not hypothetical: it is assembled here rather
 * than living in `TOOLS` because it needs a model, and a second tool built that
 * way would slip through the same gap.
 *
 * The task tool is built here rather than living in `src/tools/` alongside the
 * others because it needs the model, and a tool module that imported the agent
 * to get one would close the cycle `agent -> tools -> explore agent -> agent`. It goes
 * last so the six the prompt describes keep their pinned order, and with them
 * the cached prefix.
 *
 * The return type is annotated rather than inferred, and that is not cosmetic.
 * `tool()` has two overload families — one for a plain function, one for a
 * function taking a `runtime` — and they return different type arguments for the
 * tool's event type: inferred from the function in the first
 * (`InferToolOutputFromFunc`), fixed to `ToolEventType` in the second
 * (@langchain/core/dist/tools/index.d.ts:219-228). Each family alone infers
 * fine; **mixed in one array**, `createAgent`'s tool inference falls through to
 * its last overload, which demands `responseFormat` — measured, both ways round.
 * Naming the element type sidesteps the inference instead of casting past it.
 */
export function registeredTools(environment: AgentEnvironment): ClientTool[] {
  return [
    ...TOOLS,
    createTaskTool({ model: environment.model, subagents: subagentSpecs(environment) }),
  ];
}

/**
 * The options this program was started with, in the shape a kind is built from.
 *
 * Every kind is fitted from the same environment — the main agent and every
 * subagent read the same instructions, spend into the same log, and report
 * events to the same listener. What differs between them is the identity they
 * are given, and nothing else, which is what makes a per-kind column in the log
 * meaningful.
 *
 * The conditional spreads are the `exactOptionalPropertyTypes` tax: `onUsage:
 * undefined` is not the same as an absent `onUsage` under that flag.
 */
function environment(model: ChatOpenAI, options: AgentOptions): AgentEnvironment {
  return {
    model,
    ...(options.projectInstructions !== undefined
      ? { instructions: options.projectInstructions }
      : {}),
    ...(options.onUsage !== undefined ? { onUsage: options.onUsage } : {}),
    ...(options.onWindow !== undefined ? { onWindow: options.onWindow } : {}),
    ...(options.window !== undefined ? { window: options.window } : {}),
  };
}

/**
 * The loop.
 *
 * `createAgent` is `new ReactAgent(...)`, which builds a StateGraph over two
 * nodes joined by a back edge — the loop itself is not what it adds. What it adds
 * is four middleware slots (beforeAgent / beforeModel / afterModel / afterAgent)
 * plus `wrapModelCall` and `wrapToolCall`, and the routing between them. All
 * three middlewares below hang off one of those slots, which is why this
 * repository once kept the same loop drawn by hand as a control and no longer
 * does — see docs/the-hand-drawn-loop.md.
 *
 * The checkpointer is not optional and not a feature request. `interrupt()` —
 * which is how the gate asks — throws `GraphValueError: No checkpointer set`
 * without one, because pausing mid-run means the run has to be persisted to be
 * resumed. It also means every call needs `configurable.thread_id`.
 *
 * Which saver is the caller's business — and that is the whole point of the
 * seam. The in-process default dies with the process; `main.ts` hands in the
 * JSONL one, so a thread outlives the terminal. Nothing else about the loop
 * changes, which is what "durable history is a different saver, not a different
 * design" was always claiming and now demonstrates.
 */
export function createUniversalAgent(options: AgentOptions) {
  // Built once and shared: the same model answers turns and writes summaries.
  // A summary decides what every later turn can see, which is a poor place to
  // economise, and this is a single-model program besides.
  const model = createModel(options);

  // The main agent is a kind like any other, so its window, its meter and its
  // instructions come from the same assembler every subagent uses — including
  // the order between the first two, which `agentStack` asserts rather than
  // leaving to whoever edits this next.
  //
  // The gate is appended here rather than being part of that stack because it is
  // the one thing a subagent must not have: a subagent cannot `interrupt()` to
  // ask, and a kind that cannot ask must not be able to do anything worth asking
  // about (docs/adr/0003). Outside the stack that stays a fact about who is being
  // built; inside it, behind a flag, it would be a switch.
  //
  // Annotated rather than inferred, and for the same reason `registeredTools` is:
  // handed to `createAgent` as a bare spread expression, its inference falls
  // through to the last overload and demands `responseFormat` (measured — the
  // identical error, from the middleware side this time). Naming the element type
  // sidesteps the inference; a cast would only silence it.
  // Built once and handed to both. It used to be computed twice — once for the
  // tools, once for the middleware — which was harmless only because it is pure.
  const env = environment(model, options);

  const middleware: AnyAgentMiddleware[] = [
    ...agentStack(MAIN_AGENT, env),
    confirmationGate(),
    // Appended here for the same reason the gate is: it is the main agent's
    // alone. A subagent has `checkpointer: false`, so there is no thread for a
    // journal to sit beside — see the note in tools/task.ts.
    ...(options.stateDir !== undefined
      ? [toolRecovery({ directory: options.stateDir })]
      : []),
  ];

  return createAgent({
    model,
    tools: registeredTools(env),
    // Wrapped, not handed over as a string, and the difference is on the wire.
    // `normalizeSystemPrompt` returns a SystemMessage untouched but converts a
    // string into `new SystemMessage({ content: [{ type: "text", text }] })` —
    // which serialises as `content: [{...}]` instead of `content: "..."`
    // (measured; @langchain/openai/dist/converters/completions.js:464).
    //
    // Both reach the model, but only one of them is the shape this prompt was
    // designed against. src/agents/prompt.ts splits static from per-session text so that
    // DeepSeek's longest-common-prefix cache keeps hitting; changing the
    // serialisation changes the prefix and resets that cache once for no gain.
    // The block form buys multimodal and per-block cache markers, neither of
    // which this agent uses.
    ...(options.systemPrompt !== undefined
      ? { systemPrompt: new SystemMessage(options.systemPrompt) }
      : {}),
    checkpointer: options.checkpointer ?? new MemorySaver(),
    middleware,
  });
}
