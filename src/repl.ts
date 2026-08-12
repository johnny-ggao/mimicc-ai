import { createInterface } from "node:readline/promises";

import {
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";

import { RECURSION_LIMIT, type AgentGraph } from "./agent";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const BANNER = [
  "mimicc-ai — type a message and press enter",
  "  tools    Read · Glob · Grep (read-only)",
  "  /clear   forget the conversation so far",
  "  /exit    quit (same as Ctrl+D)",
  "  Ctrl+C   interrupt the current reply; at an idle prompt, quit",
].join("\n");

export interface ReplOptions {
  graph: AgentGraph;
  systemPrompt: string;
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

  // Turn zero, and it has to survive /clear: clearing the conversation forgets
  // what the user said, not who the agent is.
  const system = new SystemMessage(systemPrompt);
  let messages: BaseMessage[] = [system];

  process.stdout.write(`${BANNER}\n\n`);
  rl.setPrompt("> ");
  rl.prompt();

  for await (const line of rl) {
    const input = line.trim();

    if (input === "/exit") break;

    if (input.length === 0) {
      rl.prompt();
      continue;
    }

    if (input === "/clear") {
      messages = [system];
      process.stdout.write("(conversation cleared)\n\n");
      rl.prompt();
      continue;
    }

    inFlight = new AbortController();
    const turn = await runTurn(
      graph,
      [...messages, new HumanMessage(input)],
      inFlight.signal,
    );
    inFlight = null;

    // A turn that produced nothing leaves the transcript untouched, rather than
    // recording a question the model never answered.
    if (turn.messages !== null) messages = turn.messages;

    if (turn.error !== null) process.stdout.write(`${describe(turn.error)}\n`);

    process.stdout.write("\n");
    rl.prompt();
  }

  rl.close();
  process.stdout.write("\nbye\n");
}

interface TurnResult {
  /** The graph's final state, or null when the turn produced none. */
  messages: BaseMessage[] | null;
  error: unknown;
}

/**
 * Runs one user turn through the graph and renders it as it arrives.
 *
 * Two stream modes at once, because they answer different questions.
 * `"messages"` carries token-level chunks — that is what makes the reply appear
 * as it is written. `"values"` carries the whole state after each node, which is
 * both the transcript to keep and the only reliable place to notice that a tool
 * ran. Rendering tool activity from state rather than from chunks keeps the two
 * concerns apart: chunks are for prose, state is for structure.
 */
async function runTurn(
  graph: AgentGraph,
  input: BaseMessage[],
  signal: AbortSignal,
): Promise<TurnResult> {
  let latest: BaseMessage[] | null = null;
  let rendered = input.length;
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
    const stream = (await graph.stream(
      { messages: input },
      { streamMode: ["messages", "values"], recursionLimit: RECURSION_LIMIT, signal },
    )) as AsyncIterable<[string, unknown]>;

    for await (const [mode, payload] of stream) {
      if (mode === "values") {
        const state = payload as { messages: BaseMessage[] };
        latest = state.messages;
        rendered = renderStructure(state.messages, rendered, closeDim);
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

  return { messages: latest, error };
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
