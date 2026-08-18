import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HumanMessage } from "@langchain/core/messages";

import { createUniversalAgent, RECURSION_LIMIT } from "@/agents";
import { JsonlSaver } from "@/checkpoint";

/**
 * A turn that fails must leave a durable marker the next turn can read — the
 * B'+A half of R6, decided in ticket 05.
 *
 * The seam is the one the loop tests use: the real agent behind a stub server,
 * with a JsonlSaver at a temp directory. The failure is a 200 carrying no
 * choices (a malformed completion), which fails immediately rather than being
 * retried six times with backoff — measured, any failing *status code* is
 * retried, a 200 with no choices is not (see tests/task.test.ts).
 *
 * What is observed: the stub's request log, which is exactly what the model was
 * sent. The marker reaching the next request is the whole point — it is not a
 * console print, it is durable state the projection carried forward.
 */

let server: ReturnType<typeof Bun.serve>;
const requests: { messages: { role: string; content?: unknown }[] }[] = [];
let fail = false;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as (typeof requests)[number];
      requests.push(body);

      if (fail) {
        // A 200 with no choices, never an error status: the latter is retried
        // six times with backoff, this fails on the first attempt.
        return Response.json({ id: "x", object: "chat.completion", choices: [] });
      }

      return Response.json({
        id: `chatcmpl-${String(requests.length)}`,
        object: "chat.completion",
        created: 0,
        model: "stub",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: `answer ${String(requests.length)}`,
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
});

afterAll(() => void server.stop(true));
beforeEach(() => {
  requests.length = 0;
  fail = false;
});

function build() {
  return createUniversalAgent({
    baseURL: `http://localhost:${String(server.port)}`,
    apiKey: "sk-stub",
    model: "stub",
    checkpointer: new JsonlSaver(mkdtempSync(join(tmpdir(), "mimicc-fail-"))),
  });
}

/** The last request's message text, joined — what the model was actually sent. */
function lastRequestText(): string {
  const last = requests.at(-1);
  if (last === undefined) throw new Error("the stub was never called");
  return last.messages
    .map((message) => (typeof message.content === "string" ? message.content : ""))
    .join(" ");
}

async function failureFrom(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return String(error);
  }
  throw new Error("expected this to fail, but it succeeded");
}

test("a failed turn leaves a marker the next turn reads", async () => {
  const graph = build();
  const thread = crypto.randomUUID();

  fail = true;
  const failure = await failureFrom(
    graph.invoke(
      { messages: [new HumanMessage("first")] },
      { recursionLimit: RECURSION_LIMIT, configurable: { thread_id: thread } },
    ),
  );
  expect(failure).not.toBe("");

  fail = false;
  await graph.invoke(
    { messages: [new HumanMessage("second")] },
    { recursionLimit: RECURSION_LIMIT, configurable: { thread_id: thread } },
  );

  expect(lastRequestText()).toContain("[previous turn failed");
});

test("a turn that does not fail leaves no marker", async () => {
  const graph = build();
  const thread = crypto.randomUUID();

  await graph.invoke(
    { messages: [new HumanMessage("first")] },
    { recursionLimit: RECURSION_LIMIT, configurable: { thread_id: thread } },
  );
  await graph.invoke(
    { messages: [new HumanMessage("second")] },
    { recursionLimit: RECURSION_LIMIT, configurable: { thread_id: thread } },
  );

  expect(lastRequestText()).not.toContain("[previous turn failed");
});

test("a turn that fails through stream leaves the marker too", async () => {
  // The console drives the graph through `stream`, and the model's error
  // surfaces when the iterable is consumed — a different path from `invoke`,
  // where it settles the promise. The wrapper must catch both.
  const graph = build();
  const thread = crypto.randomUUID();

  fail = true;
  let threw = "";
  try {
    const events = await graph.stream(
      { messages: [new HumanMessage("first")] },
      {
        streamMode: ["values"],
        recursionLimit: RECURSION_LIMIT,
        configurable: { thread_id: thread },
      },
    );
    for await (const _event of events) {
      // drained; the failure throws out of the loop
    }
  } catch (error) {
    threw = String(error);
  }
  expect(threw).not.toBe("");

  fail = false;
  await graph.invoke(
    { messages: [new HumanMessage("second")] },
    { recursionLimit: RECURSION_LIMIT, configurable: { thread_id: thread } },
  );

  expect(lastRequestText()).toContain("[previous turn failed");
});
