import { describe, expect, test } from "bun:test";

import { decide, parseRule, type Rule } from "@/tools/permission";

describe("the hard floor", () => {
  // 🔴 This asserted the opposite until Terminal-Bench priced the rule: four
  // tasks in run `2026-08-27__22-37-36` were refused a path outside `/app`
  // (`/usr/bin/curl` — that task's actual answer — `/protected/maze_server.py`,
  // a site-packages module, `/tmp`) and all four times the model got it anyway
  // through `cat`/heredoc in Bash. The floor bought a wasted lap and moved the
  // action onto the one path with no gate on it.
  test("a read may leave the working directory; a write may not", () => {
    expect(decide({ tool: "Read", path: "../escaped.txt" }).decision).not.toBe("deny");

    for (const tool of ["Write", "Edit"]) {
      const verdict = decide({ tool, path: "../escaped.txt" });
      expect(verdict.decision).toBe("deny");
      expect(verdict.reason).toContain("escapes the working directory");
    }
  });

  // Letting Read out put the whole filesystem behind a tool that allows by
  // default. Until then the escape rule covered `~/.ssh` by covering everything.
  test("credential files outside the working directory are still refused", () => {
    for (const path of [
      "/Users/someone/.ssh/id_rsa",
      "/Users/someone/.aws/credentials",
      "/Users/someone/.docker/config.json",
      "/Users/someone/.config/gcloud/token.json",
      "/Users/someone/.netrc",
      "../.env",
    ]) {
      const verdict = decide({ tool: "Read", path });
      expect(verdict.decision).toBe("deny");
      expect(verdict.reason).toContain("may hold credentials");
    }
  });

  // The control: without it, a floor that denies everything outside passes the
  // test above and the widening never happened.
  test("an ordinary file outside the working directory is readable", () => {
    for (const path of ["/etc/hosts", "/usr/bin/curl", "../notes.md"]) {
      expect(decide({ tool: "Read", path }).decision).not.toBe("deny");
    }
  });

  test("denies the files whose whole point is to hold secrets", () => {
    for (const path of [
      ".env",
      ".env.local",
      "keys/deploy.pem",
      "certs/server.key",
      ".git/config",
      "id_rsa",
      ".mimicc/thread.jsonl",
    ]) {
      const verdict = decide({ tool: "Read", path });
      expect(verdict.decision).toBe("deny");
      expect(verdict.reason).toContain("may hold credentials");
    }
  });

  test("deny wins over ask: a mutating tool on a secret path is denied, not asked", () => {
    expect(decide({ tool: "Write", path: ".env" }).decision).toBe("deny");
    expect(decide({ tool: "Edit", path: "../outside.ts" }).decision).toBe("deny");
  });
});

describe("the baseline", () => {
  test("mutating tools ask by default", () => {
    expect(decide({ tool: "Write", path: "src/new.ts" }).decision).toBe("ask");
    expect(decide({ tool: "Edit", path: "src/index.ts" }).decision).toBe("ask");
    expect(decide({ tool: "Bash", command: "cat .env" }).decision).toBe("ask");
  });

  test("read-only tools allow by default", () => {
    expect(decide({ tool: "Read", path: "src/index.ts" }).decision).toBe("allow");
    expect(decide({ tool: "Glob" }).decision).toBe("allow");
    expect(decide({ tool: "Grep" }).decision).toBe("allow");
  });

  test("an unlisted tool asks by default (fail-closed)", () => {
    expect(decide({ tool: "SomethingNew" }).decision).toBe("ask");
  });
});

describe("safe Bash commands", () => {
  test("a read-only command like `ls` allows without asking", () => {
    expect(decide({ tool: "Bash", command: "ls docs/adr/" }).decision).toBe("allow");
  });

  test("a content-reading or mutating command still asks", () => {
    expect(decide({ tool: "Bash", command: "cat .env" }).decision).toBe("ask");
    expect(decide({ tool: "Bash", command: "rm -rf /" }).decision).toBe("ask");
  });
});

const allow = (spec: string): Rule => parseRule(spec, "allow");
const ask = (spec: string): Rule => parseRule(spec, "ask");
const deny = (spec: string): Rule => parseRule(spec, "deny");

