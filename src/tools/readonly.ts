import { relative, resolve, sep } from "node:path";

import { tool } from "@langchain/core/tools";
import { z } from "zod";

/** Everything is resolved against this. Set once, at module load. */
const ROOT = process.cwd();

// Output caps. A tool result goes straight into the next prompt, so an
// unbounded read is an unbounded bill — and it evicts the conversation.
const MAX_FILE_BYTES = 64_000;
const MAX_GLOB_HITS = 200;
const MAX_GREP_HITS = 100;

const IGNORED = ["node_modules/**", ".git/**", "dist/**", "coverage/**"];

/**
 * Read-only is not risk-free. Tool output is sent to the model, which makes an
 * unconstrained path an exfiltration channel rather than merely a read. Two
 * guards: stay inside the working directory, and refuse the files whose whole
 * point is to hold secrets.
 *
 * Throwing here is the right move — `ToolNode` turns a thrown error into a tool
 * message, so the model reads the refusal and can explain it to the user.
 */
const SECRET = /(^|\/)\.env(\.|$)|(^|\/)\.git\/|(^|\/)id_[a-z]+$|\.pem$|\.key$/;

function resolveInside(path: string): string {
  const full = resolve(ROOT, path);
  if (full !== ROOT && !full.startsWith(ROOT + sep)) {
    throw new Error(`path escapes the working directory: ${path}`);
  }
  const rel = relative(ROOT, full);
  if (SECRET.test(`/${rel}`)) {
    throw new Error(
      `refusing to read ${rel}: it may hold credentials, and tool output is sent to the model`,
    );
  }
  return full;
}

function ignored(path: string): boolean {
  return IGNORED.some((pattern) => new Bun.Glob(pattern).match(path));
}

export const readTool = tool(
  async ({ path }): Promise<string> => {
    const file = Bun.file(resolveInside(path));
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
  },
  {
    name: "Read",
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
      if (ignored(path) || SECRET.test(`/${path}`)) continue;

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
