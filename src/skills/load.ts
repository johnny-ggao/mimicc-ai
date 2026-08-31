import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Logger } from "../logger";

/** The one file every skill is built around. */
export const SKILL_FILE = "SKILL.md";

/**
 * Output cap on a skill body, and deliberately not `MAX_INSTRUCTION_BYTES`
 * (8_000): that number sizes text that rides along on every request for the
 * life of a thread, while a skill body is loaded on demand and paid for once.
 * `MAX_FILE_BYTES` is the same order and the same reason — a tool result goes
 * straight into the next prompt.
 *
 * Measured against the local install (2026-08-19): the largest body is ~11.6KB,
 * so this bound is a runaway detector rather than the path anything real takes.
 */
export const MAX_SKILL_BYTES = 64_000;

/** One skill, as read off disk and ready to be wrapped or catalogued. */
export interface Skill {
  /** The addressing key: the tool name, the slash command, the tag. */
  name: string;
  /** Frontmatter `description`. Only model-invoked skills expose it to the model. */
  description: string;
  /** `false` when the frontmatter says `disable-model-invocation: true`. */
  modelInvokable: boolean;
  /** Frontmatter `argument-hint`, when present. Parsed now, wired later. */
  argumentHint?: string;
  /**
   * Frontmatter `requires`: tool names this skill's instructions assume, comma
   * separated. A skill that declares them is only advertised when every one is
   * registered (research-kind ticket 02) — the borrowed-skill failure this
   * closes is a skill promising "search the primary sources" to an agent with
   * no way to reach them, and the model promising it onward to the user.
   * Undeclared means unchecked: a foreign skill passes through exactly as
   * before, because a fail-closed default would silently drop every skill
   * written for some other agent.
   */
  requires?: string[];
  /** Absolute directory the skill was read from — the base for auxiliary files. */
  dir: string;
  /** The SKILL.md body with frontmatter stripped, clipped when oversized. */
  body: string;
  /** Sibling file basenames (excluding SKILL.md and dotfiles) the body may reach. */
  files: string[];
}

/**
 * Reads every skill under every root, first root winning on a name collision.
 *
 * `roots` are ordered highest-precedence-first by the caller (see
 * `defaultSkillRoots`), so "first seen keeps the name" is the shadowing rule and
 * there is nothing more to say about it. A root that does not exist, a directory
 * with no `SKILL.md`, and a file that will not parse are all skipped rather than
 * fatal: one broken skill must not take down the whole list it sits in.
 */
export function loadSkills(roots: string[], log: Logger): Skill[] {
  return mergeSkills(
    roots.map((root) =>
      listSkillDirs(root)
        .map((dir) => readSkill(dir, log))
        .filter((skill): skill is Skill => skill !== undefined),
    ),
    log,
  );
}

/**
 * First group wins on a name collision, and the loser is warned by name and
 * origin — shadowing is a feature, silent shadowing is a mystery. Groups exist
 * because a precedence slot is not always a directory: the bundled skills
 * (`bundled.ts`) sit between the user's mimicc root and the borrowed Claude
 * root, and they were never on disk.
 *
 * Sorted by name, because the catalogue rides in the injected context and a
 * stable order is what keeps it byte-identical between runs.
 */
