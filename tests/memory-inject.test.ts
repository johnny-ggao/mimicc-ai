import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { createUniversalAgent, DURABILITY, RECURSION_LIMIT } from "@/agents";
import { JsonlSaver } from "@/checkpoint";
import { decodeMessage, encodeMessage } from "@/checkpoint/messages";
import { isPinned, PINNED, type WindowEvent } from "@/context";
import {
  MAX_INJECTED_BYTES,
  MEMORY_ID,
  MemoryStore,
  render,
  renderUpdate,
  select,
  SNAPSHOT_KEY,
  type Memory,
  type MemoryDirs,
  type WriteContext,
} from "@/memory";

/**
 * What injection costs, measured rather than asserted.
 *
 * This file used to defend the opposite design. Memory was re-injected live and
 * the price was that a turn which changed it broke the provider's cached prefix
 * from that message onwards; the tests pinned *where* two requests stopped
 * matching, so the price was at least known.
 *
 * The block is frozen now and corrections ride out as a `<memory-update>`
 * appended to the request, so the claim being defended is stronger: a turn that
 * changes memory breaks the prefix **nowhere**. That is still a claim about
 * bytes, so it is still measured the same way — a stub records every request
 * body and the tests read what actually went to the provider.
 *
 * ⚠️ The inverted test below is deliberately not deleted. What it protected was
 * "the cost lands at the memory message rather than at the system prompt"; what
 * replaces it protects "there is no cost to land". Dropping it would have left
 * the strongest claim in the file resting on nobody having checked.
 */

interface StubRequest {
  messages: { role: string; content?: unknown }[];
}

let server: ReturnType<typeof Bun.serve>;
let seen: StubRequest[] = [];
/** Set per test: the tool calls the stub emits, one entry per reply. */
let scripted: { name: string; args: unknown }[][] = [];

let root: string;
let dirs: MemoryDirs;
let store: MemoryStore;