describe("rules", () => {
  test("parses a path-glob rule", () => {
    expect(allow("Read(src/**)")).toEqual({
      tool: "Read",
      specifier: "src/**",
      decision: "allow",
    });
  });

  test("parses a Bash prefix rule", () => {
    expect(deny("Bash(rm -rf:*)")).toEqual({
      tool: "Bash",
      specifier: "rm -rf:*",
      decision: "deny",
    });
  });

  test("rejects a rule for a tool with no path or command", () => {
    expect(() => parseRule("Glob(**)", "allow")).toThrow();
    expect(() => parseRule("Grep(x)", "deny")).toThrow();
  });

  test("rejects a malformed rule", () => {
    expect(() => parseRule("Read", "allow")).toThrow();
    expect(() => parseRule("Read()", "allow")).toThrow();
    expect(() => parseRule("Bash", "allow")).toThrow();
  });

  test("an allow rule overrides the baseline ask for a mutating tool", () => {
    expect(
      decide({ tool: "Write", path: "src/new.ts" }, [allow("Write(src/**)")]).decision,
    ).toBe("allow");
    expect(
      decide({ tool: "Write", path: "docs/new.md" }, [allow("Write(src/**)")]).decision,
    ).toBe("ask");
  });

  test("a deny rule beats an allow rule for the same path", () => {
    const rules = [allow("Read(src/**)"), deny("Read(src/secret.md)")];
    expect(decide({ tool: "Read", path: "src/secret.md" }, rules).decision).toBe(
      "deny",
    );
    expect(decide({ tool: "Read", path: "src/other.ts" }, rules).decision).toBe(
      "allow",
    );
  });

  test("a deny rule reports which rule refused", () => {
    const verdict = decide({ tool: "Read", path: "src/secret.md" }, [
      deny("Read(src/**)"),
    ]);
    expect(verdict.decision).toBe("deny");
    expect(verdict.reason).toContain("Read(src/**)");
  });

  test("a Bash deny rule matches by command prefix", () => {
    expect(
      decide({ tool: "Bash", command: "rm -rf /" }, [deny("Bash(rm -rf:*)")]).decision,
    ).toBe("deny");
    expect(
      decide({ tool: "Bash", command: "git push" }, [deny("Bash(rm -rf:*)")]).decision,
    ).toBe("ask");
  });

  test("an ask rule makes a read-only tool ask", () => {
    expect(
      decide({ tool: "Read", path: "src/x.ts" }, [ask("Read(src/**)")]).decision,
    ).toBe("ask");
  });

  test("no rule can relax the hard floor", () => {
    expect(decide({ tool: "Read", path: ".env" }, [allow("Read(.env)")]).decision).toBe(
      "deny",
    );
    expect(
      decide({ tool: "Write", path: ".env" }, [allow("Write(.env)")]).decision,
    ).toBe("deny");
  });
});

describe("auto mode", () => {
  test("flips the baseline ask to allow", () => {
    expect(decide({ tool: "Write", path: "src/x.ts" }, undefined, true).decision).toBe(
      "allow",
    );
    expect(decide({ tool: "Edit", path: "src/x.ts" }, undefined, true).decision).toBe(
      "allow",
    );
    expect(decide({ tool: "Bash", command: "ls" }, undefined, true).decision).toBe(
      "allow",
    );
  });

  test("does not relax deny rules or the hard floor", () => {
    expect(decide({ tool: "Write", path: ".env" }, undefined, true).decision).toBe(
      "deny",
    );
    expect(
      decide({ tool: "Read", path: "src/x.ts" }, [deny("Read(src/**)")], true).decision,
    ).toBe("deny");
  });

  test("explicit ask rules still ask", () => {
    expect(
      decide({ tool: "Read", path: "src/x.ts" }, [ask("Read(src/**)")], true).decision,
    ).toBe("ask");
  });

  test("off (the default) behaves as before", () => {
    expect(decide({ tool: "Write", path: "src/x.ts" }).decision).toBe("ask");
  });
});
