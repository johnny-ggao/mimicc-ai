import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { MemoryDirs } from "./location";

/**
 * The four kinds of thing worth remembering, and the whole of the judgement.
 *
 * This list *is* the mechanical criterion for "what counts as a memory". The
 * alternative — a confidence score the model assigns itself — was rejected
 * (2026-08-17): it is a number the model makes up, nothing can check it, and a
 * model that wants its memory to survive learns to write 1.0. A category can be
 * checked against a list; that is the difference.
 *
 * Taken from a memory directory that has been in daily use by another agent
 * rather than invented here. deer-flow's five (`preference` / `personal` /
 * `behavior` / `correction` / `context`) were *not* copied: they describe a
 * person for a consumer assistant, and this program is an agent working inside a
 * code repository.
 */
export const CATEGORIES = ["user", "feedback", "project", "reference"] as const;

export type Category = (typeof CATEGORIES)[number];

/**
 * Which tier a category lands in — derived, never chosen.
 *
 * The model fills in a category and nothing else. Letting it pick the tier too
 * would be a second knob it can get wrong, and the two would disagree the first
 * time it did. `user` and `feedback` describe the person and hold in any
 * repository; `project` and `reference` only hold in this one.
 */
const TIER: Record<Category, keyof MemoryDirs> = {
  user: "global",
  feedback: "global",
  project: "project",
  reference: "project",
};

/**
 * Cap on one memory, and deliberately the same order of magnitude as
 * `MAX_INSTRUCTION_BYTES` rather than `MAX_FILE_BYTES`.
 *
 * The reasoning transfers exactly: like the project instructions, a memory rides
 * along on every request for the life of the thread. What a `Read` returns is
 * paid for once; this is paid for every lap, forever.
 */
export const MAX_MEMORY_BYTES = 2_000;

/**
 * Cap on how many memories may exist, and it is a runaway detector rather than a
 * budget.
 *
 * The context bill is already closed by bounding *injection* (see the injection
 * ticket), so this number is not protecting tokens — it is protecting against a
 * loop that writes forever. It should never be reached in normal use, which is
 * why hitting it refuses the write instead of evicting something: eviction is
 * irreversible and picks its victim by a key nobody can verify, while a refusal
 * is visible to both the model and the person and destroys nothing.
 *
 * ⚠️ If this is hit routinely, this whole model is wrong and belongs back in
 * front of the user — the limit would be a daily constraint, not a detector.
 */
export const MAX_MEMORIES = 1_000;

export interface Memory {
  /** Content hash. See {@link identify}. */
  id: string;
  content: string;
  category: Category;
  /** Where this came from, written by the harness — never by the model. */
  source: string;
  /** ISO 8601. The injection tier needs an ordering key and this is it. */
  created: string;
}

/**
 * What the harness knows about the call that is writing a memory.
 *
 * `callId` is the tool call id rather than a turn counter, and that is what
 * makes `source` worth storing: the tool journal (`<threadId>.tools.jsonl`) is
 * keyed by exactly this id, so a memory that turns out to be wrong can be traced
 * back to the call that wrote it and, from there, to the conversation around it.
 * A counter we invented here would join to nothing.
 */
export interface WriteContext {
  threadId: string;
  callId: string;
}

/**
 * The id, and the deduplication gate, are the same thing.
 *
 * Hashing the normalised content means "this memory already exists" and "this
 * filename is taken" are one condition, enforced by the filesystem rather than
 * by a check someone can forget to run. The cost is that editing a memory gives
 * it a new id — which is honest: a fact whose text changed is a different fact.
 *
 * Normalisation is `trim` + `toLowerCase`, matching deer-flow's `casefold`
 * comparison. It is a weak rule and knowingly so: the model can defeat it by
 * rewording. The alternative is asking a model whether two memories mean the
 * same thing, which costs a request per write — the same price that got the
 * automatic-extraction design rejected in the first place.
 */
export function identify(content: string): string {
  const normalised = content.trim().toLowerCase();
  return createHash("sha256").update(normalised).digest("hex").slice(0, 12);
}

/** Raised when a gate refuses. The message is written to be read by the model. */
export class MemoryRefused extends Error {}

/**
 * Memories on disk, one Markdown file each.
 *
 * One file per memory rather than one document holding all of them, for the
 * reason the checkpointer is JSONL: a person has to be able to read it, and a
 * single file that every write rewrites is a file two writes can corrupt.
 *
 * deer-flow shards fact files by the first two hex digits of their id. That is
 * not copied — it exists to keep tens of thousands of files out of one
 * directory, and {@link MAX_MEMORIES} is three orders of magnitude below where
 * that starts to matter.
 */
export class MemoryStore {
  constructor(private readonly dirs: MemoryDirs) {}

  /** Every memory across both tiers, newest first. */
  all(): Memory[] {
    return [...this.read("global"), ...this.read("project")].sort((a, b) =>
      b.created.localeCompare(a.created),
    );
  }

