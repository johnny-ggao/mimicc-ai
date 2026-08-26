import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";

import { classify, DURABILITY, RECURSION_LIMIT, type AgentGraph } from "../agents";
import { isClarifyRequest, type ClarifyAnswer } from "../tools/clarify";

/**
 * One turn, no terminal: the shape a benchmark harness can invoke.
 *
 * ## Why this exists rather than a flag on the repl
 *
 * Harbor's `BaseInstalledAgent` — the interface Terminal-Bench runs an agent
 * through — installs a CLI into the task container and runs it once, with the
 * task as an argument. Until now this program had no such shape: `args.ts`
 * offered `--auto` and `--resume` and nothing else, so it could only be driven
 * by a person typing.
 *
 * ## Why not reuse `runTurn`
 *
 * That function is not exported, and the reason is visible in its body: it is
 * the terminal renderer — dim tool lines, streamed markdown, the subagent
 * activity dots, the thinking row. A headless run wants none of it. Sharing the
 * *graph* is what matters, and both paths share that.
 *
 * ## 🔴 Nobody is attached, so the gate refuses
 *
 * The confirmation gate interrupts. With no reader, the only honest answers are
 * "refuse" or "hang", and hanging is not an answer. So every request the gate
 * raises is **rejected with a reason the model can read** — it is a pinned
 * refusal like any other, so the model can route around it or say plainly that
 * it could not proceed.
 *
 * ⚠️ **The consequence is deliberate and it is severe**: without `--auto`, a
 * real task gets almost nothing done, because the baseline asks about every
 * mutating call and every `Bash`. That is the point. `auto` is the user saying
 * "stop asking" (CONTEXT.md 「自动模式」), and a headless flag that says it on
 * their behalf would be a back door into the posture switch. A caller who wants
 * work done passes `--auto` themselves.
 */
export interface OnceOptions {
  graph: AgentGraph;
  /** What the caller wants done, as one turn's input. */
  task: string;
  /** The thread this runs on. A fresh uuid unless a caller pins one. */
  session?: string;
}

export interface OnceResult {
  /** The model's final reply, or "" when the turn produced none. */
  text: string;
  /** False when the turn threw, was aborted, or ran out of steps. */
  ok: boolean;
  /** How many gate requests were refused for want of a human. */
  refused: number;
  /** Present only when the turn ended badly. */
  error?: string;
}

/** What the gate is told when there is no one to ask. */
export const NO_HUMAN =
  "Rejected: this session is running non-interactively (--print), so there is " +
  "no one to approve it. Either do the task with calls that need no approval, " +
  "or stop and say plainly what you could not do. Re-running the same call will " +
  "be rejected again.";

/** What Clarify is told, for the same reason. */
const NO_HUMAN_ANSWER =
  "No one is attached to this session — decide it yourself and say what you assumed.";

interface Interrupt {
  actionRequests?: { name?: string }[];
  questions?: { header?: string }[];
}

/**
 * Answers whatever the graph parked on, without a human.
 *
 * Two interrupt sources with different payloads, told apart the same way the
 * repl tells them apart — by the clarify tag rather than by "has no
 * actionRequests", because absence is also what an unrelated third source would
 * look like, and reading that as a gate with an empty batch would auto-approve
 * it.
 */
function answer(value: unknown): { command: Command; refused: number } {
  const parked = value as Interrupt | undefined;

  if (isClarifyRequest(value)) {
    const answers: ClarifyAnswer[] = (parked?.questions ?? []).map((question) => ({
      header: typeof question.header === "string" ? question.header : "?",
      chosen: [NO_HUMAN_ANSWER],
      // Typed, not chosen: this is free text, and saying otherwise would tell
      // the model one of its own options was picked.
      typed: true,
    }));
    return { command: new Command({ resume: answers }), refused: 0 };
  }

  const requests = parked?.actionRequests ?? [];
  return {
    command: new Command({
      resume: {
        decisions: requests.map(() => ({ type: "reject" as const, message: NO_HUMAN })),
      },
    }),
    refused: requests.length,
  };
}

/**
 * Runs one turn to completion and returns what the model said.
 *
 * The loop is over *interrupts*, not over model calls: the graph handles its own
 * tool laps, and this comes back only when something is parked. The bound is a
 * guard against a graph that parks forever, not a budget — a turn that legitimately
 * asks eight times has already told us something is wrong with the run.
 */
export async function runOnce({
  graph,
  task,
  session = crypto.randomUUID(),
}: OnceOptions): Promise<OnceResult> {
  const controller = new AbortController();
  let input: { messages: BaseMessage[] } | Command = {
    messages: [new HumanMessage(task)],
  };
  let refused = 0;

  for (let park = 0; park < 16; park += 1) {
    let parked: unknown;

    try {
      const stream = await graph.stream(input, {
        streamMode: ["messages", "values"],
        recursionLimit: RECURSION_LIMIT,
        durability: DURABILITY,
        signal: controller.signal,
        configurable: { thread_id: session },
      });

      // Drained rather than read: the values events carry the interrupt, and the
      // messages events are the terminal renderer's business, not this one's.
      for await (const event of stream as AsyncIterable<[string, unknown]>) {
        const [mode, payload] = event;
        if (mode !== "values") continue;
        const value = (payload as { __interrupt__?: { value?: unknown }[] })
          .__interrupt__?.[0]?.value;
        if (value !== undefined) parked = value;
      }
    } catch (error) {
      const outcome = classify(error);
      return {
        text: "",
        ok: false,
        refused,
        error: outcome.kind === "abort" ? "interrupted" : String(error).slice(0, 300),
      };
    }

    if (parked === undefined) break;

    const reply = answer(parked);
    refused += reply.refused;
    input = reply.command;
  }

  const state = await graph.getState({ configurable: { thread_id: session } });
  return { text: finalText(state.values.messages ?? []), ok: true, refused };
}

/**
 * The last thing the model said in its own voice.
 *
 * Walked from the end rather than filtered, because the interesting message is
 * always the last one and a long thread is mostly tool traffic.
 */
function finalText(messages: BaseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message === undefined || message.getType() !== "ai") continue;
    if (typeof message.content === "string" && message.content.trim() !== "") {
      return message.content;
    }
  }
  return "";
}
