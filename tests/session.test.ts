import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listSessions, openSession, resolveSession } from "@/session";

/**
 * The lister's contract, exercised against files rather than against a saver.
 *
 * That is the right seam for this module and not a shortcut: it exists to read
 * files **somebody else wrote, possibly a while ago**, including the ones on this
 * repository's own disk today, which carry no `header` line because nothing has
 * ever written one. Building its fixtures through the saver would only ever
 * produce files this version writes, which is the one case least likely to break.
 */

const HUMAN = (id: string, content: string) =>
  JSON.stringify({ kind: "message", id, data: { type: "human", data: { content } } });
const AI = (id: string, content: string) =>
  JSON.stringify({ kind: "message", id, data: { type: "ai", data: { content } } });
const CHECKPOINT = (id: string) =>
  JSON.stringify({ kind: "checkpoint", id, ns: "", channels: {}, messageChannels: [] });
const GATE = (checkpoint: string) =>
  JSON.stringify({
    kind: "writes",
    checkpoint,
    ns: "",
    entries: [{ slot: "t,-1", task: "t", channel: "__interrupt__", value: {} }],
  });

function fixture(lines: string[][]): string {
  const dir = mkdtempSync(join(tmpdir(), "mimicc-sessions-"));
  for (const [name, ...body] of lines.map((entry) => entry)) {
    writeFileSync(join(dir, name as string), `${body.join("\n")}\n`, "utf8");
  }
  return dir;
}

test("lists sessions newest-activity-first, with a title from the first human message", async () => {
  const dir = fixture([
    ["11111111-1111-4111-8111-111111111111.jsonl", HUMAN("a", "第一条会话\n第二行")],
    [
      "22222222-2222-4222-8222-222222222222.jsonl",
      HUMAN("b", "第二条会话"),
      AI("c", "好"),
    ],
  ]);

  const sessions = await listSessions(dir);
  expect(sessions.map((session) => session.title)).toEqual([
    "第二条会话",
    "第一条会话",
  ]);
  expect(sessions[0]?.messages).toBe(2);
  // The title is one row: a first message with a body must not drag it along.
  expect(sessions[1]?.title).toBe("第一条会话");
});

test("a file with no header line still lists — the header is never written yet", async () => {
  const dir = fixture([
    ["33333333-3333-4333-8333-333333333333.jsonl", HUMAN("a", "无头")],
  ]);
  expect((await listSessions(dir)).length).toBe(1);
});

test("a slash command's activation does not become the title", async () => {
  const SKILL = JSON.stringify({
    kind: "message",
    id: "skill:wayfinder",
    data: { type: "human", data: { content: '<skill name="wayfinder">\n…\n</skill>' } },
  });
  const withTask = fixture([
    ["aaaa1111-1111-4111-8111-111111111111.jsonl", SKILL, HUMAN("b", "把地图更新一下")],
  ]);
  // Typed bare, the skill is all there is — then its name is the best title going.
  const bare = fixture([["bbbb2222-2222-4222-8222-222222222222.jsonl", SKILL]]);

  expect((await listSessions(withTask))[0]?.title).toBe("把地图更新一下");
  expect((await listSessions(bare))[0]?.title).toBe("/wayfinder");
});

test("the tool journal, probe directories and temp files are not sessions", async () => {
  const dir = fixture([
    ["44444444-4444-4444-8444-444444444444.jsonl", HUMAN("a", "真的")],
    [
      "44444444-4444-4444-8444-444444444444.tools.jsonl",
      JSON.stringify({ kind: "intent" }),
    ],
    [".12345.tmp", "half a line"],
  ]);
  mkdirSync(join(dir, "probe-18"), { recursive: true });
  writeFileSync(
    join(dir, "probe-18", "probe-18.jsonl"),
    `${HUMAN("a", "探针")}\n`,
    "utf8",
  );

  const sessions = await listSessions(dir);
  expect(sessions.map((session) => session.title)).toEqual(["真的"]);
});

