import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { interrupt } from "@langchain/langgraph";
import { createMiddleware, tool, type AnyAgentMiddleware } from "langchain";
import { z } from "zod";

import { PINNED } from "../context";
import { NEVER_REPLAY } from "./replay";

/**
 * Asking the user a question the model cannot answer by reading code.
 *
 * ## Why the tool body is empty
 *
 * It never runs. The middleware below intercepts the call in `afterModel`,
 * `interrupt()`s there, and hands the answers back as the call's own
 * `ToolMessage` — the tool is a **schema declaration**, nothing more.
 *
 * That is not the design anyone reaches for first. The obvious one is to
 * `interrupt()` inside the body, and it is measured broken here
 * (`repro/25-interrupt-inside-a-tool-body.ts`), by our own code:
 *
 * - `stallGuard` turns a throwing tool into a readable `ToolMessage`, and
 *   langgraph implements `interrupt()` **as a throw** — so the question never
 *   reaches the user and the model reads `"GraphInterrupt: … Please fix your
 *   mistakes."`.
 * - `toolRecovery` cannot tell "paused to ask a human" from "the process died
 *   mid-call": the gate opens, but on resume the call is journaled as
 *   interrupted-and-unsafe-to-repeat and `interruptedText` replaces the answer.
 * - Even with neither installed, **the body re-runs from the top on resume**
 *   (`body-entered` twice), which would make idempotence a contract requirement
 *   nobody can enforce.
 *
 * `afterModel` has none of those problems: there is no body to re-run, and
 * neither `wrapToolCall` middleware ever sees it. deer-flow arrived at the same
 * place from the product side rather than from a probe — its `ask_clarification`
 * body is a one-line placeholder reading *"The actual logic is handled by
 * ClarificationMiddleware which intercepts this tool call"*
 * (`backend/packages/harness/deerflow/tools/builtins/clarification_tool.py:22`).
 *
 * ## Why the arguments are validated twice
 *
 * The zod schema below is what the **model** sees, and it is the only thing zod
 * is doing here: `ToolNode` validates arguments on the way into a tool body, and
 * this body is never entered. So {@link readRequest} re-checks the same shape at
 * runtime, defensively. deer-flow's schema carries the identical warning for the
 * identical reason (`clarification_tool.py:8-11`).
 *
 * ## Why free text is not an option the model can switch off
 *
 * Every question always accepts something typed instead. pi makes that a flag
 * (`allowOther`, defaulting true — `packages/coding-agent/examples/extensions/
 * questionnaire.ts:87`); here it is not a flag, because there is no version of
 * this program where trapping the user inside four options the model thought of
 * is the right behaviour. A flag would only be a way to get that wrong.
 */

/** The one literal: the name the model types, and the name the middleware matches. */
export const CLARIFY_TOOL_NAME = "Clarify";

/**
 * How many questions one call may carry.
 *
 * deer-flow argues for exactly one — *"Ask ONE clarification at a time for
 * clarity"* (`clarification_tool.py:66`) — and pi allows several behind a tab
 * bar. The cap is the middle: several are allowed because the decisions that
 * block a design usually come in a set, and asking them one round-trip at a time
 * is what produced the seven-question wall of prose this tool exists to replace.
 * Four is where a tab bar still fits one line.
 */
export const MAX_QUESTIONS = 4;

/** Options per question. Two is a choice; more than four is a list, not a decision. */
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;

/** Widths, so one question renders inside a terminal without wrapping into soup. */
const HEADER_WIDTH = 12;
const QUESTION_WIDTH = 200;
const LABEL_WIDTH = 60;
const DESCRIPTION_WIDTH = 240;

/** One thing the user can pick. */
export interface ClarifyOption {
  /** The choice itself, short enough to read in a list. */
  label: string;
  /** What picking it commits to — the trade-off, not a restatement of the label. */
  description: string;
}

/** One question. */
export interface ClarifyQuestion {
  /** Two or three words naming the decision. The tab label, and the answer's key. */
  header: string;
  /** The question as a person would read it. */
  question: string;
  options: ClarifyOption[];
}

