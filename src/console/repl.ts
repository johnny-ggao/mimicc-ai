import { createInterface } from "node:readline/promises";

import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";

import {
  classify,
  DURABILITY,
  failureText,
  RECURSION_LIMIT,
  type AgentGraph,
} from "../agents";
import { markdownStream } from "./markdown";
import { TASK_TOOL_NAME } from "../tools";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const BANNER = [
  "mimicc-ai — type a message and press enter",
  "  tools    Read · Write · Edit · Bash · Glob · Grep · Task",
  "  Task     sends a read-only explore agent; its searching stays out of the conversation",
  "  Bash     stops and asks before it runs; the others do not",
  "  /clear   start a new thread; the old one stays in the checkpointer",
  "  /exit    quit (same as Ctrl+D)",
  "  Ctrl+C   interrupt the current reply; at an idle prompt, quit",
].join("\n");

export interface ReplOptions {
  graph: AgentGraph;
}

/** One tool call waiting on a human. Shape comes from `__interrupt__`. */
interface ActionRequest {
  name: string;
  args: Record<string, unknown>;
  description?: string;
}

type Decision =
  | { type: "approve" }
  | { type: "edit"; editedAction: { name: string; args: Record<string, unknown> } }
  | { type: "reject"; message?: string };

/**
 * A batch of tool calls the gate stopped, and the decisions collected so far.
 *
 * The console asks for these one line at a time through the *same* readline
 * iterator that reads prompts, rather than through `rl.question`: both consume
 * "line" events, and running them concurrently makes which one wins a matter of
 * timing. A line is a line — what changes is how the loop reads it.
 */
interface Pending {
  requests: ActionRequest[];
  decisions: Decision[];
  /** True once the user chose "edit" and the next line is the replacement. */
  editing: boolean;
}

export async function runRepl({ graph }: ReplOptions): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    // Piped stdin (tests, here-docs) must not be forced into terminal mode.
    terminal: process.stdin.isTTY === true,
    historySize: 200,
  });

  // Non-null exactly while a turn is in flight. That is also how the SIGINT
  // handler tells "interrupt the reply" apart from "quit the repl".
  let inFlight: AbortController | null = null;

  rl.on("SIGINT", () => {
    if (inFlight) {
      inFlight.abort();
      return;
    }
    rl.close();
  });

  // History lives in the checkpointer now, keyed by this. `/clear` mints a new
  // one rather than deleting anything: the old thread stays addressable, which
  // is what makes time travel possible at all.
  let thread = crypto.randomUUID();
  // How many messages of this thread have already been rendered. The graph hands
  // back the whole thread on every values event, so without a watermark every
  // tool line would be reprinted each lap.
  let rendered = 0;
  let pending: Pending | null = null;

  process.stdout.write(`${BANNER}\n\n`);
  rl.setPrompt("> ");
  rl.prompt();

  for await (const line of rl) {
    const input = line.trim();

    if (pending) {
      const resume = readDecision(input, pending);
      if (resume === null) {
        rl.prompt();
        continue;
      }
      // The decision was typed at the "> " prompt, so the resumed output would
      // otherwise start on that same line.
      process.stdout.write("\n");
      inFlight = new AbortController();
      const turn = await runTurn(graph, resume, thread, rendered, inFlight.signal);
      inFlight = null;
      pending = finish(turn);
      rendered = turn.rendered;
      rl.prompt();
      continue;
    }

    if (input === "/exit") break;

    if (input.length === 0) {
      rl.prompt();
      continue;
    }

    if (input === "/clear") {
      thread = crypto.randomUUID();
      rendered = 0;
      process.stdout.write("(new thread)\n\n");
      rl.prompt();
      continue;
    }

    // No system message here. The prompt is handed to the agent at construction
    // and prepended to every model call from outside the thread — see
    // AgentOptions.systemPrompt for why it must not live in state.
    //
    // Not pinned here, deliberately: pinning what the user typed is the graph's
    // job, not the console's — see `pinTurnTask`. A guarantee that depends on
    // which caller invoked the graph is not a guarantee.
    const messages: BaseMessage[] = [new HumanMessage(input)];

    inFlight = new AbortController();
    const turn = await runTurn(graph, { messages }, thread, rendered, inFlight.signal);
    inFlight = null;

    pending = finish(turn);
    rendered = turn.rendered;
    rl.prompt();
  }

  rl.close();
  process.stdout.write("\nbye\n");
}

