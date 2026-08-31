/**
 * Skills: reusable, task-specific instructions — installed outside the
 * repository, or bundled into the program itself.
 *
 * `location.ts` says where the installed ones are read from; `load.ts` reads
 * them off disk into {@link Skill}s; `bundled.ts` carries the ones compiled
 * into the binary; `registry.ts` answers every question the two entry points
 * ask of them; `tool.ts` is the model's entry (`Skill(name)`), `inject.ts` is
 * the catalogue the model uses to know what to name. The user's entry — the
 * slash command — is parsed in `registry.ts` and wired in the console, so both
 * entries share one loader and one product.
 */
import type { Logger } from "../logger";

import { bundledSkills } from "./bundled";
import { loadSkills, mergeSkills, type Skill } from "./load";
import { defaultSkillRoots } from "./location";

export { defaultSkillRoots, SKILLS_DIR_NAME } from "./location";
export { BUNDLED_DIR, bundledSkills } from "./bundled";
export {
  loadSkills,
  mergeSkills,
  MAX_SKILL_BYTES,
  SKILL_FILE,
  skillFromRaw,
  type Skill,
} from "./load";

/**
 * Everything this run offers, in precedence order:
 * the user's mimicc skills, then the bundled ones, then skills borrowed from
 * `~/.claude`. The bundled slot sits in the middle on purpose — a user who
 * installs their own `research` overrides the shipped one, while the shipped
 * one shadows the borrowed copy that was written for another agent and cannot
 * keep its promises here (research-kind ticket 02).
 */
export function defaultSkills(log: Logger): Skill[] {
  const [mimicc, ...rest] = defaultSkillRoots();
  return mergeSkills(
    [
      loadSkills(mimicc === undefined ? [] : [mimicc], log),
      bundledSkills(log),
      loadSkills(rest, log),
    ],
    log,
  );
}
export {
  parseSkillCommand,
  renderSkillList,
  skillActivationMessage,
  SKILL_CATALOG_ID,
  SkillRegistry,
  wrapSkill,
  type SkillCommand,
} from "./registry";
export { createSkillTool, pinSkillLoads, SKILL_TOOL_NAME } from "./tool";
export { injectSkillCatalog } from "./inject";