/** What the user chose, one per question, in the order they were asked. */
export interface ClarifyAnswer {
  header: string;
  /**
   * An array even though today's console picks one, because the shape is the
   * expensive half to change: multi-select is a renderer that returns two
   * entries, and a `string` here would make that a migration of everything the
   * model has already been told.
   */
  chosen: string[];
  /** True when this is something typed rather than one of the options. */
  typed: boolean;
}

const optionSchema = z.object({
  label: z.string().min(1).max(LABEL_WIDTH).describe("The choice, in a few words"),
  description: z
    .string()
    .min(1)
    .max(DESCRIPTION_WIDTH)
    .describe(
      "What picking this commits to: the trade-off it accepts, not a restatement of the label",
    ),
});

const questionSchema = z.object({
  header: z
    .string()
    .min(1)
    .max(HEADER_WIDTH)
    .describe("Two or three words naming the decision, e.g. 持仓周期, Auth method"),
  question: z
    .string()
    .min(1)
    .max(QUESTION_WIDTH)
    .describe("The question, plus one clause on why the answer changes what you build"),
  options: z
    .array(optionSchema)
    .min(MIN_OPTIONS)
    .max(MAX_OPTIONS)
    .describe("Distinct answers. Put the one you recommend first"),
});

export const clarifySchema = z.object({
  questions: z
    .array(questionSchema)
    .min(1)
    .max(MAX_QUESTIONS)
    .describe("The decisions you need settled before you can proceed"),
});

/**
 * The declaration the model sees. **The body is unreachable** — see the note at
 * the top of this file — and it throws rather than returning a placebo string so
 * that a future change routing around the middleware fails loudly instead of
 * feeding the model a fabricated answer.
 */
export const clarifyTool = tool(
  () => {
    throw new Error(
      `${CLARIFY_TOOL_NAME} is answered by its middleware and must never execute; ` +
        `see the note in src/tools/clarify.ts`,
    );
  },
  {
    name: CLARIFY_TOOL_NAME,
    description:
      "Ask the user to settle decisions you cannot settle by reading the code. " +
      "Use it when several valid answers exist and picking wrong would waste real work — " +
      "not for anything the repository can tell you. Each question carries 2–4 concrete " +
      "options with the trade-off each one accepts; the user can also type an answer of " +
      "their own. Ask in one call rather than one question per turn, and say nothing else " +
      "in the same turn.",
    schema: clarifySchema,
    // Declared, and **moot at runtime**: `toolRecovery` hangs off `wrapToolCall`,
    // which only fires when a body runs, and this one never does. Declared anyway
    // because the exhaustiveness gate asserts that a decision was taken
    // (`tests/tools/replay.test.ts`), and `never` is the answer that stays right
    // if the interception is ever removed — a crash can land *after* the user
    // answered, and re-running would throw their answer away and ask again.
    metadata: { ...NEVER_REPLAY },
  },
);

/**
 * Reads the model's arguments, or says what is wrong with them in a sentence the
 * model can act on.
 *
 * A returned reason becomes the tool's own error result, so a malformed call
 * costs one round-trip and self-corrects. Throwing instead would surface as a
 * harness crash for something the model is allowed to get wrong.
 */
export function readRequest(
  args: unknown,
): { ok: true; questions: ClarifyQuestion[] } | { ok: false; reason: string } {
  const parsed = clarifySchema.safeParse(args);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.join(".") ?? "questions";
    return {
      ok: false,
      reason:
        `${CLARIFY_TOOL_NAME} was called with arguments that do not fit its schema ` +
        `(${where}: ${first?.message ?? "invalid"}). At most ${String(MAX_QUESTIONS)} ` +
        `questions, each with ${String(MIN_OPTIONS)}–${String(MAX_OPTIONS)} options. ` +
        `Fix the call and ask again.`,
    };
  }

  // Headers are the answers' keys, so two questions sharing one make the result
  // ambiguous to the model that reads it back.
  const headers = new Set<string>();
  for (const question of parsed.data.questions) {
    if (headers.has(question.header)) {
      return {
        ok: false,
        reason:
          `Two questions share the header "${question.header}". Headers name the answers, ` +
          `so they have to differ. Fix the call and ask again.`,
      };
    }
    headers.add(question.header);
  }

  return { ok: true, questions: parsed.data.questions };
}

/** What the interrupt carries out to the console. */
export interface ClarifyRequest {
  kind: "clarify";
  questions: ClarifyQuestion[];
}