export function mergeSkills(groups: readonly Skill[][], log: Logger): Skill[] {
  const byName = new Map<string, Skill>();
  for (const group of groups) {
    for (const skill of group) {
      if (byName.has(skill.name)) {
        log.warn("skill_shadowed", { name: skill.name, dir: skill.dir });
        continue;
      }
      byName.set(skill.name, skill);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Immediate subdirectories of `root`, following symlinks. Missing → none. */
function listSkillDirs(root: string): string[] {
  // Resolved once here so every skill carries an absolute directory: `readFile`
  // confines paths by prefix, and a relative base next to an absolute resolution
  // would break that check.
  const absRoot = resolve(root);

  let names: string[];
  try {
    names = readdirSync(absRoot);
  } catch {
    return [];
  }

  const dirs: string[] = [];
  for (const name of names) {
    const path = join(absRoot, name);
    try {
      // `stat`, not the dirent's own flag: `~/.claude/skills` holds symlinks to
      // `~/.agents/skills`, and a dirent reports a symlink as not-a-directory.
      if (statSync(path).isDirectory()) dirs.push(path);
    } catch {
      // Raced away or unreadable — one directory, not the load.
    }
  }
  return dirs;
}

/** Reads one skill directory, or undefined when it is not one. */
function readSkill(dir: string, log: Logger): Skill | undefined {
  const raw = readRaw(dir, log);
  if (raw === undefined) return undefined;
  return skillFromRaw(raw, dir, siblingFiles(dir), log);
}

/**
 * One skill from its raw SKILL.md text. The seam the bundled skills come
 * through (`bundled.ts`): parsing, validation and clipping are identical
 * whether the bytes came off disk or out of the compiled bundle, so `requires`
 * filtering and the catalogue never learn the difference.
 */
export function skillFromRaw(
  raw: string,
  dir: string,
  files: string[],
  log: Logger,
): Skill | undefined {
  const parsed = parseFrontmatter(raw);
  if (parsed === undefined) {
    log.warn("skill_no_frontmatter", { dir });
    return undefined;
  }
  if (parsed.name === undefined || parsed.name === "") {
    log.warn("skill_no_name", { dir });
    return undefined;
  }

  return {
    name: parsed.name,
    description: parsed.description,
    modelInvokable: !parsed.disableModelInvocation,
    ...(parsed.argumentHint !== undefined ? { argumentHint: parsed.argumentHint } : {}),
    ...(parsed.requires !== undefined ? { requires: parsed.requires } : {}),
    dir,
    body: clip(parsed.body.trim()),
    files,
  };
}

function readRaw(dir: string, log: Logger): string | undefined {
  const path = join(dir, SKILL_FILE);
  try {
    const stat = statSync(path, { throwIfNoEntry: false });
    if (stat === undefined) {
      log.warn("skill_missing_file", { dir, file: SKILL_FILE });
      return undefined;
    }
    if (!stat.isFile()) {
      log.warn("skill_missing_file", {
        dir,
        file: SKILL_FILE,
        reason: "not a regular file",
      });
      return undefined;
    }
    return readFileSync(path, "utf8");
  } catch (error) {
    log.warn("skill_unreadable", {
      dir,
      file: SKILL_FILE,
      reason: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

interface Frontmatter {
  name?: string;
  description: string;
  disableModelInvocation: boolean;
  argumentHint?: string;
  requires?: string[];
}

/**
 * Splits a SKILL.md into its frontmatter and body.
 *
 * The format is a leading `---` fence, `key: value` lines, a closing `---`, then
 * the body. Only the four keys this program acts on are kept; every other key
 * (e.g. `cli_version`) is read and dropped, deliberately not rejected — a
 * foreign key is metadata for some other agent, not a reason to skip the skill.
 * Values are split on the *first* colon, so a description that contains one
 * still parses. Undefined when the file does not open with the fence.
 */
function parseFrontmatter(raw: string): (Frontmatter & { body: string }) | undefined {
  const lines = raw.split(/\r?\n/);
  if (lines[0] !== "---") return undefined;

  const close = lines.indexOf("---", 1);
  if (close === -1) return undefined;

  const fm: Frontmatter = { description: "", disableModelInvocation: false };
  for (let index = 1; index < close; index += 1) {
    const line = lines[index];
    if (line === undefined || line.trim() === "") continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = unquote(line.slice(colon + 1).trim());

    if (key === "name") fm.name = value;
    else if (key === "description") fm.description = value;
    else if (key === "disable-model-invocation")
      fm.disableModelInvocation = value === "true";
    else if (key === "argument-hint") fm.argumentHint = value;
    else if (key === "requires") {
      // Comma separated on one line, matching the parser's line discipline.
      // An empty declaration is dropped rather than kept as [] — "requires
      // nothing" and "declared nothing" must stay the same case.
      const named = value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "");
      if (named.length > 0) fm.requires = named;
    }
  }

  return {
    ...(fm.name !== undefined ? { name: fm.name } : {}),
    description: fm.description,
    disableModelInvocation: fm.disableModelInvocation,
    ...(fm.argumentHint !== undefined ? { argumentHint: fm.argumentHint } : {}),
    ...(fm.requires !== undefined ? { requires: fm.requires } : {}),
    body: lines.slice(close + 1).join("\n"),
  };
}

/** Strips one pair of surrounding double quotes, when present. */
function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

function siblingFiles(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  return names.filter((name) => {
    if (name === SKILL_FILE || name.startsWith(".")) return false;
    try {
      return statSync(join(dir, name)).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * Clips a body over the cap, with the same `[clipped at …]` marker `Read` and
 * `readProjectInstructions` use. Refusing to load at all would fail silently: an
 * oversized skill would simply not apply, and nobody would know.
 */
function clip(body: string): string {
  if (body.length <= MAX_SKILL_BYTES) return body;
  return `${body.slice(0, MAX_SKILL_BYTES)}\n\n[clipped at ${String(MAX_SKILL_BYTES)} bytes of ${String(body.length)}]`;
}