  /**
   * Case-insensitive substring match over content, newest first.
   *
   * Substring rather than anything cleverer for the same reason the dedupe rule
   * is exact-match: every alternative needs either a model call or an embedding
   * dependency, and this list is small enough that neither earns its cost.
   */
  search(query: string, options: { category?: Category; limit: number }): Memory[] {
    const needle = query.trim().toLowerCase();
    return this.all()
      .filter(
        (memory) =>
          options.category === undefined || memory.category === options.category,
      )
      .filter(
        (memory) => needle === "" || memory.content.toLowerCase().includes(needle),
      )
      .slice(0, options.limit);
  }

  /**
   * Writes one memory, or refuses with a reason the model can act on.
   *
   * Every gate refuses rather than repairs. Falling back to a default category,
   * truncating over-long content, or dropping the oldest memory would each leave
   * the user with something they did not ask for and no way to notice — and
   * silently mishandling input is the exact failure this program has already
   * been bitten by once.
   */
  add(content: string, category: string, context: WriteContext): Memory {
    const trimmed = content.trim();
    if (trimmed === "") throw new MemoryRefused("content is empty");

    if (!isCategory(category)) {
      throw new MemoryRefused(
        `unknown category ${JSON.stringify(category)}; use one of: ${CATEGORIES.join(", ")}`,
      );
    }

    const bytes = Buffer.byteLength(trimmed, "utf8");
    if (bytes > MAX_MEMORY_BYTES) {
      throw new MemoryRefused(
        `too long: ${String(bytes)} bytes, limit ${String(MAX_MEMORY_BYTES)}. ` +
          `Split it into separate memories or state it more briefly — it is not truncated.`,
      );
    }

    const id = identify(trimmed);
    if (this.find(id) !== undefined) {
      throw new MemoryRefused(`already remembered (${id})`);
    }

    const total = this.count();
    if (total >= MAX_MEMORIES) {
      throw new MemoryRefused(
        `memory is full (${String(total)}/${String(MAX_MEMORIES)}). ` +
          `Use memory_search to find one that no longer holds, memory_delete it, then retry.`,
      );
    }

    // `source` is assembled here and the tool does not accept it as an argument.
    // A source the model supplies is a claim the model is making, not a fact
    // about where the memory came from, and the only value of this field is that
    // it can be trusted when a memory turns out to be wrong.
    const memory: Memory = {
      id,
      content: trimmed,
      category,
      source: `thread=${context.threadId} call=${context.callId}`,
      created: new Date().toISOString(),
    };

    const dir = this.dirs[TIER[category]];
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.md`), serialise(memory), "utf8");
    return memory;
  }

  /** Removes one memory. Returns false when the id was not there. */
  remove(id: string): boolean {
    const found = this.locate(id);
    if (found === undefined) return false;
    rmSync(found.path);
    return true;
  }

  find(id: string): Memory | undefined {
    return this.locate(id)?.memory;
  }

  /**
   * How many memories exist, without reading any of them.
   *
   * Separate from `all().length` on purpose. The runaway detector runs on every
   * write and only needs a number, while `all` parses every file — measured, the
   * two together were O(n²) per write and took a full-cap store past a five
   * second test timeout. Counting filenames is the whole job.
   */
  count(): number {
    return this.names("global").length + this.names("project").length;
  }

  private locate(id: string): { memory: Memory; path: string } | undefined {
    for (const tier of ["global", "project"] as const) {
      const path = join(this.dirs[tier], `${id}.md`);
      const memory = load(path);
      if (memory !== undefined) return { memory, path };
    }
    return undefined;
  }

  private read(tier: keyof MemoryDirs): Memory[] {
    return this.names(tier)
      .map((name) => load(join(this.dirs[tier], name)))
      .filter((memory): memory is Memory => memory !== undefined);
  }

  private names(tier: keyof MemoryDirs): string[] {
    try {
      return readdirSync(this.dirs[tier]).filter((name) => name.endsWith(".md"));
    } catch {
      // A tier with nothing in it has no directory yet. That is not an error,
      // and creating one on read would make a query a write.
      return [];
    }
  }
}

function isCategory(value: string): value is Category {
  return (CATEGORIES as readonly string[]).includes(value);
}

/**
 * Frontmatter plus body — the shape of the memory directory this design was
 * taken from, and the reason is that a person opening one of these files should
 * not have to parse anything. JSON would need pretty-printing to stay readable
 * and would still put the content behind quotes and escapes.
 */
function serialise(memory: Memory): string {
  return [
    "---",
    `id: ${memory.id}`,
    `category: ${memory.category}`,
    `source: ${memory.source}`,
    `created: ${memory.created}`,
    "---",
    "",
    memory.content,
    "",
  ].join("\n");
}

function load(path: string): Memory | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }

  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (match === null) return undefined;

  const [, header = "", body = ""] = match;
  const fields = new Map(
    header.split("\n").map((line) => {
      const at = line.indexOf(":");
      return at === -1
        ? ([line.trim(), ""] as const)
        : ([line.slice(0, at).trim(), line.slice(at + 1).trim()] as const);
    }),
  );

  const category = fields.get("category");
  const id = fields.get("id");
  if (id === undefined || category === undefined || !isCategory(category))
    return undefined;

  return {
    id,
    category,
    content: body.trim(),
    source: fields.get("source") ?? "",
    created: fields.get("created") ?? "",
  };
}