test("what a session spent is summed off the messages, dispatches included", async () => {
  const AI = (id: string, input: number, output: number, cached: number) =>
    JSON.stringify({
      kind: "message",
      id,
      data: {
        type: "ai",
        data: {
          content: "ok",
          usage_metadata: {
            input_tokens: input,
            output_tokens: output,
            input_token_details: { cache_read: cached },
          },
        },
      },
    });
  // A dispatch's tokens ride in on the tool result: the subagent's own messages
  // are never written down, so this is the only place they can be.
  const DISPATCH = JSON.stringify({
    kind: "message",
    id: "t1",
    data: {
      type: "tool",
      data: {
        content: "report",
        tool_call_id: "call_1",
        response_metadata: { usage: { input: 900, output: 100, cacheRead: 400 } },
      },
    },
  });

  const dir = fixture([
    [
      "abcd1111-1111-4111-8111-111111111111.jsonl",
      HUMAN("h", "跑一下"),
      AI("a1", 1000, 200, 600),
      DISPATCH,
      AI("a2", 500, 50, 0),
    ],
  ]);

  const [session] = await listSessions(dir);
  expect(session?.spent).toEqual({ input: 2400, output: 350, cacheRead: 1000 });
});

test("a message with no usage on it costs nothing rather than breaking the sum", async () => {
  const dir = fixture([
    ["abcd2222-2222-4222-8222-222222222222.jsonl", HUMAN("h", "一")],
  ]);
  expect((await listSessions(dir))[0]?.spent).toEqual({
    input: 0,
    output: 0,
    cacheRead: 0,
  });
});

test("parked at a gate is judged from the newest checkpoint, not from the whole file", async () => {
  const answered = fixture([
    [
      "55555555-5555-4555-8555-555555555555.jsonl",
      HUMAN("a", "跑一下"),
      CHECKPOINT("1f19-0001"),
      GATE("1f19-0001"),
      // Answering the gate lands a newer checkpoint that carries no interrupt.
      CHECKPOINT("1f19-0002"),
    ],
  ]);
  const parked = fixture([
    [
      "66666666-6666-4666-8666-666666666666.jsonl",
      HUMAN("a", "跑一下"),
      CHECKPOINT("1f19-0001"),
      CHECKPOINT("1f19-0002"),
      GATE("1f19-0002"),
    ],
  ]);

  expect((await listSessions(answered))[0]?.atGate).toBe(false);
  expect((await listSessions(parked))[0]?.atGate).toBe(true);
});

test("a torn last line is tolerated; damage earlier in the file declines the session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mimicc-sessions-"));
  writeFileSync(
    join(dir, "77777777-7777-4777-8777-777777777777.jsonl"),
    `${HUMAN("a", "被 Ctrl+C 打断的那条")}\n{"kind":"checkp`,
    "utf8",
  );
  writeFileSync(
    join(dir, "88888888-8888-4888-8888-888888888888.jsonl"),
    `{"kind":"messa\n${HUMAN("a", "中间坏了")}\n`,
    "utf8",
  );

  const sessions = await listSessions(dir);
  expect(sessions.map((session) => session.title)).toEqual(["被 Ctrl+C 打断的那条"]);
});

test("listing never writes: the torn tail is still there afterwards", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mimicc-sessions-"));
  const path = join(dir, "99999999-9999-4999-8999-999999999999.jsonl");
  const raw = `${HUMAN("a", "看一眼")}\n{"kind":"checkp`;
  writeFileSync(path, raw, "utf8");

  await listSessions(dir);
  expect(await Bun.file(path).text()).toBe(raw);
});

test("a prefix resolves to one session, to nothing, or to several", async () => {
  const dir = fixture([
    ["abc11111-1111-4111-8111-111111111111.jsonl", HUMAN("a", "一")],
    ["abc22222-2222-4222-8222-222222222222.jsonl", HUMAN("b", "二")],
    ["def33333-3333-4333-8333-333333333333.jsonl", HUMAN("c", "三")],
  ]);

  expect((await resolveSession(dir, "def")).kind).toBe("one");
  expect((await resolveSession(dir, "zzz")).kind).toBe("none");

  const many = await resolveSession(dir, "abc");
  expect(many.kind).toBe("many");
  expect(many.kind === "many" ? many.candidates.length : 0).toBe(2);

  // A whole id is also a prefix of itself, and must not be reported ambiguous.
  const whole = await resolveSession(dir, "abc11111-1111-4111-8111-111111111111");
  expect(whole.kind).toBe("one");
});

test("an id that could name a path is refused rather than followed", async () => {
  const dir = fixture([
    ["aaaaaaaa-1111-4111-8111-111111111111.jsonl", HUMAN("a", "一")],
  ]);
  expect(await openSession(dir, "../escape")).toBeUndefined();
});

test("a state directory that was never created is empty history, not a failure", async () => {
  expect(await listSessions(join(tmpdir(), "mimicc-does-not-exist-9d3f"))).toEqual([]);
});
