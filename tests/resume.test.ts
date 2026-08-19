import { describe, expect, test } from "bun:test";

import { PAGE, parseArgs, readChoice, renderSessionList } from "@/console";
import type { Session } from "@/session";

/**
 * The two pure halves of "carry on from an earlier session".
 *
 * The console is a debugging shell and its loop stays out of the tests
 * (`repl.test.ts` says why). What is pinned here is everything that could be
 * wrong without the terminal looking wrong: how an argument is read, and which
 * row a typed number addresses. The second one matters more than it looks —
 * picking row 3 out of a list that was cut off at 20 must not reach the
 * twenty-third session.
 */

const session = (id: string, extra: Partial<Session> = {}): Session => ({
  id,
  path: `/tmp/${id}.jsonl`,
  title: `session ${id}`,
  messages: 2,
  lastActive: new Date("2026-08-19T10:00:00Z"),
  atGate: false,
  spent: { input: 0, output: 0, cacheRead: 0 },
  ...extra,
});

describe("the command line", () => {
  test("no arguments is a new session", () => {
    expect(parseArgs([])).toEqual({ kind: "new" });
  });

  test("bare --resume asks for the picker", () => {
    expect(parseArgs(["--resume"])).toEqual({ kind: "pick" });
    expect(parseArgs(["-r"])).toEqual({ kind: "pick" });
  });

  test("--resume <id> carries a prefix, in both spellings", () => {
    expect(parseArgs(["--resume", "c70b"])).toEqual({ kind: "resume", prefix: "c70b" });
    expect(parseArgs(["-r=c70b"])).toEqual({ kind: "resume", prefix: "c70b" });
  });

  // A flag where an id belongs is a typo. Reading it as a session named `--foo`
  // would turn that typo into "no session starts with --foo", which sends the
  // reader looking in the wrong place.
  test("a flag where an id belongs is usage, not an id", () => {
    expect(parseArgs(["--resume", "--verbose"]).kind).toBe("error");
  });

  test("anything else is refused by name", () => {
    const parsed = parseArgs(["--wat"]);
    expect(parsed.kind).toBe("error");
    expect(parsed.kind === "error" ? parsed.message : "").toContain("--wat");
  });

  test("trailing extras are usage", () => {
    expect(parseArgs(["--resume", "abc", "def"]).kind).toBe("error");
  });
});

describe("picking a row", () => {
  const sessions = [session("aaa"), session("bbb"), session("ccc")];

  test("a number in range picks that row", () => {
    const choice = readChoice("2", sessions);
    expect(choice.kind === "pick" ? choice.session.id : "").toBe("bbb");
  });

  test("an empty line declines and opens a new session", () => {
    expect(readChoice("", sessions)).toEqual({ kind: "skip" });
  });

  test("out of range, zero and nonsense all ask again", () => {
    expect(readChoice("4", sessions).kind).toBe("again");
    expect(readChoice("0", sessions).kind).toBe("again");
    expect(readChoice("-1", sessions).kind).toBe("again");
    expect(readChoice("abc", sessions).kind).toBe("again");
    expect(readChoice("1.5", sessions).kind).toBe("again");
  });

  test("a number past the cut-off addresses nothing, even though the session exists", () => {
    const many = Array.from({ length: PAGE + 5 }, (_, index) =>
      session(`s${String(index)}`),
    );
    expect(readChoice(String(PAGE + 1), many).kind).toBe("again");
    expect(readChoice(String(PAGE), many).kind).toBe("pick");
  });
});

describe("the list", () => {
  test("empty history says so rather than printing a bare prompt", () => {
    expect(renderSessionList([])).toBe("no earlier sessions.");
  });

  test("a session parked at a gate is marked", () => {
    const rendered = renderSessionList([
      session("aaa"),
      session("bbb", { atGate: true }),
    ]);
    const [first, second] = rendered.split("\n");
    expect(first).not.toContain("⚠");
    expect(second).toContain("⚠");
  });

  test("what is not shown is counted rather than dropped silently", () => {
    const many = Array.from({ length: PAGE + 3 }, (_, index) =>
      session(`s${String(index)}`),
    );
    expect(renderSessionList(many)).toContain("and 3 more");
  });
});
