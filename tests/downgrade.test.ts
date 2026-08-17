import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";

import { createUniversalAgent, RECURSION_LIMIT } from "@/agents";
import { downgrade, DOWNGRADE_DIR, type WindowEvent } from "@/context";
import { readTool } from "@/tools";

/**
 * Downgrading, asked directly, plus the one assertion that cannot be faked.
 *
 * The mechanism is easy to test and easy to get subtly useless: a synopsis
 * carrying a path the model cannot open is a downgrade that silently destroys
 * information. So one test here goes through the **real `Read` tool** rather
 * than the filesystem, because what is being checked is not "did the file get
 * written" but "is it reachable from where the model stands".
 */

const big = (label: string, lines = 400): string =>
  Array.from(
    { length: lines },
    (_, i) => `${label} line ${String(i)} ${"x".repeat(40)}`,
  ).join("\n");

const result = (text: string, id = "call_1", name = "Read"): BaseMessage =>
  new ToolMessage({ content: text, tool_call_id: id, name });

const calls = (ids: string[]): BaseMessage =>
  new AIMessage({
    content: "",
    tool_calls: ids.map((id) => ({ id, name: "Read", args: { path: "x" } })),
  });

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "mimicc-downgrade-"));
}

describe("downgrade — what replaces an oversized tool result", () => {
  test("a result under the limit is left alone, and the array is not rebuilt", () => {
    const history = [
      new HumanMessage("q"),
      calls(["c1"]),
      result("small"),
      new AIMessage("a"),
    ];

    const { messages, downgraded } = downgrade(history, { root: tempRoot() });

    expect(downgraded).toHaveLength(0);
    expect(messages).toBe(history);
  });

  test("an oversized one becomes a synopsis that says so, keeping the pairing", () => {
    const text = big("alpha");
    const history = [calls(["c1"]), result(text, "c1"), new AIMessage("done")];

    const { messages, downgraded } = downgrade(history, { root: tempRoot() });
    const replaced = messages[1] as ToolMessage;

    expect(downgraded).toHaveLength(1);
    expect(downgraded[0]?.to).toBeLessThan(downgraded[0]?.from ?? 0);
    // The pairing is the provider's hard rule, so it outranks everything here.
    expect(replaced.tool_call_id).toBe("c1");
    // A synopsis that reads like output gets used like output.
    expect(replaced.text).toContain("a synopsis, not the output itself");
    expect(replaced.text).toContain(DOWNGRADE_DIR);
    // Both ends, not just the head: a file's first lines say what it is, a
    // command's last lines say how it went.
    expect(replaced.text).toContain("alpha line 0");
    expect(replaced.text).toContain("alpha line 399");
  });

  /**
   * The loop breaker, and the reason it is a rule about position rather than
   * about which tool ran.
   *
   * A pointer is only worth having if `Read` can follow it. If what came back
   * from following it were downgraded on arrival, the model would be handed a
   * synopsis of the thing it just went to fetch, for ever.
   */
  test("the lap in flight is never downgraded", () => {
    const text = big("fresh");
    const history = [calls(["c1"]), result(text, "c1")];

    const { messages, downgraded } = downgrade(history, { root: tempRoot() });

    expect(downgraded).toHaveLength(0);
    expect(messages).toBe(history);
  });

  test("two runs produce the same text and one file", () => {
    const root = tempRoot();
    const history = [calls(["c1"]), result(big("same"), "c1"), new AIMessage("done")];

    const first = downgrade(history, { root });
    const second = downgrade(history, { root });

    // Reproducibility is not a nicety: the view is recomputed on every model
    // call, and a synopsis that differed between them would make the projection
    // non-deterministic — which is the one property it exists to have.
    expect((second.messages[1] as ToolMessage).text).toBe(
      (first.messages[1] as ToolMessage).text,
    );
    expect(readdirSync(join(root, DOWNGRADE_DIR))).toHaveLength(1);
  });

  test("when the disk refuses, it truncates instead and offers no path", () => {
    // A file where the directory would have to go: mkdir fails with ENOTDIR.
    const root = join(tempRoot(), "not-a-dir");
    writeFileSync(root, "");

    const history = [calls(["c1"]), result(big("nodisk"), "c1"), new AIMessage("done")];
    const { messages, downgraded } = downgrade(history, { root });

    expect(downgraded).toHaveLength(1);
    expect(downgraded[0]?.path).toBeUndefined();
    expect((messages[1] as ToolMessage).text).toContain(
      "a truncation, not the output itself",
    );
  });
});

/**
 * The assertion the whole mechanism rests on.
 *
 * `.mimicc` is blacklisted by the tools' `SECRET` pattern and `/tmp` is outside
 * `resolveInside`'s reach, so both of the obvious homes for this file produce a
 * pointer the model cannot open — and nothing else in this suite would notice.
 * This one writes into the real working directory, because that is the only
 * place `readTool` will look.
 */
describe("the pointer, from where the model stands", () => {
  const litter = join(process.cwd(), DOWNGRADE_DIR);
  const existed = existsSync(litter);

  afterAll(() => {
    if (!existed) rmSync(litter, { recursive: true, force: true });
  });

  test("the model's own Read can open what the synopsis points at", async () => {
    const text = big("reachable");
    const history = [calls(["c1"]), result(text, "c1"), new AIMessage("done")];

    const { downgraded } = downgrade(history, { root: process.cwd() });
    const pointer = downgraded[0]?.path;
    if (pointer === undefined) throw new Error("nothing was persisted to point at");

    const back = await readTool.invoke({ path: pointer });

    // Read numbers the lines, so this is the content and not a byte comparison.
    expect(back).toContain("reachable line 0");
    expect(back).toContain("reachable line 399");
  });
});

/**
 * On the wire, under real pressure — the ordering claim rather than the shape.
 */
describe("in the window middleware", () => {
  let server: ReturnType<typeof Bun.serve>;
  let requests: { messages: { role: string; content?: unknown }[] }[] = [];
  let promptTokens = 1;
  const events: WindowEvent[] = [];

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as (typeof requests)[number];
        requests.push(body);
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
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: 1,
            total_tokens: promptTokens,
          },
        });
      },
    });
  });

  afterAll(() => void server.stop(true));
  afterEach(() => {
    requests = [];
    events.length = 0;
    promptTokens = 1;
  });

  test("over the trigger the model gets the synopsis, and the scale sees it", async () => {
    const root = tempRoot();
    const graph = createUniversalAgent({
      baseURL: `http://localhost:${String(server.port)}`,
      apiKey: "sk-stub",
      model: "stub",
      window: { limit: 2_000, keepFraction: 0.05, root },
      onWindow: (event) => events.push(event),
    });

    promptTokens = 1_900;
    await graph.invoke(
      {
        messages: [
          new HumanMessage("q"),
          calls(["c1"]),
          result(big("wire"), "c1"),
          new AIMessage("done"),
          new HumanMessage("and now?"),
        ],
      },
      {
        recursionLimit: RECURSION_LIMIT,
        configurable: { thread_id: "downgrade-wire" },
      },
    );

    const sent = JSON.stringify(requests.at(-1)?.messages ?? []);
    expect(sent).toContain("a synopsis, not the output itself");
    // …and the original bulk is not on the wire twice.
    expect(sent).not.toContain("wire line 200");

    const downgrades = events.filter((event) => event.type === "downgraded");
    expect(downgrades).toHaveLength(1);
  });
});
