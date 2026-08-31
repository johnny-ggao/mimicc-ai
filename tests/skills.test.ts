import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  createSkillTool,
  loadSkills,
  parseSkillCommand,
  renderSkillList,
  skillActivationMessage,
  SKILL_CATALOG_ID,
  SKILL_TOOL_NAME,
  SkillRegistry,
  wrapSkill,
} from "@/skills";
import type { Logger } from "@/logger";
import { isPinned } from "@/context";

/**
 * Fixtures live inside the repository, same reason as tests/instructions.ts:
 * nothing should write outside it. `.test-tmp/` is gitignored.
 */
const DIR = ".test-tmp/skills";

/** Records what the loader reported, since the failure modes are log-only. */
function recorder(): { lines: string[]; log: Logger } {
  const lines: string[] = [];
  const note =
    (level: string) =>
    (message: string, meta?: Record<string, unknown>): void => {
      lines.push(`${level} ${message} ${JSON.stringify(meta ?? {})}`);
    };
  return {
    lines,
    log: {
      debug: note("debug"),
      info: note("info"),
      warn: note("warn"),
      error: note("error"),
    },
  };
}

/** Writes one skill directory and returns its path. */
function skillDir(
  root: string,
  name: string,
  frontmatter: string,
  body: string,
  files: Record<string, string> = {},
): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}\n`);
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(dir, file), content);
  }
  return dir;
}

function root(): string {
  const dir = join(DIR, String(Math.random()).slice(2));
  mkdirSync(dir, { recursive: true });
  return dir;
}

afterAll(() => rmSync(DIR, { recursive: true, force: true }));

describe("loadSkills", () => {
  test("parses frontmatter and strips it from the body", () => {
    const { log } = recorder();
    const r = root();
    skillDir(
      r,
      "tdd",
      "name: tdd\ndescription: Test-driven development. Use when the user wants test-first.",
      "Do the red-green-refactor.\n",
    );

    const [skill] = loadSkills([r], log);
    expect(skill).toBeDefined();
    expect(skill?.name).toBe("tdd");
    expect(skill?.description).toContain("Test-driven development");
    expect(skill?.modelInvokable).toBe(true);
    expect(skill?.body).toBe("Do the red-green-refactor.");
  });

  test("reads disable-model-invocation and argument-hint", () => {
    const { log } = recorder();
    const r = root();
    skillDir(
      r,
      "implement",
      'name: implement\ndescription: "Implement a piece of work."\ndisable-model-invocation: true\nargument-hint: "What work?"',
      "Implement the work.\n",
    );

    const [skill] = loadSkills([r], log);
    expect(skill?.modelInvokable).toBe(false);
    expect(skill?.argumentHint).toBe("What work?");
  });

  test("a description containing a colon still parses", () => {
    const { log } = recorder();
    const r = root();
    skillDir(
      r,
      "review",
      "name: review\ndescription: Review a diff: standards and spec.",
      "Review.\n",
    );

    const [skill] = loadSkills([r], log);
    expect(skill?.description).toBe("Review a diff: standards and spec.");
  });

  test("skips a directory with no SKILL.md and a file with no name", () => {
    const { lines, log } = recorder();
    const r = root();
    mkdirSync(join(r, "empty"), { recursive: true });
    skillDir(r, "anon", "description: no name here", "body\n");

    const skills = loadSkills([r], log);
    expect(skills).toHaveLength(0);
    expect(lines.some((line) => line.startsWith("warn skill_missing_file"))).toBe(true);
    expect(lines.some((line) => line.startsWith("warn skill_no_name"))).toBe(true);
  });

  test("the first root wins on a name collision", () => {
    const { log } = recorder();
    const first = root();
    const second = root();
    skillDir(first, "tdd", "name: tdd\ndescription: mine", "first body\n");
    skillDir(second, "tdd", "name: tdd\ndescription: borrowed", "second body\n");

    const skills = loadSkills([first, second], log);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.body).toBe("first body");
  });

  test("lists sibling files and clips an oversized body", () => {
    const { log } = recorder();
    const r = root();
    skillDir(r, "big", "name: big\ndescription: big body", "x".repeat(70_000), {
      "GLOSSARY.md": "terms",
      ".hidden": "not listed",
    });

    const [skill] = loadSkills([r], log);
    expect(skill?.files).toEqual(["GLOSSARY.md"]);
    expect(skill?.body).toContain("[clipped at");
  });
});

describe("SkillRegistry", () => {
  function registry(): SkillRegistry {
    const { log } = recorder();
    const r = root();
    skillDir(
      r,
      "tdd",
      "name: tdd\ndescription: Test-first development.",
      "Do red-green-refactor.\n",
      { "GLOSSARY.md": "terms" },
    );
    skillDir(
      r,
      "implement",
      'name: implement\ndescription: "Implement a piece of work."\ndisable-model-invocation: true',
      "Implement the work.\n",
    );
    return new SkillRegistry(loadSkills([r], log));
  }

  test("catalog lists only model-invoked skills", () => {
    const text = registry().catalogText();
    expect(text).toContain("<skill-catalog>");
    expect(text).toContain("- tdd: Test-first development.");
    expect(text).not.toContain("implement");
  });

  test("catalog is undefined when nothing is model-invoked", () => {
    const { log } = recorder();
    const r = root();
    skillDir(
      r,
      "implement",
      'name: implement\ndescription: "Implement."\ndisable-model-invocation: true',
      "body\n",
    );
    expect(new SkillRegistry(loadSkills([r], log)).catalogText()).toBeUndefined();
  });

  test("wrapSkill carries provenance and the auxiliary-file pointer", () => {
    const skill = registry().get("tdd");
    expect(skill).toBeDefined();
    const wrapped = wrapSkill(skill as NonNullable<typeof skill>);

    expect(wrapped).toContain('<skill name="tdd">');
    expect(wrapped).toContain("Do red-green-refactor.");
    expect(wrapped).toContain("Auxiliary files: `GLOSSARY.md`");
    expect(wrapped).toContain("</skill>");
  });

  test("readFile reads a sibling and refuses an escape", () => {
    const reg = registry();
    expect(reg.readFile("tdd", "GLOSSARY.md")).toBe("terms");
    expect(() => reg.readFile("tdd", "../outside")).toThrow(/escapes/);
    expect(() => reg.readFile("tdd", "missing.md")).toThrow(/no such auxiliary file/);
  });

  test("activation message is pinned with a per-skill id", () => {
    const skill = registry().get("tdd");
    const message = skillActivationMessage(skill as NonNullable<typeof skill>);

    expect(isPinned(message)).toBe(true);
    expect(message.id).toBe("skill:tdd");
  });
});

describe("slash commands", () => {
  function registry(): SkillRegistry {
    const { log } = recorder();
    const r = root();
    skillDir(r, "tdd", "name: tdd\ndescription: Test-first.", "body\n");
    skillDir(
      r,
      "implement",
      'name: implement\ndescription: "Implement."\ndisable-model-invocation: true',
      "body\n",
    );
    return new SkillRegistry(loadSkills([r], log));
  }

  test("parses /skills, /name, /name with a tail, and an unknown", () => {
    const reg = registry();

    expect(parseSkillCommand("/skills", reg)).toEqual({ type: "list" });

    const activate = parseSkillCommand("/tdd", reg);
    expect(activate.type).toBe("activate");

    const withTail = parseSkillCommand("/tdd build the login form", reg);
    expect(withTail.type).toBe("activate");
    if (withTail.type === "activate")
      expect(withTail.tail).toBe("build the login form");

    expect(parseSkillCommand("/nope", reg)).toEqual({ type: "unknown", name: "nope" });
  });

  test("renderSkillList groups by invocation mode", () => {
    const list = renderSkillList(registry());

    expect(list).toContain("model-invoked");
    expect(list).toContain("/tdd");
    expect(list).toContain("slash-only");
    expect(list).toContain("/implement");
  });

  test("an empty registry lists nothing", () => {
    expect(renderSkillList(new SkillRegistry([]))).toBe("no skills installed");
  });
});

describe("the Skill tool", () => {
  function registry(): SkillRegistry {
    const { log } = recorder();
    const r = root();
    skillDir(
      r,
      "tdd",
      "name: tdd\ndescription: Test-first.",
      "Do red-green-refactor.\n",
      { "GLOSSARY.md": "terms" },
    );
    skillDir(
      r,
      "implement",
      'name: implement\ndescription: "Implement."\ndisable-model-invocation: true',
      "body\n",
    );
    return new SkillRegistry(loadSkills([r], log));
  }

  /** Awaits a rejection and hands back the message. */
  async function failureFrom(work: Promise<unknown>): Promise<string> {
    try {
      await work;
    } catch (error) {
      return String(error);
    }
    throw new Error("expected this to fail, but it succeeded");
  }

  test("has the name the prompt advertises", () => {
    expect(createSkillTool(registry()).name).toBe(SKILL_TOOL_NAME);
  });

  test("loads a model-invoked skill as its wrapped body", async () => {
    const result = await createSkillTool(registry()).invoke({ name: "tdd" });

    expect(result).toContain('<skill name="tdd">');
    expect(result).toContain("Do red-green-refactor.");
  });

  test("refuses a user-invoked skill and an unknown name", async () => {
    const tool = createSkillTool(registry());

    expect(await failureFrom(tool.invoke({ name: "implement" }))).toContain(
      "user-invoked only",
    );
    expect(await failureFrom(tool.invoke({ name: "nope" }))).toContain(
      "no skill named nope",
    );
  });

  test("reads an auxiliary file when file is passed", async () => {
    const result = await createSkillTool(registry()).invoke({
      name: "tdd",
      file: "GLOSSARY.md",
    });

    expect(result).toBe("terms");
  });

  test("deduplicates a second load within one thread", async () => {
    const tool = createSkillTool(registry());
    const config = { configurable: { thread_id: "skills-thread" } };

    await tool.invoke({ name: "tdd" }, config);
    const second = await tool.invoke({ name: "tdd" }, config);

    expect(second).toContain("already loaded");
  });

  test("does not deduplicate across threads", async () => {
    const tool = createSkillTool(registry());

    await tool.invoke({ name: "tdd" }, { configurable: { thread_id: "a" } });
    const other = await tool.invoke(
      { name: "tdd" },
      { configurable: { thread_id: "b" } },
    );

    expect(other).toContain('<skill name="tdd">');
  });
});

describe("the catalogue injection id", () => {
  test("is a stable id the reducer can merge on", () => {
    expect(SKILL_CATALOG_ID).toBe("skill-catalog");
  });
});

describe("argument-hint", () => {
  function hintRegistry(): SkillRegistry {
    const { log } = recorder();
    const r = root();
    skillDir(
      r,
      "handoff",
      'name: handoff\ndescription: "Write a handoff document."\ndisable-model-invocation: true\nargument-hint: "What will the next session be used for?"',
      "Write the handoff.\n",
    );
    return new SkillRegistry(loadSkills([r], log));
  }

  test("the activation message surfaces the hint for the model", () => {
    const skill = hintRegistry().get("handoff");
    const message = skillActivationMessage(skill as NonNullable<typeof skill>);

    expect(message.content).toContain("This skill takes an argument");
    expect(message.content).toContain("What will the next session be used for?");
  });

  test("a skill without a hint carries no argument line", () => {
    const { log } = recorder();
    const r = root();
    skillDir(r, "tdd", "name: tdd\ndescription: Test-first.", "Do it.\n");
    const reg = new SkillRegistry(loadSkills([r], log));
    const skill = reg.get("tdd") as NonNullable<ReturnType<typeof reg.get>>;

    expect(skillActivationMessage(skill).content).not.toContain(
      "This skill takes an argument",
    );
  });

  test("/skills shows the argument placeholder and the hint", () => {
    const list = renderSkillList(hintRegistry());

    expect(list).toContain("/handoff <argument>");
    expect(list).toContain('(argument: "What will the next session be used for?")');
  });
});

// The two entry points share one loader and one product: the slash command's
// activation message and the tool's return wrap the same bytes.
describe("one loader, one product", () => {
  test("the slash activation and the tool result wrap identically", async () => {
    const { log } = recorder();
    const r = root();
    skillDir(r, "tdd", "name: tdd\ndescription: Test-first.", "Do it.\n");
    const reg = new SkillRegistry(loadSkills([r], log));
    const skill = reg.get("tdd") as NonNullable<ReturnType<typeof reg.get>>;

    const viaSlash = skillActivationMessage(skill).content;
    const viaTool = await createSkillTool(reg).invoke({ name: "tdd" });

    expect(viaSlash).toBe(viaTool);
  });
});

/**
 * `requires`: a skill's declared tool assumptions, and the filter that keeps a
 * skill from being advertised to an agent that cannot honour it
 * (research-kind ticket 02 — the borrowed research skill promised web research
 * while nothing here could reach the web, and the model promised it onward).
 */
describe("declared requirements", () => {
  test("requires is parsed as a comma list; absent and empty stay undeclared", () => {
    const dir = join(DIR, "requires-parse");
    mkdirSync(join(dir, "declared"), { recursive: true });
    writeFileSync(
      join(dir, "declared", "SKILL.md"),
      "---\nname: declared\ndescription: d\nrequires: WebSearch, WebFetch\n---\nbody",
    );
    mkdirSync(join(dir, "undeclared"), { recursive: true });
    writeFileSync(
      join(dir, "undeclared", "SKILL.md"),
      "---\nname: undeclared\ndescription: d\n---\nbody",
    );
    mkdirSync(join(dir, "empty"), { recursive: true });
    writeFileSync(
      join(dir, "empty", "SKILL.md"),
      "---\nname: empty\ndescription: d\nrequires:\n---\nbody",
    );

    const skills = loadSkills([dir], recorder().log);
    expect(skills.find((s) => s.name === "declared")?.requires).toEqual([
      "WebSearch",
      "WebFetch",
    ]);
    // "declared nothing" and "requires nothing" must stay the same case.
    expect(skills.find((s) => s.name === "undeclared")?.requires).toBeUndefined();
    expect(skills.find((s) => s.name === "empty")?.requires).toBeUndefined();
  });

  test("satisfiedBy keeps the satisfied and the undeclared, drops the rest by name", () => {
    const skill = (name: string, requires?: string[]) => ({
      name,
      description: "d",
      modelInvokable: true,
      dir: "/x",
      body: "b",
      files: [],
      ...(requires !== undefined ? { requires } : {}),
    });
    const registry = new SkillRegistry([
      skill("fits", ["Read"]),
      skill("foreign"),
      skill("stranded", ["WebSearch", "Bash"]),
    ]);

    const { kept, dropped } = registry.satisfiedBy(new Set(["Read", "Bash"]));

    expect(
      kept
        .all()
        .map((s) => s.name)
        .sort(),
    ).toEqual(["fits", "foreign"]);
    // The dropped entry says what was missing — "why is my skill not offered"
    // must be answerable, so silence is not an option here.
    expect(dropped).toEqual([{ name: "stranded", missing: ["WebSearch"] }]);
    // Out of the catalogue too, not just the list: the catalogue is what the
    // model reads before promising a capability onward.
    expect(kept.catalogText()).not.toContain("stranded");
  });

  test("the repository's own research skill declares the web pair", () => {
    // The canonical copy of the replacement skill (ticket 02's second half).
    // If this stops parsing, the installed copy is being edited blind.
    const skills = loadSkills(["skills"], recorder().log);
    const research = skills.find((s) => s.name === "research");

    expect(research?.requires).toEqual(["WebSearch", "WebFetch"]);
    expect(research?.modelInvokable).toBe(true);
    expect(research?.body).toContain("[citation:Title](URL)");
  });
});
