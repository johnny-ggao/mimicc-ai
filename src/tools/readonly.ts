import { statSync } from "node:fs";
import { resolve } from "node:path";

import { tool } from "@langchain/core/tools";
import { z } from "zod";

import { SAFE_TO_REPLAY } from "./replay";

import { MAX_FILE_BYTES, ROOT, withPathLock } from "./workspace";

import { isSecret, resolvePath } from "./permission";

// Result caps. Same reasoning as MAX_FILE_BYTES: what a tool returns is what the
// next request pays for.
const MAX_GLOB_HITS = 200;
const MAX_GREP_HITS = 100;

const IGNORED = ["node_modules/**", ".git/**", "dist/**", "coverage/**"];

function ignored(path: string): boolean {
  return IGNORED.some((pattern) => new Bun.Glob(pattern).match(path));
}

/**
 * How many bytes are enough to tell what a file is. Magic numbers live in the
 * first few; the NUL check below only needs a representative sample.
 */
const SNIFF_BYTES = 4096;

/** Formats worth naming, so the refusal says *what* it is and not just "binary". */
const MAGIC: readonly (readonly [string, readonly number[], boolean])[] = [
  ["a PNG image", [0x89, 0x50, 0x4e, 0x47], true],
  ["a JPEG image", [0xff, 0xd8, 0xff], true],
  ["a GIF image", [0x47, 0x49, 0x46, 0x38], true],
  ["a BMP image", [0x42, 0x4d], true],
  ["a PDF document", [0x25, 0x50, 0x44, 0x46], false],
  ["a gzip archive", [0x1f, 0x8b], false],
  ["a ZIP archive, or a format built on one", [0x50, 0x4b, 0x03, 0x04], false],
  ["an ELF executable", [0x7f, 0x45, 0x4c, 0x46], false],
  ["a Mach-O executable", [0xcf, 0xfa, 0xed, 0xfe], false],
];

/** What this file is, when it is not UTF-8 text. `null` when it reads as text. */
function describeBinary(head: Uint8Array): { what: string; image: boolean } | null {
  for (const [what, signature, image] of MAGIC) {
    if (signature.every((byte, index) => head[index] === byte)) return { what, image };
  }
  // RIFF....WEBP — the only one worth a second window.
  if (head[0] === 0x52 && head[1] === 0x49 && head[8] === 0x57 && head[9] === 0x45) {
    return { what: "a WebP image", image: true };
  }
  // The standard heuristic, and the one `grep` and `git` use: text does not
  // contain NUL. It misses UTF-16 and a few oddities, and that is the trade —
  // a false "this is text" costs a garbled read, a false "this is binary"
  // would refuse a file the model needs.
  return head.includes(0)
    ? { what: "binary (it contains NUL bytes)", image: false }
    : null;
}

/**
 * Why a binary read is refused instead of returned.
 *
 * 🔴 **The refusal is the feature.** Before this, `Read` on a PNG returned the
 * bytes decoded as UTF-8 — mojibake, numbered line by line, `status: success`.
 * Terminal-Bench measured what that costs: on `chess-best-move` the model read
 * the board image, got numbered noise, correctly guessed on its own that "Read
 * reads UTF-8 text", and then spent **660 seconds and 224,909 characters of
 * reasoning** building a pixel classifier out of `python3 -c` one-liners to see
 * a picture it was never going to see. Nothing in the loop ever told it the
 * truth (`.scratch/external-bench/issues/07-tools-must-not-lie.md`).
 *
 * The image sentence is not hedged, because the limit is this program's and not
 * the model's: **no tool here builds image content**, and `src/models.ts:106-108`
 * leaves the vision model out of the registry for exactly that reason. So there
 * is no route by which those bytes reach the model, whatever model it is.
 *
 * ⚠️ **No workaround is suggested for images**, deliberately. Pointing at `Bash`
 * is what the model already did on its own, for eleven minutes.
 */
function binaryRefusal(path: string, found: { what: string; image: boolean }): string {
  const head = `cannot read ${path}: it is ${found.what}, and Read returns UTF-8 text`;
  return found.image
    ? `${head}. This program sends no images to the model, so there is no tool here that can show it to you. If the task needs the picture looked at, say that you cannot see it rather than trying to reconstruct it.`
    : `${head}. Use Bash if a command can extract what you need from it (file, strings, unzip -l).`;
}