/** Whether an interrupt value is this middleware's rather than the confirmation gate's. */
export function isClarifyRequest(value: unknown): value is ClarifyRequest {
  return (value as ClarifyRequest | null)?.kind === "clarify";
}

/**
 * The answers, as the model reads them.
 *
 * Keyed by header rather than by position, because the model wrote the headers
 * and a numbered list would make it count rows to find out what it asked.
 */
export function renderAnswers(answers: readonly ClarifyAnswer[]): string {
  if (answers.length === 0) return "The user answered nothing.";
  return answers
    .map((answer) => {
      const chosen =
        answer.chosen.length === 0 ? "(no answer)" : answer.chosen.join(", ");
      return `${answer.header}: ${chosen}${answer.typed ? "  (typed, not one of the options)" : ""}`;
    })
    .join("\n");
}

/**
 * Turns a `Clarify` call into a question for the user and its answer back again.
 *
 * ## Why the tool call stays on the message
 *
 * The obvious tidy-up — drop the call now that it will never run — produces a
 * `ToolMessage` answering nothing, and `repro/19-orphan-tool-call.ts` measured
 * what a provider does with that mismatch: **a hard 400**. langchain's own HITL
 * keeps rejected calls on the message for the same reason
 * (`agents/middleware/hitl.js:498`). So the call stays, the answer is attached
 * to its id, and `jumpTo: "model"` is what stops `ToolNode` from running it.
 *
 * ## Why sibling tool calls are dropped
 *
 * A turn that asks a question and also reads three files loses the reads. That
 * is the same trade HITL makes on a rejection (`hitl.js:491` keeps only the
 * rejected calls) and it is the safe direction: the alternative is running work
 * that was planned **before** the user answered, against the answer they gave.
 * The model reissues what it still wants. The prompt tells it to ask alone.
 */
export function clarifyGate(): AnyAgentMiddleware {
  return createMiddleware({
    name: "Clarify",
    afterModel: {
      canJumpTo: ["model"],
      hook: (state: { messages?: BaseMessage[] }) => {
        const messages = state.messages ?? [];
        const last = messages[messages.length - 1];
        if (last === undefined || !AIMessage.isInstance(last)) return;

        const calls = last.tool_calls ?? [];
        const asking = calls.filter((call) => call.name === CLARIFY_TOOL_NAME);
        if (asking.length === 0) return;

        // Only ever the first. Two `Clarify` calls in one message is the model
        // asking twice at once; answering the first and dropping the second is
        // the same shape as dropping siblings, and it keeps the console's job
        // to one question set at a time.
        const call = asking[0];
        if (call === undefined) return;
        last.tool_calls = [call];

        const answer = (
          content: string,
          failed: boolean,
        ): { messages: BaseMessage[]; jumpTo: "model" } => ({
          messages: [
            last,
            new ToolMessage({
              content,
              name: CLARIFY_TOOL_NAME,
              tool_call_id: call.id ?? CLARIFY_TOOL_NAME,
              ...(failed ? { status: "error" as const } : {}),
              // Pinned at construction, by the rule that whoever produces a
              // message pins it (`context/projection.ts`). A decision the user
              // made is exactly the thing a summary must not eat: the model
              // would redesign against a question it has already been answered.
              additional_kwargs: { ...PINNED },
            }),
          ],
          jumpTo: "model",
        });

        const request = readRequest(call.args);
        if (!request.ok) return answer(request.reason, true);

        // The interrupt. First time through this throws and the value reaches
        // the console; on resume it returns whatever was sent back.
        // Annotated rather than asserted: `interrupt` is typed to return whatever
        // the caller says, so an `as` here is a cast that changes nothing and
        // eslint says so. The annotation carries the same claim honestly — this
        // is what the console is contracted to send back.
        const chosen: ClarifyAnswer[] | undefined = interrupt({
          kind: "clarify",
          questions: request.questions,
        } satisfies ClarifyRequest);

        if (chosen === undefined || chosen.length === 0) {
          return answer(
            "The user dismissed the question without answering. Do not ask again — " +
              "proceed on your best reading and say which assumption you made.",
            true,
          );
        }

        return answer(renderAnswers(chosen), false);
      },
    },
  }) as AnyAgentMiddleware;
}
