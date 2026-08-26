import { describe, expect, test } from "bun:test";

import { FakeListChatModel } from "@langchain/core/utils/testing";

import {
  agentStack,
  assertBlocksInFrequencyOrder,
  BLOCKS,
  subagentSpecs,
  type Freq,
} from "@/agents";

/**
 * The block-order tripwire, fired and not fired.
 *
 * The invariant (upstream view-layout ticket 01): the view is re-read from the
 * top every turn, so the blocks beforeAgent hooks inject must sit least-changing
 * first — a block that changes every turn costs the whole history when it sits
 * in front (HEAD 4.0% vs TAIL 39.3%). Today every block is `never`, so the
 * check idles and green tests would prove nothing: only a deliberately wrong
 * stack that throws proves the tripwire bites.
 *
 * The wrong order is manufactured through the `blocks` override because it
 * cannot be built from real middlewares today — all three real blocks are
 * `never`. Overriding `ProjectInstructions` to `rare` is exactly the day
 * AGENTS.md goes live, which is this rule's first real user (view-layout-impl
 * ticket 01, 订正②).
 */

interface FakeMiddleware {
  name: string;
  beforeAgent: () => unknown;
}

const withHook = (name: string): FakeMiddleware => ({ name, beforeAgent: () => ({}) });

describe("the block-order assertion", () => {
  test("a block that changes never must not sit after one that changes rarely", () => {
    // ProjectInstructions ("rare") before Memory ("never") — the wrong stack,
    // and exactly the day AGENTS.md goes live. Least-changing first means the
    // frozen Memory must sit ahead of the rarely-changing instructions.
    const wrong = [withHook("ProjectInstructions"), withHook("Memory")];
    const liveAgentsMd: Record<string, Freq> = {
      ...BLOCKS,
      ProjectInstructions: "rare",
    };

    expect(() => {
      assertBlocksInFrequencyOrder(wrong, liveAgentsMd);
    }).toThrow(/least-changing first/);

    // And the right way round is silent — otherwise the guard above proves
    // nothing except that this function throws.
    expect(() => {
      assertBlocksInFrequencyOrder([...wrong].reverse(), liveAgentsMd);
    }).not.toThrow();
  });

  test("a beforeAgent middleware that is not registered is refused at assembly", () => {
    // The failure mode this line exists to stop: someone adds a block and does
    // not know there is a rule about where it sits. Fail-closed, so forgetting
    // to register cannot pass in silence.
    const stack = [withHook("InjectRepoDigest")];

    expect(() => {
      assertBlocksInFrequencyOrder(stack);
    }).toThrow(/not registered in BLOCKS/);
  });

  test("notABlock middlewares sit anywhere and do not count as blocks", () => {
    const stack = [
      withHook("PinTurnTask"),
      withHook("ProjectInstructions"),
      withHook("StaleReads"),
      withHook("Memory"),
      withHook("SkillCatalog"),
    ];

    expect(() => {
      assertBlocksInFrequencyOrder(stack);
    }).not.toThrow();
  });

  test("the real stacks pass today", () => {
    // Every block is frozen at `never` today, so the check must idle on the
    // stacks the program actually assembles — including the full main stack,
    // where SkillCatalog and the three guards are appended outside agentStack.
    const model = new FakeListChatModel({ responses: ["ok"] });
    const modelFor = () => model;

    expect(() => {
      agentStack("main", { model, modelFor, instructions: "# be kind" });
    }).not.toThrow();
    expect(() => {
      subagentSpecs({ model, modelFor });
    }).not.toThrow();
  });
});
