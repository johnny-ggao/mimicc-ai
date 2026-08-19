import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The directory a skill lives in, under both roots. Named to sit beside
 * `~/.mimicc/memory` rather than to describe the contents.
 */
export const SKILLS_DIR_NAME = "skills";

/**
 * The directories skill loading reads, highest precedence first.
 *
 * Order is the entire collision policy: a `name` seen in an earlier root wins,
 * so mimicc's own skills shadow a Claude skill of the same name. Both are read
 * in place — no copy, no conversion — and `~/.claude/skills` is followed through
 * its symlinks rather than resolved away, because "where did this come from" is
 * provenance the loader keeps.
 */
export function defaultSkillRoots(): string[] {
  return [
    join(homedir(), ".mimicc", SKILLS_DIR_NAME),
    join(homedir(), ".claude", SKILLS_DIR_NAME),
  ];
}
