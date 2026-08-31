import { ContextOverflowError } from "@langchain/core/errors";
import type { ClientTool } from "@langchain/core/tools";
import { SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatOpenAI } from "@langchain/openai";
import { MemorySaver } from "@langchain/langgraph";
import type { BaseCheckpointSaver, Command } from "@langchain/langgraph";
import {
  createAgent,
  humanInTheLoopMiddleware,
  type AnyAgentMiddleware,
  type InterruptOnConfig,
} from "langchain";

import {
  agentStack,
  assertDispatchNeverEscalates,
  subagentSpecs,
  type AgentEnvironment,
} from "./kinds";
import { assertBlocksInFrequencyOrder } from "./blockOrder";
import { createChatModel } from "./model";
import { toolRecovery } from "./recovery";
import { createMemoryTools, MemoryStore, type MemoryDirs } from "../memory";
import {
  createSkillTool,
  injectSkillCatalog,
  pinSkillLoads,
  SKILL_TOOL_NAME,
  type SkillRegistry,
} from "../skills";
import {
  CLARIFY_TOOL_NAME,
  TASK_TOOL_NAME,
  TOOLS,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  clarifyGate,
  clarifyTool,
  createTaskTool,
  createWebSearchTool,
  type SearchBackend,
} from "../tools";
import { decide, toolCallOf, type RuleSet } from "../tools/permission";
import type { ModelUsage } from "../usage";
import {
  markPinned,
  WINDOW_LIMIT,
  type WindowEvent,
  type WindowTuning,
} from "../context";
import { classify, failureMarker } from "./outcome";
import { loopGuard, type TurnCapReason } from "./loopguard";
import { turnBudget } from "./turnBudget";
import { stallGuard } from "./stallguard";
import { emptyReplyGuard } from "./terminal";

/**
 * The graph's recursion ceiling.
 *
 * A format placeholder, not a budget: LangGraph requires a finite integer
 * ≥ 1 (`pregel/index.js:1010` throws otherwise), so the number exists to
 * satisfy the library. The real guards are the turn budget on the token/time
 * axis (`turnBudget`, window × 4 per turn with a 10-minute wall-clock backstop),
 * the pathology guards (`loopGuard` on repeated calls, `stallGuard` on
 * consecutive failures), and the deployment's wall clock. None of the peers
 * budget steps — pi's drive loop is `while (true)`, deepseek-harness runs until
 * the model completes or hits max-tokens, deer-flow keeps one clamped ceiling
 * as a crash net — and a step budget misclassifies a healthy-busy turn as
 * broken: csv-to-parquet burned 17, then 25 honest tool-call laps on one hard
 * task and got cut mid-fix three times (48 → 102 → 150 nodes).
 * `.scratch/external-bench/issues/03-csv-budget.md` and
 * `.scratch/turn-budget/issues/01-what-axis.md` record the decision.
 *
 * A graph that reaches this number is neither busy nor broken — it is a
 * runaway, and the number is chosen so nothing healthy can ever touch it.
 */