/** Prints whatever the turn produced, and returns the batch still waiting. */
function finish(turn: TurnResult): Pending | null {
  if (turn.error !== null) process.stdout.write(`${describeError(turn.error)}\n`);
  if (turn.requests === null) {
    process.stdout.write("\n");
    return null;
  }

  const pending: Pending = { requests: turn.requests, decisions: [], editing: false };
  ask(pending);
  return pending;
}

/** Prints the request now awaiting a decision. */
function ask(pending: Pending): void {
  const request = pending.requests[pending.decisions.length];
  if (request === undefined) return;

  const detail =
    typeof request.args["command"] === "string"
      ? request.args["command"]
      : JSON.stringify(request.args);

  const count =
    pending.requests.length > 1
      ? ` (${String(pending.decisions.length + 1)}/${String(pending.requests.length)})`
      : "";

  process.stdout.write(
    `\n${DIM}⚠${RESET} ${request.name}${count} wants to run:\n    ${detail}\n` +
      `${DIM}  [a] approve   [e] edit   [r] reject (any other text becomes the reason)${RESET}\n`,
  );
}

/**
 * Folds one line into the pending batch. Returns a Command once every request in
 * the batch has a decision, and null while more input is needed.
 */
function readDecision(input: string, pending: Pending): Command | null {
  const request = pending.requests[pending.decisions.length];
  if (request === undefined) return null;

  if (pending.editing) {
    pending.editing = false;
    pending.decisions.push({
      type: "edit",
      editedAction: { name: request.name, args: { ...request.args, command: input } },
    });
  } else if (input === "a" || input === "") {
    pending.decisions.push({ type: "approve" });
  } else if (input === "e") {
    pending.editing = true;
    process.stdout.write(`${DIM}  replacement command:${RESET}\n`);
    return null;
  } else if (input === "r") {
    pending.decisions.push({ type: "reject" });
  } else {
    // Anything else is a rejection with a reason — the model reads it, so
    // "not on production" is more useful than a bare refusal.
    pending.decisions.push({ type: "reject", message: input });
  }

  if (pending.decisions.length < pending.requests.length) {
    ask(pending);
    return null;
  }

  return new Command({ resume: { decisions: pending.decisions } });
}

interface TurnResult {
  /** Tool calls the gate stopped, or null when the turn ran to completion. */
  requests: ActionRequest[] | null;
  /** New watermark for how much of the thread has been printed. */
  rendered: number;
  error: unknown;
}

/**
 * Runs one turn through the graph and renders it as it arrives.
 *
 * Two stream modes at once, because they answer different questions.
 * `"messages"` carries token-level chunks — that is what makes the reply appear
 * as it is written. `"values"` carries the whole state after each node, which is
 * the only reliable place to notice that a tool ran, and the only place an
 * interrupt shows up. Rendering tool activity from state rather than from chunks
 * keeps the two concerns apart: chunks are for prose, state is for structure.
 */
