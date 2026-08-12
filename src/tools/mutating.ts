import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";

import { tool } from "@langchain/core/tools";
import { z } from "zod";

import { AmbiguousMatch, locate } from "./matching";
import { ROOT, resolveInside, withPathLock } from "./workspace";

/** A command that has not produced anything in this long is not going to. */
const MAX_COMMAND_MS = 120_000;

/** Command output goes into the next prompt, same as any other tool result. */
const MAX_OUTPUT_BYTES = 32_000;

export const writeTool = tool(
  async ({ path, content }): Promise<string> => {
    const full = resolveInside(path);

    return withPathLock(full, async () => {
      const existing = Bun.file(full);
      const had = await existing.exists();
      const previous = had ? existing.size : 0;

      // Bun.write does not create intermediate directories.
      await mkdir(dirname(full), { recursive: true });
      await Bun.write(full, content);

      // Reporting the overwrite rather than staying silent: this tool is the one
      // that can destroy work, and the transcript is where that becomes visible.
      return had
        ? `overwrote ${path} (${String(previous)} bytes -> ${String(content.length)})`
        : `created ${path} (${String(content.length)} bytes)`;
    });
  },
  {
    name: "Write",
    description:
      "Create a file, or replace one in full. Never use it to make a small change — use Edit. Creates parent directories as needed.",
    schema: z.object({
      path: z.string().describe("Path relative to the working directory"),
      content: z.string().describe("The complete file contents"),
    }),
  },
);

export const editTool = tool(
  async ({ path, oldString, newString }): Promise<string> => {
    if (oldString === newString) {
      throw new Error("oldString and newString are identical: nothing to do");
    }
    if (oldString.length === 0) {
      throw new Error("oldString is empty: there is nothing to locate");
    }

    const full = resolveInside(path);

    // The whole read-modify-write is inside the lock. Holding it for only the
    // write would leave exactly the gap that loses one of two concurrent edits.
    return withPathLock(full, async () => {
      const file = Bun.file(full);
      if (!(await file.exists())) throw new Error(`no such file: ${path}`);

      const text = await file.text();

      let found;
      try {
        found = locate(text, oldString, newString);
      } catch (caught) {
        // Ambiguity is the one thing no amount of tolerance may resolve. Say how
        // many, and ask for the one thing that actually fixes it.
        if (caught instanceof AmbiguousMatch) {
          throw new Error(
            `oldString ${caught.message} in ${path} (${caught.level}). Include more surrounding lines to make the target unique`,
            { cause: caught },
          );
        }
        throw caught;
      }

      if (found === null) {
        throw new Error(
          `oldString not found in ${path}. Read the file again and copy the target from it — note that Read prefixes every line with its number and a tab, and that prefix is not part of the file`,
        );
      }

      await Bun.write(
        file,
        text.slice(0, found.start) + found.replacement + text.slice(found.end),
      );

      const line = text.slice(0, found.start).split("\n").length;
      // A tolerated mismatch is reported. The prompt tells the model that a
      // successful Edit means the change landed and not to re-read — that stays
      // true only while the tool admits which level it had to fall back to.
      const note = found.level === "exact" ? "" : ` (${found.level})`;
      return `edited ${path} at line ${String(line)}${note}`;
    });
  },
  {
    name: "Edit",
    description:
      "Replace one exact string in a file with another. The target must resolve to exactly one place; line endings, blank lines around the block, and indentation are tolerated, ambiguity is not.",
    schema: z.object({
      path: z.string().describe("Path relative to the working directory"),
      oldString: z.string().describe("Text to replace, copied from the file"),
      newString: z.string().describe("Text to put in its place"),
    }),
  },
);

export const bashTool = tool(
  async ({ command }): Promise<string> => {
    const child = Bun.spawn(["/bin/sh", "-c", command], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
      // The model's own environment, minus the one variable it must never read
      // back out of a process it started.
      env: { ...process.env, LLM_API_KEY: undefined },
    });

    const timer = setTimeout(() => void child.kill(), MAX_COMMAND_MS);
    let stdout: string;
    let stderr: string;
    let code: number | null;
    try {
      [stdout, stderr] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      code = await child.exited;
    } finally {
      clearTimeout(timer);
    }

    const body = [stdout, stderr].filter((part) => part.length > 0).join("\n");
    const clipped =
      body.length > MAX_OUTPUT_BYTES
        ? `${body.slice(0, MAX_OUTPUT_BYTES)}\n\n[clipped at ${String(MAX_OUTPUT_BYTES)} bytes of ${String(body.length)}]`
        : body;

    // A non-zero exit is a *result*, not a tool failure: a failing test suite is
    // exactly what the model needs to read. Only the command never finishing is
    // an error, and that arrives as a kill rather than as an exception.
    if (code !== 0) {
      return `${clipped}${clipped.length > 0 ? "\n" : ""}[exit ${String(code)}]`;
    }
    return clipped.length > 0 ? clipped : "[no output]";
  },
  {
    name: "Bash",
    description: `Run one shell command in the working directory. Returns stdout and stderr combined; a non-zero exit is reported as [exit N] rather than as a failure. Times out after ${String(MAX_COMMAND_MS / 1000)}s.`,
    schema: z.object({
      command: z.string().describe("The command to run. One command per call."),
    }),
  },
);
