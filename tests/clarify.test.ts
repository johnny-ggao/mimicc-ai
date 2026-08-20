import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";

import { createUniversalAgent, RECURSION_LIMIT } from "@/agents";
import { isPinned } from "@/context";
import {
  CLARIFY_TOOL_NAME,
  isClarifyRequest,
  MAX_QUESTIONS,
  readRequest,
  renderAnswers,
  type ClarifyAnswer,
  type ClarifyQuestion,
} from "@/tools";

/**
 * The tool that asks the user a question.
 *
 * Two halves, and the second one is why this file exists at all. The pure half —
 * what the model is allowed to ask, and how the answer reads coming back — is
 * ordinary. The wired half proves the thing `repro/25-interrupt-inside-a-tool-body.ts`
 * measured **broken** for the obvious design: an `interrupt()` raised from inside
 * a tool body is eaten by `stallGuard` (it looks like a throw) and mis-journaled
 * by `toolRecovery` (it looks like a crash). Both of those middlewares are in the
 * stack `createUniversalAgent` builds, so a test that skips them would pass while
 * the shipping program asked nobody anything.
 */

const question = (
  header: string,
  extra: Partial<ClarifyQuestion> = {},
): ClarifyQuestion => ({
  header,
  question: `${header}?`,
  options: [
    { label: "one", description: "the first way" },
    { label: "two", description: "the second way" },
  ],
  ...extra,
});

describe("what the model is allowed to ask", () => {
  test("a well-formed call is read back as its questions", () => {
    const read = readRequest({ questions: [question("持仓周期"), question("技术栈")] });
    expect(read.ok).toBe(true);
    expect(read.ok && read.questions.map((one) => one.header)).toEqual([
      "持仓周期",
      "技术栈",
    ]);
  });

  /**
   * The cap is not decoration. This tool exists because the model asked seven
   * questions in one wall of prose, and a limit the model can ignore would let
   * it rebuild that wall inside a picker.
   */
  test("too many questions is refused with a reason the model can act on", () => {
    const read = readRequest({
      questions: Array.from({ length: MAX_QUESTIONS + 1 }, (_, i) =>
        question(`q${String(i)}`),
      ),
    });
    expect(read.ok).toBe(false);
    expect(read.ok === false && read.reason).toContain(String(MAX_QUESTIONS));
  });

  test("one option is not a choice", () => {
    const read = readRequest({
      questions: [
        { header: "h", question: "q?", options: [{ label: "a", description: "b" }] },
      ],
    });
    expect(read.ok).toBe(false);
  });

  /**
   * Headers are the keys the answers come back under, so two questions sharing
   * one produces a result the model cannot read — `技术栈: bun` twice, and no way
   * to tell which question either belongs to.
   */
  test("two questions may not share a header", () => {
    const read = readRequest({ questions: [question("同名"), question("同名")] });
    expect(read.ok).toBe(false);
    expect(read.ok === false && read.reason).toContain("同名");
  });

  /**
   * ⚠️ The reason this is checked at all: zod validates arguments on the way into
   * a tool *body*, and this tool's body is never entered. Nothing else would
   * catch a malformed call — it would reach `interrupt()` and the console would
   * be handed garbage to render. deer-flow's schema carries the same warning
   * (`clarification_tool.py:8-11`).
   */
  test("nonsense arguments are a refusal, not a throw", () => {
    expect(readRequest(undefined).ok).toBe(false);
    expect(readRequest({ questions: "yes" }).ok).toBe(false);
    expect(readRequest({}).ok).toBe(false);
  });
});