async function runTurn(
  graph: AgentGraph,
  input: { messages: BaseMessage[] } | Command,
  thread: string,
  rendered: number,
  signal: AbortSignal,
): Promise<TurnResult> {
  let requests: ActionRequest[] | null = null;
  let dimmed = false;
  // When the last activity dot was printed; see the subagent branch below.
  let lastDot = 0;
  let error: unknown = null;

  // One per turn, so a reply that ends inside an unclosed code fence — the model
  // stopped early, or Ctrl+C landed mid-block — cannot leave the next reply
  // rendering as code.
  const markdown = markdownStream((text) => process.stdout.write(text));

  const openDim = (): void => {
    if (!dimmed) {
      process.stdout.write(DIM);
      dimmed = true;
    }
  };
  const closeDim = (): void => {
    if (dimmed) {
      process.stdout.write(RESET);
      dimmed = false;
    }
  };

  try {
    // The array form of streamMode yields [mode, payload] tuples; the typings do
    // not narrow that, so this is the one place we assert the shape.
    const stream = (await graph.stream(input, {
      streamMode: ["messages", "values"],
      recursionLimit: RECURSION_LIMIT,
      durability: DURABILITY,
      signal,
      configurable: { thread_id: thread },
    })) as AsyncIterable<[string, unknown]>;

    for await (const [mode, payload] of stream) {
      if (mode === "values") {
        // An interrupt arrives as a values event carrying *only* `__interrupt__`
        // — no messages key at all. Reading state.messages unguarded here is a
        // crash, not a missing feature.
        const state = payload as {
          messages?: BaseMessage[];
          __interrupt__?: { value?: { actionRequests?: ActionRequest[] } }[];
        };

        const stopped = state.__interrupt__?.[0]?.value?.actionRequests;
        if (stopped !== undefined) requests = stopped;
        if (state.messages !== undefined) {
          // Flushed first, and not as a precaution. A held partial line would
          // otherwise be printed *after* the tool-call line below it, which
          // arrives on a different event stream — the transcript would show the
          // model's sentence appearing after the call it introduced.
          markdown.flush();
          rendered = renderStructure(state.messages, rendered, closeDim);
        }
        continue;
      }

      const [chunk, metadata] = payload as [BaseMessage, unknown];
      if (chunk.getType() === "tool") continue; // Rendered from state instead.

      if (fromSubagent(metadata)) {
        // Throttled to one a second, not one per chunk: an explore agent writing five
        // hundred tokens produced five hundred dots, which is a different kind
        // of noise. At this rate the row of dots is roughly how long the explore agents
        // have been running, which is the only thing it should be saying.
        const now = Date.now();
        if (now - lastDot < 1000) continue;
        lastDot = now;

        // A subagent's tokens are dropped rather than rendered. They arrive on
        // this same stream — inherited through AsyncLocalStorage, so there is
        // nothing to switch off at the call site — and with two explore agents running
        // they interleave character by character into something nobody can read
        // (measured; see the transcript in the T5 notes). Nothing is lost: the
        // report comes back as a tool result, and the agent relays it.
        //
        // One dim dot per chunk, because the alternative is a silent minute. It
        // says the run is alive without printing anything that has to be read.
        openDim();
        process.stdout.write("·");
        continue;
      }

      const reasoning = chunk.additional_kwargs["reasoning_content"];
      if (typeof reasoning === "string" && reasoning.length > 0) {
        openDim();
        process.stdout.write(reasoning);
      }

      if (typeof chunk.content === "string" && chunk.content.length > 0) {
        if (dimmed) {
          closeDim();
          process.stdout.write("\n\n");
        }
        // The reply is markdown and gets read as markdown. The reasoning above
        // deliberately does not: it is dim by the paragraph and rendering it
        // would compete with the answer for the eye.
        markdown.push(chunk.content);
      }
    }
  } catch (caught) {
    error = caught;
  } finally {
    // Flushed on every exit path for the same reason the dim escape is closed on
    // every exit path: an interrupt or a failure mid-line must not swallow the
    // text the model had already produced.
    markdown.flush();
    // The dim escape has to be closed on every exit path, or an interrupt during
    // reasoning leaves the whole terminal dimmed.
    closeDim();
    process.stdout.write("\n");
  }

  return { requests, rendered, error };
}

/** How much of a tool call's arguments fits on one line of the transcript. */
const CALL_WIDTH = 76;

