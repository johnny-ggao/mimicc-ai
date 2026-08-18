import { expect, test } from "bun:test";
import { createMiddleware, type AnyAgentMiddleware } from "langchain";

import { pinRejections } from "@/agents";

/**
 * pinRejections wraps the confirmation gate's afterModel to pin the rejection
 * messages the gate builds. It introspects the afterModel shape, and a shape it
 * does not recognise used to be a silent no-op — rejections unpinned, the model
 * free to retry a command the user just refused (ticket 06).
 */

test("an afterModel of an unexpected shape is refused, not skipped", () => {
  const gate = createMiddleware({ name: "Gate" });
  const wrong = { ...gate, afterModel: {} } as unknown as AnyAgentMiddleware;
  expect(() => pinRejections(wrong)).toThrow(/afterModel changed shape/);
});

test("a gate with no afterModel is left untouched", () => {
  const gate = createMiddleware({ name: "Gate" });
  expect(() => pinRejections(gate as AnyAgentMiddleware)).not.toThrow();
});

test("a gate whose afterModel is the object form wraps without complaint", () => {
  const gate = createMiddleware({
    name: "Gate",
    afterModel: { hook: async () => {} },
  });
  expect(() => pinRejections(gate as AnyAgentMiddleware)).not.toThrow();
});
