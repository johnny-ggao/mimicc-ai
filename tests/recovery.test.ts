import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HumanMessage } from "@langchain/core/messages";

import { createUniversalAgent, RECURSION_LIMIT } from "@/agents";
import { JsonlSaver, ToolJournal } from "@/checkpoint";
import type { Replay } from "@/tools";

/**
 * What a tool call does when it comes back from the dead.
 *
 * ## Why nothing here kills a process
 *
 * A crash's whole effect on this mechanism is the state it leaves on disk: an
 * intent with no settlement, or a settlement whose result never reached the
 * conversation. Writing that state directly *is* restoring from a crash, and it
 * is the same idiom `tests/checkpoint.test.ts` uses when it opens a second saver
 * over one directory and calls that a restart. The kill itself is covered where
 * it belongs — `repro/13-crash-mid-tool.ts` does it for real.
 *
 * ## Why the assertions are about files rather than call counts
 *
 * There is no seam for injecting a counting tool into this agent, and inventing
 * one would mean testing a graph nobody ships. `Write` leaves a file behind when
 * it runs; asking whether that file exists is a stronger question than asking a
 * spy how many times it was called, because it is the effect itself rather than a
 * proxy for it.
 */

let server: ReturnType<typeof Bun.serve>;
let replies = 0;
/** The call the stub asks for on the turn's first reply. */
let ask: { name: string; args: Record<string, unknown> } = {
  name: "Read",
  args: { path: "package.json" },
};

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { messages: { role: string }[] };
      const answered = body.messages.some((message) => message.role === "tool");
      replies += 1;

      return Response.json({
        // Distinct per reply — messages merge by id, and a reused one makes the
        // second answer overwrite the first in place.
        id: `chatcmpl-${String(replies)}`,
        object: "chat.completion",
        created: 0,
        model: "stub",
        choices: [
          {
            index: 0,
            message: answered
              ? { role: "assistant", content: "done" }
              : {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: { name: ask.name, arguments: JSON.stringify(ask.args) },
                    },
                  ],
                },
            finish_reason: answered ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
});

afterAll(() => void server.stop(true));
beforeEach(() => {
  replies = 0;
  ask = { name: "Read", args: { path: "package.json" } };
});

/**
 * Somewhere to keep thread files, and somewhere `Write` is actually allowed to
 * write.
 *
 * ⚠️ The two cannot be the same place, and getting that wrong makes the tests
 * below pass for the wrong reason. `Write` goes through `resolveInside`, which
 * confines every path to the process's working directory — so a `Write` aimed at
 * a temp directory is refused before it starts, and "the file is not there" would
 * prove nothing about recovery. The target has to sit inside the repository;
 * `.mimicc-outputs/` is already git-ignored, and the control test below is what
 * proves the path really is writable.
 */
const TARGETS = ".mimicc-outputs";

function workspace() {
  mkdirSync(join(process.cwd(), TARGETS), { recursive: true });
  return { state: mkdtempSync(join(tmpdir(), "mimicc-recovery-")) };
}

/** A writable path, relative because that is what the tool takes. */
function target(name: string): { relative: string; absolute: string } {
  const relative = join(TARGETS, `recovery-${name}.txt`);
  return { relative, absolute: join(process.cwd(), relative) };
}

function agentOn(state: string, thread: string) {
  const graph = createUniversalAgent({
    baseURL: `http://localhost:${String(server.port)}`,
    apiKey: "sk-stub",
    model: "stub",
    checkpointer: new JsonlSaver(state),
    stateDir: state,
  });
  return async () =>
    (await graph.invoke(
      { messages: [new HumanMessage("go")] },
      { recursionLimit: RECURSION_LIMIT, configurable: { thread_id: thread } },
    )) as { messages: { content: unknown; getType: () => string }[] };
}