export const RECURSION_LIMIT = 1_000_000;

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
 * first line, then reopen the same session. Under the default `"async"` the
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
   * The most this program asks for on one answer, before the window clamps it.
   *
   * Distinct from {@link maxTokens}, which is the ceiling the model instance is
   * *built* with. This one is a want that `outputCeiling` lowers per request as
   * the history fills up (`src/context/compaction.ts`).
   */
  outputBudget?: number;
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
   * Where sessions are persisted.
   *
   * Optional, and the default is deliberately the in-process saver: most tests
   * only care about the loop, and making them all name a directory would be
   * noise. `main.ts` always passes a real one — a history that dies with the
   * process is not a history.
   */
  checkpointer?: BaseCheckpointSaver;
  /**
   * Where cross-session memory lives, or absent to run without any.
   *
   * The two directories rather than a store, for the same reason `stateDir` is a
   * path and `projectInstructions` is a string: `main.ts` decides where things
   * live, and the agent builder does not touch the filesystem.
   *
   * ⚠️ This is **not** the general tool-injection seam that was declined on
   * 2026-08-17. That request was for letting arbitrary tools be passed in for
   * tests; this is a named capability with a named dependency, exactly like
   * `checkpointer` and `stateDir` above it. The distinction matters because the
   * reason for declining — "the gap it was for closed, so do not open it" —
   * does not reach a capability the program actually ships.
   */
  memory?: MemoryDirs;
  /**
   * The live web-search backend, or absent to run without the WebSearch tool.
   *
   * A resolved backend rather than a key and a name, for the same reason
   * `skills` is a registry and `projectInstructions` is a string: `main.ts`
   * resolves configuration, the agent builder does not. Like `memory` above,
   * this is a **named capability with a named dependency**, not the general
   * tool-injection seam declined on 2026-08-17.
   */
  webSearch?: SearchBackend;
  /**
   * The skills installed outside the repository, already read and indexed, or
   * absent to run without any.
   *
   * A registry rather than the paths, for the same reason `projectInstructions`
   * is a string and `memory` is two directories: `main.ts` does the filesystem
   * read, and the agent builder does not. Skills are a **main-agent-only**
   * capability — the catalogue and the `Skill` tool are added here rather than
   * in `agentStack`, so an Explore subagent never carries them.
   */
  skills?: SkillRegistry;
  /**
   * Where session files live, so tool calls can be journalled beside them.
   *
   * Absent means no journalling, and that is the honest default rather than a
   * missing feature: without a directory there is no durable session either, so
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
   * Told when requirement filtering dropped skills: each entry names the skill
   * and the tools it declared but this run does not register. Optional like the
   * listeners above, and for the same reason main.ts always passes one — a
   * capability that silently vanished reads as one that never existed.
   */
  onSkillsUnavailable?: (dropped: { name: string; missing: string[] }[]) => void;
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
   * Turn-budget overrides for the token/time axis (see `turnBudget`).
   *
   * Defaults when absent: token budget = the effective window limit × 4,
   * wall-clock backstop = 10 minutes per turn. Both are reachable from
   * main.ts via `MIMICC_TURN_TOKEN_BUDGET_MULTIPLIER` and
   * `MIMICC_TURN_TIME_BUDGET_MS`; the fields exist here rather than raw env
   * because the loop is built from options, not from the environment
   * (turn-budget ticket 02).
   */
  turnBudget?: {
    /** Multiplier over the window limit. Default 4. */
    tokenMultiplier?: number;
    /** Wall-clock budget per turn, milliseconds. Default 600_000. */
    timeBudgetMs?: number;
  };
  /**
   * Where per-request token and cache numbers go. Optional because the loop runs
   * fine without a scale — but every context-engineering change is judged on
   * these numbers, so main.ts always passes one.
   */
  onUsage?: (usage: ModelUsage) => void;
  /**
   * Told when a turn ends capped rather than clean (forced by the loop guard).
   *
   * Structured and separate from `onUsage`/`onWindow` because it is a turn
   * outcome, not a request: a capped turn is neither a failure nor a clean
   * success, and that third state is the whole point (see ticket 17 and
   * ADR 0005). main.ts logs it as `turn_capped`.
   */
  onCap?: (reason: TurnCapReason) => void;
  /**
   * The permission rules, already read and merged, or absent for no rules.
   *
   * A `RuleSet` rather than two file paths, for the same reason
   * `projectInstructions` is a string and `memory` is directories: `main.ts` does
   * the filesystem read (`loadPermissions`), and the agent builder does not.
   */
  rules?: RuleSet;
  /**
   * Auto mode: flip the baseline's ask to allow, so the mutating tools stop
   * asking. Only the "ask or not" axis moves — the hard floor and deny rules
   * still hold (see `decide` in tools/permission.ts).
   */
  auto?: boolean;
  /**
   * 不注册的工具名（`--exclude-tools`）。
   *
   * ⚠️ **它有两个落点，缺一处就是留下一段谎话**：这里（不注册工具、连带摘掉它的
   * 中间件）和系统提示词（`prompt.ts` 的 `staticPromptFor`）。提示词逐字教了每个
   * 工具怎么用，只在这里拿掉，模型会照着提示词去调一个不存在的工具。
   */
  excludeTools?: readonly string[];
}

