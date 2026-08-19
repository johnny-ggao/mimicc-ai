/**
 * Skills: reusable, task-specific instructions installed outside the repository.
 *
 * `location.ts` says where they are read from; `load.ts` reads them off disk
 * into {@link Skill}s; `registry.ts` answers every question the two entry points
 * ask of them; `tool.ts` is the model's entry (`Skill(name)`), `inject.ts` is
 * the catalogue the model uses to know what to name. The user's entry — the
 * slash command — is parsed in `registry.ts` and wired in the console, so both
 * entries share one loader and one product.
 */
export { defaultSkillRoots, SKILLS_DIR_NAME } from "./location";
export { loadSkills, MAX_SKILL_BYTES, SKILL_FILE, type Skill } from "./load";
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
