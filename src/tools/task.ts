import {
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { tool, type ClientTool, type ToolRuntime } from "@langchain/core/tools";
import { createAgent, type AnyAgentMiddleware } from "langchain";
import { z } from "zod";

/**
 * `Task`: dispatch a registered subagent, get one report back.
 *
 * ## What this file knows, and what it deliberately does not
 *
 * It knows how to run an agent inside a tool call and hand its final message
 * back. It does **not** know what kinds of subagent exist, what they may do, or
 * what they are told — those arrive as {@link SubagentSpec}s. Registering a kind
 * is a data change in `src/subagents.ts`; nothing here changes for it, and
 * `tests/task.test.ts` dispatches a made-up kind to keep that honest.
 *
 * The split matters because "read-only explore agent" is one policy, not the mechanism.
 * A kind that may write, or one bound to a different model, is the same
 * dispatch: a spec with different contents.
 *
 * ## Why LangChain has nothing to import here
 *
 * There is no subagent API. The exported surface contains no `createSubagent`;
 * the one export with the word in it, `createSubagentTransformer`, is a *stream
 * projection* — it watches `tasks` events and surfaces nested runs on
 * `run.subagents` (agents/transformers/subagent.js:17-39). It makes a subagent
 * visible; it does not make one. The mechanism is stated only in a type comment:
 * *a nested `createAgent` run whose `lc_agent_name` differs from its parent's —
 * e.g. a `createAgent({ name })` invoked inside a tool body*
 * (agents/transformers/types.d.ts). So a subagent is a tool contract, and this
 * file is that contract.
 *
 * ## The shape is deepagents', on purpose
 *
 * `deepagents@1.12.3` solves the same problem with one `task` tool over a
 * registry: `{ description, subagent_type }`, the tool's own description
 * enumerating the available types, and an unknown type answered with the list of
 * allowed ones (dist/langsmith-CUTUAjHo.js:2465-2528). The alternative — one tool
 * per kind — grows the tool block on every request for something the model can
 * select with a string.
 *
 * Two parts of theirs are deliberately not copied, and neither is a matter of
 * taste:
 *
 * - **They hand the subagent the parent's state** minus a few keys, then
 *   overwrite `messages` with the single task message (:2487-2494). What survives
 *   is their virtual filesystem — a shared workspace we do not have. Worth noting
 *   that they too keep the conversation itself out of it.
 * - **They return a `Command` that merges the subagent's state back** (:2517),
 *   because their subagents write files the parent must see. Merging a
 *   subagent's keys into the parent is the opposite of the isolation this tool
 *   exists for; a kind that needs it can be added when one exists.
 *
 * ## Why a factory, rather than an exported tool
 *
 * A subagent needs a model, and the model is built by the agent. A ready-made
 * tool in `TOOLS` would have to import the agent to get one, closing the cycle
 * `agent -> tools -> task -> agent`. Handing the dependency in from the
 * assembling caller keeps the graph acyclic — the same seam `main.ts` uses to
 * keep the filesystem out of the agent builder.
 */

/** The parent's name for this capability. Referenced by the confirmation policy. */
export const TASK_TOOL_NAME = "Task";

/**
 * Ceiling on one subagent, in node executions — the same units as the agent's
 * own limit, and deliberately smaller. A subagent that has taken eight laps is
 * not closing in on an answer, and every lap of it is billed at the uncached
 * rate.
 */
export const SUBAGENT_RECURSION_LIMIT = 16;

/**
 * One kind of subagent the parent may dispatch.
 *
 * `description` is not documentation: it is what the model reads when choosing a
 * `subagent_type`, so it has to say what this kind is *for* and what it can
 * reach. `tools` is not a convenience either — it is the entire statement of
 * what this kind may do, since a subagent can only act through the tools it was
 * given.
 */
export interface SubagentSpec {
  name: string;
  description: string;
  prompt: string;
  tools: ClientTool[];
  /** Installed on this kind only. The parent's middleware does not reach here. */
  middleware?: AnyAgentMiddleware[];
}

/**
 * How many subagents may run at once.
 *
 * `ToolNode` runs every tool call of one lap concurrently and has no throttle,
 * so without this a model that dispatches five subagents in one turn starts five
 * agents, each carrying its own resident prompt and tool block, all billed at the
 * uncached rate. Three is enough to make parallel investigation worth doing and
 * small enough that a runaway turn is a recognisable cost rather than a surprise.
 *
 * The limit lives here rather than in a middleware because it is a property of
 * the resource, and the tool owns the resource — the same reasoning that puts
 * `withPathLock` in the tools layer instead of the scheduler.
 */
export const MAX_CONCURRENT_SUBAGENTS = 3;

export interface TaskToolOptions {
  /**
   * The model subagents run on — normally the parent's own instance.
   *
   * Sharing rather than rebuilding is the caller's decision, and in this program
   * it is deliberate: that object carries the `onFailedAttempt` guard that stops
   * a context-overflow error being retried six times, and a fresh instance would
   * quietly re-enter that trap. The cost is a shared `AsyncCaller`, so concurrent
   * subagents share one concurrency and retry budget.
   */
  model: BaseChatModel;
  /** Every kind that can be dispatched. Required: this tool defines no kinds. */
  subagents: SubagentSpec[];
  recursionLimit?: number;
  maxConcurrent?: number;
}

/**
 * Builds the tool: name a kind, hand it an objective, get a report back.
 *
 * The parent's abort signal is forwarded, and that single line is the whole of
 * cancellation support. `ToolNode` hands the tool a merged abort signal
 * (nodes/ToolNode.js:241), and core's `mergeConfigs` combines signals with
 * `AbortSignal.any` (runnables/config.js:37-40) — so the parent's Ctrl+C is
 * already the subagent's Ctrl+C once the signal is passed along.
 *
 * **Only** the signal. Handing over the whole runtime also hands over
 * `configurable`, which is where langgraph keeps the parent's saver and thread
 * id — measured: the subagent's entire run was written into the parent's thread
 * file under a `tools:<id>` namespace, while the parent's `state.messages`
 * stayed clean and every unit test stayed green.
 */
export function createTaskTool(options: TaskToolOptions) {
  if (options.subagents.length === 0) {
    // Registering the tool with nothing to dispatch would advertise a capability
    // to the model that always fails. Loud at construction beats confusing at
    // run time.
    throw new Error("createTaskTool needs at least one subagent spec");
  }

  const nesting = options.subagents.find((spec) =>
    spec.tools.some((tool) => "name" in tool && tool.name === TASK_TOOL_NAME),
  );
  if (nesting !== undefined) {
    // A subagent holding this tool can dispatch subagents that hold it too, and
    // nothing downstream would stop the recursion: `recursionLimit` bounds one
    // graph, and each generation is a fresh graph with a fresh budget. Refused at
    // construction because there is no run-time symptom short of the bill.
    throw new Error(
      `subagent "${nesting.name}" carries ${TASK_TOOL_NAME}; subagents may not dispatch subagents`,
    );
  }

  const limit = options.recursionLimit ?? SUBAGENT_RECURSION_LIMIT;
  const enter = gate(options.maxConcurrent ?? MAX_CONCURRENT_SUBAGENTS);
  const graphs = new Map(
    options.subagents.map((spec) => [
      spec.name,
      createAgent({
        model: options.model,
        tools: spec.tools,
        // Named, because that is what marks a nested run as a subagent —
        // `lc_agent_name` in the run's metadata (ReactAgent.js:58) — and it is
        // also what tells a subagent's streamed chunks from the parent's.
        name: spec.name,
        // Stated in the graph, not left to what the caller passes. Pregel
        // resolves its saver as `this.checkpointer === false` first, then
        // `config.configurable.__pregel_checkpointer`, then its own
        // (pregel/index.js:878-882) — so anything short of `false` inherits the
        // parent's saver from an inherited config. A subagent's working notes
        // are not the user's conversation and do not belong in their thread.
        checkpointer: false,
        systemPrompt: new SystemMessage(spec.prompt),
        middleware: spec.middleware ?? [],
      }),
    ]),
  );

  return tool(
    async ({ description, subagent_type }, runtime: ToolRuntime): Promise<string> => {
      const graph = graphs.get(subagent_type);
      // Thrown rather than returned, because ToolNode turns a throw into a tool
      // message: the model reads the allowed list and picks again, instead of
      // the turn dying on a typo.
      if (graph === undefined) {
        const allowed = [...graphs.keys()].map((name) => `\`${name}\``).join(", ");
        throw new Error(
          `no subagent of type ${subagent_type}; the only allowed types are ${allowed}`,
        );
      }

      const result = await enter(async () => {
        try {
          return (await graph.invoke(
            { messages: [new HumanMessage(description)] },
            {
              // Spread conditionally for the same reason `createModel` does it
              // with maxTokens: `exactOptionalPropertyTypes` is on, so `signal:
              // undefined` is not the same as an absent signal.
              ...(runtime.signal !== undefined ? { signal: runtime.signal } : {}),
              recursionLimit: limit,
            },
          )) as { messages: BaseMessage[] };
        } catch (error) {
          // An abort is not a failed dispatch, it is the user pressing Ctrl+C,
          // and it has to reach the console rather than becoming a tool result
          // the parent reads and carries on from. ToolNode agrees — it rethrows
          // whatever it catches while its own signal is aborted
          // (nodes/ToolNode.js:125-127) — but saying so here keeps the intent
          // where the decision is.
          if (runtime.signal?.aborted === true) throw error;
          // The cause is kept even though only the message reaches the model:
          // the console's error path prints a stack, and losing the original
          // here would make a genuine bug in a subagent unfindable.
          throw new Error(explain(error, subagent_type, limit), { cause: error });
        }
      });

      const report = result.messages.at(-1);
      const text = report === undefined ? "" : contentText(report);

      // A subagent that returns nothing is a failure with no symptom: the parent
      // would read an empty tool result as "looked, found nothing" and answer
      // from that. Saying so is the difference between a wrong answer and a
      // reported gap.
      if (text.trim() === "") throw new Error("the subagent returned an empty report");
      return text;
    },
    {
      name: TASK_TOOL_NAME,
      description: describeTask(options.subagents),
      schema: z.object({
        description: z
          .string()
          .describe(
            "The objective, stated in full. The subagent sees nothing of this conversation, so name any paths you already know and say exactly what to report back.",
          ),
        subagent_type: z
          .string()
          .describe(
            `Which kind to dispatch. Available: ${options.subagents.map((spec) => spec.name).join(", ")}`,
          ),
      }),
    },
  );
}

/**
 * The tool's description, built from the registry so the two cannot drift.
 *
 * Registering a kind and telling the model about it are the same act — a kind
 * the description forgets to mention is a kind the model never dispatches.
 */
function describeTask(specs: SubagentSpec[]): string {
  return [
    "Dispatch a subagent to handle one question in an isolated context window, and get back a single report.",
    "",
    "Available types:",
    ...specs.map((spec) => `- ${spec.name}: ${spec.description}`),
    "",
    "Usage notes:",
    "- Dispatch several in one turn when the questions are independent.",
    "- Each dispatch is stateless: the subagent sees only the objective you write, and returns one final report. Put the full detail in the objective.",
    "- Its work never enters this conversation; only its report does. That is what this tool is for.",
    "- The report is not shown to the user. Relay what matters yourself.",
  ].join("\n");
}

/**
 * Turns a failed dispatch into one line the parent model can act on.
 *
 * What reaches the parent is a tool result, and a tool result is read by a model
 * deciding what to do next — so a stack trace and a documentation URL are worse
 * than useless there. Running out of steps is called out by name because it is
 * the one failure the parent can actually do something about: the objective was
 * too broad, and splitting it is the fix.
 *
 * Detection is by `name`, not `instanceof`. Errors cross a package boundary
 * here, and a duplicated `@langchain/langgraph` in the tree makes `instanceof`
 * quietly false — the same reason `checkpoint/messages.ts` sniffs messages
 * structurally.
 */
function explain(error: unknown, type: string, limit: number): string {
  const named = error as { name?: string; message?: string };
  if (named.name === "GraphRecursionError") {
    return `the ${type} subagent used all ${String(limit)} steps without reporting back. Narrow the objective, or split it across several dispatches.`;
  }
  const message = (named.message ?? String(error)).split("\n")[0] ?? "";
  return `the ${type} subagent failed: ${message}`;
}

/**
 * Lets `limit` callers run at once and queues the rest in arrival order.
 *
 * Queued rather than refused, deliberately: a refusal is a tool result the model
 * has to interpret, and "try again later" is not something it can act on
 * sensibly. Waiting is invisible to it and correct.
 *
 * One slot is released to exactly one waiter, so the count cannot drift: the
 * releaser decrements before waking, and the waiter it wakes takes that slot
 * without re-checking.
 */
function gate(limit: number): <T>(work: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: (() => void)[] = [];

  return async function enter<T>(work: () => Promise<T>): Promise<T> {
    if (running >= limit) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    running += 1;
    try {
      return await work();
    } finally {
      running -= 1;
      waiting.shift()?.();
    }
  };
}

/** MessageContent is a string or an array of blocks; only the text is wanted. */
function contentText(message: BaseMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  return content
    .map((block) =>
      typeof block === "object" && block !== null && "text" in block
        ? String((block as { text: unknown }).text)
        : "",
    )
    .join("");
}