describe("how the answer reads coming back", () => {
  test("keyed by the header the model wrote, not by position", () => {
    const answers: ClarifyAnswer[] = [
      { header: "持仓周期", chosen: ["严格不隔夜"], typed: false },
      { header: "技术栈", chosen: ["bun"], typed: false },
    ];
    expect(renderAnswers(answers)).toBe("持仓周期: 严格不隔夜\n技术栈: bun");
  });

  /** Whether the user picked or wrote is information the model needs: a typed
   * answer is one nobody offered, so it may not fit the plan the options came from. */
  test("a typed answer says so", () => {
    expect(
      renderAnswers([{ header: "h", chosen: ["something else"], typed: true }]),
    ).toContain("typed");
  });

  test("an interrupt from the gate is not mistaken for one of these", () => {
    expect(isClarifyRequest({ kind: "clarify", questions: [] })).toBe(true);
    expect(isClarifyRequest({ actionRequests: [{ name: "Bash" }] })).toBe(false);
    expect(isClarifyRequest(undefined)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * The wired half: a real graph, the real middleware stack, a stub model that
 * calls `Clarify` once and then speaks.
 */
describe("asking, through the stack that broke the obvious design", () => {
  let server: ReturnType<typeof Bun.serve>;
  let calls = 0;

  const completion = (
    id: string,
    message: Record<string, unknown>,
    finish: string,
  ) => ({
    id,
    object: "chat.completion",
    created: 0,
    model: "stub",
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });

  const ASKED = {
    questions: [
      {
        header: "持仓周期",
        question: "「日内」的准确含义是什么？",
        options: [
          { label: "短周期波段", description: "由信号决定出场，不强制隔夜平仓" },
          { label: "严格不隔夜", description: "固定时点平仓，规避资金费率" },
        ],
      },
    ],
  };

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        await request.json();
        calls += 1;
        return Response.json(
          calls === 1
            ? completion(
                "chatcmpl-ask",
                {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "call_clarify_1",
                      type: "function",
                      function: {
                        name: CLARIFY_TOOL_NAME,
                        arguments: JSON.stringify(ASKED),
                      },
                    },
                  ],
                },
                "tool_calls",
              )
            : completion(
                "chatcmpl-done",
                { role: "assistant", content: "收到" },
                "stop",
              ),
        );
      },
    });
  });

  afterAll(() => void server.stop(true));

  const graph = () =>
    createUniversalAgent({
      baseURL: `http://localhost:${String(server.port)}`,
      apiKey: "test-key",
      model: "stub",
    });

  const config = (thread: string) => ({
    recursionLimit: RECURSION_LIMIT,
    configurable: { thread_id: thread },
  });

  test("the question reaches the interrupt, and the answer reaches the model", async () => {
    calls = 0;
    const agent = graph();
    const where = config("clarify-happy");

    const stopped = (await agent.invoke(
      { messages: [new HumanMessage("做个量化程序")] },
      where,
    )) as { __interrupt__?: { value?: unknown }[] };

    // ① It stopped, and what it stopped with is this middleware's payload rather
    //    than the confirmation gate's.
    const value = stopped.__interrupt__?.[0]?.value;
    expect(isClarifyRequest(value)).toBe(true);
    expect(isClarifyRequest(value) && value.questions[0]?.header).toBe("持仓周期");

    // ② Answer it the way the console will.
    const answers: ClarifyAnswer[] = [
      { header: "持仓周期", chosen: ["严格不隔夜"], typed: false },
    ];
    const done = (await agent.invoke(new Command({ resume: answers }), where)) as {
      messages: BaseMessage[];
    };

    // ③ The model got the answer as this call's own result — not `interruptedText`,
    //    which is what `toolRecovery` substituted on the tool-body path (repro/25).
    const result = done.messages.find(
      (message): message is ToolMessage =>
        ToolMessage.isInstance(message) && message.tool_call_id === "call_clarify_1",
    );
    expect(result?.content).toBe("持仓周期: 严格不隔夜");
    expect(result?.content).not.toContain("interrupted");

    // ④ Pinned, by the rule that whoever produces a message pins it. A decision
    //    the user made is the thing a summary must not eat — the model would
    //    redesign against a question it has already been answered.
    expect(result !== undefined && isPinned(result)).toBe(true);

    // ⑤ The turn carried on and the model spoke, so `jumpTo: "model"` routed past
    //    ToolNode rather than ending the turn on a tool result.
    expect(done.messages[done.messages.length - 1]?.getType()).toBe("ai");
  });

  /**
   * The body throws on purpose (see the note in `src/tools/clarify.ts`), so if
   * the interception is ever removed this is the test that says so rather than
   * the model receiving a fabricated answer.
   */
  test("the tool body is never reached", async () => {
    calls = 0;
    const agent = graph();
    const where = config("clarify-body");
    await agent.invoke({ messages: [new HumanMessage("go")] }, where);
    const done = (await agent.invoke(
      new Command({ resume: [{ header: "持仓周期", chosen: ["x"], typed: false }] }),
      where,
    )) as { messages: BaseMessage[] };

    const errored = done.messages.some(
      (message) =>
        ToolMessage.isInstance(message) &&
        JSON.stringify(message.content).includes("must never execute"),
    );
    expect(errored).toBe(false);
  });

  /** Dismissing has to leave the model something to do, or the turn ends on a gap. */
  test("dismissing without answering tells the model to proceed on an assumption", async () => {
    calls = 0;
    const agent = graph();
    const where = config("clarify-dismissed");
    await agent.invoke({ messages: [new HumanMessage("go")] }, where);
    const done = (await agent.invoke(new Command({ resume: [] }), where)) as {
      messages: BaseMessage[];
    };

    const result = done.messages.find(
      (message): message is ToolMessage =>
        ToolMessage.isInstance(message) && message.tool_call_id === "call_clarify_1",
    );
    expect(JSON.stringify(result?.content)).toContain("assumption");
  });
});