function toolText(out: {
  messages: { content: unknown; getType: () => string }[];
}): string {
  return out.messages
    .filter((message) => message.getType() === "tool")
    .map((message) => String(message.content))
    .join("\n");
}

/** The state a crash leaves: recorded as about to run, never recorded as done. */
async function seedIntent(state: string, thread: string, tool: string, replay: Replay) {
  await new ToolJournal(state, thread).recordIntent({
    toolCallId: "call_1",
    tool,
    args: {},
    replay,
  });
}

test("a call whose result was recorded comes back from the journal, not the tool", async () => {
  const { state } = workspace();
  const journal = new ToolJournal(state, "settled");
  await journal.recordIntent({
    toolCallId: "call_1",
    tool: "Read",
    args: {},
    replay: "safe",
  });
  await journal.recordSettlement({
    toolCallId: "call_1",
    content: "REMEMBERED-not-the-file",
    isError: false,
  });

  const out = await agentOn(state, "settled")();

  // If it had run, this would be package.json with line numbers.
  expect(toolText(out)).toContain("REMEMBERED-not-the-file");
});

/**
 * The control, and it has to come first in the reading order because everything
 * below it is a claim that this did *not* happen.
 */
test("with nothing recorded, the same call writes the file", async () => {
  const { state } = workspace();
  const file = target("control");
  rmSync(file.absolute, { force: true });
  ask = { name: "Write", args: { path: file.relative, content: "hello" } };

  await agentOn(state, "control")();

  expect(existsSync(file.absolute)).toBe(true);
});

/** The case the whole line exists for. */
test("an interrupted unreplayable call is not repeated, and says so", async () => {
  const { state } = workspace();
  const file = target("never");
  rmSync(file.absolute, { force: true });
  ask = { name: "Write", args: { path: file.relative, content: "hello" } };
  await seedIntent(state, "never", "Write", "never");

  const out = await agentOn(state, "never")();

  // The effect itself, not a proxy for it — and the control above is what makes
  // this line mean "recovery stopped it" rather than "Write never works here".
  expect(existsSync(file.absolute)).toBe(false);
  expect(toolText(out)).toContain("interrupted");
  expect(toolText(out)).toContain("unsafe to repeat");
});

/**
 * The synthesised settlement is a record like any other, so a closed turn drops
 * it too.
 *
 * ⚠️ This used to assert `settled` — and it was right to, until the turn started
 * closing itself: `toolRecovery` now prunes on `afterAgent` (ticket 05), and a
 * settled record's whole job is over by then. What the assertion pins now is the
 * pruning, which is why it is not the same test wearing a new name: remove the
 * prune and this fails.
 *
 * The half that moved out of reach — *that* recovery wrote a settlement at all,
 * rather than leaving a bare intent — is only observable while the turn is still
 * open, so it is measured where that is possible: `repro/21-when-a-turn-closes.ts`
 * aborts a batch mid-flight and reads the settlement straight off the file.
 */
test("a closed turn leaves no settled record behind, synthesised or not", async () => {
  const { state } = workspace();
  ask = { name: "Write", args: { path: target("twice").relative, content: "hello" } };
  await seedIntent(state, "twice", "Write", "never");

  const out = await agentOn(state, "twice")();

  // It did settle as interrupted — that is what the model was handed.
  expect(toolText(out)).toContain("interrupted");
  const after = await new ToolJournal(state, "twice").lookup("call_1");
  expect(after.kind).toBe("unrecorded");
});

test("an interrupted call both sides call safe is simply run again", async () => {
  const { state } = workspace();
  await seedIntent(state, "safe", "Read", "safe");

  const out = await agentOn(state, "safe")();

  // It really re-read the file rather than synthesising anything.
  expect(toolText(out)).toContain('"name": "mimicc-ai"');
  expect(toolText(out)).not.toContain("interrupted");
});

/**
 * Both declarations, because `bun run dev` is `--watch`: the program changing
 * between the crash and the restart is the ordinary case here.
 */
