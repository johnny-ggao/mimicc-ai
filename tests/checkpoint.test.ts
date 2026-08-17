import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";

import { createUniversalAgent, DURABILITY, RECURSION_LIMIT } from "@/agents";
import { JsonlSaver, resolveStateDir } from "@/checkpoint";
import { readTool } from "@/tools";

/**
 * The seam is the one the loop tests already use: the real agent behind a stub
 * model server. What changes here is that its checkpointer points at a temp
 * directory, which makes the two things worth asserting both observable —
 * **what the model was sent** (the stub's request log) and **what survived on
 * disk** (the thread file).
 *
 * A few tests drive `JsonlSaver` directly instead. Not a second seam: the file
 * *is* a saver's external contract, and a half-written last line cannot be
 * produced through the agent on purpose.
 */

let server: ReturnType<typeof Bun.serve>;
const requests: unknown[] = [];

const completion = (id: string, message: Record<string, unknown>, finish: string) => ({
  id,
  object: "chat.completion",
  created: 0,
  model: "stub",
  choices: [{ index: 0, message, finish_reason: finish }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { messages: { content?: unknown }[] };
      requests.push(body);
      const asked = body.messages
        .map((message) => (typeof message.content === "string" ? message.content : ""))
        .join(" ");

      // One turn in these tests wants the gate to stop it, which needs a Bash
      // call rather than an answer. Keyed off the prompt so every other test
      // keeps the simple stub.
      if (asked.includes("please run something") && !asked.includes("ok")) {
        return Response.json(
          completion(
            `chatcmpl-${String(requests.length)}`,
            {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call_bash",
                  type: "function",
                  function: { name: "Bash", arguments: '{"command":"echo ok"}' },
                },
              ],
            },
            "tool_calls",
          ),
        );
      }

      // Distinct ids per reply: messages merge by id, so a reused one makes the
      // second answer overwrite the first and a lap vanish. Same trap as in
      // tests/agent.test.ts.
      return Response.json(
        completion(
          `chatcmpl-${String(requests.length)}`,
          { role: "assistant", content: `answer ${String(requests.length)}` },
          "stop",
        ),
      );
    },
  });
});

afterAll(() => void server.stop(true));

function stateDir(): string {
  return mkdtempSync(join(tmpdir(), "mimicc-ckpt-"));
}

function agentOn(directory: string) {
  return createUniversalAgent({
    baseURL: `http://localhost:${String(server.port)}`,
    apiKey: "sk-stub",
    model: "stub",
    checkpointer: new JsonlSaver(directory),
  });
}

async function say(graph: ReturnType<typeof agentOn>, thread: string, text: string) {
  // `.invoke`, matching the loop tests: the stub speaks plain JSON completions,
  // and streaming would want SSE. What is being observed here is what landed in
  // the file, which does not depend on how the reply was delivered.
  await graph.invoke(
    { messages: [new HumanMessage(text)] },
    { recursionLimit: RECURSION_LIMIT, configurable: { thread_id: thread } },
  );
}

/**
 * Awaits a rejection and hands back the message.
 *
 * Written out rather than using `expect(...).rejects`, because the lint rule
 * treats that matcher as non-thenable and so the `await` gets dropped — which
 * leaves the turn running into the *next* test, quietly consuming its stub
 * calls. Cost an hour of chasing the wrong failure.
 */
async function failureFrom(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return String(error);
  }
  throw new Error("expected this to fail, but it succeeded");
}

function contentsOf(directory: string): string[] {
  const files = readdirSync(directory);
  const first = files[0];
  if (first === undefined) return [];
  return readFileSync(join(directory, first), "utf8").trimEnd().split("\n");
}

/**
 * The point of the whole ticket: close the process, open it again, still there.
 * A second `JsonlSaver` over the same directory is what "restart" means when the
 * only thing the process held was the replayed file.
 */
test("a thread survives the process that wrote it", async () => {
  const directory = stateDir();
  await say(agentOn(directory), "t1", "first question");
  await say(agentOn(directory), "t1", "second question");

  const reopened = new JsonlSaver(directory);
  const tuple = await reopened.getTuple({ configurable: { thread_id: "t1" } });
  const messages = tuple?.checkpoint.channel_values.messages as { content: unknown }[];

  expect(messages.map((message) => String(message.content))).toEqual([
    "first question",
    "answer 1",
    "second question",
    "answer 2",
  ]);
});

