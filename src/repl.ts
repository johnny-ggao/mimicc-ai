import { createInterface } from "node:readline/promises";

import {
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";

import { RECURSION_LIMIT, type AgentGraph } from "./agent";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const BANNER = [
  "mimicc-ai — type a message and press enter",
  "  tools    Read · Write · Edit · Bash · Glob · Grep",
  "  Bash     stops and asks before it runs; the others do not",
  "  /clear   start a new thread; the old one stays in the checkpointer",
  "  /exit    quit (same as Ctrl+D)",
  "  Ctrl+C   interrupt the current reply; at an idle prompt, quit",
].join("\n");

export interface ReplOptions {
  graph: AgentGraph;
  systemPrompt: string;
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

export async function runRepl({ graph, systemPrompt }: ReplOptions): Promise<void> {
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
  // The system message is turn zero of a thread, so it is sent once per thread
  // rather than once per request.
  let seeded = false;
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
      seeded = false;
      rendered = 0;
      process.stdout.write("(new thread)\n\n");
      rl.prompt();
      continue;
    }

    const messages: BaseMessage[] = seeded
      ? [new HumanMessage(input)]
      : [new SystemMessage(systemPrompt), new HumanMessage(input)];
    seeded = true;

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
  if (turn.error !== null) process.stdout.write(`${describe(turn.error)}\n`);
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
  let error: unknown = null;

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
          rendered = renderStructure(state.messages, rendered, closeDim);
        }
        continue;
      }

      const [chunk] = payload as [BaseMessage];
      if (chunk.getType() === "tool") continue; // Rendered from state instead.

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
        process.stdout.write(chunk.content);
      }
    }
  } catch (caught) {
    error = caught;
  } finally {
    // The dim escape has to be closed on every exit path, or an interrupt during
    // reasoning leaves the whole terminal dimmed.
    closeDim();
    process.stdout.write("\n");
  }

  return { requests, rendered, error };
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
        const args = JSON.stringify(call.args);
        process.stdout.write(
          `\n${DIM}· ${call.name} ${args.length > 64 ? `${args.slice(0, 61)}...` : args}${RESET}`,
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
function describe(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const { name, status, message } = error as {
      name?: string;
      status?: number;
      message?: string;
    };

    if (name === "AbortError" || name?.includes("Abort") === true)
      return "^C interrupted";
    if (name === "GraphRecursionError") {
      return `stopped after ${String(RECURSION_LIMIT)} steps without a final answer`;
    }

    const hint =
      status === 401 || status === 403
        ? " (check LLM_API_KEY)"
        : status === 429
          ? " (rate limited, or out of balance)"
          : status === 402
            ? " (insufficient balance)"
            : "";
    if (status !== undefined) return `llm ${String(status)}: ${message ?? ""}${hint}`;
  }

  return error instanceof Error ? error.message : String(error);
}
