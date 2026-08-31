import { readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

import { HumanMessage } from "@langchain/core/messages";

import { PINNED } from "../context";

import { MAX_SKILL_BYTES, type Skill } from "./load";

/**
 * The message id for the injected catalogue, and — exactly as with the project
 * instructions — the entire deduplication strategy: `messagesStateReducer` merges
 * by id, replacing in place, so a `beforeAgent` that returns it every turn is
 * idempotent without a guard or a scan.
 */
export const SKILL_CATALOG_ID = "skill-catalog";

/**
 * The loaded skills, indexed by name for the two entry points (the `Skill` tool
 * and the slash command) to share.
 *
 * The registry is pure: it holds what `loadSkills` read and answers questions
 * about it, and never touches the filesystem except through {@link readFile} —
 * and that is confined to a skill's own directory.
 */
export class SkillRegistry {
  private readonly byName: Map<string, Skill>;

  constructor(skills: readonly Skill[]) {
    this.byName = new Map(skills.map((skill) => [skill.name, skill]));
  }

  /** Every skill, whatever its invocation mode. For `/skills`. */
  all(): Skill[] {
    return [...this.byName.values()];
  }

  /** The skills the model may load on its own. For the catalogue. */
  modelInvokable(): Skill[] {
    return this.all().filter((skill) => skill.modelInvokable);
  }

  get(name: string): Skill | undefined {
    return this.byName.get(name);
  }

  /**
   * The registry split against what is actually registered: skills whose
   * declared `requires` are all present stay, the rest are dropped **with the
   * names of what they were missing** — the caller reports them, because a
   * capability that silently vanished reads as a capability that never existed.
   *
   * A skill that declares nothing is kept unchecked, deliberately: `requires`
   * is this program's key, and a fail-closed default would drop every skill
   * written for some other agent (see the note on `Skill.requires`).
   */
  satisfiedBy(roster: ReadonlySet<string>): {
    kept: SkillRegistry;
    dropped: { name: string; missing: string[] }[];
  } {
    const kept: Skill[] = [];
    const dropped: { name: string; missing: string[] }[] = [];
    for (const skill of this.byName.values()) {
      const missing = (skill.requires ?? []).filter((tool) => !roster.has(tool));
      if (missing.length === 0) kept.push(skill);
      else dropped.push({ name: skill.name, missing });
    }
    return { kept: new SkillRegistry(kept), dropped };
  }

  /**
   * The injected catalogue, or undefined when there is nothing to inject.
   *
   * Only model-invoked skills appear: a `disable-model-invocation` skill is the
   * user's to remember, and its description is human-facing, not model-facing.
   * Nothing to inject is no section — an empty tag would spend tokens saying what
   * the tag's absence already says, on every request, forever.
   */
  catalogText(): string | undefined {
    const skills = this.modelInvokable();
    if (skills.length === 0) return undefined;

    return [
      "<skill-catalog>",
      "Task-specific skills available to you. Their full instructions are loaded on demand with Skill(name); only the name and description are shown here.",
      ...skills.map((skill) => `- ${skill.name}: ${skill.description}`),
      "</skill-catalog>",
    ].join("\n");
  }

  /**
   * Reads an auxiliary file that lives inside a skill's directory, and nothing
   * else. The path is resolved against the skill's base and refused if it leaves
   * it — the same one-directory confinement the project instructions get, but
   * enforced at the read because the model supplies the path.
   */
  readFile(name: string, file: string): string {
    const skill = this.byName.get(name);
    if (skill === undefined) throw new Error(`no skill named ${name}`);

    const full = resolve(skill.dir, file);
    if (full !== skill.dir && !full.startsWith(skill.dir + sep)) {
      throw new Error(`path escapes the skill directory: ${file}`);
    }

    let stat;
    try {
      stat = statSync(full, { throwIfNoEntry: false });
    } catch (error) {
      throw new Error(
        `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (stat === undefined || !stat.isFile()) {
      throw new Error(`no such auxiliary file: ${file}`);
    }

    const text = readFileSync(full, "utf8");
    if (text.length <= MAX_SKILL_BYTES) return text;
    return `${text.slice(0, MAX_SKILL_BYTES)}\n\n[clipped at ${String(MAX_SKILL_BYTES)} bytes of ${String(text.length)}]`;
  }
}

/**
 * Wraps a skill body in the tag that carries its provenance.
 *
 * The tag is the only place provenance can go: the body enters the context as a
 * user-role message, and the completions converter writes no `name` field there,
 * so "this text came from a skill" has to live in the text itself. What the tag
 * buys is a boundary and an origin, not obedience — the authority relationship
 * is stated in the system prompt, which a skill cannot reach.
 */
export function wrapSkill(skill: Skill): string {
  const pointer =
    skill.files.length === 0
      ? ""
      : `\nAuxiliary files: ${skill.files.map((file) => `\`${file}\``).join(", ")} — read one with Skill(name="${skill.name}", file="<file>").`;
  return `<skill name="${skill.name}">\n${skill.body.trim()}${pointer}\n</skill>`;
}

/**
 * The pinned message a slash command injects when the user types `/name`.
 *
 * Pinned at construction, by the one who knows it has to be: it carries the
 * skill's binding instructions, and a summary eating it is exactly the failure a
 * skill exists to prevent. The id is per-skill, so typing the same skill twice
 * merges onto the first copy instead of appending a duplicate.
 *
 * When the skill declares an `argument-hint`, that hint is surfaced here rather
 * than left in the frontmatter the model never sees: the model has to know what
 * to ask for when the user typed `/name` bare, and what the trailing words
 * answer when they typed `/name <argument>`. The tail itself stays a separate
 * message — the activation is instructions, the argument is the turn's task.
 */
export function skillActivationMessage(skill: Skill): HumanMessage {
  const hint =
    skill.argumentHint === undefined
      ? ""
      : `\n\nThis skill takes an argument: "${skill.argumentHint}". If the user provided it in their message, use it; otherwise ask them for it first.`;

  return new HumanMessage({
    id: `skill:${skill.name}`,
    content: `${wrapSkill(skill)}${hint}`,
    additional_kwargs: { ...PINNED },
  });
}

/**
 * The `/skills` listing: every skill, split by whether the model may reach it on
 * its own. The human is the index for the slash-only half, so those names must
 * be visible here — that is the one place the user can be reminded they exist.
 * A skill that takes an argument shows the `<argument>` placeholder and the hint
 * that says what the argument is.
 */
export function renderSkillList(registry: SkillRegistry): string {
  const model = registry.modelInvokable();
  const userInvoked = registry.all().filter((skill) => !skill.modelInvokable);

  if (model.length === 0 && userInvoked.length === 0) return "no skills installed";

  const lines: string[] = [];
  if (model.length > 0) {
    lines.push("model-invoked (the agent loads these on its own):");
    lines.push(...model.map(skillEntry));
  }
  if (userInvoked.length > 0) {
    lines.push("slash-only (type the name to run):");
    lines.push(...userInvoked.map(skillEntry));
  }
  return lines.join("\n");
}

/** One skill as a scannable line: how to invoke it, what it is, and its argument. */
function skillEntry(skill: Skill): string {
  const command =
    skill.argumentHint === undefined ? `/${skill.name}` : `/${skill.name} <argument>`;
  const hint =
    skill.argumentHint === undefined ? "" : ` (argument: "${skill.argumentHint}")`;
  return `  ${command} — ${skill.description}${hint}`;
}

/** What a slash-prefixed line means, after `/clear` and `/exit` are ruled out. */
export type SkillCommand =
  | { type: "list" }
  | { type: "activate"; skill: Skill; tail?: string }
  | { type: "unknown"; name: string };

/**
 * Parses one slash command into a list / activate / unknown result.
 *
 * `input` is already known to start with `/`; `/clear` and `/exit` are the
 * console's own built-ins and never reach here, which is what makes them win
 * over a skill of the same name. A trailing word after `/name` is the skill's
 * argument: it rides as the turn's task message, and the activation message
 * carries the `argument-hint` that says what it answers. Losing what the user
 * typed would be a bug, so the tail is always carried rather than dropped.
 */
export function parseSkillCommand(
  input: string,
  registry: SkillRegistry,
): SkillCommand {
  const space = input.indexOf(" ");
  const word = space === -1 ? input.slice(1) : input.slice(1, space);
  const tail = space === -1 ? "" : input.slice(space + 1).trim();

  if (word === "skills") return { type: "list" };

  const skill = registry.get(word);
  if (skill === undefined) return { type: "unknown", name: word };
  return { type: "activate", skill, ...(tail !== "" ? { tail } : {}) };
}