test("each thread gets its own file, and /clear does not disturb the old one", async () => {
  const directory = stateDir();
  const graph = agentOn(directory);
  await say(graph, "keep-me", "in the first thread");
  const before = readFileSync(join(directory, "keep-me.jsonl"), "utf8");

  // What `/clear` does: a new thread id, nothing deleted.
  await say(graph, "fresh", "in the second thread");

  expect(readdirSync(directory).sort()).toEqual(["fresh.jsonl", "keep-me.jsonl"]);
  expect(readFileSync(join(directory, "keep-me.jsonl"), "utf8")).toBe(before);
});

/**
 * The ticket's acceptance criterion. Doubling the turns must roughly double the
 * bytes; the stock arrangement quadruples them, because it writes the whole
 * message list into every checkpoint.
 */
test("bytes on disk grow with the conversation, not with its square", async () => {
  async function bytesFor(turns: number): Promise<number> {
    const directory = stateDir();
    const graph = agentOn(directory);
    for (let turn = 0; turn < turns; turn += 1) {
      await say(graph, "growth", `question ${String(turn)} ${"padding ".repeat(20)}`);
    }
    return statSync(join(directory, "growth.jsonl")).size;
  }

  const small = await bytesFor(8);
  const large = await bytesFor(16);

  // Linear would be 2.0 and quadratic 4.0; the gap is wide enough that a loose
  // bound still tells them apart, and a tight one would be flaky.
  expect(large / small).toBeLessThan(2.6);
}, 20_000);

test("a message survives the round trip with its tool call pairing intact", async () => {
  const directory = stateDir();
  const saver = new JsonlSaver(directory);
  const config = { configurable: { thread_id: "pairing" } };

  const call = new AIMessage({
    id: "a1",
    content: "",
    tool_calls: [{ id: "call_1", name: "Read", args: { path: "package.json" } }],
  });
  const result = new ToolMessage({
    id: "t1",
    tool_call_id: "call_1",
    name: "Read",
    content: "the file",
  });

  await saver.put(
    config,
    {
      v: 4,
      id: "1efb0000-0000-6000-8000-000000000001",
      ts: new Date(0).toISOString(),
      channel_values: { messages: [call, result] },
      channel_versions: {},
      versions_seen: {},
    },
    { source: "update", step: 1, parents: {} },
  );

  const back = (await new JsonlSaver(directory).getTuple(config))?.checkpoint
    .channel_values.messages as [AIMessage, ToolMessage];

  expect(back[0].tool_calls?.[0]?.id).toBe("call_1");
  expect(back[1].tool_call_id).toBe("call_1");
  expect(back[1].name).toBe("Read");
  expect(back[1].content).toBe("the file");
});

/**
 * Interrupting a turn is a keystroke away in this program, so a half-written
 * last line is routine. The three conditions are asserted separately because
 * each one exists to stop a different misdiagnosis.
 */
test("a torn last line is repaired, and the rest of the file survives", async () => {
  const directory = stateDir();
  await say(agentOn(directory), "torn", "a question");

  const path = join(directory, "torn.jsonl");
  const whole = readFileSync(path, "utf8");
  writeFileSync(path, `${whole}{"kind":"checkp`);

  const tuple = await new JsonlSaver(directory).getTuple({
    configurable: { thread_id: "torn" },
  });
  expect(tuple).toBeDefined();
  // The repair rewrites the file rather than tolerating the tear in memory.
  expect(readFileSync(path, "utf8")).toBe(whole);
});

test("a broken line that is not the last one is a corrupt file, not a tear", async () => {
  const directory = stateDir();
  await say(agentOn(directory), "mid", "a question");

  const path = join(directory, "mid.jsonl");
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  lines.splice(1, 0, '{"kind":"messa');
  writeFileSync(path, `${lines.join("\n")}\n`);

  expect(
    await failureFrom(
      new JsonlSaver(directory).getTuple({ configurable: { thread_id: "mid" } }),
    ),
  ).toContain("CorruptSessionFile");
});

test("a last line that parses but is not a known kind is refused, not repaired", async () => {
  const directory = stateDir();
  await say(agentOn(directory), "shape", "a question");

  const path = join(directory, "shape.jsonl");
  writeFileSync(path, `${readFileSync(path, "utf8")}{"kind":"something-else"}\n`);

  expect(
    await failureFrom(
      new JsonlSaver(directory).getTuple({ configurable: { thread_id: "shape" } }),
    ),
  ).toContain("CorruptSessionFile");
});

