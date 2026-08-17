import { resolve } from "node:path";

import { tool } from "@langchain/core/tools";
import { z } from "zod";

import { SAFE_TO_REPLAY } from "./replay";

import {
  MAX_FILE_BYTES,
  ROOT,
  isSecret,
  resolveInside,
  withPathLock,
} from "./workspace";

// Result caps. Same reasoning as MAX_FILE_BYTES: what a tool returns is what the
// next request pays for.
const MAX_GLOB_HITS = 200;
const MAX_GREP_HITS = 100;

const IGNORED = ["node_modules/**", ".git/**", "dist/**", "coverage/**"];

function ignored(path: string): boolean {
  return IGNORED.some((pattern) => new Bun.Glob(pattern).match(path));
}

export const readTool = tool(
  async ({ path }): Promise<string> => {
    const full = resolveInside(path);

    // Reading takes the lock too, so a Read batched alongside an Edit of the
    // same file cannot observe a half-written one. Glob and Grep do not — they
    // are bulk scans, and locking every file they walk would cost real time to
    // prevent at worst one bad line in a search result.
    return withPathLock(full, async () => {
      const file = Bun.file(full);
      if (!(await file.exists())) throw new Error(`no such file: ${path}`);

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
      "Read a UTF-8 text file inside the working directory. Returns the file with 1-based line numbers.",
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