export const readTool = tool(
  async ({ path }): Promise<string> => {
    const full = resolvePath(path);

    // Reading takes the lock too, so a Read batched alongside an Edit of the
    // same file cannot observe a half-written one. Glob and Grep do not — they
    // are bulk scans, and locking every file they walk would cost real time to
    // prevent at worst one bad line in a search result.
    return withPathLock(full, async () => {
      const file = Bun.file(full);
      if (!(await file.exists())) {
        // A directory exists and is not readable as a file, and `Bun.file`
        // reports both the same way. Saying "no such file" about something that
        // is right there sends the model looking for a path problem it does not
        // have.
        throw new Error(
          statSync(full, { throwIfNoEntry: false })?.isDirectory() === true
            ? `${path} is a directory, not a file. Use Glob to list what is in it.`
            : `no such file: ${path}`,
        );
      }

      const head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
      const binary = describeBinary(head);
      if (binary !== null) throw new Error(binaryRefusal(path, binary));

      const text = await file.text();
      const clipped = text.length > MAX_FILE_BYTES;
      const numbered = (clipped ? text.slice(0, MAX_FILE_BYTES) : text)
        .split("\n")
        .map((line, i) => `${String(i + 1)}\t${line}`)
        .join("\n");

      return clipped
        ? `${numbered}\n\n[clipped at ${String(MAX_FILE_BYTES)} bytes of ${String(text.length)}]`
        : numbered;
    });
  },
  {
    name: "Read",
    // Reading the same path twice leaves the world exactly as it was.
    metadata: { ...SAFE_TO_REPLAY },
    description:
      "Read a UTF-8 text file. Returns the file with 1-based line numbers. Refuses binary files, naming what they are; images cannot be shown to you by any tool here.",
    schema: z.object({
      path: z.string().describe("Path relative to the working directory"),
    }),
  },
);

export const globTool = tool(
  async ({ pattern }): Promise<string> => {
    const hits: string[] = [];
    for await (const hit of new Bun.Glob(pattern).scan({
      cwd: ROOT,
      onlyFiles: true,
    })) {
      if (ignored(hit)) continue;
      hits.push(hit);
      if (hits.length >= MAX_GLOB_HITS) break;
    }

    return hits.length === 0 ? `no files match ${pattern}` : hits.sort().join("\n");
  },
  {
    name: "Glob",
    // A scan. Same pattern, same answer, nothing touched.
    metadata: { ...SAFE_TO_REPLAY },
    description:
      "Find files by path pattern, e.g. src/**/*.test.ts. Skips node_modules, .git, dist and coverage.",
    schema: z.object({
      pattern: z.string().describe("Glob pattern, relative to the working directory"),
    }),
  },
);

export const grepTool = tool(
  async ({ pattern, glob }): Promise<string> => {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch (caught) {
      throw new Error(
        `bad regular expression: ${caught instanceof Error ? caught.message : String(caught)}`,
        { cause: caught },
      );
    }

    const hits: string[] = [];
    for await (const path of new Bun.Glob(glob).scan({ cwd: ROOT, onlyFiles: true })) {
      if (ignored(path) || isSecret(path)) continue;

      const file = Bun.file(resolve(ROOT, path));
      if (file.size > MAX_FILE_BYTES) continue;

      const text = await file.text().catch(() => "");
      for (const [i, line] of text.split("\n").entries()) {
        if (!regex.test(line)) continue;
        hits.push(`${path}:${String(i + 1)}:${line.trim().slice(0, 200)}`);
        if (hits.length >= MAX_GREP_HITS) break;
      }
      if (hits.length >= MAX_GREP_HITS) break;
    }

    return hits.length === 0
      ? `no matches for /${pattern}/ in ${glob}`
      : hits.join("\n");
  },
  {
    name: "Grep",
    // Same: it looks, it does not touch.
    metadata: { ...SAFE_TO_REPLAY },
    description:
      "Find files by content, using a JavaScript regular expression. Returns path:line:text.",
    schema: z.object({
      pattern: z.string().describe("JavaScript regular expression source"),
      glob: z
        .string()
        .default("**/*")
        .describe("Restrict the search to files matching this glob"),
    }),
  },
);