/**
 * The reason this saver does not use LangChain's general `load()`: a session
 * file is a file, and in development it sits inside the working directory.
 * Naming a class that is not a message must fail rather than construct it.
 */
test("a hand-edited line naming a foreign type is refused", async () => {
  const directory = stateDir();
  await say(agentOn(directory), "tamper", "a question");

  const path = join(directory, "tamper.jsonl");
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  const patched = lines.map((line) =>
    line.includes('"kind":"message"')
      ? line.replace('"type":"human"', '"type":"ChatPromptTemplate"')
      : line,
  );
  writeFileSync(path, `${patched.join("\n")}\n`);

  expect(
    await failureFrom(
      new JsonlSaver(directory).getTuple({ configurable: { thread_id: "tamper" } }),
    ),
  ).toMatch(/unexpected type/i);
});

test("the state directory is out of the tools' reach", async () => {
  // Not a credential, but the same rule: this is the agent's own past
  // conversations, and reading them back into itself is a channel nothing in
  // the design asks for.
  expect(
    await failureFrom(readTool.invoke({ path: ".mimicc/some-thread.jsonl" })),
  ).toMatch(/credentials/);
});

test("where history lives depends on the environment, and can be overridden", () => {
  const cwd = "/tmp/some-repo";

  expect(resolveStateDir({ nodeEnv: "development", cwd })).toBe(
    "/tmp/some-repo/.mimicc",
  );
  // Released builds stay out of somebody else's repository.
  expect(resolveStateDir({ nodeEnv: "production", cwd })).toMatch(
    /\/\.mimicc\/some-repo-[0-9a-f]{12}$/,
  );
  // Two checkouts of the same project must not share a history.
  expect(resolveStateDir({ nodeEnv: "production", cwd })).not.toBe(
    resolveStateDir({ nodeEnv: "production", cwd: "/elsewhere/some-repo" }),
  );
  expect(resolveStateDir({ nodeEnv: "production", cwd, override: "/explicit" })).toBe(
    "/explicit",
  );
});

test("the file is readable without a program", async () => {
  // The reason JSONL was chosen over sqlite. If this ever stops holding, the
  // trade-off that justified the format is gone.
  const directory = stateDir();
  await say(agentOn(directory), "legible", "hello");

  const kinds = contentsOf(directory).map(
    (line) => (JSON.parse(line) as { kind: string }).kind,
  );
  expect(kinds).toContain("message");
  expect(kinds).toContain("checkpoint");

  const message = contentsOf(directory)
    .map((line) => JSON.parse(line) as { kind: string; data?: { type: string } })
    .find((line) => line.kind === "message");
  expect(message?.data?.type).toBe("human");
});

/**
 * The hardest path through this saver, and the one nothing else reaches.
 *
 * `interrupt()` is why a checkpointer is mandatory at all: pausing mid-run means
 * persisting the run so it can be resumed. That persistence goes through
 * `putWrites`, and resuming reads it back as `pendingWrites` — the one part of
 * the interface the happy path never exercises. Resuming through a *second*
 * saver over the same directory is what proves it round-tripped through the
 * file rather than through memory that happened to still be there.
 */
test("a turn paused at the confirmation gate resumes after a restart", async () => {
  const directory = stateDir();
  const config = {
    recursionLimit: RECURSION_LIMIT,
    configurable: { thread_id: "gated" },
  };

  const paused = await agentOn(directory).invoke(
    { messages: [new HumanMessage("please run something")] },
    config,
  );
  // The gate stopped it: no answer yet, and an interrupt is on the state.
  expect(paused.messages.at(-1)?.getType()).toBe("ai");

  const state = await new JsonlSaver(directory).getTuple({
    configurable: { thread_id: "gated" },
  });
  expect(state?.pendingWrites?.length ?? 0).toBeGreaterThan(0);

  const resumed = await agentOn(directory).invoke(
    new Command({ resume: { decisions: [{ type: "approve" }] } }),
    config,
  );

  const kinds = resumed.messages.map((message: BaseMessage) => message.getType());
  expect(kinds).toContain("tool");
  expect(resumed.messages.at(-1)?.getType()).toBe("ai");
});

