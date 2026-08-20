import { expect, test } from "bun:test";

import { FakeListChatModel } from "@langchain/core/utils/testing";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

import { registeredTools } from "@/agents";
import { bothSafe, declaredReplay, replayOf } from "@/tools";

/**
 * Every tool says whether running it twice is free, and none of them says it by
 * accident.
 */

function registered() {
  // A fake model because `registeredTools` builds the dispatch tool and that
  // needs one; nothing here calls it. Same seam `tests/agent.test.ts` uses for
  // the confirmation gate's coverage.
  return registeredTools({ model: new FakeListChatModel({ responses: ["unused"] }) });
}

/**
 * The exhaustiveness gate, and it guards something subtler than it looks.
 *
 * The default is `never`, so a tool that forgets to declare is handled *safely* —
 * this is not the confirmation gate, where an unlisted tool runs unconfirmed.
 * What an omission costs here is quieter: a tool that is genuinely safe to
 * re-read gets treated as though it had changed the world, and the recovery it
 * could have had for free becomes a synthetic error the model has to work around.
 * Nothing fails, nothing is logged, and the classification was never made.
 *
 * So this asserts a *decision was taken*, not that a value is present.
 */
test("every registered tool declares its replay policy explicitly", () => {
  const undeclared = registered()
    .filter((one) => declaredReplay(one) === undefined)
    .map((one) => one.name);

  expect(undeclared).toEqual([]);
});

test("the classification is the one the criterion produces", () => {
  const byName = Object.fromEntries(
    registered().map((one) => [one.name, replayOf(one)]),
  );

  expect(byName).toEqual({
    // Same arguments, same answer, nothing touched.
    Read: "safe",
    Glob: "safe",
    Grep: "safe",
    // Writes.
    Write: "never",
    Edit: "never",
    // Never, even when the command is `ls`: the declaration is per tool and the
    // runtime cannot read a shell command.
    Bash: "never",
    // Never although an Explore agent only reads — a second dispatch buys the
    // same report at uncached prices. "Unchanged" includes money.
    Task: "never",
    // Never, and moot: the body is unreachable (`clarifyGate` answers the call in
    // `afterModel`), so no `wrapToolCall` ever classifies it. The declaration is
    // the answer that stays right if that interception is removed — a crash can
    // land *after* the user answered, and replaying would discard their answer.
    Clarify: "never",
  });
});

test("a tool that says nothing is treated as though it changed the world", () => {
  const silent = tool(() => "ok", {
    name: "Silent",
    description: "declares nothing",
    schema: z.object({}),
  });

  expect(declaredReplay(silent)).toBeUndefined();
  expect(replayOf(silent)).toBe("never");
});

/**
 * Both sides, because the program can change between the crash and the restart —
 * and in this repository that is the ordinary case, not the exotic one:
 * `bun run dev` is `--watch`, so editing a file restarts the process.
 */
test("replaying needs the captured declaration and the current one to agree", () => {
  expect(bothSafe("safe", "safe")).toBe(true);
  // The tool was safe when the intent was written and is not any more.
  expect(bothSafe("safe", "never")).toBe(false);
  // …and the other way round: the record is what was promised, not what is.
  expect(bothSafe("never", "safe")).toBe(false);
  expect(bothSafe("never", "never")).toBe(false);
});