/**
 * All the console needs from the loop: hand it messages, get a stream back —
 * and, since it learned to carry on from a session it did not start, ask what is
 * parked on a thread.
 *
 * Stated outright rather than derived as `ReturnType<typeof
 * createUniversalAgent>`. That alias would drag langchain's whole compiled graph
 * type into the console's signature, so every change to what middleware is
 * installed would ripple into repl.ts — which uses two of them. Naming the
 * surface the caller actually uses is what keeps that seam a seam.
 *
 * The payload stays `unknown`: the tuple shape depends on streamMode, and repl.ts
 * is the one place that asserts it.
 *
 * ⚠️ **`repro/15-typing-during-a-turn.ts` implements this interface by hand**, and
 * `repro/` is outside `tsconfig.json` by an explicit decision (`repro/README.md`).
 * So adding a method here breaks that probe **and nothing reports it** — measured
 * on 2026-08-19, when `getState` was added and `bun run check` stayed green while
 * the probe threw on its first line. Change this signature, re-run that probe.
 */
export interface AgentGraph {
  stream(
    /**
     * `null` means "carry on with what is already parked", and it is the only
     * input that does: measured (`repro/14`, `repro/23`), **any** non-null input
     * starts a new run from START instead of finishing the batch of tool calls
     * the graph is sitting on. That is what a session adopted after a crash
     * needs — the calls are on disk with their intents, and resuming closes them
     * without repeating a side effect that already happened.
     */
    input: { messages: BaseMessage[] } | Command | null,
    options: {
      /**
       * `custom` carries the tick a running command emits (`COMMAND_TICK_EVENT`).
       * Pinned in the tuple like the other two rather than left optional: a
       * caller that forgets it gets a console with nothing to say between "the
       * model asked for Bash" and however many minutes later the result lands,
       * and that silence is indistinguishable from a hang.
       */
      streamMode: ["messages", "values", "custom"];
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
  /**
   * What is parked on this thread right now.
   *
   * On the console rather than on the session repository, and that placement was
   * decided rather than fallen into: a confirmation gate that was open when the
   * process died is a **pending write on the newest checkpoint**, and the thing
   * that knows how to read one is the runtime. A directory lister can guess at it
   * from the file — and does, for the list's ⚠️ column — but the console is about
   * to *act* on the answer, so it asks the graph.
   *
   * Narrow for the same reason `stream` is: the console reads exactly two things
   * out of a snapshot — how long the branch is, which is the render watermark,
   * and whatever interrupt is still waiting.
   */
  getState(config: { configurable: { thread_id: string } }): Promise<{
    values: { messages?: BaseMessage[] };
    tasks?: readonly { interrupts?: readonly { value?: unknown }[] }[];
    /**
     * Which nodes the graph would run next, empty when it has finished.
     *
     * Read alongside `tasks` because the two answer different questions and the
     * console needs both: a session parked **at a gate** shows an interrupt,
     * while one parked **mid-batch** — the process died after the calls were
     * approved and started — shows `next: ["tools"]` with no interrupt at all
     * (measured, `repro/23`). Looking only at interrupts is how that batch used
     * to be dropped without a word.
     */
    next?: readonly string[];
  }>;
}

/**
 * Builds model instances that differ only in their output ceiling.
 *
 * ## Why a factory and not one instance
 *
 * `maxTokens` is a **constructor field**, not a call option:
 * `@langchain/openai/dist/chat_models/completions.js:60-61` reads
 * `this.maxTokens`, and this version's `ChatOpenAI` has no `.bind` at all
 * (measured — `repro/34-can-a-middleware-change-max-tokens.ts` calls it and gets
 * *request.model.bind is not a function*). So anything that wants a different
 * ceiling for one call needs a different instance; there is no other lever.
 *
 * **Not cached, and that was measured rather than assumed.** Constructing one
 * costs **6 µs** and its `client` is `undefined` until first use — the OpenAI
 * SDK client is built lazily, so a fresh instance does not mean a fresh
 * connection pool. Against a network round-trip that is nothing.
 *
 * ⚠️ A `Map` keyed by ceiling stood here first. It is worse than useless once
 * the ceiling is computed per request rather than chosen from a short list: the
 * key space becomes continuous and the map grows one entry per distinct ceiling,
 * for the life of the process, to save 6 µs.
 *
 * ⚠️ **Instances from here must never have tools bound.** `AgentNode` calls
 * `validateLLMHasNoBoundTools(request.model)` before binding its own
 * (`langchain/dist/agents/nodes/AgentNode.js:143-145`), which is also why
 * swapping the model inside `wrapModelCall` does not lose the agent's tools:
 * binding happens after the middleware, not before.
 */
function modelFactory(options: AgentOptions): (maxTokens?: number) => ChatOpenAI {
  // Destructured away rather than set to `undefined`: `exactOptionalPropertyTypes`
  // is on, so an absent key and a key holding `undefined` are different types.
  const { maxTokens: _ignored, ...withoutCeiling } = options;
  return (maxTokens?: number) =>
    createModel(
      maxTokens === undefined ? withoutCeiling : { ...withoutCeiling, maxTokens },
    );
}

function createModel(options: AgentOptions): ChatOpenAI {
  return createChatModel({
    model: options.model,
    apiKey: options.apiKey,
    baseURL: options.baseURL,
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
 * The ask half of the permission gate: each registered tool's answer vocabulary.
 *
 * Every registered tool appears here with the choices a human may make when
 * asked, and the prompt for the choice. What is deliberately NOT here is the ask
 * decision itself — `confirmationGate` attaches a single `when` predicate that
 * consults the rule engine, so a tool asks exactly when `decide` says "ask". A
 * tool **absent** from this map is auto-approved (`humanInTheLoopMiddleware`
 * treats "no config" as "no interrupt", fail-open), which is why
 * `tests/agent.test.ts` fails when a newly registered tool is missing — adding a
 * tool forces a decision rather than inheriting one.
 *
 * The allow/ask baseline itself lives in `decide` (tools/permission.ts), not
 * here — this map only answers "when the gate asks, what may the human say".
 */
export const CONFIRMATION_POLICY: Record<string, InterruptOnConfig> = {
  Read: {
    allowedDecisions: ["approve", "reject"],
    description: "Read a file",
  },
  Glob: {
    allowedDecisions: ["approve", "reject"],
    description: "Glob files",
  },
  Grep: {
    allowedDecisions: ["approve", "reject"],
    description: "Grep files",
  },
  Write: {
    allowedDecisions: ["approve", "reject"],
    description: "Create a new file",
  },
  Edit: {
    allowedDecisions: ["approve", "reject"],
    description: "Change one span of a file",
  },
  // Every dispatchable kind is read-only, so dispatching one can do nothing a
  // Read or a WebFetch could not — and the escalation assertion in
  // `allRegisteredTools` keeps that transitively true. The baseline in `decide`
  // allows it; this entry exists so the exhaustiveness test still sees every
  // registered tool.
  [TASK_TOOL_NAME]: {
    allowedDecisions: ["approve", "reject"],
    description: "Dispatch a read-only subagent",
  },
  [SKILL_TOOL_NAME]: {
    allowedDecisions: ["approve", "reject"],
    description: "Load a skill",
  },
  // The memory tools allow by default for the frequency reason, not because
  // writing a memory is harmless — a gate that fires constantly stops being
  // read, and the gate that stops being read is the one guarding Bash. The
  // baseline in `decide` carries that decision; the entries here are for the
  // exhaustiveness test.
  MemorySearch: {
    allowedDecisions: ["approve", "reject"],
    description: "Search memory",
  },
  MemoryAdd: {
    allowedDecisions: ["approve", "reject"],
    description: "Add a memory",
  },
  MemoryUpdate: {
    allowedDecisions: ["approve", "reject"],
    description: "Update a memory",
  },
  MemoryDelete: {
    allowedDecisions: ["approve", "reject"],
    description: "Delete a memory",
  },
  // Never asked, and not because asking a question is harmless — because this
  // tool **is** the asking. `clarifyGate` answers the call in `afterModel`,
  // before the gate is reached, so `when` here can never fire; the entry exists
  // because an unlisted tool is auto-approved.
  [CLARIFY_TOOL_NAME]: {
    allowedDecisions: ["approve", "reject"],
    description: "Ask a clarifying question",
  },
  Bash: {
    allowedDecisions: ["approve", "reject"],
    description: "Run a shell command",
  },
  // The web pair allows by default (`decide`'s baseline names them) — these
  // entries exist for the exhaustiveness test, like Task's and the memory
  // tools' above. WebFetch carries its own floor in-tool: it refuses private
  // and internal addresses before any request is made.
  [WEB_FETCH_TOOL_NAME]: {
    allowedDecisions: ["approve", "reject"],
    description: "Fetch a public web page",
  },
  [WEB_SEARCH_TOOL_NAME]: {
    allowedDecisions: ["approve", "reject"],
    description: "Search the web",
  },
};

/** The `when` predicate: ask exactly when the rule engine says "ask". */
function asks(rules?: RuleSet, auto = false): NonNullable<InterruptOnConfig["when"]> {
  return (request) =>
    decide(toolCallOf(request.toolCall), rules, auto).decision === "ask";
}

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
function confirmationGate(rules?: RuleSet, auto = false): AnyAgentMiddleware {
  const when = asks(rules, auto);
  const interruptOn: Record<string, InterruptOnConfig> = {};
  for (const [name, config] of Object.entries(CONFIRMATION_POLICY)) {
    interruptOn[name] = { ...config, when };
  }
  const gate = humanInTheLoopMiddleware({ interruptOn } as unknown as Parameters<
    typeof humanInTheLoopMiddleware
  >[0]) as AnyAgentMiddleware;

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
export function pinRejections(gate: AnyAgentMiddleware): AnyAgentMiddleware {
  const slot = (gate as { afterModel?: unknown }).afterModel;
  // No afterModel means nothing to pin: the gate simply has no hook to wrap.
  if (slot === undefined) return gate;
  const hook = typeof slot === "function" ? slot : (slot as { hook?: unknown })?.hook;
  if (typeof hook !== "function") {
    throw new Error(
      "the confirmation gate's afterModel changed shape — rejections would not be pinned",
    );
  }

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
export function registeredTools(
  environment: AgentEnvironment,
  skills?: SkillRegistry,
  exclude?: readonly string[],
): ClientTool[] {
  const excluded = new Set(exclude ?? []);
  // 摘 WebSearch 不能只过滤清单：research kind 里还揣着自己的那份实例，留下它就是
  // 「派遣提权」——子 agent 能做派遣者被摘掉的事，正是 assertDispatchNeverEscalates
  // 防的那件。所以在**源头**摘：环境里不带后端，工具和携带它的 kind 一起消失，
  // 一个开关，所有落点（提示词那一路 main.ts 已用同一个开关走了改写）。
  const stripped =
    excluded.has(WEB_SEARCH_TOOL_NAME) && environment.webSearch !== undefined;
  const effective = stripped ? withoutWebSearch(environment) : environment;

  const all = allRegisteredTools(effective, skills);
  if (excluded.size === 0) return all;
  const names = new Set(all.map((t) => t.name));
  for (const name of excluded) {
    // 源头摘掉的那个名字当然不在清单里——那是排除生效了，不是打错了。
    if (name === WEB_SEARCH_TOOL_NAME && stripped) continue;
    // 打错的名字要出声。静默忽略等于让调用方以为自己拿掉了一个工具，
    // 而它还在——同 `--timeout` 那条：**拒绝，不要退回默认值**。
    if (!names.has(name)) {
      throw new Error(
        `--exclude-tools: no tool named ${name}. Registered: ${[...names].join(", ")}`,
      );
    }
  }
  return all.filter((tool) => !excluded.has(tool.name));
}

/** The same environment minus the search backend — see the strip note above. */
function withoutWebSearch(environment: AgentEnvironment): AgentEnvironment {
  const { webSearch: _stripped, ...rest } = environment;
  return rest;
}

/**
 * The names {@link registeredTools} will register, computed without building.
 *
 * Exists for skill filtering: a skill's declared `requires` has to be checked
 * against the roster *before* the Skill tool is built, because that tool closes
 * over the registry it will serve — building first and filtering after leaves a
 * tool that can still load what the catalogue no longer advertises. Deriving
 * names without construction is a second copy of `allRegisteredTools`'
 * conditionals, which is exactly the drift the exhaustiveness tests exist to
 * catch — so `tests/skills.test.ts` pins this function against the real
 * assembly across every conditional, and the memory literals here are the same
 * four the confirmation policy already names.
 */
export function registeredToolNames(
  environment: AgentEnvironment,
  hasSkills: boolean,
  exclude?: readonly string[],
): Set<string> {
  const excluded = new Set(exclude ?? []);
  const names = [
    ...TOOLS.map((tool) => tool.name),
    TASK_TOOL_NAME,
    ...(hasSkills ? [SKILL_TOOL_NAME] : []),
    CLARIFY_TOOL_NAME,
    ...(environment.webSearch !== undefined ? [WEB_SEARCH_TOOL_NAME] : []),
    ...(environment.memory !== undefined
      ? ["MemorySearch", "MemoryAdd", "MemoryUpdate", "MemoryDelete"]
      : []),
  ];
  return new Set(names.filter((name) => !excluded.has(name)));
}

function allRegisteredTools(
  environment: AgentEnvironment,
  skills?: SkillRegistry,
): ClientTool[] {
  // Hoisted so the escalation assertion below sees the same specs the Task tool
  // was built from — two calls to `subagentSpecs` would let them drift.
  const subagents = subagentSpecs(environment);
  const all: ClientTool[] = [
    ...TOOLS,
    createTaskTool({ model: environment.model, subagents }),
    // After Task: the six the prompt names keep their pinned order, and Skill
    // joins as the eighth in the same order the prompt lists it. Absent when the
    // program was started with no skills — a tool with nothing to load is a
    // capability the model was never offered.
    ...(skills !== undefined ? [createSkillTool(skills)] : []),
    // After Task, and last on purpose: the six the prompt names keep their pinned
    // order and, with them, the cached prefix. Absent when the program was
    // started without a memory directory, which is the honest default — a tool
    // that always fails is worse than a capability the model was never offered.
    // After the optional Skill and **before** the optional memory tools. Tools are
    // serialised ahead of messages, so position is a cache decision: a new tool
    // appends to the *unconditional* set rather than being inserted among the six,
    // which is the same move Task and Skill each made. Memory keeps the tail it
    // documents below — two things cannot both be last, and putting this after
    // them would have made the claim there false.
    //
    // Unconditional, and it needs no condition to be main-agent-only: a
    // subagent's tools come from `EXPLORE_TOOLS` (`agents/kinds.ts`), never from
    // here. That is the confirmation gate's property for the gate's reason — a
    // kind that cannot `interrupt()` cannot ask (docs/adr/0003), and a tool that
    // can only fail is worse than a capability the model was never offered.
    clarifyTool,
    // Conditional like the memory tools, and for the same honest default: no
    // resolved search backend means no WebSearch — a tool that can only fail is
    // worse than a capability the model was never offered. `main.ts` removes it
    // from the prompt in the same breath (one source, two landing sites).
    ...(environment.webSearch !== undefined
      ? [createWebSearchTool(environment.webSearch)]
      : []),
    ...(environment.memory !== undefined
      ? createMemoryTools({ store: environment.memory })
      : []),
  ];
  // A dispatch must never escalate past its dispatcher (docs/adr/0003's
  // property, held transitively). Asserted on the *full* list, after every
  // conditional joined — a subset check against a partial registration would
  // pass exactly when it matters most.
  assertDispatchNeverEscalates(subagents, all);
  return all;
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
function environment(
  model: ChatOpenAI,
  modelFor: (maxTokens?: number) => ChatOpenAI,
  options: AgentOptions,
): AgentEnvironment {
  return {
    model,
    modelFor,
    ...(options.projectInstructions !== undefined
      ? { instructions: options.projectInstructions }
      : {}),
    ...(options.onUsage !== undefined ? { onUsage: options.onUsage } : {}),
    ...(options.onWindow !== undefined ? { onWindow: options.onWindow } : {}),
    ...(options.window !== undefined ? { window: options.window } : {}),
    ...(options.outputBudget !== undefined
      ? { outputBudget: options.outputBudget }
      : {}),
    ...(options.memory !== undefined
      ? { memory: new MemoryStore(options.memory) }
      : {}),
    ...(options.webSearch !== undefined ? { webSearch: options.webSearch } : {}),
    ...(options.rules !== undefined ? { rules: options.rules } : {}),
  };
}

/**
 * Writes a durable failure marker when a turn fails, without widening the
 * console's narrow seam.
 *
 * The model's error surfaces when the returned iterable is consumed (for
 * `stream`) or when the promise settles (for `invoke`) — never at the call
 * itself, so both entry points are wrapped rather than a middleware hook.
 * There is no middleware slot that runs on model *error*: `wrapModelCall` can
 * retry or substitute a response but cannot reach the checkpoint, and the
 * error propagates before any `afterModel` hook (see ticket 14).
 *
 * A failure writes the marker via `updateState` before re-throwing, so the
 * caller sees exactly the error it saw before — the only difference is that the
 * checkpoint now records the failure for the next turn to read. Abort is left
 * untouched: it is control, not failure (CONTEXT.md「中止」), and re-throws as
 * it came.
 */
function withFailureMarker<T>(graph: T): T {
  // The graph is viewed through a loose lens here, because the wrapped entry
  // points only need three methods and forwarding the rest is the proxy's job.
  // The public type stays `T` — this cast never leaks to a caller.
  const g = graph as unknown as {
    invoke: (...args: unknown[]) => Promise<unknown>;
    stream: (...args: unknown[]) => Promise<AsyncIterable<unknown>>;
    updateState: (config: unknown, values: unknown) => Promise<unknown>;
  };

  const record = async (config: unknown, error: unknown): Promise<void> => {
    if (classify(error).kind === "abort") return;
    const threadId = (config as { configurable?: { thread_id?: unknown } } | undefined)
      ?.configurable?.thread_id;
    if (typeof threadId !== "string") return;
    try {
      await g.updateState(
        { configurable: { thread_id: threadId } },
        { messages: [failureMarker(error)] },
      );
    } catch {
      // Best effort: the turn already failed, and a marker that cannot be
      // written must not mask that failure with a bookkeeping error.
    }
  };

  const invoke = async (...args: unknown[]): Promise<unknown> => {
    try {
      return await g.invoke(...args);
    } catch (error) {
      await record(args[1], error);
      throw error;
    }
  };

  const stream = async (...args: unknown[]): Promise<AsyncIterable<unknown>> => {
    const inner = await g.stream(...args);
    return (async function* () {
      try {
        for await (const event of inner) yield event;
      } catch (error) {
        await record(args[1], error);
        throw error;
      }
    })();
  };

  // A proxy, not a new type: it forwards everything except the two wrapped
  // entry points, so callers keep the full compiled-graph surface while the
  // failure marker is written on their behalf.
  return new Proxy(graph as object, {
    get(target, prop, receiver) {
      if (prop === "invoke") return invoke;
      if (prop === "stream") return stream;
      const value = Reflect.get(target, prop, receiver) as unknown;
      // Bind methods back to the graph: a forwarded method reads `this.#graph`
      // (a private field), and `this` would otherwise be the proxy, which
      // throws a TypeError (ticket 05).
      if (typeof value !== "function") return value;
      const fn = value as (...args: unknown[]) => unknown;
      return (...args: unknown[]) => fn.apply(target, args);
    },
  }) as T;
}

/**
 * Refuses a main-agent stack whose loop guard would not see the raw model output.
 *
 * The loop guard hashes the tool-call set in `afterModel` to notice a model
 * going in circles. The gate also runs in `afterModel`, and it intercepts tool
 * calls to ask for confirmation — so if it ran first, the guard would hash
 * whatever the gate left, not what the model wrote. Both are installed
 * unconditionally for the main agent, so a missing half is as wrong as the
 * wrong order, and both are refused.
 *
 * By name rather than by identity, for the same reason as
 * `assertMeterInsideWindow`: the names are what langchain carries
 * (`createMiddleware({ name })`), and comparing instances would only prove the
 * function returned what it just built. Exported so a test can hand it a
 * deliberately wrong stack.
 */
export function assertLoopGuardBeforeGate(stack: AnyAgentMiddleware[]): void {
  const at = (name: string) =>
    stack.findIndex((middleware) => middleware.name === name);
  const guard = at("LoopGuard");
  const gate = at("HumanInTheLoopMiddleware");
  if (guard !== -1 && gate !== -1 && guard < gate) return;
  throw new Error(
    `the loop guard must be installed before the confirmation gate, or it hashes what the gate left instead of the raw model output (LoopGuard at ${String(guard)}, HumanInTheLoopMiddleware at ${String(gate)})`,
  );
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
 * JSONL one, so a session outlives the terminal. Nothing else about the loop
 * changes, which is what "durable history is a different saver, not a different
 * design" was always claiming and now demonstrates.
 */
export function createUniversalAgent(options: AgentOptions) {
  const excludedTools = new Set(options.excludeTools ?? []);
  // Built once and shared: the same model answers turns and writes summaries.
  // A summary decides what every later turn can see, which is a poor place to
  // economise, and this is a single-model program besides.
  // One factory, and the agent's own instance comes out of it too — so the
  // summariser's instance and this one are siblings rather than one being a
  // special case of the other. This one is built once and reused for the life of
  // the graph; only callers that need a different ceiling call the factory again.
  const modelFor = modelFactory(options);
  const model = modelFor(options.maxTokens);

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
  const env = environment(model, modelFor, options);

  // Skills checked against the roster before anything closes over them: a skill
  // that declared `requires` it cannot have here is dropped — from the
  // catalogue AND from what the Skill tool can load, which is why the filtering
  // sits before both. The drop is reported, not silent (research-kind ticket
  // 02: the failure this closes is a skill promising web research to an agent
  // that had no way to do it, and the model promising it onward).
  const filtered = options.skills?.satisfiedBy(
    registeredToolNames(env, options.skills !== undefined, options.excludeTools),
  );
  if (filtered !== undefined && filtered.dropped.length > 0) {
    options.onSkillsUnavailable?.(filtered.dropped);
  }
  const skills = filtered?.kept;

  // The catalogue is built (or not) here rather than inline, so the decision
  // "no model-invoked skills → no middleware" is made once and the array below
  // reads as a plain conditional.
  const skillCatalog = skills === undefined ? undefined : injectSkillCatalog(skills);

  const middleware: AnyAgentMiddleware[] = [
    ...agentStack(MAIN_AGENT, env),
    // Skills are main-agent-only, so both halves are added here rather than in
    // `agentStack`, which a subagent shares. The catalogue is a beforeAgent hook
    // (injected once per thread, like the project instructions). The pinner is a
    // wrapToolCall hook and must sit before the other wrapToolCall users —
    // toolRecovery and stallGuard — because wrapToolCall nests
    // first-in-outermost, and it has to see the final result of a Skill call,
    // however the inner wraps shaped it.
    ...(skillCatalog !== undefined ? [skillCatalog] : []),
    ...(skills !== undefined ? [pinSkillLoads()] : []),
    // Before the gate, so it hashes the raw model output rather than whatever
    // the gate did to it.
    loopGuard(options.onCap !== undefined ? { onCap: options.onCap } : {}),
    // The work budget on the token/time axis. After loopGuard so pathology
    // (a repeated call) is named before plain exhaustion; its afterModel is
    // read by the same assembly assertions as the guards' (BLOCKS:
    // "notABlock").
    turnBudget({
      tokenBudget:
        (options.window?.limit ?? WINDOW_LIMIT) *
        (options.turnBudget?.tokenMultiplier ?? 4),
      timeBudgetMs: options.turnBudget?.timeBudgetMs ?? 600_000,
      ...(options.onCap !== undefined ? { onCap: options.onCap } : {}),
    }),
    // Outside stallGuard: wrapToolCall nests first-in-outermost, so this must
    // sit outside the guard to see the error ToolMessage the guard turns a
    // throw into and record its settlement — the reverse order skips it
    // (ticket 10). It belongs to the main agent alone: a subagent has
    // `checkpointer: false`, so there is no session for a journal to sit
    // beside (see the note in tools/task.ts).
    ...(options.stateDir !== undefined
      ? [toolRecovery({ directory: options.stateDir })]
      : []),
    stallGuard(),
    emptyReplyGuard(),
    // Before the gate, and that ordering is load-bearing. `clarifyGate` narrows
    // the message's `tool_calls` to the `Clarify` call alone (in place, the same
    // way langchain's HITL does it at `hitl.js:498`), so a turn that asked a
    // question *and* wanted to run a command leaves the gate nothing to stop.
    // The reverse order produces two interrupts in one turn — a confirmation and
    // a question — and the console can only hold one.
    // Clarify 被拿掉时它也走：一个永远不会被调用的工具的门，留着只是死代码，
    // 而死代码会让下一个人以为这条路还活着。
    ...(excludedTools.has(CLARIFY_TOOL_NAME) ? [] : [clarifyGate()]),
    confirmationGate(options.rules, options.auto ?? false),
  ];

  assertLoopGuardBeforeGate(middleware);
  // The block-order tripwire runs again on the full array: SkillCatalog is
  // appended here, where the assembler's own check cannot see it
  // (view-layout-impl ticket 01, 订正①).
  assertBlocksInFrequencyOrder(middleware);

  const graph = createAgent({
    model,
    tools: registeredTools(env, skills, options.excludeTools),
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
  return withFailureMarker(graph);
}
