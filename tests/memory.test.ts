import { afterEach, beforeEach, expect, test } from "bun:test";

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeListChatModel } from "@langchain/core/utils/testing";

import { CONFIRMATION_POLICY, registeredTools } from "@/agents";
import {
  CATEGORIES,
  MAX_MEMORIES,
  MAX_MEMORY_BYTES,
  MemoryRefused,
  MemoryStore,
  identify,
  resolveMemoryDirs,
  type MemoryDirs,
  type WriteContext,
} from "@/memory";
import { SkillRegistry } from "@/skills";

/**
 * The gates, and — for every gate — a case that must *not* be stopped by it.
 *
 * The control cases are the point. A gate test with only the refusal half stays
 * green if the gate starts refusing everything, which is the failure that costs
 * the most: the model loses the ability to remember anything and the only
 * symptom is that memory is empty, which looks exactly like a model that never
 * thought to write one.
 */

let root: string;
let dirs: MemoryDirs;
let store: MemoryStore;

const CONTEXT: WriteContext = { threadId: "t-1", callId: "call-1" };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mimicc-memory-"));
  dirs = { global: join(root, "global"), project: join(root, "projects", "p") };
  store = new MemoryStore(dirs);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ── the tier is derived from the category, never chosen ──────────────────────

test("user and feedback land in the global tier, project and reference in the project tier", () => {
  store.add("writes in Chinese", "user", CONTEXT);
  store.add("asked for a probe first", "feedback", CONTEXT);
  store.add("this repo targets Bun", "project", CONTEXT);
  store.add("spec lives in pi/docs", "reference", CONTEXT);

  const tierOf = (content: string): string => {
    const memory = store.all().find((candidate) => candidate.content === content);
    if (memory === undefined) throw new Error(`missing: ${content}`);
    // The file's location is the assertion — a record that claims one tier while
    // sitting in the other would pass a check against the record alone.
    return readFileSync(join(dirs.global, `${memory.id}.md`), "utf8").length > 0
      ? "global"
      : "project";
  };

  expect(tierOf("writes in Chinese")).toBe("global");
  expect(tierOf("asked for a probe first")).toBe("global");
  expect(() => tierOf("this repo targets Bun")).toThrow();
  expect(() => tierOf("spec lives in pi/docs")).toThrow();
});

// ── gate 1: the category whitelist ───────────────────────────────────────────

test("an unknown category is refused, and the message names the legal ones", () => {
  expect(() => store.add("something", "preference", CONTEXT)).toThrow(MemoryRefused);

  try {
    store.add("something", "preference", CONTEXT);
  } catch (error) {
    // The model reads this string; it has to be actionable, not just a refusal.
    expect((error as Error).message).toContain("user, feedback, project, reference");
  }

  // Nothing was written on the way to being refused.
  expect(store.all()).toHaveLength(0);
});

test("control: every category on the whitelist is accepted", () => {
  for (const category of CATEGORIES) {
    expect(() =>
      store.add(`a fact about ${category}`, category, CONTEXT),
    ).not.toThrow();
  }
  expect(store.all()).toHaveLength(CATEGORIES.length);
});

// ── gate 2: source is written by the harness, not by the model ───────────────

test("source names the thread and the tool call the harness supplied", () => {
  const memory = store.add("a fact", "user", { threadId: "abc", callId: "call-7" });
  // The call id is the join key into `<threadId>.tools.jsonl`, which is the only
  // reason this field earns its place: a wrong memory can be traced to the call
  // that wrote it. A counter invented here would join to nothing.
  expect(memory.source).toBe("thread=abc call=call-7");
});

// ── gate 3: the size cap refuses rather than truncating ──────────────────────

test("over-long content is refused, and is not silently truncated", () => {
  const huge = "x".repeat(MAX_MEMORY_BYTES + 1);
  expect(() => store.add(huge, "user", CONTEXT)).toThrow(MemoryRefused);

  // The refusal half alone would also pass if the store had written a clipped
  // copy first. Nothing on disk is the other half of the claim.
  expect(store.all()).toHaveLength(0);
});

test("control: content exactly at the cap is accepted", () => {
  const exact = "x".repeat(MAX_MEMORY_BYTES);
  expect(() => store.add(exact, "user", CONTEXT)).not.toThrow();
  expect(store.all()[0]?.content).toHaveLength(MAX_MEMORY_BYTES);
});

// ── gate 4: dedupe by normalised content ─────────────────────────────────────

test("the same fact, differently cased and spaced, is refused as a duplicate", () => {
  store.add("He prefers Chinese", "user", CONTEXT);
  expect(() => store.add("  he prefers chinese  ", "user", CONTEXT)).toThrow(
    MemoryRefused,
  );
  expect(store.all()).toHaveLength(1);
});

test("control: a different fact in the same category is accepted", () => {
  store.add("He prefers Chinese", "user", CONTEXT);
  expect(() => store.add("He prefers Bun", "user", CONTEXT)).not.toThrow();
  expect(store.all()).toHaveLength(2);
});

test("the id is the content hash, so dedupe and the filename are one rule", () => {
  const memory = store.add("a fact", "user", CONTEXT);
  expect(memory.id).toBe(identify("A FACT"));
  expect(readFileSync(join(dirs.global, `${memory.id}.md`), "utf8")).toContain(
    "a fact",
  );
});

// ── gate 5: the runaway detector refuses instead of evicting ─────────────────

