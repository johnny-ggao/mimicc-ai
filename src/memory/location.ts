import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { repoSlug } from "../checkpoint";

/**
 * Where memory lives, and why it is *not* where the session files live.
 *
 * `resolveStateDir` splits by environment on purpose: developing this repository
 * you want the history next to the code, running against somebody else's project
 * you must not write into their tree. **Memory cannot follow that split**, for
 * two reasons that only apply to it:
 *
 * - **The global tier spans projects.** Putting it under a working directory
 *   means it disappears the moment the program starts somewhere else, which is
 *   the one thing that tier exists to prevent.
 * - **A `NODE_ENV`-dependent path would fork one project's memory in half.** A
 *   forked checkpoint is harmless — each conversation stands alone. Forked
 *   memory is not: it is an accumulating asset, and half of it would silently go
 *   missing depending on how the program was started.
 *
 * There is a third, quieter reason: in development the state directory lives
 * inside the working tree and is git-ignored, which makes it exactly the sort of
 * directory a person deletes without thinking. Session files can afford that.
 *
 * `MIMICC_MEMORY_DIR` overrides it, the same escape hatch `MIMICC_STATE_DIR` is
 * for the state directory — and, like that one, it is read from the environment
 * rather than declared in the config schema, because it exists for tests and for
 * the cases the default does not fit.
 */
export const MEMORY_DIR_NAME = "memory";

export interface MemoryLocation {
  /** `MIMICC_MEMORY_DIR`, when set. Wins over the default. */
  override?: string | undefined;
  /** The directory the program was started in. This is what "project" means. */
  cwd: string;
}

export interface MemoryDirs {
  /** Facts that hold no matter which repository this is. */
  global: string;
  /** Facts that only hold in the project the program was started in. */
  project: string;
}

/**
 * Resolves both tiers.
 *
 * The project tier is keyed by `repoSlug(cwd)` — the same slug the state
 * directory uses, so a person who can find their history can find their memory
 * by the same name. **The key is the absolute path of the working directory**,
 * which is the decided meaning of "project" (2026-08-17): starting from `src/`
 * and starting from the repository root are two different projects. That is the
 * chosen semantics, not an oversight — the program has no other signal at
 * startup about what the user considers one project.
 */
export function resolveMemoryDirs(location: MemoryLocation): MemoryDirs {
  const root =
    location.override !== undefined && location.override !== ""
      ? resolve(location.override)
      : join(homedir(), ".mimicc", MEMORY_DIR_NAME);

  return {
    global: join(root, "global"),
    project: join(root, "projects", repoSlug(location.cwd)),
  };
}
