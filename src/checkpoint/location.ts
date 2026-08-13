import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

/**
 * Where thread files live, and why the answer is not one place.
 *
 * Two placements, because the two audiences want opposite things:
 *
 * - **Developing this repository**, the history is the thing being studied. It
 *   belongs next to the code, where an editor and a `jq` one-liner can reach it
 *   without anyone remembering a path. It is git-ignored, and — the part that is
 *   not obvious — the tools refuse to read it (see `SECRET` in tools/workspace),
 *   because a directory inside the working directory is a directory the agent's
 *   own `Read` can open, and its own past conversations are the one thing it has
 *   no business fetching.
 * - **Running it against somebody else's project**, writing into their tree is
 *   rude and, worse, easy to commit by accident. So it goes under the user's home
 *   directory, partitioned by repository.
 *
 * `MIMICC_STATE_DIR` overrides both, for the cases neither default fits.
 */

/** The directory name used inside the working directory, and under `~`. */
export const STATE_DIR_NAME = ".mimicc";

export interface StateLocation {
  /** `NODE_ENV`, already parsed by the config schema. */
  nodeEnv: "development" | "test" | "production";
  /** `MIMICC_STATE_DIR`, when set. Wins over everything. */
  override?: string | undefined;
  cwd: string;
}

export function resolveStateDir(location: StateLocation): string {
  if (location.override !== undefined && location.override !== "") {
    return resolve(location.override);
  }
  if (location.nodeEnv === "production") {
    return join(homedir(), STATE_DIR_NAME, repoSlug(location.cwd));
  }
  return join(location.cwd, STATE_DIR_NAME);
}

/**
 * A directory name that is unique per repository but still recognisable.
 *
 * The hash alone would be correct and unreadable; the basename alone collides
 * the moment somebody has two checkouts of the same project. Both together let a
 * person find their own history in `~/.mimicc` by eye, which is the same reason
 * the file format is JSONL.
 */
function repoSlug(cwd: string): string {
  const absolute = resolve(cwd);
  const digest = createHash("sha256").update(absolute).digest("hex").slice(0, 12);
  const name = basename(absolute).replace(/[^\w.-]/g, "-") || "repo";
  return `${name}-${digest}`;
}