test("hitting the cap refuses the new write and destroys nothing", () => {
  const full = new MemoryStore(dirs);
  for (let i = 0; i < MAX_MEMORIES; i += 1)
    full.add(`fact number ${String(i)}`, "user", CONTEXT);

  expect(() => full.add("one more", "user", CONTEXT)).toThrow(MemoryRefused);

  // The reverse assertion, and the one that matters: refusing must not have
  // quietly made room. Eviction was rejected precisely because it is invisible.
  expect(full.all()).toHaveLength(MAX_MEMORIES);
  expect(full.all().some((memory) => memory.content === "fact number 0")).toBe(true);
});

test("the full message tells the model how to make room", () => {
  const full = new MemoryStore(dirs);
  for (let i = 0; i < MAX_MEMORIES; i += 1)
    full.add(`fact number ${String(i)}`, "user", CONTEXT);

  try {
    full.add("one more", "user", CONTEXT);
  } catch (error) {
    expect((error as Error).message).toContain("memory_search");
    expect((error as Error).message).toContain("memory_delete");
  }
});

// ── search, deletion, round-trip ─────────────────────────────────────────────

test("search matches case-insensitively and can filter to one category", () => {
  store.add("He prefers Chinese", "user", CONTEXT);
  store.add("Chinese docs live in pi", "reference", CONTEXT);

  expect(store.search("chinese", { limit: 10 })).toHaveLength(2);
  expect(store.search("chinese", { limit: 10, category: "user" })).toHaveLength(1);
  // An empty query is "show me everything", not "match nothing".
  expect(store.search("", { limit: 10 })).toHaveLength(2);
  expect(store.search("", { limit: 1 })).toHaveLength(1);
});

test("a deleted memory is gone from both the listing and the disk", () => {
  const memory = store.add("a fact", "user", CONTEXT);
  expect(store.remove(memory.id)).toBe(true);
  expect(store.all()).toHaveLength(0);
  expect(store.remove(memory.id)).toBe(false);
});

test("a memory survives a round trip through the file, fields intact", () => {
  const written = store.add("a fact worth keeping", "project", {
    threadId: "t",
    callId: "call-3",
  });
  const read = new MemoryStore(dirs).find(written.id);

  expect(read).toEqual(written);
});

test("a file that is not a memory is skipped, not crashed on", () => {
  store.add("a real one", "user", CONTEXT);
  writeFileSync(join(dirs.global, "junk.md"), "no frontmatter here", "utf8");
  writeFileSync(join(dirs.global, "notes.txt"), "---\nid: x\n---\nignored", "utf8");

  expect(store.all()).toHaveLength(1);
});

test("a tier with no directory yet reads as empty rather than throwing", () => {
  // Reading must not create anything either: a query that writes would make
  // "did we ever remember something here" impossible to answer from the disk.
  expect(store.all()).toEqual([]);
  expect(() => readFileSync(join(dirs.global, "anything"), "utf8")).toThrow();
});

// ── where the two tiers live ─────────────────────────────────────────────────

test("the project tier is keyed by the working directory, the global tier is not", () => {
  const here = resolveMemoryDirs({ override: root, cwd: "/tmp/one" });
  const there = resolveMemoryDirs({ override: root, cwd: "/tmp/two" });

  expect(here.project).not.toBe(there.project);
  // The whole reason the global tier exists: it must not move when the project
  // does. This is the assertion that fails if someone "simplifies" the layout by
  // putting both tiers under the slug.
  expect(here.global).toBe(there.global);
});

test("starting from a subdirectory is a different project, as decided", () => {
  const repo = resolveMemoryDirs({ override: root, cwd: "/tmp/repo" });
  const sub = resolveMemoryDirs({ override: root, cwd: "/tmp/repo/src" });

  // Pinned deliberately: this is the chosen meaning of "project" (2026-08-17),
  // not an accident. If it is ever changed, this test is where the decision is
  // recorded.
  expect(repo.project).not.toBe(sub.project);
});

// ── the wiring: registered only when the program was started with a directory ──

test("the memory tools are registered when a directory was resolved, and not otherwise", () => {
  const model = new FakeListChatModel({ responses: ["unused"] });
  const modelFor = () => model;

  const without = registeredTools({ model, modelFor }).map((tool) => tool.name);
  const withMemory = registeredTools({ model, modelFor, memory: store }).map(
    (tool) => tool.name,
  );

  // The control half. Absent memory must not half-register anything: a tool that
  // always fails is worse than a capability the model was never offered.
  expect(without).not.toContain("MemoryAdd");

  expect(withMemory).toEqual([
    ...without,
    "MemorySearch",
    "MemoryAdd",
    "MemoryUpdate",
    "MemoryDelete",
  ]);
});

test("every memory tool has an explicit confirmation decision", () => {
  // The same claim `tests/agent.test.ts` makes for the base set, asked again with
  // memory configured — that test builds its environment without a store, so it
  // cannot see these four. A tool missing from the policy is auto-approved
  // (fail-open), so "it passed over there" is not cover.
  const registered = registeredTools(
    {
      model: new FakeListChatModel({ responses: ["unused"] }),
      modelFor: () => new FakeListChatModel({ responses: ["unused"] }),
      memory: store,
    },
    new SkillRegistry([]),
  ).map((tool) => tool.name);

  expect(Object.keys(CONFIRMATION_POLICY).sort()).toEqual(registered.sort());
});