const CONTEXT: WriteContext = { threadId: "t", callId: "c" };

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as StubRequest;
      seen.push(body);
      const calls = scripted.shift() ?? [];
      return Response.json({
        // A distinct id per reply: messages merge by id, and reusing one makes
        // the later reply overwrite the earlier one in place.
        id: `chatcmpl-${String(seen.length)}`,
        object: "chat.completion",
        created: 0,
        model: "stub",
        choices: [
          {
            index: 0,
            message:
              calls.length > 0
                ? {
                    role: "assistant",
                    content: "",
                    tool_calls: calls.map((call, index) => ({
                      id: `call-${String(seen.length)}-${String(index)}`,
                      type: "function",
                      function: {
                        name: call.name,
                        arguments: JSON.stringify(call.args),
                      },
                    })),
                  }
                : { role: "assistant", content: "ok" },
            finish_reason: calls.length > 0 ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
});

afterAll(() => server.stop(true));

beforeEach(() => {
  seen = [];
  scripted = [];
  root = mkdtempSync(join(tmpdir(), "mimicc-inject-"));
  dirs = { global: join(root, "global"), project: join(root, "project") };
  store = new MemoryStore(dirs);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function agent(withMemory: boolean) {
  return createUniversalAgent({
    baseURL: `http://localhost:${String(server.port)}/v1`,
    apiKey: "sk-stub",
    model: "stub",
    systemPrompt: "stub prompt",
    ...(withMemory ? { memory: dirs } : {}),
  });
}

async function turn(
  graph: ReturnType<typeof createUniversalAgent>,
  text: string,
  thread: string,
): Promise<BaseMessage[]> {
  const result = (await graph.invoke(
    { messages: [new HumanMessage(text)] },
    {
      recursionLimit: RECURSION_LIMIT,
      durability: DURABILITY,
      configurable: { thread_id: thread },
    },
  )) as { messages: BaseMessage[] };
  return result.messages;
}

/** The index of the first message where two requests stop being identical. */
function divergence(a: StubRequest, b: StubRequest): number {
  const shared = Math.min(a.messages.length, b.messages.length);
  for (let i = 0; i < shared; i += 1) {
    if (JSON.stringify(a.messages[i]) !== JSON.stringify(b.messages[i])) return i;
  }
  return shared;
}

/* ---------- 注入本身 ---------- */

// The control case, and the one that has to be free. Nothing remembered is not
// an empty section — an empty tag would spend tokens on every request, forever,
// saying what the absent tag already says.
test("an empty memory injects nothing at all", async () => {
  const messages = await turn(agent(true), "hello", "t1");
  expect(messages.find((message) => message.id === MEMORY_ID)).toBeUndefined();
  expect(JSON.stringify(seen[0])).not.toContain("<memory>");
});

test("a remembered fact arrives as a pinned human message under a fixed id", async () => {
  store.add("writes in Chinese", "user", CONTEXT);

  const messages = await turn(agent(true), "hello", "t1");
  const injected = messages.find((message) => message.id === MEMORY_ID);

  expect(injected).toBeDefined();
  expect(injected?.getType()).toBe("human");
  // Not `system`: every line of this was written by the agent itself, so putting
  // it in system would let the model's own output carry the authority of its
  // safety rules.
  expect(
    seen[0]?.messages.some(
      (message) =>
        message.role === "system" && String(message.content).includes("<memory>"),
    ),
  ).toBe(false);
  // Pinned, or a long session would silently trim the memory back out.
  expect(isPinned(injected as BaseMessage)).toBe(true);
});

test("control: no store means no middleware, not an empty one", async () => {
  store.add("writes in Chinese", "user", CONTEXT);
  const messages = await turn(agent(false), "hello", "t1");

  expect(messages.find((message) => message.id === MEMORY_ID)).toBeUndefined();
  expect(JSON.stringify(seen[0])).not.toContain("writes in Chinese");
});

/* ---------- 缓存前缀的账 ---------- */

test("a turn that changes nothing sends a byte-identical prefix", async () => {
  store.add("writes in Chinese", "user", CONTEXT);
  const graph = agent(true);

  await turn(graph, "first", "same");
  await turn(graph, "second", "same");

  const [one, two] = seen;
  expect(one).toBeDefined();
  expect(two).toBeDefined();

  // Everything the first request contained is still there, unchanged, in the
  // same order. That is exactly the condition a provider's prefix cache needs,
  // and it is the whole claim that live re-injection is cheap when memory is
  // quiet.
  expect(divergence(one as StubRequest, two as StubRequest)).toBe(
    (one as StubRequest).messages.length,
  );
});

test("a turn that changes memory breaks the prefix nowhere, and rides at the tail", async () => {
  store.add("writes in Chinese", "user", CONTEXT);
  const graph = agent(true);

  await turn(graph, "first", "same");
  store.add("prefers Bun over Node", "user", { threadId: "t", callId: "c2" });
  await turn(graph, "second", "same");

  const [one, two] = seen;
  const first = one as StubRequest;
  const second = two as StubRequest;

  // The inversion. Under live re-injection this diverged partway through; frozen,
  // everything the first request contained is still there, byte for byte, in the
  // same order — even though memory changed between the two.
  expect(divergence(first, second)).toBe(first.messages.length);

  // The change is not lost, it is appended — and it is *last*, so nothing before
  // it moved and nothing before it re-bills. Exactly one, because it is rebuilt
  // on every model call and a second copy would mean one of them stayed behind.
  const carrying = second.messages.filter((message) =>
    String(message.content).includes("</memory-update>"),
  );
  expect(carrying).toHaveLength(1);
  const appended = second.messages[second.messages.length - 1];
  expect(String(appended?.content)).toContain("</memory-update>");
  expect(String(appended?.content)).toContain("prefers Bun over Node");

  // And the frozen block still says what it said, which is the other half of the
  // same claim: the update wins, the block does not chase it.
  const block = second.messages.find((message) =>
    String(message.content).includes("<memory>"),
  );
  expect(String(block?.content)).not.toContain("prefers Bun over Node");
});

test("the update says what is no longer listed, not only what is new", async () => {
  store.add("writes in Chinese", "user", CONTEXT);
  const stale = store.add("uses Node 18", "project", CONTEXT);
  const graph = agent(true);

  await turn(graph, "first", "drop");
  seen = [];
  store.remove(stale.id);
  await turn(graph, "second", "drop");

  const appended = (seen[0] as StubRequest).messages.at(-1);
  // Deletion is the case an "append the new stuff" design cannot express: the
  // text is still visible in the block above, so the update has to retract it by
  // id rather than by staying quiet.
  expect(String(appended?.content)).toContain(`- [${stale.id}]`);
});

test("the update never enters the transcript", async () => {
  store.add("writes in Chinese", "user", CONTEXT);
  const graph = agent(true);

  await turn(graph, "first", "ephemeral");
  store.add("prefers Bun over Node", "user", { threadId: "t", callId: "c2" });
  const messages = await turn(graph, "second", "ephemeral");

  // It went to the provider (the test above reads it there) and it is nowhere in
  // the state. That is what keeps it out of `pinTurnTask`'s reach — a human
  // message written back would be pinned on the next turn and outlive its point.
  // The closing tag, not the opening one: the frozen block's preamble names
  // `<memory-update>` to tell the model where corrections show up, so matching
  // the opening tag finds the block itself and the assertion passes for the
  // wrong reason. Measured — it did, on the first run.
  expect(JSON.stringify(seen)).toContain("</memory-update>");
  expect(
    messages.some((message) =>
      JSON.stringify(message.content).includes("</memory-update>"),
    ),
  ).toBe(false);
});

test("the frozen block carries its id set, and it survives the checkpointer", async () => {
  const written = store.add("writes in Chinese", "user", CONTEXT);
  const messages = await turn(agent(true), "hello", "t1");
  const block = messages.find((message) => message.id === MEMORY_ID);

  expect(block?.additional_kwargs[SNAPSHOT_KEY]).toEqual([written.id]);

  // Measured, not assumed. `checkpoint/messages.ts` lists the fields whose
  // fidelity it has checked and `additional_kwargs` is not among them, so the
  // marker this design depends on is checked here instead of inherited.
  const round = decodeMessage(encodeMessage(block as BaseMessage));
  expect(round.additional_kwargs[SNAPSHOT_KEY]).toEqual([written.id]);
  expect(isPinned(round)).toBe(true);
  expect(JSON.stringify(round.content)).toBe(JSON.stringify(block?.content));
});

test("reopening the thread with a fresh agent leaves the block byte-identical", async () => {
  store.add("writes in Chinese", "user", CONTEXT);
  const stateDir = join(root, "state");

  // A second `createUniversalAgent` over the same saved state is what `--resume`
  // does: new middleware, empty closures, the block coming back off disk. The
  // marker has to be read out of the message, because there is nothing in memory
  // left to remember it.
  const first = createUniversalAgent({
    baseURL: `http://localhost:${String(server.port)}/v1`,
    apiKey: "sk-stub",
    model: "stub",
    systemPrompt: "stub prompt",
    memory: dirs,
    checkpointer: new JsonlSaver(stateDir),
  });
  await turn(first, "before", "resumed");

  seen = [];
  const second = createUniversalAgent({
    baseURL: `http://localhost:${String(server.port)}/v1`,
    apiKey: "sk-stub",
    model: "stub",
    systemPrompt: "stub prompt",
    memory: dirs,
    checkpointer: new JsonlSaver(stateDir),
  });
  const messages = await turn(second, "after", "resumed");

  const block = messages.find((message) => message.id === MEMORY_ID);
  expect(block?.additional_kwargs[SNAPSHOT_KEY]).toBeDefined();
  // The failure this pins is silent: a re-freeze here would work perfectly and
  // simply stop the cache hitting, for the rest of the session.
  expect(JSON.stringify(block?.content)).toContain("writes in Chinese");
  expect(JSON.stringify(seen)).not.toContain("</memory-update>");
});

test("a block that cannot say what it holds is re-frozen, and the event says so", async () => {
  store.add("writes in Chinese", "user", CONTEXT);
  const events: WindowEvent[] = [];
  const graph = createUniversalAgent({
    baseURL: `http://localhost:${String(server.port)}/v1`,
    apiKey: "sk-stub",
    model: "stub",
    systemPrompt: "stub prompt",
    memory: dirs,
    onWindow: (event) => events.push(event),
  });

  // A session written before the block was frozen: right id, pinned, no marker.
  // "Never marked" and "marker lost" are the same situation from here, so they
  // take the same road rather than a branch each.
  const legacy = new HumanMessage({
    id: MEMORY_ID,
    content: "<memory>\n[stale] whatever it used to say\n</memory>",
    additional_kwargs: { ...PINNED },
  });
  const result = (await graph.invoke(
    { messages: [legacy, new HumanMessage("hello")] },
    {
      recursionLimit: RECURSION_LIMIT,
      durability: DURABILITY,
      configurable: { thread_id: "legacy" },
    },
  )) as { messages: BaseMessage[] };

  const block = result.messages.find((message) => message.id === MEMORY_ID);
  expect(block?.additional_kwargs[SNAPSHOT_KEY]).toBeDefined();
  expect(JSON.stringify(block?.content)).toContain("writes in Chinese");
  // Reported, because re-freezing costs a cached prefix and is otherwise
  // invisible — everything keeps working, the cache just stops hitting.
  expect(events.filter((event) => event.type === "memory_refroze")).toHaveLength(1);
});

/* ---------- 选择：优先级、预算、整条 ---------- */

function fake(category: Memory["category"], content: string, created: string): Memory {
  return { id: content, content, category, source: "", created };
}

test("corrections outrank preferences, which outrank project facts and references", () => {
  const kept = select(
    [
      fake("reference", "r", "2026-01-04"),
      fake("project", "p", "2026-01-03"),
      fake("user", "u", "2026-01-02"),
      fake("feedback", "f", "2026-01-01"),
    ],
    MAX_INJECTED_BYTES,
  );

  // Oldest-first input, so a stable sort that ignored priority would return the
  // input order and this would pass by accident. It does not: the order is
  // exactly reversed.
  expect(kept.map((memory) => memory.content)).toEqual(["f", "u", "p", "r"]);
});

test("within one category the newest wins", () => {
  const kept = select(
    [fake("user", "older", "2026-01-01"), fake("user", "newer", "2026-06-01")],
    MAX_INJECTED_BYTES,
  );
  expect(kept.map((memory) => memory.content)).toEqual(["newer", "older"]);
});

test("the budget stops at a whole memory and never mid-sentence", () => {
  const long = "x".repeat(300);
  const kept = select(
    [fake("user", long, "2026-01-02"), fake("user", `${long}y`, "2026-01-01")],
    400,
  );

  expect(kept).toHaveLength(1);
  // Half of "never run this against production" is an instruction to run it.
  expect(kept[0]?.content).toHaveLength(300);
});

test("a memory that does not fit does not let a later shorter one jump the queue", () => {
  const kept = select(
    [
      fake("user", "x".repeat(300), "2026-01-03"),
      fake("user", "x".repeat(300), "2026-01-02"),
      fake("user", "tiny", "2026-01-01"),
    ],
    400,
  );

  // `select` breaks rather than continues, so what is injected never depends on
  // the sizes of what came before: adding one long memory cannot silently swap
  // out an unrelated short one.
  expect(kept.map((memory) => memory.content)).toEqual(["x".repeat(300)]);
});

test("control: everything fits when the budget is not the constraint", () => {
  const memories = [
    fake("feedback", "f", "2026-01-01"),
    fake("user", "u", "2026-01-02"),
    fake("project", "p", "2026-01-03"),
  ];
  expect(select(memories, MAX_INJECTED_BYTES)).toHaveLength(3);
});

/* ---------- 渲染 ---------- */

test("the rendered block groups by category and shows the id the tools take", () => {
  const text = render([fake("feedback", "ask first", "2026-01-01")]);

  expect(text).toContain("<feedback>");
  expect(text).toContain("[ask first] ask first");
  // The id is shown so a model that spots a stale memory can update or delete it
  // without a search round-trip first.
  expect(text).toContain("MemoryDelete");
});

test("nothing rendered from nothing, so the caller can tell empty from absent", () => {
  expect(render([])).toBeUndefined();
});

test("no change renders no update, because it is recomputed on every model call", () => {
  const kept = [fake("user", "a", "2026-01-01")];
  expect(renderUpdate(kept, ["a"])).toBeUndefined();
});

test("the update diffs the selected set, not the whole store", () => {
  // The trap this pins: `select` caps the block, so a memory the budget left out
  // is absent from the snapshot ids. Diffing the *store* against them would
  // report every excluded memory as an addition on every single request, handing
  // back exactly the bytes the cap just saved.
  const long = "x".repeat(300);
  const all = [
    fake("user", long, "2026-01-02"),
    fake("user", `${long}y`, "2026-01-01"),
  ];
  const kept = select(all, 400);
  expect(kept).toHaveLength(1);

  const snapshot = kept.map((memory) => memory.id);
  expect(renderUpdate(kept, snapshot)).toBeUndefined();

  // And the control: diffing what was deliberately excluded really would have
  // produced one, so the assertion above is not passing because nothing can.
  const wrong = renderUpdate(all, snapshot);
  expect(wrong).toBeDefined();
  expect(String(wrong)).toContain(`${long}y`);
});

test("an added memory is a `+` line and a vanished one is a `-` line", () => {
  const update = renderUpdate([fake("user", "new", "2026-01-02")], ["gone"]);
  expect(update).toContain("+ [new] new");
  expect(update).toContain("- [gone]");
  // Weaker than "deleted" on purpose: a memory can leave the selection by being
  // crowded out, and the block never claimed to be the whole store.
  expect(update).toContain("no longer listed");
});

/* ---------- 票 12 与票 13 接起来 ---------- */

test("what the model remembered in one turn comes back in the next", async () => {
  // The two tickets are only useful joined: 12 proves a memory can be written,
  // 13 proves one can be injected, and neither proves the model's own write is
  // the thing that comes back. This drives the shipped tools through the shipped
  // middleware — no store methods called directly.
  scripted = [
    [{ name: "MemoryAdd", args: { content: "prefers Bun", category: "user" } }],
  ];

  const graph = agent(true);
  await turn(graph, "remember that I prefer Bun", "joined");

  // Turn one could not have carried it: the memory did not exist when
  // `beforeAgent` ran. Without this the next assertion would also pass if the
  // block had simply always been there.
  //
  // The block, not the text. Asserting the *content* was absent nearly passed
  // for the wrong reason — the user message in this very turn says "I prefer
  // Bun", one letter away from the memory being searched for.
  expect(JSON.stringify(seen[0])).not.toContain("<memory>");

  seen = [];
  await turn(graph, "and now?", "joined");

  const injected = (seen[0] as StubRequest).messages.find((message) =>
    String(message.content).includes("<memory>"),
  );
  expect(String(injected?.content)).toContain("prefers Bun");
  // Provenance is the harness's, not the model's: it never appeared in the tool
  // arguments, so a source in the file can be trusted when the memory turns out
  // to be wrong.
  expect(store.all()[0]?.source).toContain("thread=joined");
});