test("a declaration that was safe and is not any more does not replay", async () => {
  const { state } = workspace();
  const file = target("was-safe");
  rmSync(file.absolute, { force: true });
  ask = { name: "Write", args: { path: file.relative, content: "hello" } };
  // Recorded as safe by a version that thought so; `Write` says never today.
  await seedIntent(state, "was-safe", "Write", "safe");

  const out = await agentOn(state, "was-safe")();

  expect(existsSync(file.absolute)).toBe(false);
  expect(toolText(out)).toContain("interrupted");
});

test("a declaration that is safe now but was not then does not replay either", async () => {
  const { state } = workspace();
  // `Read` declares safe, but the record from before the crash says never.
  await seedIntent(state, "was-never", "Read", "never");

  const out = await agentOn(state, "was-never")();

  expect(toolText(out)).toContain("interrupted");
});

test("an ordinary call's result reaches the model, and its record does not outlive the turn", async () => {
  const { state } = workspace();

  const out = await agentOn(state, "ordinary")();

  expect(toolText(out)).toContain('"name": "mimicc-ai"');
  // Pruned on `afterAgent`: settled means "already in the conversation", and the
  // conversation is where it lives from here.
  expect((await new ToolJournal(state, "ordinary").lookup("call_1")).kind).toBe(
    "unrecorded",
  );
});
/**
 * A tool that *throws* still settles — as an error, not as an interruption.
 *
 * A throw is "this call ran and failed", not "the process died mid-call". The
 * journal must not confuse the two: an interruption means the outcome is
 * unknown, an error settlement means it is known and bad (tickets 10/11).
 */
test("a call that throws settles as an error, not as an interruption", async () => {
  const { state } = workspace();
  // `Read` throws on a missing file — the ordinary path, not a crash.
  ask = { name: "Read", args: { path: "definitely-not-here.txt" } };

  const out = await agentOn(state, "threw")();

  // The distinction the journal must not blur: an error is a known-bad outcome,
  // an interruption is an unknown one. Read off the message, because the record
  // itself is pruned with the turn.
  expect(toolText(out)).toContain("Error");
  expect(toolText(out)).not.toContain("interrupted");
  expect((await new ToolJournal(state, "threw").lookup("call_1")).kind).toBe(
    "unrecorded",
  );
});

/**
 * The gate runs in `afterModel`, before the tools superstep, so a rejected call
 * never reaches this middleware at all. Worth pinning: a refusal that left an
 * intent behind would make the next resume think a command the user forbade had
 * been about to run.
 */
test("a call the confirmation gate stopped leaves no intent behind", async () => {
  const { state } = workspace();
  ask = { name: "Bash", args: { command: "echo hi" } };

  const out = await agentOn(state, "gated")();

  // The turn parks at the interrupt rather than finishing.
  expect(out).toBeDefined();
  expect((await new ToolJournal(state, "gated").lookup("call_1")).kind).toBe(
    "unrecorded",
  );
});

test("with no state directory the middleware is not installed at all", async () => {
  const { state } = workspace();
  const graph = createUniversalAgent({
    baseURL: `http://localhost:${String(server.port)}`,
    apiKey: "sk-stub",
    model: "stub",
    checkpointer: new JsonlSaver(state),
  });

  await graph.invoke(
    { messages: [new HumanMessage("go")] },
    { recursionLimit: RECURSION_LIMIT, configurable: { thread_id: "no-dir" } },
  );

  // Nothing durable to recover into means nothing worth journalling — but the
  // turn still ran, which is what tells this apart from journalling that failed.
  expect(existsSync(join(state, "no-dir.tools.jsonl"))).toBe(false);
  expect(existsSync(join(state, "no-dir.jsonl"))).toBe(true);
});

afterAll(() => {
  for (const name of ["control", "never", "twice", "was-safe"]) {
    rmSync(target(name).absolute, { force: true });
  }
});
