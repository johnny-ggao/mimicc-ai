import { existsSync, readFileSync } from "node:fs";

import { z } from "zod";

import { parseRule, type RuleSet } from "./permission";

/**
 * The shape of one permissions file. Strict on purpose: an unknown key is a
 * typo (e.g. `alow`), and silently ignoring it would ship a rule the author
 * thought they had written.
 */
const layerSchema = z
  .object({
    allow: z.array(z.string()).optional(),
    ask: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
  })
  .strict();

export interface PermissionFiles {
  /** User-level rules: `~/.mimicc/permissions.json`. */
  userFile: string;
  /** Repository-level rules: `.mimicc-permissions.json`, tracked. */
  repoFile: string;
}

/**
 * Loads and merges the two permission layers into one rule set.
 *
 * Merge is concatenation — the rule engine (`decide`) already evaluates deny →
 * ask → allow, so "strictest wins" is an evaluation property, not a merge one.
 * What the loader adds is the one asymmetry: a repository may only contain
 * `ask` and `deny`, never `allow`, because it can tighten the user's rules but
 * never loosen them.
 *
 * Throws with a readable message on any malformed input rather than failing
 * open: a permissions file that cannot be read must stop the program, not
 * silently remove its protection.
 */
export function loadPermissions(files: PermissionFiles): RuleSet {
  const user = loadLayer(files.userFile, "user");
  const repo = loadLayer(files.repoFile, "repo");
  return [...user, ...repo];
}

function loadLayer(file: string, layer: "user" | "repo"): RuleSet {
  if (!existsSync(file)) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `cannot parse ${layer} permissions file ${file}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }

  const result = layerSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`invalid ${layer} permissions file ${file}:\n${details}`);
  }

  if (layer === "repo" && result.data.allow !== undefined) {
    throw new Error(
      `invalid repo permissions file ${file}: it may not contain "allow" — a repository can tighten, never loosen`,
    );
  }

  const rules: RuleSet = [];
  for (const decision of ["deny", "ask", "allow"] as const) {
    for (const spec of result.data[decision] ?? []) {
      try {
        rules.push(parseRule(spec, decision));
      } catch (error) {
        throw new Error(
          `invalid rule in ${layer} permissions file ${file}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        );
      }
    }
  }
  return rules;
}