/**
 * `durability: "sync"` — what it buys, and why the test has to slow the disk down
 * to see it.
 *
 * The difference between `"sync"` and the default `"async"` is *when* a checkpoint
 * reaches the disk, and in a process that runs to completion everything reaches
 * the disk eventually. So the honest in-process observation is not "did it land"
 * but **"did the run wait for it"** — and that is only visible if landing takes
 * long enough to notice. Hence `SlowSaver`: every `put` sleeps before it appends,
 * and the stub records how many writes were still in flight when the model was
 * next called.
 *
 * Under `"sync"` the barrier at `pregel/loop.js:475` sits between the checkpoint
 * and the next superstep's tasks, so no model request can arrive with a write
 * outstanding. Under the default it can, and the second half of this test asserts
 * exactly that — a guarantee that cannot fail is not being tested.
 *
 * The behaviour this protects against a real crash is pinned in
 * `repro/13-crash-mid-tool.ts`, which does the SIGKILL that a unit test cannot.
 */
class SlowSaver extends JsonlSaver {
  inFlight = 0;
  readonly seenInFlight: number[] = [];

  override async put(
    ...args: Parameters<JsonlSaver["put"]>
  ): ReturnType<JsonlSaver["put"]> {
    this.inFlight += 1;
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return await super.put(...args);
    } finally {
      this.inFlight -= 1;
    }
  }
}

async function writesOutstandingDuringRun(
  durability: "sync" | undefined,
): Promise<number[]> {
  const saver = new SlowSaver(stateDir());
  const observed: number[] = [];
  const local = Bun.serve({
    port: 0,
    fetch() {
      observed.push(saver.inFlight);
      const lap = observed.length;
      return Response.json(
        completion(
          `chatcmpl-slow-${String(lap)}`,
          lap === 1
            ? {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "call_slow_read",
                    type: "function",
                    function: { name: "Read", arguments: '{"path":"package.json"}' },
                  },
                ],
              }
            : { role: "assistant", content: "done" },
          lap === 1 ? "tool_calls" : "stop",
        ),
      );
    },
  });

  try {
    const graph = createUniversalAgent({
      baseURL: `http://localhost:${String(local.port)}`,
      apiKey: "sk-stub",
      model: "stub",
      checkpointer: saver,
    });
    await graph.invoke(
      { messages: [new HumanMessage("read it")] },
      {
        recursionLimit: RECURSION_LIMIT,
        configurable: { thread_id: "durability" },
        ...(durability === undefined ? {} : { durability }),
      },
    );
  } finally {
    void local.stop(true);
  }
  // The first request happens before anything has been written, so it is never
  // evidence either way.
  return observed.slice(1);
}

test("durability sync makes the run wait for each checkpoint to land", async () => {
  expect(DURABILITY).toBe("sync");
  const outstanding = await writesOutstandingDuringRun(DURABILITY);

  expect(outstanding.length).toBeGreaterThan(0);
  expect(outstanding.every((count) => count === 0)).toBe(true);
});

test("without it a model call can happen while a checkpoint is still in flight", async () => {
  // The control. If this ever goes green the test above proves nothing, because
  // it would be passing on a guarantee the default already gives.
  const outstanding = await writesOutstandingDuringRun(undefined);

  expect(outstanding.some((count) => count > 0)).toBe(true);
});

/**
 * `checkpointDuring: false` maps silently to `durability: "exit"`
 * (`pregel/index.js:886-889`), which writes nothing until the run ends — a kill
 * mid-turn then loses everything. Nobody passes it today; this is the tripwire for
 * the day somebody adds it as a "write less to disk" optimisation.
 */
test("nothing in src reaches for checkpointDuring", async () => {
  const hits = await Array.fromAsync(
    new Bun.Glob("src/**/*.ts").scan({ cwd: join(import.meta.dir, "..") }),
  );
  // Comment lines are skipped, because the constant's own doc block names the
  // thing it is warning about. Crude — a `//` trailing a statement would slip
  // through — but the failure this guards is somebody *passing* the option, and
  // that lands at the start of a line in a config object.
  const offenders = hits.filter((file) =>
    readFileSync(join(import.meta.dir, "..", file), "utf8")
      .split("\n")
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .some((line) => line.includes("checkpointDuring")),
  );

  expect(offenders).toEqual([]);
});
