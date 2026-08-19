import { HumanMessage } from "@langchain/core/messages";
import { createMiddleware, type AnyAgentMiddleware } from "langchain";

import { PINNED } from "../context";

import { SKILL_CATALOG_ID, type SkillRegistry } from "./registry";

/**
 * Injects the catalogue of model-invoked skills once per thread, or nothing when
 * there is nothing to inject.
 *
 * The message is built once at construction — the registry is read at startup,
 * so its bytes cannot change mid-session — and returned every turn for the
 * reducer to merge in place under a fixed id, exactly as `projectInstructions`
 * does. Pinned, because it sits before every cut that will ever be made and
 * would otherwise drop out of the view: a model that has lost the catalogue can
 * no longer name a skill to load.
 */
export function injectSkillCatalog(
  registry: SkillRegistry,
): AnyAgentMiddleware | undefined {
  const text = registry.catalogText();
  if (text === undefined) return undefined;

  const message = new HumanMessage({
    id: SKILL_CATALOG_ID,
    content: text,
    additional_kwargs: { ...PINNED },
  });

  return createMiddleware({
    name: "SkillCatalog",
    beforeAgent: () => ({ messages: [message] }),
  }) as AnyAgentMiddleware;
}