/**
 * One line naming a tool call, short enough to read at a glance.
 *
 * `Task` is singled out, and it earns it: dispatches are the one call that comes
 * in threes, and the serialised arguments of three of them are identical for the
 * first sixty characters — `{"description":"Read /Users/…/src` — so the default
 * rendering printed three indistinguishable lines. Leading with the kind and
 * then the objective is what makes concurrent explore agents tellable apart, which is
 * the whole point of showing them.
 */
export function summarizeCall(name: string, args: unknown): string {
  const fields = (args ?? {}) as { description?: unknown; subagent_type?: unknown };

  if (name === TASK_TOOL_NAME && typeof fields.description === "string") {
    const kind = typeof fields.subagent_type === "string" ? fields.subagent_type : "?";
    return `${name}[${kind}] ${clip(fields.description, CALL_WIDTH)}`;
  }

  return `${name} ${clip(JSON.stringify(args), CALL_WIDTH)}`;
}

function clip(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 3)}...` : text;
}

/**
 * Whether a streamed chunk came from a subagent rather than from the agent.
 *
 * The obvious discriminator is the message's `name` — the agent's own messages
 * carry `"model"`, a subagent's carry its kind — and it is the wrong one:
 * measured, `name` is absent on *streamed* chunks and only appears on the
 * finished message (`repro/12-subagent-stream.ts`).
 *
 * What does distinguish them is nesting depth, in the metadata that rides
 * alongside every chunk. The agent's own model chunks carry a single-segment
 * `checkpoint_ns` (`model_request:<id>`); a subagent's carry a nested one
 * (`tools:<id>|model_request:<id>`), and `|` is langgraph's namespace separator.
 * Depth, not identity — which is also why this keeps working if a second kind of
 * subagent is registered.
 */
export function fromSubagent(metadata: unknown): boolean {
  const namespace = (metadata as { checkpoint_ns?: unknown } | undefined)
    ?.checkpoint_ns;
  return typeof namespace === "string" && namespace.includes("|");
}

/**
 * Prints one dim line per tool call and per result, for the messages that have
 * appeared since the last time we looked. Returns the new watermark.
 */
function renderStructure(
  messages: BaseMessage[],
  rendered: number,
  closeDim: () => void,
): number {
  for (const message of messages.slice(rendered)) {
    const type = message.getType();

    if (type === "ai") {
      const calls = (message as { tool_calls?: { name: string; args: unknown }[] })
        .tool_calls;
      for (const call of calls ?? []) {
        closeDim();
        process.stdout.write(
          `\n${DIM}· ${summarizeCall(call.name, call.args)}${RESET}`,
        );
      }
    }

    if (type === "tool") {
      // MessageContent is a string or an array of content blocks; tools only ever
      // produce the former, but the type has to be narrowed anyway.
      const body =
        typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content);
      const lines = body.split("\n");
      const failed = body.startsWith("Error:") || body.startsWith("error:");
      const summary = failed
        ? (lines[0] ?? "failed")
        : `${String(lines.length)} line${lines.length === 1 ? "" : "s"}`;
      process.stdout.write(`${DIM} → ${summary}${RESET}\n`);
    }
  }

  return messages.length;
}

/** Turns whatever the graph threw into one line a user can act on. */
export function describeError(error: unknown): string {
  const outcome = classify(error);
  if (outcome.kind === "abort") return "^C interrupted";
  if (outcome.reason === "recursion") {
    return `stopped after ${String(RECURSION_LIMIT)} steps without a final answer`;
  }
  if (outcome.reason === "llm_status") {
    const status = outcome.status;
    const message = (outcome.error as { message?: string }).message;
    const hint =
      status === 401 || status === 403
        ? " (check LLM_API_KEY)"
        : status === 429
          ? " (rate limited, or out of balance)"
          : status === 402
            ? " (insufficient balance)"
            : "";
    return `llm ${String(status)}: ${message ?? ""}${hint}`;
  }
  return failureText(outcome.error);
}
