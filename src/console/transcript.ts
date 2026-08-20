import type { BaseMessage } from "@langchain/core/messages";

import {
  isInjected,
  isSkillActivation,
  SKILL_ACTIVATION_PREFIX,
  SUMMARY_SOURCE,
} from "../context";
import { TASK_TOOL_NAME } from "../tools";
import { markdownStream } from "./markdown";

/**
 * Turning stored messages back into the lines a terminal shows.
 *
 * Two callers with the same problem and different timing. The live loop renders
 * a turn *as it arrives* — prose streams through `markdown.ts`, structure comes
 * off the values stream — and it never renders the user's own line, because
 * readline already echoed it. Resuming has neither advantage: the messages are
 * all there at once, and **nothing in this process ever echoed them**.
 *
 * So the shared piece is not the loop, it is the vocabulary: what one tool call
 * looks like on one line, what one result looks like. Both live here so the two
 * paths cannot drift into printing the same call two different ways — a
 * transcript that changes shape halfway down is worse than either shape.
 */

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** How much of a call's arguments fit on one line. */
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

/**
 * One line standing in for a tool's output.
 *
 * A line count rather than the output, because the output is why this is a
 * summary at all: a `Bash` that ran `ls -R` is thousands of lines the model
 * needed and the reader does not. A failure is the exception — the first line of
 * an error is the one thing worth the width, since it is what the next turn is
 * about.
 */
export function summarizeResult(message: BaseMessage): string {
  // MessageContent is a string or an array of content blocks; tools only ever
  // produce the former, but the type has to be narrowed anyway.
  const body =
    typeof message.content === "string"
      ? message.content
      : JSON.stringify(message.content);
  const lines = body.split("\n");
  const failed = body.startsWith("Error:") || body.startsWith("error:");
  if (failed) return lines[0] ?? "failed";
  return `${String(lines.length)} line${lines.length === 1 ? "" : "s"}`;
}

/**
 * The whole of a restored session, as scrollback.
 *
 * ## Why this exists at all
 *
 * `adopt` used to print one banner line and set the watermark to the end of the
 * history, which reads in code as "these are already rendered" and on screen as
 * **the conversation is gone**. It is not gone — the model gets every message
 * back, `getState` proves it — but the person is the one who has to decide what
 * to type next, and they were being asked to do that against a blank terminal.
 * Restoring state without restoring the transcript restores half the session.
 *
 * ## What is left out, and why that is not a cap
 *
 * Everything the *user and the model* said is printed, however long the session
 * is: a limit here would be this file quietly deciding which part of somebody's
 * own conversation they are allowed to see, and the reason they resumed is
 * usually further back than the last exchange.
 *
 * What is dropped is the harness talking to itself. Four middlewares inject a
 * `HumanMessage` that no human typed — project instructions, memory, the skill
 * catalogue, a skill activation — and they are told apart by the `PINNED` marker
 * their producers already set (`context/projection.ts`), not by sniffing their
 * text. That is the same contract `session/read.ts` leans on for titles, and for
 * the same reason: **the marker is a promise, the content is a payload.** The
 * catalogue alone was 3k characters of tool descriptions in a five-message
 * session — printing it would bury the two lines that were actually said.
 *
 * A skill activation is the one pinned message with a human behind it, so it is
 * replayed as the `/name` that caused it rather than as the skill's body.
 */
export function renderHistory(messages: readonly BaseMessage[]): string {
  let out = "";
  const markdown = markdownStream((text) => {
    out += text;
  });

  let printed = 0;
  for (const message of messages) {
    const type = message.getType();

    if (type === "human") {
      const line = humanLine(message);
      if (line === undefined) continue;
      out += `${line}\n`;
      printed += 1;
      continue;
    }

    if (type === "ai") {
      const text = textOf(message);
      if (text !== "") {
        out += "\n";
        markdown.push(text);
        markdown.flush();
        out += "\n";
        printed += 1;
      }
      const calls = (message as { tool_calls?: { name: string; args: unknown }[] })
        .tool_calls;
      for (const call of calls ?? []) {
        out += `${DIM}· ${summarizeCall(call.name, call.args)}${RESET}\n`;
        printed += 1;
      }
      continue;
    }

    if (type === "tool") {
      out += `${DIM} → ${summarizeResult(message)}${RESET}\n`;
      printed += 1;
    }
  }

  // Nothing survived the filter — a session whose only messages are injections,
  // which is what a run that died before its first reply leaves behind. Saying
  // so beats printing a rule with nothing above it.
  if (printed === 0) return "";

  // The reader has to be able to tell where the past stops. Without this the
  // first thing they type lands directly under a reply they did not just get,
  // and the two are indistinguishable in scrollback.
  return `${out}${DIM}────── 以上为恢复的历史 ──────${RESET}\n\n`;
}

/**
 * How one stored human message is shown, or `undefined` if it is plumbing.
 *
 * The `> ` is not decoration: it is what readline itself put in front of that
 * line when it was first typed, so a replayed session and a live one read the
 * same way.
 */
function humanLine(message: BaseMessage): string | undefined {
  // Which messages are the harness talking to itself is decided in one place
  // (`context/projection.ts`), because the session lister has to reach the same
  // verdict: a list that says five and a replay that shows three are two numbers
  // about the same conversation.
  if (isInjected(message)) return undefined;

  if (message.additional_kwargs["lc_source"] === SUMMARY_SOURCE) {
    // Dim, because it is not a sentence anybody typed — it is the shape the
    // earlier part of this conversation was compressed into.
    return `${DIM}${textOf(message)}${RESET}`;
  }

  // Not injected, and yet not the text either: a person typed `/tdd`, and what
  // is in the history is the skill's whole body. Replaying that would repeat the
  // catalogue's mistake at the size of a whole skill.
  if (isSkillActivation(message)) {
    return `> /${(message.id ?? "").slice(SKILL_ACTIVATION_PREFIX.length)}`;
  }

  return `> ${textOf(message)}`;
}

/** A message's text, whether it was stored as a string or as content blocks. */
function textOf(message: BaseMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: unknown) => {
      const part = block as { type?: unknown; text?: unknown } | null;
      return part?.type === "text" && typeof part.text === "string" ? part.text : "";
    })
    .join("");
}

function clip(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 3)}...` : text;
}
