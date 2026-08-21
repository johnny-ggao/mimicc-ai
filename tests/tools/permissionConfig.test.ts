import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadPermissions } from "@/tools/permissionConfig";

const DIR = mkdtempSync(join(tmpdir(), "mimicc-permissions-"));

afterAll(() => rmSync(DIR, { recursive: true, force: true }));

function write(name: string, content: string): string {
  const file = join(DIR, name);
  writeFileSync(file, content);
  return file;
}

test("no files means no rules", () => {
  expect(
    loadPermissions({
      userFile: join(DIR, "none-user"),
      repoFile: join(DIR, "none-repo"),
    }),
  ).toEqual([]);
});

test("loads and merges user and repo rules", () => {
  const user = write(
    "user.json",
    JSON.stringify({ allow: ["Read(src/**)"], deny: ["Bash(rm -rf:*)"] }),
  );
  const repo = write(
    "repo.json",
    JSON.stringify({ ask: ["Write(*)"], deny: ["Read(dist/**)"] }),
  );

  const rules = loadPermissions({ userFile: user, repoFile: repo });

  expect(rules).toHaveLength(4);
  expect(
    rules
      .filter((rule) => rule.decision === "deny")
      .map((rule) => rule.specifier)
      .sort(),
  ).toEqual(["dist/**", "rm -rf:*"]);
  expect(
    rules.filter((rule) => rule.decision === "ask").map((rule) => rule.specifier),
  ).toEqual(["*"]);
  expect(
    rules.filter((rule) => rule.decision === "allow").map((rule) => rule.specifier),
  ).toEqual(["src/**"]);
});

test("rejects a repo file that contains allow", () => {
  const repo = write("repo-allow.json", JSON.stringify({ allow: ["Read(src/**)"] }));
  expect(() =>
    loadPermissions({ userFile: join(DIR, "nope"), repoFile: repo }),
  ).toThrow(/may not contain "allow"/);
});

test("rejects malformed JSON", () => {
  const user = write("bad.json", "{ not json");
  expect(() =>
    loadPermissions({ userFile: user, repoFile: join(DIR, "nope") }),
  ).toThrow();
});

test("rejects a malformed rule", () => {
  const user = write("bad-rule.json", JSON.stringify({ allow: ["Glob(**)"] }));
  expect(() =>
    loadPermissions({ userFile: user, repoFile: join(DIR, "nope") }),
  ).toThrow(/cannot target Glob/);
});

test("rejects an unknown key", () => {
  const user = write("unknown.json", JSON.stringify({ alow: ["Read(src/**)"] }));
  expect(() =>
    loadPermissions({ userFile: user, repoFile: join(DIR, "nope") }),
  ).toThrow();
});
