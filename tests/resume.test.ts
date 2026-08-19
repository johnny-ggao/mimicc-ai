import { describe, expect, test } from "bun:test";

import {
  cachedShare,
  compact,
  PAGE,
  parseArgs,
  readChoice,
  renderSessionList,
  spendBreakdown,
  spendLine,
} from "@/console";
import type { Spend } from "@/usage";
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
  spent: { uncachedInput: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  byModel: {},
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

/**
 * What a session has spent, as the console says it.
 *
 * Three numbers rather than one total, and that is this repository's own rule
 * rather than taste: every context-engineering change is weighed on `input` and
 * `cached` (`CONTEXT.md`), and a single total folds exactly those two together.
 * Measured on real history, one session reads 557k total, 179k uncached, 65%
 * from cache — three different statements, and only the last one would notice a
 * cache that stopped working.
 */
describe("saying what a session spent", () => {
  const spend = (extra: Partial<Spend> = {}): Spend => ({
    uncachedInput: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    ...extra,
  });

  test("counts are shortened, and small ones are left alone", () => {
    expect(compact(999)).toBe("999");
    expect(compact(12_345)).toBe("12k");
    expect(compact(1_240_000)).toBe("1.2M");
  });

  test("the cache share is of input, and absent before anything is sent", () => {
    expect(cachedShare(spend({ uncachedInput: 35, cacheRead: 65 }))).toBe(65);
    // Output is not input: including it would make a chatty turn look cache-cold.
    expect(cachedShare(spend({ uncachedInput: 50, cacheRead: 50, output: 900 }))).toBe(
      50,
    );
    // "0% cached" reads as a problem; "nothing sent yet" is not one.
    expect(cachedShare(spend())).toBeUndefined();
  });

  test("the line carries all three numbers, and drops the share when there is none", () => {
    expect(spendLine(spend({ uncachedInput: 1200, output: 300, cacheRead: 800 }))).toBe(
      "1k in · 300 out · 40% cached",
    );
    expect(spendLine(spend())).toBe("0 in · 0 out");
  });

  test("the breakdown is per model, biggest first, and says so when empty", () => {
    const rendered = spendBreakdown({
      "kimi-k3": spend({ uncachedInput: 100, output: 10 }),
      "deepseek-v4-flash": spend({ uncachedInput: 9000, output: 500, cacheRead: 1000 }),
    });
    const [first, second] = rendered.split("\n");

    expect(first).toContain("deepseek-v4-flash");
    expect(second).toContain("kimi-k3");
    // The model column is padded, so the numbers of both rows start at the same
    // place and two rows read as a column rather than as two sentences.
    expect(first?.indexOf("9k in")).toBe(second?.indexOf("100 in") ?? -1);

    expect(spendBreakdown({})).toBe("nothing spent yet.");
  });
});
