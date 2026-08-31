import type { Logger } from "../logger";

import { skillFromRaw, type Skill } from "./load";

// The canonical file IS the source: `bun build` inlines a `type: "text"` import
// into the bundle, so the installed single-file main.js carries the skill with
// no install step and no path to break — `install.sh` ships nothing but that
// one file, which is why a bundled *directory* was never an option. Editing
// skills/research/SKILL.md changes what ships; there is no second copy.
import researchRaw from "../../skills/research/SKILL.md" with { type: "text" };

/**
 * The sentinel `dir` a bundled skill carries. Not a path on purpose: a bundled
 * skill has no directory, advertises no auxiliary files (`files: []`), and
 * `SkillRegistry.readFile`'s confinement can never resolve into it.
 */
export const BUNDLED_DIR = "<bundled>";

/**
 * The skills this program ships with (research-kind ticket 02, reshaped
 * 2026-08-31 on the user's call: "封装到 agent 内部，不需要额外安装").
 *
 * Parsed through the same frontmatter path installed skills take, so `requires`
 * filtering, clipping and the catalogue treat a bundled skill exactly like an
 * installed one — bundling changes where the bytes come from, nothing else.
 * Precedence is decided by the caller (`defaultSkills`): user-installed mimicc
 * skills override these, and these override skills borrowed from other agents'
 * roots — which is the point, since the borrowed `research` skill promising
 * capabilities it cannot name is the failure this skill replaces.
 */
export function bundledSkills(log: Logger): Skill[] {
  const skills: Skill[] = [];
  for (const raw of [researchRaw]) {
    const skill = skillFromRaw(raw, BUNDLED_DIR, [], log);
    if (skill !== undefined) skills.push(skill);
  }
  return skills;
}
